// push_submissions accessors — one row per (sku x marketplace) write. The
// row is the source of truth for a submission's lifecycle; audit_events
// records the immutable history alongside it.
const { getDb } = require('./db');

function insert({
  submissionUuid, jobUuid = null, idempotencyKey = null, caller, scope, operation,
  vendorCode = null, sku = null, asin = null, itemNumber = null, marketplaceCode = null,
  productType = null, sourceHash = null, sourceSnapshot = null, requestBody, priorState = null,
  status, approvalToken = null, revertOfUuid = null, payloadOrigin = 'built', rawPackage = null,
  flyappMeta = null
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO push_submissions (
      submission_uuid, job_uuid, idempotency_key, caller, scope, operation,
      vendor_code, sku, asin, item_number, marketplace_code, product_type,
      source_hash, source_snapshot_json, request_body_json, prior_state_json,
      status, approval_token, revert_of_uuid, payload_origin, raw_package_json,
      flyapp_meta_json
    ) VALUES (
      @submission_uuid, @job_uuid, @idempotency_key, @caller, @scope, @operation,
      @vendor_code, @sku, @asin, @item_number, @marketplace_code, @product_type,
      @source_hash, @source_snapshot_json, @request_body_json, @prior_state_json,
      @status, @approval_token, @revert_of_uuid, @payload_origin, @raw_package_json,
      @flyapp_meta_json
    )
  `).run({
    submission_uuid: submissionUuid,
    job_uuid: jobUuid,
    idempotency_key: idempotencyKey,
    caller,
    scope,
    operation,
    vendor_code: vendorCode,
    sku,
    asin,
    item_number: itemNumber,
    marketplace_code: marketplaceCode,
    product_type: productType,
    source_hash: sourceHash,
    source_snapshot_json: sourceSnapshot == null ? null : JSON.stringify(sourceSnapshot),
    request_body_json: JSON.stringify(requestBody),
    prior_state_json: priorState == null ? null : JSON.stringify(priorState),
    status,
    approval_token: approvalToken,
    revert_of_uuid: revertOfUuid,
    payload_origin: payloadOrigin || 'built',
    raw_package_json: rawPackage == null ? null : (typeof rawPackage === 'string' ? rawPackage : JSON.stringify(rawPackage)),
    flyapp_meta_json: flyappMeta == null ? null : (typeof flyappMeta === 'string' ? flyappMeta : JSON.stringify(flyappMeta))
  });
  return getByUuid(submissionUuid);
}

function getByUuid(uuid) {
  return getDb().prepare('SELECT * FROM push_submissions WHERE submission_uuid = ?').get(uuid);
}
function getByIdempotencyKey(key) {
  if (!key) return null;
  return getDb().prepare('SELECT * FROM push_submissions WHERE idempotency_key = ?').get(key);
}
function getByApprovalToken(token) {
  if (!token) return null;
  return getDb().prepare('SELECT * FROM push_submissions WHERE approval_token = ?').get(token);
}

const UPDATABLE = [
  'status', 'amazon_response_json', 'issues_json', 'prior_state_json',
  'approved_by', 'approved_at', 'error_message', 'feed_id', 'feed_document_id'
];

function update(uuid, fields = {}) {
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
  if (!sets.length) return getByUuid(uuid);
  sets.push("updated_at = datetime('now')");
  vals.push(uuid);
  db.prepare(`UPDATE push_submissions SET ${sets.join(', ')} WHERE submission_uuid = ?`).run(...vals);
  return getByUuid(uuid);
}

function listRecent({ limit = 200 } = {}) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  return getDb().prepare(`
    SELECT submission_uuid, job_uuid, caller, scope, operation, vendor_code, sku,
           asin, item_number, marketplace_code, status, approved_by, approved_at,
           error_message, issues_json, amazon_response_json, created_at, updated_at,
           flyapp_meta_json
    FROM push_submissions ORDER BY id DESC LIMIT ${cap}
  `).all();
}

function listForJob(jobUuid) {
  return getDb().prepare('SELECT * FROM push_submissions WHERE job_uuid = ? ORDER BY id ASC').all(jobUuid);
}

module.exports = { insert, getByUuid, getByIdempotencyKey, getByApprovalToken, update, listRecent, listForJob };
