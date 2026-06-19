// Re-submit a failed (or kill-switch-blocked) submission with its stored
// request_body_json — the operator path for "upstream is fixed, push again".
const submissions = require('./submissions');
const forwarder = require('./forwarder');
const audit = require('./audit/auditEvents');
const { recomputeJobStatus } = require('./jobOrchestrator');

const RETRYABLE = new Set(['FAILED', 'BLOCKED']);

function isRetryable(submission) {
  if (!submission) return false;
  if (!RETRYABLE.has(submission.status)) return false;
  return !!submission.request_body_json;
}

function prepareForRetry(uuid) {
  submissions.update(uuid, {
    status: 'IN_PROGRESS',
    error_message: null,
    issues_json: [],
    amazon_response_json: null,
    package_level_readded: 0,
    feed_id: null,
    feed_document_id: null,
    poll_error_count: 0,
    effective_sku: null
  });
}

async function retrySubmission(uuid, { actor = 'system' } = {}) {
  const submission = submissions.getByUuid(uuid);
  if (!submission) return { ok: false, reason: 'submission_not_found' };
  if (!isRetryable(submission)) return { ok: false, reason: 'not_retryable', status: submission.status };

  prepareForRetry(uuid);
  audit.record({
    event: 'error_retry',
    submissionUuid: uuid,
    jobUuid: submission.job_uuid || null,
    actor,
    details: { operation: submission.operation, priorStatus: submission.status }
  });

  const fresh = submissions.getByUuid(uuid);
  const settled = await forwarder.forward(fresh);
  if (settled.job_uuid) recomputeJobStatus(settled.job_uuid);

  return {
    ok: true,
    submissionUuid: uuid,
    status: settled.status,
    errorMessage: settled.error_message || null,
    issues: forwarder.buildResponseFromSubmission(settled).issues
  };
}

module.exports = { isRetryable, prepareForRetry, retrySubmission };
