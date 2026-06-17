// ai_resolutions accessors — one latest LLM error-resolution proposal per
// FAILED submission. The proposal carries the model's diagnosis plus a
// corrected SP-API package; the operator reviews/edits/approves it in the
// console. Lifecycle: PROPOSED -> APPLIED | REJECTED (or FAILED when the
// model/validation could not produce a usable proposal).
const { getDb } = require('./db');

// Insert or replace the resolution for a submission (upsert on submission_uuid).
// `record` carries already-serialised-or-plain values; *_json fields accept
// objects and are JSON.stringified here for convenience.
function upsert(submissionUuid, record = {}) {
  const db = getDb();
  const payload = {
    submission_uuid: submissionUuid,
    status: record.status || 'PROPOSED',
    diagnosis: record.diagnosis == null ? null : String(record.diagnosis),
    root_cause: record.root_cause == null ? null : String(record.root_cause),
    confidence: Number.isFinite(record.confidence) ? Math.round(record.confidence) : null,
    resolvable: record.resolvable ? 1 : 0,
    operation: record.operation || null,
    proposed_package_json: jsonOrNull(record.proposed_package),
    changed_attr_names_json: jsonOrNull(record.changed_attr_names),
    unresolved_json: jsonOrNull(record.unresolved),
    warnings_json: jsonOrNull(record.warnings),
    validation_json: jsonOrNull(record.validation),
    model: record.model || null,
    input_hash: record.input_hash || null,
    error_message: record.error_message == null ? null : String(record.error_message).slice(0, 2000),
    applied_submission_uuid: record.applied_submission_uuid || null,
    reviewed_by: record.reviewed_by || null
  };
  db.prepare(`
    INSERT INTO ai_resolutions (
      submission_uuid, status, diagnosis, root_cause, confidence, resolvable,
      operation, proposed_package_json, changed_attr_names_json, unresolved_json,
      warnings_json, validation_json, model, input_hash, error_message,
      applied_submission_uuid, reviewed_by, updated_at
    ) VALUES (
      @submission_uuid, @status, @diagnosis, @root_cause, @confidence, @resolvable,
      @operation, @proposed_package_json, @changed_attr_names_json, @unresolved_json,
      @warnings_json, @validation_json, @model, @input_hash, @error_message,
      @applied_submission_uuid, @reviewed_by, datetime('now')
    )
    ON CONFLICT (submission_uuid) DO UPDATE SET
      status = excluded.status,
      diagnosis = excluded.diagnosis,
      root_cause = excluded.root_cause,
      confidence = excluded.confidence,
      resolvable = excluded.resolvable,
      operation = excluded.operation,
      proposed_package_json = excluded.proposed_package_json,
      changed_attr_names_json = excluded.changed_attr_names_json,
      unresolved_json = excluded.unresolved_json,
      warnings_json = excluded.warnings_json,
      validation_json = excluded.validation_json,
      model = excluded.model,
      input_hash = excluded.input_hash,
      error_message = excluded.error_message,
      applied_submission_uuid = excluded.applied_submission_uuid,
      reviewed_by = excluded.reviewed_by,
      updated_at = datetime('now')
  `).run(payload);
  return getBySubmission(submissionUuid);
}

// Mark an existing proposal's lifecycle without touching the proposal body.
function setStatus(submissionUuid, { status, reviewedBy = null, appliedSubmissionUuid = null } = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE ai_resolutions
    SET status = ?,
        reviewed_by = COALESCE(?, reviewed_by),
        applied_submission_uuid = COALESCE(?, applied_submission_uuid),
        updated_at = datetime('now')
    WHERE submission_uuid = ?
  `).run(status, reviewedBy, appliedSubmissionUuid, submissionUuid);
  return getBySubmission(submissionUuid);
}

function getBySubmission(submissionUuid) {
  if (!submissionUuid) return null;
  return getDb().prepare('SELECT * FROM ai_resolutions WHERE submission_uuid = ?').get(submissionUuid) || null;
}

// Map of submission_uuid -> { status, confidence, applied_submission_uuid } for
// a set of submissions, so the Errors tab can render per-row resolution badges
// in one query instead of N.
function statusMap(submissionUuids = []) {
  const out = {};
  const ids = submissionUuids.filter(Boolean);
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT submission_uuid, status, confidence, resolvable, applied_submission_uuid, updated_at
    FROM ai_resolutions WHERE submission_uuid IN (${placeholders})
  `).all(...ids);
  for (const r of rows) {
    out[r.submission_uuid] = {
      status: r.status,
      confidence: r.confidence,
      resolvable: !!r.resolvable,
      appliedSubmissionUuid: r.applied_submission_uuid || null,
      updatedAt: r.updated_at
    };
  }
  return out;
}

// Shape a stored row into the API/UI record (parses the *_json blobs).
function toRecord(row) {
  if (!row) return null;
  return {
    submission_uuid: row.submission_uuid,
    status: row.status,
    diagnosis: row.diagnosis || null,
    root_cause: row.root_cause || null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    resolvable: !!row.resolvable,
    operation: row.operation || null,
    proposedPackage: parseJson(row.proposed_package_json),
    changedAttrNames: parseJson(row.changed_attr_names_json) || [],
    unresolved: parseJson(row.unresolved_json) || [],
    warnings: parseJson(row.warnings_json) || [],
    validation: parseJson(row.validation_json) || null,
    model: row.model || null,
    errorMessage: row.error_message || null,
    appliedSubmissionUuid: row.applied_submission_uuid || null,
    reviewedBy: row.reviewed_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function jsonOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return null; }
}
function parseJson(s) {
  if (s == null || s === '') return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { upsert, setStatus, getBySubmission, statusMap, toRecord };
