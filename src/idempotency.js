// Idempotency cache backed by push_submissions.idempotency_key (UNIQUE).
// When a caller retries with the same Idempotency-Key, we return the
// original response instead of re-issuing to Amazon, so a transient
// client-side retry can't double-write.
const submissions = require('./submissions');

function buildReplayResponse(submission) {
  let amazon = null;
  if (submission.amazon_response_json) {
    try { amazon = JSON.parse(submission.amazon_response_json); } catch { amazon = { rawText: submission.amazon_response_json }; }
  }
  const base = { submissionId: submission.submission_uuid, status: submission.status, replayed: true };
  if (submission.operation === 'patchItem' || submission.operation === 'patchItem:dry-run') {
    return { ...base, issues: (amazon && amazon.issues) || [], amazon };
  }
  return { ...base, ...(amazon || {}) };
}

function lookupReplay(idempotencyKey) {
  if (!idempotencyKey) return null;
  const submission = submissions.getByIdempotencyKey(idempotencyKey);
  if (!submission) return null;
  return { submission, response: buildReplayResponse(submission) };
}

module.exports = { lookupReplay, buildReplayResponse };
