// Automatic sibling-ASIN repurposing on push failure.
//
// When a push FAILS with required-but-missing attribute errors (e.g. Amazon's
// 90220 "'<attr>' is required but missing"), this module repurposes the values
// from the MOST COMPLETE record of the SAME ASIN in the SAME marketplace under a
// different vendor code, and re-pushes the listing automatically under the
// failing vendor code.
//
// Why same marketplace: it guarantees the borrowed values are already in the
// correct language and unit system, so free-text attributes (safety warnings,
// item type names) are valid as-is — no translation guesswork.
//
// Why "most complete vendor code": among the accepted siblings in that
// marketplace we pick the one whose listing carries the most of the missing
// attributes (then the most attributes overall), i.e. the richest donor.
//
// Safety: this only runs when the master write switch is on; it never recurses
// (the re-push it creates is marked payload_origin='auto_repurposed' and is
// skipped), and any failure is swallowed so it can never break the original push.
'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const submissions = require('./submissions');
const jobs = require('./jobs');
const audit = require('./audit/auditEvents');
const packageValidator = require('./packageValidator');
const { buildRequestBody } = require('./packageRequestBody');
const { resolveByCode } = require('../config/marketplaces');
const { languageTagFor } = require('../config/languages');
const siblingAttributeSource = require('./sot/siblingAttributeSource');

function parseJson(s) {
  if (s == null || s === '') return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// Amazon error codes that mean "a required attribute is missing/invalid" — the
// only failures worth repurposing. Transient (4000000), already-listed
// (101161/101165), and vendor-sku (101168) errors are deliberately excluded so
// we never re-push over a retryable/no-op condition.
const MISSING_ATTR_CODES = new Set(['90220', '8560']);
// Language-agnostic guard so an issue that carries a code outside the set but is
// clearly a "required ... missing" message (any marketplace language) still
// counts, while transient messages ("internal error, try again") never do.
const REQUIRED_MISSING_RE = /required|missing|obligatori|manquant|erforderlich|obbligatori|requ(i|e)rid|fehlt|falta/i;

// Attribute names blamed by required-but-missing issues only.
function missingAttrNamesFromIssues(issues) {
  const names = new Set();
  for (const i of issues || []) {
    if (!i) continue;
    const code = i.code != null ? String(i.code) : '';
    const looksMissing = MISSING_ATTR_CODES.has(code) || (REQUIRED_MISSING_RE.test(String(i.message || '')));
    if (!looksMissing) continue;
    const arr = Array.isArray(i.attributeNames)
      ? i.attributeNames
      : (i.attributeName ? [i.attributeName] : []);
    for (const a of arr) if (a) names.add(String(a));
  }
  return [...names];
}

// Is this failed submission a candidate for auto-repurpose?
function eligible(submission) {
  if (!env.SIBLING_REPURPOSE_ENABLED || !env.AUTO_REPURPOSE_ON_FAILURE) return false;
  if (!env.SPAPI_WRITES_ENABLED) return false; // re-push would just be BLOCKED
  if (!submission || submission.status !== 'FAILED') return false;
  // Never repurpose a repurpose (or an AI fix) — prevents loops/oscillation.
  if (submission.payload_origin === 'auto_repurposed') return false;
  if (submission.operation !== 'patchItem' && submission.operation !== 'submitJsonListingsFeed') return false;
  if (!submission.asin || !submission.marketplace_code || !submission.product_type) return false;
  return true;
}

// Choose the richest same-marketplace sibling vendor for this ASIN. Ranked by
// how many of the missing attributes it can supply (coverage), then by total
// attribute count (completeness); ties resolve to the most recent (the DB query
// already returns rows newest-first). Returns { row, attrs, coverage, total } or null.
function chooseDonor(failed, neededNames) {
  const rows = submissions.listAcceptedByAsin(failed.asin, {
    excludeUuid: failed.submission_uuid,
    marketplaceCode: failed.marketplace_code,
    productType: failed.product_type,
    limit: 100
  }) || [];
  const target = String(failed.marketplace_code || '').toUpperCase();
  let best = null;
  for (const row of rows) {
    if (String(row.marketplace_code || '').toUpperCase() !== target) continue; // same marketplace only
    const attrs = siblingAttributeSource.attributesFromSubmissionRow(row);
    const total = Object.keys(attrs).length;
    const coverage = neededNames.reduce((n, name) => n + (attrs[name] != null ? 1 : 0), 0);
    if (coverage === 0) continue;
    if (!best || coverage > best.coverage || (coverage === best.coverage && total > best.total)) {
      best = { row, attrs, coverage, total };
    }
  }
  return best;
}

// Merge the donor's values for the missing attributes into the original failed
// package (keeping everything it already carried). Returns { pkg, used, operation }
// or null when nothing fillable remains.
function buildPackage(failed, donor, neededNames, ctx) {
  const operation = failed.operation;
  const filled = {};
  const used = {};
  for (const name of neededNames) {
    const raw = donor.attrs[name];
    if (raw == null) continue;
    const shaped = siblingAttributeSource._internal.shapeForTarget(raw, name, ctx, null);
    if (!shaped) continue;
    filled[name] = shaped;
    used[name] = `auto-repurpose: vendor ${donor.row.vendor_code || '?'} sub ${donor.row.submission_uuid} (${donor.row.marketplace_code})`;
  }
  if (!Object.keys(filled).length) return null;

  const orig = parseJson(failed.request_body_json) || {};

  if (operation === 'submitJsonListingsFeed') {
    const payload = orig.payload || {};
    const baseMessages = (Array.isArray(payload.messages) && payload.messages.length)
      ? payload.messages
      : [{ sku: failed.effective_sku || failed.sku, attributes: {} }];
    const messages = baseMessages.map((m, idx) => (idx === 0
      ? { ...m, sku: m.sku || failed.effective_sku || failed.sku, attributes: { ...(m.attributes || {}), ...filled } }
      : m));
    return { pkg: { messages }, used, operation };
  }

  // patchItem: keep original patches, then add/replace the filled attributes.
  const patches = Array.isArray(orig.patches) ? orig.patches.map((p) => ({ ...p })) : [];
  const indexByName = new Map();
  patches.forEach((p, i) => {
    const nm = packageValidator.attrNameFromPatchPath(p && p.path);
    if (nm && !indexByName.has(nm)) indexByName.set(nm, i);
  });
  for (const [name, value] of Object.entries(filled)) {
    if (indexByName.has(name)) {
      const p = patches[indexByName.get(name)];
      p.op = 'replace';
      p.path = `/attributes/${name}`;
      p.value = value;
    } else {
      patches.push({ op: 'replace', path: `/attributes/${name}`, value });
    }
  }
  return { pkg: { patches }, used, operation };
}

// Core: build and forward a repurposed re-push for one FAILED submission.
async function repurpose(failed) {
  const issues = parseJson(failed.issues_json) || [];
  const neededNames = missingAttrNamesFromIssues(issues);
  if (!neededNames.length) return { ok: false, reason: 'no_missing_attrs' };

  const mp = resolveByCode(failed.marketplace_code);
  if (!mp) return { ok: false, reason: 'unknown_marketplace' };

  const donor = chooseDonor(failed, neededNames);
  if (!donor) return { ok: false, reason: 'no_donor' };

  const ctx = { marketplaceId: mp.amazonMarketplaceId, languageTag: languageTagFor(failed.marketplace_code) };
  const built = buildPackage(failed, donor, neededNames, ctx);
  if (!built) return { ok: false, reason: 'no_fillable_values' };

  const productType = failed.product_type;
  const marketplaceCode = String(failed.marketplace_code).toUpperCase();
  const validated = await packageValidator.validatePackage({
    pkg: built.pkg, operation: built.operation, productType, marketplaceCode, allowUnknownAttributes: false
  });
  if (!validated.ok) return { ok: false, reason: 'package_invalid', problems: validated.problems };

  const requestBody = buildRequestBody({ operation: built.operation, marketplaceCode, productType, validated });

  // Lazy requires break the forwarder <-> autoRepurpose require cycle.
  const forwarder = require('./forwarder');
  const { recomputeJobStatus } = require('./jobOrchestrator');

  const jobUuid = crypto.randomUUID();
  jobs.create({
    jobUuid, kind: 'auto_repurpose', caller: 'system', asin: failed.asin, itemNumber: failed.item_number,
    marketplaceCode, productType, label: `Auto-repurpose of ${failed.submission_uuid}`, targetCount: 1
  });
  jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });

  const submissionUuid = crypto.randomUUID();
  const submission = submissions.insert({
    submissionUuid, jobUuid, caller: 'system', scope: failed.scope, operation: built.operation,
    vendorCode: failed.vendor_code, sku: failed.effective_sku || failed.sku, parentSku: failed.parent_sku,
    asin: failed.asin, itemNumber: failed.item_number, marketplaceCode, productType,
    requestBody, status: 'IN_PROGRESS', payloadOrigin: 'auto_repurposed', rawPackage: built.pkg,
    flyappMeta: {
      autoRepurpose: true,
      donorSubmissionUuid: donor.row.submission_uuid,
      donorVendorCode: donor.row.vendor_code,
      filledAttrNames: Object.keys(built.used),
      valueSources: built.used
    },
    resolvesUuid: failed.submission_uuid
  });
  audit.record({
    event: 'auto_repurpose_applied', submissionUuid, jobUuid, actor: 'system',
    details: { resolvesUuid: failed.submission_uuid, donor: donor.row.submission_uuid, donorVendor: donor.row.vendor_code, filled: Object.keys(built.used), coverage: donor.coverage }
  });

  const finalRow = await forwarder.forward(submission);
  recomputeJobStatus(jobUuid);
  return { ok: true, submissionUuid, status: finalRow && finalRow.status, filled: Object.keys(built.used) };
}

// Public, best-effort entry point. Never throws: a repurpose problem must never
// break the original push/poll flow.
async function maybeRepurpose(submission) {
  try {
    if (!eligible(submission)) return null;
    return await repurpose(submission);
  } catch (err) {
    try {
      audit.record({ event: 'auto_repurpose_error', submissionUuid: submission && submission.submission_uuid, actor: 'system', details: { message: err && err.message } });
    } catch { /* audit best-effort */ }
    return { ok: false, reason: 'error', error: err && err.message };
  }
}

module.exports = {
  maybeRepurpose,
  // exposed for tests
  _internal: { eligible, missingAttrNamesFromIssues, chooseDonor, buildPackage, repurpose }
};
