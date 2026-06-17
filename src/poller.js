// Background poller. Async (email-approved or feed) submissions don't settle
// synchronously — a JSON_LISTINGS_FEED walks IN_QUEUE -> IN_PROGRESS -> DONE
// over minutes. This cron polls each IN_PROGRESS feed submission, downloads
// the processing report on DONE, settles the submission + its parent job,
// and records the outcome in the audit trail.
const cron = require('node-cron');
const env = require('../config/env');
const { getDb } = require('./db');
const submissions = require('./submissions');
const feeds = require('./spapi/feeds');
const audit = require('./audit/auditEvents');
const { recomputeJobStatus } = require('./jobOrchestrator');
const { scheduleReconciliation, summarizeIssues, isPackageLevelRequiredError, splitFeedPayload } = require('./forwarder');
const { scrubObject } = require('../lib/safeError');

function parse(json) {
  if (json == null) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// A feed that settled FAILED can be retried WITH package_level when (and only
// when) Amazon's processing report says it is required, the original payload
// actually carried package_level (so the deferred initial feed dropped it), and
// we haven't already re-added it. Returns true when a re-add feed was submitted
// (so the caller skips settling this submission as FAILED).
async function maybeReaddPackageLevel(submission, issues) {
  if (Number(submission.package_level_readded) === 1) return false;
  if (!isPackageLevelRequiredError(issues)) return false;
  const body = parse(submission.request_body_json) || {};
  const { hasPL } = splitFeedPayload(body.payload);
  if (!hasPL) return false;

  try {
    const result = await feeds.submitJsonListingsFeed({ marketplaceCode: submission.marketplace_code, payload: body.payload });
    submissions.update(submission.submission_uuid, {
      status: 'IN_PROGRESS',
      feed_id: result.feedId,
      feed_document_id: result.feedDocumentId,
      amazon_response_json: result,
      issues_json: [],
      error_message: null,
      package_level_readded: 1
    });
    audit.record({ event: 'package_level_readd', submissionUuid: submission.submission_uuid, actor: 'poller', details: { operation: 'submitJsonListingsFeed', feedId: result.feedId, reason: summarizeIssues(issues) } });
    return true;
  } catch (err) {
    audit.record({ event: 'package_level_readd_error', submissionUuid: submission.submission_uuid, actor: 'poller', details: { message: err.message } });
    return false;
  }
}

let task = null;
let running = false;

function dueFeedSubmissions() {
  return getDb().prepare(`
    SELECT * FROM push_submissions
    WHERE status = 'IN_PROGRESS' AND operation = 'submitJsonListingsFeed' AND feed_id IS NOT NULL
    ORDER BY id ASC LIMIT 50
  `).all();
}

// Settle an async feed submission as FAILED (it can never reach DONE) and roll
// its parent job up. Used both for structurally unpollable rows and for ones
// whose status reads keep failing past the configured ceiling.
function abandonFeed(submission, event, message) {
  submissions.update(submission.submission_uuid, { status: 'FAILED', error_message: String(message).slice(0, 1000) });
  audit.record({ event, submissionUuid: submission.submission_uuid, actor: 'poller', details: { message } });
  recomputeJobStatus(submission.job_uuid);
}

async function pollOne(submission) {
  // A feed submission with no marketplace can never be polled: getFeed needs a
  // marketplace to resolve the SP-API region, so it would error every cycle
  // forever. Settle it FAILED immediately rather than looping.
  if (!submission.marketplace_code) {
    abandonFeed(submission, 'feed_poll_abandoned', 'Feed submission has no marketplace_code — cannot resolve an SP-API region to poll its status');
    return;
  }

  let feed;
  try {
    feed = await feeds.getFeed({ feedId: submission.feed_id, marketplaceCode: submission.marketplace_code });
  } catch (err) {
    const attempt = Number(submission.poll_error_count || 0) + 1;
    const max = env.POLLER_MAX_FEED_ERRORS;
    audit.record({ event: 'feed_poll_error', submissionUuid: submission.submission_uuid, actor: 'poller', details: { message: err.message, attempt, max } });
    if (attempt >= max) {
      abandonFeed(submission, 'feed_poll_abandoned', `Abandoned after ${attempt} consecutive poll errors (limit ${max}). Last error: ${err.message}`);
    } else {
      submissions.update(submission.submission_uuid, { poll_error_count: attempt });
    }
    return;
  }
  // A successful status read clears any accumulated transient-error count so a
  // healthy but slow feed isn't abandoned for sporadic earlier failures.
  if (Number(submission.poll_error_count || 0) > 0) {
    submissions.update(submission.submission_uuid, { poll_error_count: 0 });
  }
  const processingStatus = String(feed && feed.processingStatus || '').toUpperCase();
  if (processingStatus === 'IN_QUEUE' || processingStatus === 'IN_PROGRESS' || !processingStatus) return;

  if (processingStatus === 'DONE') {
    let report = null;
    if (feed.resultFeedDocumentId) {
      try { report = await feeds.downloadFeedResult({ feedDocumentId: feed.resultFeedDocumentId, marketplaceCode: submission.marketplace_code }); }
      catch (err) { audit.record({ event: 'feed_result_download_error', submissionUuid: submission.submission_uuid, actor: 'poller', details: { message: err.message } }); }
    }
    const summary = report && report.summary ? report.summary : null;
    const hadErrors = summary ? Number(summary.errors || 0) > 0 : false;
    const issues = (report && report.issues) || [];

    // Before settling a failed feed, see if it failed because Amazon requires
    // package_level (which the initial feed deliberately omitted). If so, the
    // re-add resubmits a fresh feed and leaves this submission IN_PROGRESS for
    // the next poll cycle to settle.
    if (hadErrors && await maybeReaddPackageLevel(submission, issues)) {
      recomputeJobStatus(submission.job_uuid);
      return;
    }

    submissions.update(submission.submission_uuid, {
      status: hadErrors ? 'FAILED' : 'APPLIED',
      amazon_response_json: { feed, report: scrubObject(report) },
      issues_json: issues,
      error_message: hadErrors ? (summarizeIssues(issues) || 'Feed processing reported errors') : null
    });
    audit.record({ event: 'feed_settled', submissionUuid: submission.submission_uuid, actor: 'poller', details: { processingStatus, hadErrors, summary } });
    if (!hadErrors) scheduleReconciliation(submissions.getByUuid(submission.submission_uuid));
  } else {
    // FATAL / CANCELLED
    submissions.update(submission.submission_uuid, {
      status: 'FAILED',
      amazon_response_json: { feed },
      error_message: `Feed ${processingStatus}`
    });
    audit.record({ event: 'feed_settled', submissionUuid: submission.submission_uuid, actor: 'poller', details: { processingStatus } });
  }
  recomputeJobStatus(submission.job_uuid);
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const due = dueFeedSubmissions();
    for (const s of due) {
      try { await pollOne(s); }
      catch (err) { console.warn(`[poller] error on ${s.submission_uuid}: ${err.message}`); }
    }
  } finally {
    running = false;
  }
}

function start(cronExpr) {
  if (task) return task;
  if (!cron.validate(cronExpr)) {
    console.warn(`[poller] invalid cron '${cronExpr}', defaulting to */2 * * * *`);
    cronExpr = '*/2 * * * *';
  }
  task = cron.schedule(cronExpr, () => { runOnce().catch((err) => console.warn('[poller] runOnce failed:', err.message)); });
  console.log(`[poller] scheduled '${cronExpr}'`);
  return task;
}

function stop() { if (task) { task.stop(); task = null; } }

module.exports = { start, stop, runOnce };
