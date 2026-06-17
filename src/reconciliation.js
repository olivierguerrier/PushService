// reconciliation_checks accessors + scheduling helpers. After a write APPLIES
// we enqueue one check per configured offset (e.g. +1h, +24h, +7d). The
// reconciler cron later pulls due checks, reads the live listing from Amazon,
// and settles each to MATCH / DRIFT / MISSING / ERROR.
const crypto = require('crypto');
const { getDb } = require('./db');
const env = require('../config/env');
const packageValidator = require('./packageValidator');

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// '1h,24h,7d' -> [3600000, 86400000, 604800000]. Bad tokens are skipped.
function parseOffsets(raw) {
  return String(raw || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^(\d+)\s*([smhd])$/);
      if (!m) return null;
      return Number(m[1]) * UNIT_MS[m[2]];
    })
    .filter((n) => Number.isFinite(n) && n >= 0);
}

// Derive the per-attribute expected values from a stored submission's
// request_body — works for both fat (built) and thin (prebuilt) submissions
// since both store whole-attribute patches / feed message attributes.
function expectedFromSubmission(submission) {
  let body = null;
  try { body = submission.request_body_json ? JSON.parse(submission.request_body_json) : null; } catch { body = null; }
  if (!body) return {};
  let expected;
  if (submission.operation === 'submitJsonListingsFeed') {
    ({ expected } = packageValidator.extractExpected({ pkg: body.payload, operation: 'submitJsonListingsFeed' }));
  } else {
    ({ expected } = packageValidator.extractExpected({ pkg: { patches: body.patches || [] }, operation: 'patchItem' }));
  }
  // package_level is deferred at forward-time, so request_body_json still
  // carries it even though the initial write omitted it. Only expect it on
  // Amazon when it was actually re-added and sent.
  if (Number(submission.package_level_readded) !== 1 && expected && 'package_level' in expected) {
    const { package_level, ...rest } = expected;
    return rest;
  }
  return expected;
}

// Schedule reconciliation checks for an APPLIED submission. Idempotent-ish:
// callers should only invoke once per submission (on the APPLIED transition).
function enqueueForSubmission(submission, { offsets = parseOffsets(env.RECON_OFFSETS), now = Date.now() } = {}) {
  // Read back the listing we actually wrote: the vendor_sku fallback may have
  // pushed to the parent SKU (effective_sku) rather than the documented one.
  const effectiveSku = (submission && (submission.effective_sku || submission.sku)) || null;
  if (!submission || !effectiveSku || !submission.vendor_code) return { scheduled: 0, reason: 'missing sku/vendor_code' };
  const expected = expectedFromSubmission(submission);
  if (!Object.keys(expected).length) return { scheduled: 0, reason: 'no expected attributes' };

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO reconciliation_checks (
      check_uuid, submission_uuid, job_uuid, attempt_index, vendor_code, sku, asin,
      marketplace_code, product_type, expected_json, status, scheduled_at
    ) VALUES (
      @check_uuid, @submission_uuid, @job_uuid, @attempt_index, @vendor_code, @sku, @asin,
      @marketplace_code, @product_type, @expected_json, 'PENDING', @scheduled_at
    )
  `);
  const expectedJson = JSON.stringify(expected);
  let scheduled = 0;
  const tx = db.transaction((list) => {
    list.forEach((offsetMs, idx) => {
      insert.run({
        check_uuid: crypto.randomUUID(),
        submission_uuid: submission.submission_uuid,
        job_uuid: submission.job_uuid,
        attempt_index: idx,
        vendor_code: submission.vendor_code,
        sku: effectiveSku,
        asin: submission.asin,
        marketplace_code: submission.marketplace_code,
        product_type: submission.product_type,
        expected_json: expectedJson,
        scheduled_at: new Date(now + offsetMs).toISOString()
      });
      scheduled += 1;
    });
  });
  tx(offsets.length ? offsets : [0]);
  return { scheduled };
}

function due({ now = Date.now(), limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  return getDb().prepare(`
    SELECT * FROM reconciliation_checks
    WHERE status = 'PENDING' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC LIMIT ${cap}
  `).all(new Date(now).toISOString());
}

const UPDATABLE = ['status', 'observed_json', 'diff_json', 'error_message', 'attempts', 'checked_at', 'scheduled_at'];

function update(checkUuid, fields = {}) {
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
  if (!sets.length) return getByUuid(checkUuid);
  sets.push("updated_at = datetime('now')");
  vals.push(checkUuid);
  db.prepare(`UPDATE reconciliation_checks SET ${sets.join(', ')} WHERE check_uuid = ?`).run(...vals);
  return getByUuid(checkUuid);
}

function getByUuid(checkUuid) {
  return getDb().prepare('SELECT * FROM reconciliation_checks WHERE check_uuid = ?').get(checkUuid);
}

function listForSubmission(submissionUuid) {
  return getDb().prepare('SELECT * FROM reconciliation_checks WHERE submission_uuid = ? ORDER BY attempt_index ASC, id ASC').all(submissionUuid);
}

function listRecent({ limit = 200, status = null } = {}) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  if (status) {
    return getDb().prepare(`
      SELECT check_uuid, submission_uuid, sku, vendor_code, asin, marketplace_code, product_type,
             attempt_index, status, scheduled_at, checked_at, error_message, created_at
      FROM reconciliation_checks WHERE status = ? ORDER BY id DESC LIMIT ${cap}
    `).all(status);
  }
  return getDb().prepare(`
    SELECT check_uuid, submission_uuid, sku, vendor_code, asin, marketplace_code, product_type,
           attempt_index, status, scheduled_at, checked_at, error_message, created_at
    FROM reconciliation_checks ORDER BY id DESC LIMIT ${cap}
  `).all();
}

module.exports = {
  parseOffsets, expectedFromSubmission, enqueueForSubmission,
  due, update, getByUuid, listForSubmission, listRecent
};
