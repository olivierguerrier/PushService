// Background poller. Async (email-approved or feed) submissions don't settle
// synchronously — a JSON_LISTINGS_FEED walks IN_QUEUE -> IN_PROGRESS -> DONE
// over minutes. This cron polls each IN_PROGRESS feed submission, downloads
// the processing report on DONE, settles the submission + its parent job,
// and records the outcome in the audit trail.
const cron = require('node-cron');
const { getDb } = require('./db');
const submissions = require('./submissions');
const feeds = require('./spapi/feeds');
const audit = require('./audit/auditEvents');
const { recomputeJobStatus } = require('./jobOrchestrator');
const { scheduleReconciliation, summarizeIssues } = require('./forwarder');
const { scrubObject } = require('../lib/safeError');

let task = null;
let running = false;

function dueFeedSubmissions() {
  return getDb().prepare(`
    SELECT * FROM push_submissions
    WHERE status = 'IN_PROGRESS' AND operation = 'submitJsonListingsFeed' AND feed_id IS NOT NULL
    ORDER BY id ASC LIMIT 50
  `).all();
}

async function pollOne(submission) {
  let feed;
  try {
    feed = await feeds.getFeed({ feedId: submission.feed_id, marketplaceCode: submission.marketplace_code });
  } catch (err) {
    audit.record({ event: 'feed_poll_error', submissionUuid: submission.submission_uuid, actor: 'poller', details: { message: err.message } });
    return;
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
