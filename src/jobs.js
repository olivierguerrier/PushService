// push_jobs accessors — one parent row per user/trigger "push" action that
// may fan out to N submissions (e.g. one ASIN broadcast to several
// marketplaces). Includes boot-time recovery for jobs left mid-flight by a
// crash, ported from FlyApp's publishJobs.recoverStuckJobs.
const { getDb } = require('./db');
const audit = require('./audit/auditEvents');

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

function list({ status = null, kind = null, asin = null, marketplaceCode = null, sinceIso = null, limit = 100 } = {}) {
  const db = getDb();
  const conds = [];
  const params = [];
  if (status) { conds.push('status = ?'); params.push(status); }
  if (kind) { conds.push('kind = ?'); params.push(kind); }
  if (asin) { conds.push('asin = ?'); params.push(String(asin).toUpperCase()); }
  if (marketplaceCode) { conds.push('marketplace_code = ?'); params.push(String(marketplaceCode).toUpperCase()); }
  if (sinceIso) { conds.push('created_at >= ?'); params.push(sinceIso); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`SELECT * FROM push_jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ${cap}`).all(...params).map(hydrate);
}

// Roll forward any pending/running job older than staleAfterMinutes — a
// crash mid-fan-out would otherwise pin the row "in flight" forever.
function recoverStuckJobs({ staleAfterMinutes = 15 } = {}) {
  const db = getDb();
  const cutoffIso = new Date(Date.now() - staleAfterMinutes * 60 * 1000).toISOString();
  const stuck = db.prepare(`
    SELECT job_uuid, status, ok_count, failed_count, target_count, started_at, created_at
    FROM push_jobs
    WHERE status IN ('pending', 'running') AND COALESCE(started_at, created_at) < ?
  `).all(cutoffIso);
  const summary = { scanned: stuck.length, recovered: 0 };
  for (const row of stuck) {
    const ok = Number(row.ok_count) || 0;
    const failed = Number(row.failed_count) || 0;
    const target = Number(row.target_count) || 0;
    const newStatus = ok > 0 ? 'partial' : 'failed';
    const remaining = Math.max(0, target - ok - failed);
    try {
      update(row.job_uuid, {
        status: newStatus,
        failed_count: failed + remaining,
        completed_at: new Date().toISOString(),
        error_message: `Recovered at boot: process died mid-job (was '${row.status}').`
      });
      audit.record({ event: 'job_recovered_at_boot', jobUuid: row.job_uuid, actor: 'system', details: { previous_status: row.status, new_status: newStatus } });
      summary.recovered += 1;
    } catch (err) {
      console.warn(`[jobs] failed to recover stuck job ${row.job_uuid}: ${err.message}`);
    }
  }
  return summary;
}

module.exports = { create, update, getByUuid, list, recoverStuckJobs };
