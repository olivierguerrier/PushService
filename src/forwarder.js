// The live SP-API forwarder. Takes a PENDING/IN_PROGRESS submission row and
// actually talks to Amazon, capturing the complete envelope for the audit
// trail: prior Amazon state (GET before write, enables revert), the live
// request, the full response, every status transition, and any error.
//
// Never throws to its caller — all outcomes are persisted on the submission
// row and recorded as audit events, then a response envelope is returned.
const env = require('../config/env');
const submissions = require('./submissions');
const listingsItems = require('./spapi/listingsItems');
const feeds = require('./spapi/feeds');
const audit = require('./audit/auditEvents');
const reconciliation = require('./reconciliation');
const { scrubObject } = require('../lib/safeError');

// Schedule over-time reconciliation read-backs once a write has APPLIED.
// Best-effort: a scheduling failure must never break the push it follows.
function scheduleReconciliation(submission) {
  if (!env.RECON_ENABLED) return;
  if (!submission || submission.status !== 'APPLIED') return;
  try {
    const res = reconciliation.enqueueForSubmission(submission);
    if (res.scheduled) audit.record({ event: 'reconcile_scheduled', submissionUuid: submission.submission_uuid, actor: 'system', details: { checks: res.scheduled } });
  } catch (err) {
    audit.record({ event: 'reconcile_schedule_error', submissionUuid: submission.submission_uuid, actor: 'system', details: { message: err.message } });
  }
}

function parse(json) {
  if (json == null) return null;
  try { return JSON.parse(json); } catch { return json; }
}

// Build a concise, human-readable summary from Amazon's issue list so the
// submission's error_message carries the actual cause at a glance (the full
// structured issues are persisted separately in issues_json).
function summarizeIssues(issues) {
  if (!Array.isArray(issues) || !issues.length) return null;
  const parts = issues.slice(0, 3).map((i) => {
    if (!i) return null;
    if (typeof i === 'string') return i;
    const code = i.code ? `${i.code}: ` : '';
    const attrs = Array.isArray(i.attributeNames) && i.attributeNames.length ? ` [${i.attributeNames.join(', ')}]` : '';
    return `${code}${i.message || ''}${attrs}`.trim();
  }).filter(Boolean);
  if (!parts.length) return null;
  const more = issues.length > parts.length ? ` (+${issues.length - parts.length} more)` : '';
  return (parts.join(' | ') + more).slice(0, 1000);
}

// Map Amazon's Listings Items status to our submission status.
function statusFromAmazon(envelope) {
  const s = String(envelope && envelope.status || '').toUpperCase();
  if (s === 'ACCEPTED') return 'APPLIED';
  if (s === 'VALID') return 'APPLIED';
  if (s === 'INVALID') return 'FAILED';
  return 'SUBMITTED';
}

// Capture the current Amazon listing for the changed attributes BEFORE we
// write, so a later revert can restore them. Best-effort: a failure here is
// logged but does not block the push.
async function capturePriorState(submission) {
  if (!submission.sku || !submission.vendor_code) return null;
  try {
    const item = await listingsItems.getItem({
      sellerId: submission.vendor_code,
      sku: submission.sku,
      marketplaceCode: submission.marketplace_code,
      includedData: ['attributes', 'summaries', 'issues']
    });
    return item || null;
  } catch (err) {
    audit.record({ event: 'prior_state_capture_failed', submissionUuid: submission.submission_uuid, actor: 'system', details: { message: err.message } });
    return null;
  }
}

async function forwardPatch(submission) {
  const body = parse(submission.request_body_json) || {};
  const prior = await capturePriorState(submission);
  if (prior) {
    submissions.update(submission.submission_uuid, { prior_state_json: prior });
    audit.record({ event: 'prior_state_captured', submissionUuid: submission.submission_uuid, actor: 'system', details: { hasAttributes: !!(prior && prior.attributes) } });
  }

  audit.record({
    event: 'spapi_request',
    submissionUuid: submission.submission_uuid,
    actor: 'system',
    details: { operation: 'patchItem', asin: submission.asin, sellerId: submission.vendor_code, sku: submission.sku, marketplace: submission.marketplace_code, productType: body.productType, patchCount: Array.isArray(body.patches) ? body.patches.length : 0 }
  });

  const envelope = await listingsItems.patchItem({
    sellerId: submission.vendor_code,
    sku: submission.sku,
    marketplaceCode: submission.marketplace_code,
    productType: body.productType,
    patches: body.patches,
    mode: null
  });

  const status = statusFromAmazon(envelope);
  const issues = (envelope && envelope.issues) || [];
  submissions.update(submission.submission_uuid, {
    status,
    amazon_response_json: envelope,
    issues_json: issues,
    error_message: status === 'FAILED'
      ? (summarizeIssues(issues) || 'Amazon returned INVALID — see issues')
      : null
  });
  audit.record({ event: 'spapi_response', submissionUuid: submission.submission_uuid, actor: 'system', details: scrubObject({ status, submissionId: envelope && envelope.submissionId, issues }) });
  const settled = submissions.getByUuid(submission.submission_uuid);
  scheduleReconciliation(settled);
  return settled;
}

async function forwardFeed(submission) {
  const body = parse(submission.request_body_json) || {};
  audit.record({ event: 'spapi_request', submissionUuid: submission.submission_uuid, actor: 'system', details: { operation: 'submitJsonListingsFeed', marketplace: submission.marketplace_code } });

  const result = await feeds.submitJsonListingsFeed({ marketplaceCode: submission.marketplace_code, payload: body.payload });
  submissions.update(submission.submission_uuid, {
    status: 'IN_PROGRESS',
    feed_id: result.feedId,
    feed_document_id: result.feedDocumentId,
    amazon_response_json: result
  });
  audit.record({ event: 'feed_submitted', submissionUuid: submission.submission_uuid, actor: 'system', details: { feedId: result.feedId } });
  return submissions.getByUuid(submission.submission_uuid);
}

// Forward one submission to Amazon. Honours the master kill switch as a
// last line of defence (routes also check it).
async function forward(submission) {
  if (!env.SPAPI_WRITES_ENABLED) {
    submissions.update(submission.submission_uuid, { status: 'BLOCKED', error_message: 'SPAPI_WRITES_ENABLED is false (kill switch)' });
    audit.record({ event: 'write_blocked_kill_switch', submissionUuid: submission.submission_uuid, actor: 'system' });
    return submissions.getByUuid(submission.submission_uuid);
  }
  try {
    if (submission.operation === 'submitJsonListingsFeed') return await forwardFeed(submission);
    return await forwardPatch(submission);
  } catch (err) {
    // Persist a structured diagnostic blob (not just a short string) so the
    // root cause survives for later analysis: HTTP status, error code, the raw
    // SP-API response body, and the message.
    const message = (err && err.message ? err.message : String(err)).slice(0, 1000);
    const errorBlob = {
      error: (err && err.responseText) || message,
      message,
      status: (err && err.status) || null,
      code: (err && err.code) || null,
      responseText: (err && err.responseText) || null
    };
    submissions.update(submission.submission_uuid, {
      status: 'FAILED',
      error_message: message,
      amazon_response_json: scrubObject(errorBlob)
    });
    audit.record({ event: 'spapi_error', submissionUuid: submission.submission_uuid, actor: 'system', details: { message: err && err.message, status: err && err.status, code: err && err.code } });
    return submissions.getByUuid(submission.submission_uuid);
  }
}

// Build a client-facing response envelope from a submission row.
function buildResponseFromSubmission(submission) {
  const amazon = parse(submission.amazon_response_json);
  const issues = parse(submission.issues_json) || (amazon && amazon.issues) || [];
  return {
    submissionId: submission.submission_uuid,
    jobId: submission.job_uuid,
    status: submission.status,
    operation: submission.operation,
    marketplaceCode: submission.marketplace_code,
    asin: submission.asin,
    sku: submission.sku,
    vendorCode: submission.vendor_code,
    feedId: submission.feed_id || null,
    issues,
    amazon,
    errorMessage: submission.error_message || null
  };
}

module.exports = { forward, forwardPatch, forwardFeed, buildResponseFromSubmission, capturePriorState, statusFromAmazon, scheduleReconciliation, summarizeIssues };
