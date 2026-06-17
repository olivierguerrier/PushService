// Shared job bookkeeping used by both the push route (synchronous fan-out)
// and the poller (async feed settling). Recomputes a parent job's rollup
// counts/status from its child submissions.
const jobs = require('./jobs');
const submissions = require('./submissions');
const audit = require('./audit/auditEvents');

const TERMINAL_OK = new Set(['APPLIED']);
const TERMINAL_FAIL = new Set(['FAILED', 'REJECTED', 'EXPIRED', 'BLOCKED']);
const PENDING = new Set(['PENDING_APPROVAL', 'IN_PROGRESS', 'SUBMITTED']);

function recomputeJobStatus(jobUuid) {
  if (!jobUuid) return null;
  const job = jobs.getByUuid(jobUuid);
  if (!job) return null;
  const rows = submissions.listForJob(jobUuid);
  let ok = 0;
  let failed = 0;
  let pending = 0;
  for (const r of rows) {
    if (TERMINAL_OK.has(r.status)) ok += 1;
    else if (TERMINAL_FAIL.has(r.status)) failed += 1;
    else if (PENDING.has(r.status)) pending += 1;
  }
  const targetTotal = Math.max(Number(job.target_count) || 0, rows.length);
  const fanOutComplete = rows.length >= targetTotal && targetTotal > 0;
  let status = 'running';
  if (pending === 0 && fanOutComplete) {
    if (failed === 0 && ok > 0) status = 'completed';
    else if (ok === 0) status = 'failed';
    else status = 'partial';
  }
  const fields = { ok_count: ok, failed_count: failed, target_count: targetTotal, status };
  if (status !== 'running' && !job.completed_at) fields.completed_at = new Date().toISOString();
  const updated = jobs.update(jobUuid, fields);
  if (status !== job.status && status !== 'running') {
    audit.record({ event: 'job_settled', jobUuid, actor: 'system', details: { status, ok, failed, total: rows.length } });
  }
  return updated;
}

module.exports = { recomputeJobStatus };
