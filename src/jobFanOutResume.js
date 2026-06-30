// Boot-time recovery for jobs interrupted mid-fan-out. The push routes persist
// the full target list on the parent job row; on startup we skip targets that
// already have a child submission and continue the loop for the rest.
const { getDb } = require('./db');
const jobs = require('./jobs');
const submissions = require('./submissions');
const audit = require('./audit/auditEvents');
const { recomputeJobStatus } = require('./jobOrchestrator');

function getPushHandlers() {
  return require('../routes/push').pushHandlers;
}

function targetKeyFromTarget(target) {
  if (target.idempotencyKey) return `idem:${target.idempotencyKey}`;
  const asin = String(target.asin || '').toUpperCase();
  const mp = String(target.marketplaceCode || '').toUpperCase();
  const sku = String(target.sku || '').trim();
  return `coord:${asin}|${mp}|${sku}`;
}

function targetKeyFromSubmission(sub) {
  if (sub.idempotency_key) return `idem:${sub.idempotency_key}`;
  const asin = String(sub.asin || '').toUpperCase();
  const mp = String(sub.marketplace_code || '').toUpperCase();
  const sku = String(sub.sku || '').trim();
  return `coord:${asin}|${mp}|${sku}`;
}

function parseStoredPayload(job) {
  const p = job && job.request_payload;
  if (!p || !Array.isArray(p.targets) || !p.targets.length) return null;
  if (!p.scope || !p.operation) return null;
  return p;
}

function hasResumableTargets(requestPayloadJson) {
  if (!requestPayloadJson) return false;
  try {
    const p = JSON.parse(requestPayloadJson);
    return !!(p && Array.isArray(p.targets) && p.targets.length && p.scope && p.operation);
  } catch {
    return false;
  }
}

function listIncompleteJobs() {
  return getDb().prepare(`
    SELECT j.*,
      (SELECT COUNT(*) FROM push_submissions s WHERE s.job_uuid = j.job_uuid) AS submission_count
    FROM push_jobs j
    WHERE j.status IN ('pending', 'running')
      AND j.target_count > (SELECT COUNT(*) FROM push_submissions s WHERE s.job_uuid = j.job_uuid)
    ORDER BY j.id ASC
  `).all();
}

async function resumeOneJob(jobRow) {
  const job = jobs.getByUuid(jobRow.job_uuid);
  if (!job) return { skipped: true, reason: 'not_found' };

  const payload = parseStoredPayload(job);
  if (!payload) return { skipped: true, reason: 'no_stored_targets' };

  const existing = submissions.listForJob(job.job_uuid);
  const done = new Set(existing.map(targetKeyFromSubmission));
  const remaining = payload.targets.filter((t) => !done.has(targetKeyFromTarget(t)));

  if (!remaining.length) {
    recomputeJobStatus(job.job_uuid);
    return { skipped: true, reason: 'already_complete' };
  }

  if (job.status === 'pending') {
    jobs.update(job.job_uuid, {
      status: 'running',
      started_at: job.started_at || new Date().toISOString()
    });
  }

  audit.record({
    event: 'job_fanout_resumed_at_boot',
    jobUuid: job.job_uuid,
    actor: 'system',
    details: {
      remaining: remaining.length,
      total: payload.targets.length,
      alreadyDone: existing.length
    }
  });

  const { handleTarget, handlePackageTarget, loadContentMatchAsinGate } = getPushHandlers();
  const req = { caller: job.caller, headers: {}, query: {}, body: {} };
  const parsed = {
    scope: payload.scope,
    operation: payload.operation,
    fieldNames: payload.fieldNames || null,
    label: payload.label || null,
    comment: payload.comment || null,
    allowUnknownAttributes: !!payload.allowUnknownAttributes,
    targets: remaining
  };
  const isPackage = payload.path === 'package' || String(job.kind).startsWith('package:');
  const listingAppAsinGate = await loadContentMatchAsinGate(parsed.scope);

  let processed = 0;
  for (const target of remaining) {
    if (isPackage) {
      await handlePackageTarget({ req, jobUuid: job.job_uuid, parsed, target, listingAppAsinGate });
    } else {
      await handleTarget({ req, jobUuid: job.job_uuid, parsed, target, listingAppAsinGate });
    }
    processed += 1;
  }

  recomputeJobStatus(job.job_uuid);
  return { resumed: true, processed };
}

async function resumeIncompleteFanOuts() {
  const rows = listIncompleteJobs();
  const summary = { scanned: rows.length, resumed: 0, skipped: 0, processedTargets: 0 };
  for (const row of rows) {
    try {
      const result = await resumeOneJob(row);
      if (result.resumed) {
        summary.resumed += 1;
        summary.processedTargets += result.processed || 0;
      } else {
        summary.skipped += 1;
      }
    } catch (err) {
      console.warn(`[jobFanOutResume] failed for ${row.job_uuid}: ${err.message}`);
      summary.skipped += 1;
    }
  }
  return summary;
}

module.exports = {
  listIncompleteJobs,
  resumeIncompleteFanOuts,
  resumeOneJob,
  targetKeyFromTarget,
  targetKeyFromSubmission,
  hasResumableTargets
};
