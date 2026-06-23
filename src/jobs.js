// push_jobs accessors — one parent row per user/trigger "push" action that
// may fan out to N submissions (e.g. one ASIN broadcast to several
// marketplaces). Includes boot-time recovery for jobs left mid-flight by a
// crash, ported from FlyApp's publishJobs.recoverStuckJobs.
const { getDb } = require('./db');
const audit = require('./audit/auditEvents');

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function safeJson(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}

function create({
  jobUuid, kind, caller = null, requestedBy = null, asin = null, itemNumber = null,
  marketplaceCode = null, productType = null, label = null, requestPayload = null,
  fieldNames = null, targetCount = 0
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO push_jobs (
      job_uuid, kind, caller, requested_by, asin, item_number, marketplace_code,
      product_type, label, request_payload_json, field_names_json, target_count, status
    ) VALUES (
      @job_uuid, @kind, @caller, @requested_by, @asin, @item_number, @marketplace_code,
      @product_type, @label, @request_payload_json, @field_names_json, @target_count, 'pending'
    )
  `).run({
    job_uuid: jobUuid,
    kind,
    caller,
    requested_by: requestedBy,
    asin,
    item_number: itemNumber,
    marketplace_code: marketplaceCode,
    product_type: productType,
    label,
    request_payload_json: requestPayload == null ? null : JSON.stringify(requestPayload),
    field_names_json: Array.isArray(fieldNames) ? JSON.stringify(fieldNames) : null,
    target_count: Number(targetCount) || 0
  });
  return getByUuid(jobUuid);
}

const UPDATABLE = ['status', 'started_at', 'completed_at', 'ok_count', 'failed_count', 'target_count', 'error_message', 'result_summary_json'];

function update(jobUuid, fields = {}) {
  const db = getDb();
  const sets = [];
  const vals = [];
  for (const k of UPDATABLE) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      const v = fields[k];
      vals.push((k.endsWith('_json') && v != null && typeof v !== 'string') ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return getByUuid(jobUuid);
  sets.push("updated_at = datetime('now')");
  vals.push(jobUuid);
  db.prepare(`UPDATE push_jobs SET ${sets.join(', ')} WHERE job_uuid = ?`).run(...vals);
  return getByUuid(jobUuid);
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    request_payload: safeJson(row.request_payload_json),
    field_names: safeJson(row.field_names_json),
    result_summary: safeJson(row.result_summary_json)
  };
}

function getByUuid(jobUuid) {
  return hydrate(getDb().prepare('SELECT * FROM push_jobs WHERE job_uuid = ?').get(jobUuid));
}

function buildWhere({
  status = null, kind = null, asin = null, marketplaceCode = null, sinceIso = null,
  search = null, beforeId = null
} = {}) {
  const conds = [];
  const params = [];
  if (status) { conds.push('status = ?'); params.push(status); }
  if (kind) { conds.push('kind = ?'); params.push(kind); }
  if (asin) { conds.push('asin = ?'); params.push(String(asin).toUpperCase()); }
  if (marketplaceCode) { conds.push('marketplace_code = ?'); params.push(String(marketplaceCode).toUpperCase()); }
  if (sinceIso) { conds.push('created_at >= ?'); params.push(sinceIso); }
  const q = search != null ? String(search).trim() : '';
  if (q) {
    const term = `%${q.toLowerCase()}%`;
    conds.push(`(
      LOWER(job_uuid) LIKE ? OR
      LOWER(COALESCE(asin, '')) LIKE ? OR
      LOWER(COALESCE(caller, '')) LIKE ? OR
      LOWER(COALESCE(kind, '')) LIKE ? OR
      LOWER(COALESCE(label, '')) LIKE ? OR
      LOWER(COALESCE(item_number, '')) LIKE ? OR
      LOWER(COALESCE(marketplace_code, '')) LIKE ? OR
      LOWER(COALESCE(product_type, '')) LIKE ? OR
      LOWER(COALESCE(status, '')) LIKE ? OR
      LOWER(COALESCE(requested_by, '')) LIKE ? OR
      LOWER(COALESCE(field_names_json, '')) LIKE ?
    )`);
    for (let i = 0; i < 11; i++) params.push(term);
  }
  if (beforeId != null && Number.isFinite(Number(beforeId))) {
    conds.push('id < ?');
    params.push(Number(beforeId));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return { where, params };
}

function list({
  status = null, kind = null, asin = null, marketplaceCode = null, sinceIso = null,
  search = null, beforeId = null, limit = 100
} = {}) {
  const db = getDb();
  const { where, params } = buildWhere({ status, kind, asin, marketplaceCode, sinceIso, search, beforeId });
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`SELECT * FROM push_jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ${cap}`).all(...params).map(hydrate);
}

function count(opts = {}) {
  const { where, params } = buildWhere(opts);
  return getDb().prepare(`SELECT COUNT(*) AS n FROM push_jobs ${where}`).get(...params).n;
}

// Walk the full job history in keyset batches (newest first). Used by CSV export
// and any caller that needs every row matching the filter, not just one page.
function listAll({ search = null, maxRows = 100000 } = {}) {
  const cap = Math.max(1, Number(maxRows) || 100000);
  const batchSize = 500;
  const all = [];
  let beforeId = null;
  while (all.length < cap) {
    const batch = list({ search, beforeId, limit: batchSize });
    if (!batch.length) break;
    all.push(...batch);
    beforeId = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }
  return all.slice(0, cap);
}

// Close only legacy jobs whose fan-out was interrupted before every target
// received a submission row AND whose stored request no longer has the target
// list needed to resume. Jobs with a full set of child rows stay open — boot
// recovery re-forwards any IN_PROGRESS children and recomputes the parent rollup.
function recoverStuckJobs({ staleAfterMinutes = 15 } = {}) {
  const { recomputeJobStatus } = require('./jobOrchestrator');
  const { hasResumableTargets } = require('./jobFanOutResume');
  const db = getDb();
  const cutoffIso = new Date(Date.now() - staleAfterMinutes * 60 * 1000).toISOString();
  const stuck = db.prepare(`
    SELECT j.job_uuid, j.status, j.ok_count, j.failed_count, j.target_count, j.started_at, j.created_at,
           j.request_payload_json,
           (SELECT COUNT(*) FROM push_submissions s WHERE s.job_uuid = j.job_uuid) AS submission_count
    FROM push_jobs j
    WHERE j.status IN ('pending', 'running') AND COALESCE(j.started_at, j.created_at) < ?
  `).all(cutoffIso);
  const summary = { scanned: stuck.length, recovered: 0, recomputed: 0, leftOpen: 0 };
  for (const row of stuck) {
    const submissionCount = Number(row.submission_count) || 0;
    const target = Number(row.target_count) || 0;
    if (submissionCount >= target) {
      try {
        recomputeJobStatus(row.job_uuid);
        summary.recomputed += 1;
      } catch (err) {
        console.warn(`[jobs] failed to recompute job ${row.job_uuid}: ${err.message}`);
      }
      continue;
    }
    if (hasResumableTargets(row.request_payload_json)) {
      try {
        recomputeJobStatus(row.job_uuid);
        summary.leftOpen += 1;
      } catch (err) {
        console.warn(`[jobs] failed to recompute resumable job ${row.job_uuid}: ${err.message}`);
      }
      continue;
    }
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'APPLIED' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status IN ('FAILED', 'REJECTED', 'EXPIRED', 'BLOCKED') THEN 1 ELSE 0 END) AS failed
      FROM push_submissions WHERE job_uuid = ?
    `).get(row.job_uuid);
    const ok = Number(counts && counts.ok) || 0;
    const failed = Number(counts && counts.failed) || 0;
    const newStatus = ok > 0 ? 'partial' : 'failed';
    const remaining = Math.max(0, target - ok - failed);
    try {
      update(row.job_uuid, {
        status: newStatus,
        failed_count: failed + remaining,
        completed_at: new Date().toISOString(),
        error_message: `Recovered at boot: process died mid-fan-out (was '${row.status}', ${submissionCount}/${target} targets).`
      });
      audit.record({ event: 'job_recovered_at_boot', jobUuid: row.job_uuid, actor: 'system', details: { previous_status: row.status, new_status: newStatus, submission_count: submissionCount, target_count: target } });
      summary.recovered += 1;
    } catch (err) {
      console.warn(`[jobs] failed to recover stuck job ${row.job_uuid}: ${err.message}`);
    }
  }
  return summary;
}

async function recoverStuckJobsAsync({ staleAfterMinutes = 15, batchSize = 25 } = {}) {
  const { recomputeJobStatus } = require('./jobOrchestrator');
  const { hasResumableTargets } = require('./jobFanOutResume');
  const db = getDb();
  const cutoffIso = new Date(Date.now() - staleAfterMinutes * 60 * 1000).toISOString();
  const stuck = db.prepare(`
    SELECT j.job_uuid, j.status, j.ok_count, j.failed_count, j.target_count, j.started_at, j.created_at,
           j.request_payload_json,
           (SELECT COUNT(*) FROM push_submissions s WHERE s.job_uuid = j.job_uuid) AS submission_count
    FROM push_jobs j
    WHERE j.status IN ('pending', 'running') AND COALESCE(j.started_at, j.created_at) < ?
  `).all(cutoffIso);
  const summary = { scanned: stuck.length, recovered: 0, recomputed: 0, leftOpen: 0 };
  for (let i = 0; i < stuck.length; i++) {
    const row = stuck[i];
    const submissionCount = Number(row.submission_count) || 0;
    const target = Number(row.target_count) || 0;
    if (submissionCount >= target) {
      try {
        recomputeJobStatus(row.job_uuid);
        summary.recomputed += 1;
      } catch (err) {
        console.warn(`[jobs] failed to recompute job ${row.job_uuid}: ${err.message}`);
      }
      if ((i + 1) % batchSize === 0) await yieldToEventLoop();
      continue;
    }
    if (hasResumableTargets(row.request_payload_json)) {
      try {
        recomputeJobStatus(row.job_uuid);
        summary.leftOpen += 1;
      } catch (err) {
        console.warn(`[jobs] failed to recompute resumable job ${row.job_uuid}: ${err.message}`);
      }
      if ((i + 1) % batchSize === 0) await yieldToEventLoop();
      continue;
    }
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'APPLIED' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status IN ('FAILED', 'REJECTED', 'EXPIRED', 'BLOCKED') THEN 1 ELSE 0 END) AS failed
      FROM push_submissions WHERE job_uuid = ?
    `).get(row.job_uuid);
    const ok = Number(counts && counts.ok) || 0;
    const failed = Number(counts && counts.failed) || 0;
    const newStatus = ok > 0 ? 'partial' : 'failed';
    const remaining = Math.max(0, target - ok - failed);
    try {
      update(row.job_uuid, {
        status: newStatus,
        failed_count: failed + remaining,
        completed_at: new Date().toISOString(),
        error_message: `Recovered at boot: process died mid-fan-out (was '${row.status}', ${submissionCount}/${target} targets).`
      });
      audit.record({ event: 'job_recovered_at_boot', jobUuid: row.job_uuid, actor: 'system', details: { previous_status: row.status, new_status: newStatus, submission_count: submissionCount, target_count: target } });
      summary.recovered += 1;
    } catch (err) {
      console.warn(`[jobs] failed to recover stuck job ${row.job_uuid}: ${err.message}`);
    }
    if ((i + 1) % batchSize === 0) await yieldToEventLoop();
  }
  return summary;
}

module.exports = { create, update, getByUuid, list, listAll, count, recoverStuckJobs, recoverStuckJobsAsync };
