// Boot-time recovery: resume submissions interrupted by a process stop and
// refresh parent job rollups. The approval queue is in-memory, so any
// QUEUED row or IN_PROGRESS row that never received a feed_id (patch mid-forward,
// or feed submit not yet persisted) must be re-enqueued on startup.
const { getDb } = require('./db');
const submissions = require('./submissions');
const approvalQueue = require('./approvalQueue');
const audit = require('./audit/auditEvents');
const { recomputeJobStatus } = require('./jobOrchestrator');

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Per-row audit events use a hash-chained SQLite transaction — fine for a
// handful of resumes, but thousands of sync writes block the event loop for
// minutes and freeze the operator UI. Bulk boot resume logs one summary event.
const BULK_RESUME_AUDIT_THRESHOLD = 50;

function listInterruptedForwards() {
  return getDb().prepare(`
    SELECT * FROM push_submissions
    WHERE status IN ('QUEUED', 'IN_PROGRESS') AND feed_id IS NULL
    ORDER BY id ASC
  `).all();
}

function resumeInterruptedForwards() {
  const rows = listInterruptedForwards();
  const summary = { scanned: rows.length, resumed: 0 };
  for (const row of rows) {
    audit.record({
      event: 'submission_resumed_at_boot',
      submissionUuid: row.submission_uuid,
      jobUuid: row.job_uuid,
      actor: 'system',
      details: { operation: row.operation }
    });
    approvalQueue.enqueue(row);
    summary.resumed += 1;
  }
  return summary;
}

async function resumeInterruptedForwardsAsync({ batchSize = 25 } = {}) {
  const rows = listInterruptedForwards();
  const summary = { scanned: rows.length, resumed: 0 };
  if (!rows.length) return summary;

  const bulk = rows.length > BULK_RESUME_AUDIT_THRESHOLD;
  if (bulk) {
    audit.record({
      event: 'boot_bulk_submission_resume',
      actor: 'system',
      details: { count: rows.length }
    });
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!bulk) {
      audit.record({
        event: 'submission_resumed_at_boot',
        submissionUuid: row.submission_uuid,
        jobUuid: row.job_uuid,
        actor: 'system',
        details: { operation: row.operation }
      });
    }
    approvalQueue.enqueue(row);
    summary.resumed += 1;
    if ((i + 1) % batchSize === 0) await yieldToEventLoop();
  }
  return summary;
}

function recomputeOpenJobs() {
  const openJobs = getDb().prepare(`
    SELECT job_uuid FROM push_jobs WHERE status IN ('pending', 'running')
  `).all();
  let recomputed = 0;
  for (const { job_uuid } of openJobs) {
    recomputeJobStatus(job_uuid);
    recomputed += 1;
  }
  return { recomputed };
}

async function recomputeOpenJobsAsync({ batchSize = 25 } = {}) {
  const openJobs = getDb().prepare(`
    SELECT job_uuid FROM push_jobs WHERE status IN ('pending', 'running')
  `).all();
  let recomputed = 0;
  for (let i = 0; i < openJobs.length; i++) {
    recomputeJobStatus(openJobs[i].job_uuid);
    recomputed += 1;
    if ((i + 1) % batchSize === 0) await yieldToEventLoop();
  }
  return { recomputed };
}

module.exports = {
  listInterruptedForwards,
  resumeInterruptedForwards,
  resumeInterruptedForwardsAsync,
  recomputeOpenJobs,
  recomputeOpenJobsAsync
};
