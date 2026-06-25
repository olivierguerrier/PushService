// push_submissions accessors — one row per (sku x marketplace) write. The
// row is the source of truth for a submission's lifecycle; audit_events
// records the immutable history alongside it.
const { getDb } = require('./db');

function insert({
  submissionUuid, jobUuid = null, idempotencyKey = null, caller, scope, operation,
  vendorCode = null, sku = null, parentSku = null, asin = null, itemNumber = null, marketplaceCode = null,
  productType = null, sourceHash = null, sourceSnapshot = null, requestBody, priorState = null,
  status, approvalToken = null, revertOfUuid = null, payloadOrigin = 'built', rawPackage = null,
  flyappMeta = null, approverComment = null, resolvesUuid = null
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO push_submissions (
      submission_uuid, job_uuid, idempotency_key, caller, scope, operation,
      vendor_code, sku, parent_sku, asin, item_number, marketplace_code, product_type,
      source_hash, source_snapshot_json, request_body_json, prior_state_json,
      status, approval_token, revert_of_uuid, payload_origin, raw_package_json,
      flyapp_meta_json, approver_comment, resolves_uuid
    ) VALUES (
      @submission_uuid, @job_uuid, @idempotency_key, @caller, @scope, @operation,
      @vendor_code, @sku, @parent_sku, @asin, @item_number, @marketplace_code, @product_type,
      @source_hash, @source_snapshot_json, @request_body_json, @prior_state_json,
      @status, @approval_token, @revert_of_uuid, @payload_origin, @raw_package_json,
      @flyapp_meta_json, @approver_comment, @resolves_uuid
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
    parent_sku: parentSku,
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
    flyapp_meta_json: flyappMeta == null ? null : (typeof flyappMeta === 'string' ? flyappMeta : JSON.stringify(flyappMeta)),
    approver_comment: approverComment == null || approverComment === '' ? null : String(approverComment),
    resolves_uuid: resolvesUuid || null
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
  'approved_by', 'approved_at', 'error_message', 'feed_id', 'feed_document_id',
  'effective_sku', 'package_level_readded', 'poll_error_count'
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

// Recent submissions, newest first. Supports keyset (cursor) pagination via
// `beforeId`: pass the `id` of the last row from the previous page to fetch the
// next, older batch. Keyset is used instead of OFFSET so concurrent inserts
// (which always land at the top with a higher id) can't shift the window and
// cause rows to be skipped or duplicated across pages.
function listRecent({ limit = 200, beforeId = null } = {}) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const cursor = beforeId == null ? null : Number(beforeId);
  const cols = `id, submission_uuid, job_uuid, caller, scope, operation, vendor_code, sku,
           parent_sku, effective_sku, asin, item_number, marketplace_code, status,
           approved_by, approved_at,
           error_message, issues_json, amazon_response_json, created_at, updated_at,
           flyapp_meta_json, approver_comment`;
  if (cursor != null && Number.isFinite(cursor)) {
    return getDb().prepare(`
      SELECT ${cols}
      FROM push_submissions WHERE id < ? ORDER BY id DESC LIMIT ${cap}
    `).all(cursor);
  }
  return getDb().prepare(`
    SELECT ${cols}
    FROM push_submissions ORDER BY id DESC LIMIT ${cap}
  `).all();
}

function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM push_submissions').get().n;
}

function maxId() {
  return getDb().prepare('SELECT COALESCE(MAX(id), 0) AS m FROM push_submissions').get().m;
}

// Incremental console refresh: rows newer than `afterId`, plus already-loaded rows
// whose updated_at moved past `updatedSince`. Merged and deduped by id, newest first.
function listChanges({ afterId, updatedSince = null, limit = 100 } = {}) {
  const after = Number(afterId);
  if (!Number.isFinite(after)) return [];
  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));
  const cols = `id, submission_uuid, job_uuid, caller, scope, operation, vendor_code, sku,
           parent_sku, effective_sku, asin, item_number, marketplace_code, status,
           approved_by, approved_at,
           error_message, issues_json, amazon_response_json, created_at, updated_at,
           flyapp_meta_json, approver_comment`;
  const byId = new Map();
  const newer = getDb().prepare(`
    SELECT ${cols} FROM push_submissions WHERE id > ? ORDER BY id DESC LIMIT ${cap}
  `).all(after);
  for (const r of newer) byId.set(r.id, r);
  if (updatedSince) {
    const remaining = cap - byId.size;
    if (remaining > 0) {
      const updated = getDb().prepare(`
        SELECT ${cols} FROM push_submissions
        WHERE id <= ? AND updated_at > ?
        ORDER BY updated_at DESC, id DESC LIMIT ${remaining}
      `).all(after, updatedSince);
      for (const r of updated) byId.set(r.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

function listForJob(jobUuid) {
  return getDb().prepare('SELECT * FROM push_submissions WHERE job_uuid = ? ORDER BY id ASC').all(jobUuid);
}

// Accepted submissions for an ASIN, used to repurpose attribute values from
// other records of the same ASIN (different vendor code / SKU / marketplace).
// Only APPLIED rows are returned (their attributes actually reached Amazon).
// Ranked so a row matching BOTH the target marketplace and product type wins,
// then same marketplace, then same product type, then any — most recent first
// within each tier — so the closest, freshest sibling is consulted first.
function listAcceptedByAsin(asin, { excludeUuid = null, marketplaceCode = null, productType = null, limit = 50 } = {}) {
  if (!asin) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  return getDb().prepare(`
    SELECT submission_uuid, vendor_code, sku, asin, marketplace_code, product_type,
           request_body_json, prior_state_json, updated_at
    FROM push_submissions
    WHERE asin = ? AND status = 'APPLIED'
      AND (? IS NULL OR submission_uuid != ?)
    ORDER BY
      (CASE WHEN marketplace_code = ? THEN 0 ELSE 1 END),
      (CASE WHEN product_type = ? THEN 0 ELSE 1 END),
      id DESC
    LIMIT ${cap}
  `).all(asin, excludeUuid, excludeUuid, marketplaceCode, productType);
}

// Every submission that carries an Amazon error/diagnostic: explicit FAILED
// rows, anything with an error_message, or a non-empty issues_json (which may
// also hold WARNING-level diagnostics worth exporting). Includes the raw
// issues_json / amazon_response_json blobs so callers can distil full codes.
function listErrors({ limit = 1000 } = {}) {
  const cap = Math.max(1, Math.min(5000, Number(limit) || 1000));
  return getDb().prepare(`
    SELECT submission_uuid, job_uuid, caller, scope, operation, vendor_code, sku,
           parent_sku, effective_sku, asin, item_number, marketplace_code, product_type,
           status, approved_by, approved_at, error_message, issues_json,
           amazon_response_json, feed_id, feed_document_id, archived_at, archived_by,
           created_at, updated_at
    FROM push_submissions
    WHERE status = 'FAILED'
       OR (error_message IS NOT NULL AND error_message != '')
       OR (issues_json IS NOT NULL AND issues_json != '' AND issues_json != '[]')
    ORDER BY id DESC LIMIT ${cap}
  `).all();
}

// Archive (or un-archive) one error submission. An archived submission is
// skipped by the AI error resolver — no single or batch AI fix is assessed for
// it — but it stays visible in the Errors tab. `archived` toggles the state;
// `actor` stamps who did it (cleared on un-archive).
function setArchived(uuid, { archived = true, actor = null } = {}) {
  const db = getDb();
  if (archived) {
    db.prepare(`
      UPDATE push_submissions
      SET archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now')
      WHERE submission_uuid = ?
    `).run(actor, uuid);
  } else {
    db.prepare(`
      UPDATE push_submissions
      SET archived_at = NULL, archived_by = NULL, updated_at = datetime('now')
      WHERE submission_uuid = ?
    `).run(uuid);
  }
  return getByUuid(uuid);
}

module.exports = {
  insert, getByUuid, getByIdempotencyKey, getByApprovalToken, update,
  listRecent, listChanges, count, maxId, listForJob, listAcceptedByAsin, listErrors, setArchived
};
