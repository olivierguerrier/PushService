// The live SP-API forwarder. Takes a PENDING/IN_PROGRESS submission row and
// actually talks to Amazon, capturing the complete envelope for the audit
// trail: prior Amazon state (GET before write, enables revert), the live
// request, the full response, every status transition, and any error.
//
// Never throws to its caller — all outcomes are persisted on the submission
// row and recorded as audit events, then a response envelope is returned.
const env = require('../config/env');
const submissions = require('./submissions');
const listingsItems = require('./spapi/listingsItems');
const feeds = require('./spapi/feeds');
const audit = require('./audit/auditEvents');
const reconciliation = require('./reconciliation');
const packageValidator = require('./packageValidator');
const { scrubObject } = require('../lib/safeError');

const PACKAGE_LEVEL_ATTR = 'package_level';

// Schedule over-time reconciliation read-backs once a write has APPLIED.
// Best-effort: a scheduling failure must never break the push it follows.
function scheduleReconciliation(submission) {
  if (!env.RECON_ENABLED) return;
  if (!submission || submission.status !== 'APPLIED') return;
  try {
    const res = reconciliation.enqueueForSubmission(submission);
    if (res.scheduled) audit.record({ event: 'reconcile_scheduled', submissionUuid: submission.submission_uuid, actor: 'system', details: { checks: res.scheduled } });
  } catch (err) {
    audit.record({ event: 'reconcile_schedule_error', submissionUuid: submission.submission_uuid, actor: 'system', details: { message: err.message } });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(json) {
  if (json == null) return null;
  try { return JSON.parse(json); } catch { return json; }
}

// Build a concise, human-readable summary from Amazon's issue list so the
// submission's error_message carries the actual cause at a glance (the full
// structured issues are persisted separately in issues_json).
function summarizeIssues(issues) {
  if (!Array.isArray(issues) || !issues.length) return null;
  const parts = issues.slice(0, 3).map((i) => {
    if (!i) return null;
    if (typeof i === 'string') return i;
    const code = i.code ? `${i.code}: ` : '';
    const attrs = Array.isArray(i.attributeNames) && i.attributeNames.length ? ` [${i.attributeNames.join(', ')}]` : '';
    return `${code}${i.message || ''}${attrs}`.trim();
  }).filter(Boolean);
  if (!parts.length) return null;
  const more = issues.length > parts.length ? ` (+${issues.length - parts.length} more)` : '';
  return (parts.join(' | ') + more).slice(0, 1000);
}

// Map Amazon's Listings Items status to our submission status.
function statusFromAmazon(envelope) {
  const s = String(envelope && envelope.status || '').toUpperCase();
  if (s === 'ACCEPTED') return 'APPLIED';
  if (s === 'VALID') return 'APPLIED';
  if (s === 'INVALID') return 'FAILED';
  return 'SUBMITTED';
}

// Capture the current Amazon listing for the changed attributes BEFORE we
// write, so a later revert can restore them. Best-effort: a failure here is
// logged but does not block the push. `sku` defaults to the submission's
// documented SKU but can be overridden (used by the vendor_sku fallback so the
// captured prior state matches the listing we actually write to).
async function capturePriorState(submission, sku = submission.sku) {
  if (!sku || !submission.vendor_code) return null;
  try {
    const item = await listingsItems.getItem({
      sellerId: submission.vendor_code,
      sku,
      marketplaceCode: submission.marketplace_code,
      includedData: ['attributes', 'summaries', 'issues']
    });
    return item || null;
  } catch (err) {
    audit.record({ event: 'prior_state_capture_failed', submissionUuid: submission.submission_uuid, actor: 'system', details: { sku, message: err.message } });
    return null;
  }
}

// Amazon error 101168 ("You can't change Vendor SKU from its original value
// '<sku>'. ... [vendor_sku]") means the path SKU we used is not the SKU the
// listing is actually registered under. We detect it so the forwarder can retry
// with the caller-supplied parent SKU.
function isVendorSkuChangeError(issues) {
  if (!Array.isArray(issues)) return false;
  return issues.some((i) => {
    if (!i || typeof i !== 'object') return false;
    const code = String(i.code || '');
    const attrs = Array.isArray(i.attributeNames) ? i.attributeNames.map(String) : [];
    return code === '101168' || attrs.includes('vendor_sku');
  });
}

// The 101168 rejection names the SKU Amazon will actually accept. As a LAST
// resort — after the caller-supplied parent SKU has also been rejected — we
// parse that canonical SKU out of the message and retry by it. The phrase and
// quote glyphs are locale-specific, so we anchor on the localized phrase, skip
// any leading whitespace/quote glyph, and capture the SKU token:
//   EN "original value 'X'"
//   DE "ursprünglichen Wert ‚X'"
//   IT "valore originale X"          (no quotes — SKU follows directly)
//   FR "par défaut « X »"            (guillemets + (narrow) no-break spaces)
// The skip class therefore also covers guillemets (« ») and the no-break /
// narrow-no-break spaces (U+00A0, U+202F) French uses around them. Returns null
// when no 101168 issue carries a parseable value.
function extractVendorSkuFromIssues(issues) {
  if (!Array.isArray(issues)) return null;
  for (const it of issues) {
    if (!it || typeof it !== 'object') continue;
    if (String(it.code || '') !== '101168') continue;
    // Anchor the capture so it both starts and ends on an alphanumeric — without
    // this, locales that don't quote the SKU (e.g. IT "...valore originale X.")
    // would swallow the sentence-ending period into the token.
    const m = String(it.message || '').match(
      /(?:original value|ursprünglichen Wert|valore originale|par défaut)[\s\u00A0\u202F'‚‘’"„“«»]*([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)/i
    );
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

// Amazon errors 101161 / 101165 on a content-match patch mean the listing is
// ALREADY in the vendor's catalogue under the canonical SKU and already attached
// to this ASIN — so the merchant_suggested_asin match we're attempting is a
// no-op. 101161: "you try to edit the SKU of a product but it matches another
// product (SKU: X; ASIN: Y) already in your catalogue. SKUs cannot be
// duplicated." 101165: "your item ... matches multiple products because these
// identifiers aren't unique." We detect either anywhere in the issue list and
// settle the submission as a successful no-op rather than a failure.
function isAlreadyListedError(issues) {
  if (!Array.isArray(issues)) return false;
  return issues.some((i) => {
    if (!i || typeof i !== 'object') return false;
    const code = String(i.code || '');
    return code === '101161' || code === '101165';
  });
}

// Amazon error 4000000 ("An internal error has occurred. Try again.") is a
// generic, usually transient server-side failure. Amazon's own guidance is to
// retry the same request a couple of times before escalating.
function isInternalRetryableError(issues) {
  if (!Array.isArray(issues)) return false;
  return issues.some((i) => i && typeof i === 'object' && String(i.code || '') === '4000000');
}

// package_level is never sent on the initial write — only re-added when Amazon's
// rejection references it. An issue "requires package_level" when its
// attributeNames list names the attribute (e.g. it is missing/required for the
// product category). When Amazon raises this, we resubmit WITH package_level.
function isPackageLevelRequiredError(issues) {
  if (!Array.isArray(issues)) return false;
  return issues.some((i) => {
    if (!i || typeof i !== 'object') return false;
    const attrs = Array.isArray(i.attributeNames) ? i.attributeNames.map(String) : [];
    return attrs.includes(PACKAGE_LEVEL_ATTR);
  });
}

// Split a patchItem body into the version WITHOUT package_level patches and a
// flag for whether any were present. If package_level is the ONLY attribute
// being changed, stripping it would leave an empty (no-op) push — in that case
// we keep the original body, since deferring serves no purpose.
function splitPatchBody(body) {
  const patches = Array.isArray(body && body.patches) ? body.patches : [];
  const remaining = patches.filter((p) => packageValidator.attrNameFromPatchPath(p && p.path) !== PACKAGE_LEVEL_ATTR);
  const hasPL = remaining.length !== patches.length;
  if (!hasPL || remaining.length === 0) return { withoutPL: body, hasPL: false };
  return { withoutPL: { ...body, patches: remaining }, hasPL: true };
}

// Split a feed payload into the version WITHOUT package_level attributes and a
// flag for whether any were present. Mirrors splitPatchBody: if removing
// package_level would empty a message's attributes, that message is left as-is
// so the push isn't reduced to a no-op.
function splitFeedPayload(payload) {
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  let hasPL = false;
  const nextMessages = messages.map((m) => {
    const attrs = (m && m.attributes) || {};
    if (!(PACKAGE_LEVEL_ATTR in attrs)) return m;
    const rest = {};
    for (const [k, v] of Object.entries(attrs)) if (k !== PACKAGE_LEVEL_ATTR) rest[k] = v;
    // Keep package_level if it is the only attribute on this message.
    if (Object.keys(rest).length === 0) return m;
    hasPL = true;
    return { ...m, attributes: rest };
  });
  if (!hasPL) return { withoutPL: payload, hasPL: false };
  return { withoutPL: { ...payload, messages: nextMessages }, hasPL: true };
}

// Submit one live patchItem for `sku` and return Amazon's envelope. Records the
// request in the audit trail (with the SKU actually attempted).
async function submitPatchOnce(submission, body, sku) {
  audit.record({
    event: 'spapi_request',
    submissionUuid: submission.submission_uuid,
    actor: 'system',
    details: { operation: 'patchItem', asin: submission.asin, sellerId: submission.vendor_code, sku, marketplace: submission.marketplace_code, productType: body.productType, patchCount: Array.isArray(body.patches) ? body.patches.length : 0 }
  });
  return listingsItems.patchItem({
    sellerId: submission.vendor_code,
    sku,
    marketplaceCode: submission.marketplace_code,
    productType: body.productType,
    patches: body.patches,
    mode: null
  });
}

// Submit a patch for `sku`, transparently retrying when Amazon returns a
// transient 4000000 internal error (same request, bounded attempts + backoff).
async function submitPatchResilient(submission, body, sku) {
  const maxRetries = env.SPAPI_INTERNAL_RETRY_MAX;
  const backoffs = env.SPAPI_INTERNAL_RETRY_BACKOFF_MS;
  let envelope = await submitPatchOnce(submission, body, sku);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const issues = (envelope && envelope.issues) || [];
    if (statusFromAmazon(envelope) !== 'FAILED' || !isInternalRetryableError(issues)) break;
    const delay = backoffs[Math.min(attempt, backoffs.length - 1)] || 0;
    audit.record({
      event: 'spapi_internal_retry',
      submissionUuid: submission.submission_uuid,
      actor: 'system',
      details: { sku, attempt: attempt + 1, maxRetries, delayMs: delay, reason: summarizeIssues(issues) }
    });
    if (delay) await sleep(delay);
    envelope = await submitPatchOnce(submission, body, sku);
  }
  return envelope;
}

async function forwardPatch(submission) {
  const body = parse(submission.request_body_json) || {};
  const documentedSku = submission.sku;

  const prior = await capturePriorState(submission, documentedSku);
  if (prior) {
    submissions.update(submission.submission_uuid, { prior_state_json: prior });
    audit.record({ event: 'prior_state_captured', submissionUuid: submission.submission_uuid, actor: 'system', details: { sku: documentedSku, hasAttributes: !!(prior && prior.attributes) } });
  }

  // Defer package_level: the initial write (and every SKU fallback) goes out
  // WITHOUT it. It is only re-added if Amazon rejects with a package_level
  // -referencing issue (see below).
  const { withoutPL, hasPL } = splitPatchBody(body);
  let sentBody = withoutPL;
  let packageLevelReadded = 0;
  if (hasPL) {
    audit.record({ event: 'package_level_deferred', submissionUuid: submission.submission_uuid, actor: 'system', details: { operation: 'patchItem' } });
  }

  let envelope = await submitPatchResilient(submission, sentBody, documentedSku);
  let status = statusFromAmazon(envelope);
  let issues = (envelope && envelope.issues) || [];
  let effectiveSku = documentedSku;

  // Vendor SKU fallback tiers (only on Amazon's 101168 "can't change Vendor SKU"
  // rejection). The documented SKU was rejected because the listing is
  // registered under a different seller SKU. We retry the SAME vendor code with,
  // in order:
  //   1. the caller-supplied parent SKU (sourced from FlyApp — authoritative);
  //   2. the canonical SKU Amazon names in the rejection (inferred — last
  //      resort, used when the parent SKU is absent or itself gets 101168).
  // Each candidate is tried at most once; the loop stops as soon as a write
  // stops failing (or no new candidate remains).
  const norm = (s) => String(s || '').trim().toUpperCase();
  const parentSku = submission.parent_sku ? String(submission.parent_sku).trim() : null;
  const tried = new Set([norm(documentedSku)]);
  let guard = 0;
  while (status === 'FAILED' && isVendorSkuChangeError(issues) && guard < 3) {
    guard += 1;
    let nextSku = null;
    let source = null;
    if (parentSku && !tried.has(norm(parentSku))) {
      nextSku = parentSku;
      source = 'flyapp_parent_sku';
    } else {
      const inferred = extractVendorSkuFromIssues(issues);
      if (inferred && !tried.has(norm(inferred))) {
        nextSku = inferred;
        source = 'inferred_from_101168';
      }
    }
    if (!nextSku) break;
    tried.add(norm(nextSku));
    audit.record({
      event: 'vendor_sku_fallback',
      submissionUuid: submission.submission_uuid,
      actor: 'system',
      details: { fromSku: effectiveSku, toSku: nextSku, source, reason: summarizeIssues(issues) }
    });
    // Re-capture prior state against the candidate SKU's listing so a later
    // revert restores the listing we actually write to.
    const candidatePrior = await capturePriorState(submission, nextSku);
    if (candidatePrior) {
      submissions.update(submission.submission_uuid, { prior_state_json: candidatePrior });
      audit.record({ event: 'prior_state_captured', submissionUuid: submission.submission_uuid, actor: 'system', details: { sku: nextSku, hasAttributes: !!(candidatePrior && candidatePrior.attributes) } });
    }
    envelope = await submitPatchResilient(submission, sentBody, nextSku);
    status = statusFromAmazon(envelope);
    issues = (envelope && envelope.issues) || [];
    effectiveSku = nextSku;
  }

  // package_level re-add: if the deferred write failed BECAUSE Amazon requires
  // package_level (its rejection names the attribute), resubmit the full body
  // (with package_level) once against the SKU that the fallback resolved to.
  if (status === 'FAILED' && hasPL && isPackageLevelRequiredError(issues)) {
    audit.record({ event: 'package_level_readd', submissionUuid: submission.submission_uuid, actor: 'system', details: { operation: 'patchItem', sku: effectiveSku, reason: summarizeIssues(issues) } });
    sentBody = body;
    packageLevelReadded = 1;
    envelope = await submitPatchResilient(submission, sentBody, effectiveSku);
    status = statusFromAmazon(envelope);
    issues = (envelope && envelope.issues) || [];
  }

  // An "already listed / identifiers not unique" rejection (101161/101165) means
  // the SKU↔ASIN match we're pushing already exists, so the content match is a
  // successful no-op rather than a failure. Fold it into APPLIED (the only status
  // FlyApp's gateway maps to ACCEPTED) but keep the issues for the audit trail.
  const alreadyListed = status === 'FAILED' && isAlreadyListedError(issues);
  const finalStatus = alreadyListed ? 'APPLIED' : status;
  if (alreadyListed) {
    audit.record({
      event: 'noop_already_listed',
      submissionUuid: submission.submission_uuid,
      actor: 'system',
      details: { sku: effectiveSku, reason: summarizeIssues(issues) }
    });
  }

  submissions.update(submission.submission_uuid, {
    status: finalStatus,
    amazon_response_json: envelope,
    issues_json: issues,
    // Record the SKU actually written only when it differs from the documented
    // one; reconciliation/revert read effective_sku when present.
    effective_sku: effectiveSku !== documentedSku ? effectiveSku : null,
    package_level_readded: packageLevelReadded,
    error_message: finalStatus === 'FAILED'
      ? (summarizeIssues(issues) || 'Amazon returned INVALID — see issues')
      : null
  });
  audit.record({ event: 'spapi_response', submissionUuid: submission.submission_uuid, actor: 'system', details: scrubObject({ status, sku: effectiveSku, submissionId: envelope && envelope.submissionId, issues }) });
  const settled = submissions.getByUuid(submission.submission_uuid);
  scheduleReconciliation(settled);
  return settled;
}

async function forwardFeed(submission) {
  const body = parse(submission.request_body_json) || {};
  // Defer package_level on the initial feed too. The full payload stays in
  // request_body_json so the poller can rebuild and resubmit WITH package_level
  // if Amazon's processing report says it is required.
  const { withoutPL, hasPL } = splitFeedPayload(body.payload);
  if (hasPL) {
    audit.record({ event: 'package_level_deferred', submissionUuid: submission.submission_uuid, actor: 'system', details: { operation: 'submitJsonListingsFeed' } });
  }
  audit.record({ event: 'spapi_request', submissionUuid: submission.submission_uuid, actor: 'system', details: { operation: 'submitJsonListingsFeed', marketplace: submission.marketplace_code } });

  const result = await feeds.submitJsonListingsFeed({ marketplaceCode: submission.marketplace_code, payload: withoutPL });
  submissions.update(submission.submission_uuid, {
    status: 'IN_PROGRESS',
    feed_id: result.feedId,
    feed_document_id: result.feedDocumentId,
    amazon_response_json: result
  });
  audit.record({ event: 'feed_submitted', submissionUuid: submission.submission_uuid, actor: 'system', details: { feedId: result.feedId } });
  return submissions.getByUuid(submission.submission_uuid);
}

// Forward one submission to Amazon. Honours the master kill switch as a
// last line of defence (routes also check it).
async function forward(submission) {
  if (!env.SPAPI_WRITES_ENABLED) {
    submissions.update(submission.submission_uuid, { status: 'BLOCKED', error_message: 'SPAPI_WRITES_ENABLED is false (kill switch)' });
    audit.record({ event: 'write_blocked_kill_switch', submissionUuid: submission.submission_uuid, actor: 'system' });
    return submissions.getByUuid(submission.submission_uuid);
  }
  try {
    if (submission.operation === 'submitJsonListingsFeed') return await forwardFeed(submission);
    return await forwardPatch(submission);
  } catch (err) {
    // Persist a structured diagnostic blob (not just a short string) so the
    // root cause survives for later analysis: HTTP status, error code, the raw
    // SP-API response body, and the message.
    const message = (err && err.message ? err.message : String(err)).slice(0, 1000);
    const errorBlob = {
      error: (err && err.responseText) || message,
      message,
      status: (err && err.status) || null,
      code: (err && err.code) || null,
      responseText: (err && err.responseText) || null
    };
    submissions.update(submission.submission_uuid, {
      status: 'FAILED',
      error_message: message,
      amazon_response_json: scrubObject(errorBlob)
    });
    audit.record({ event: 'spapi_error', submissionUuid: submission.submission_uuid, actor: 'system', details: { message: err && err.message, status: err && err.status, code: err && err.code } });
    return submissions.getByUuid(submission.submission_uuid);
  }
}

// Build a client-facing response envelope from a submission row.
function buildResponseFromSubmission(submission) {
  const amazon = parse(submission.amazon_response_json);
  const issues = parse(submission.issues_json) || (amazon && amazon.issues) || [];
  return {
    submissionId: submission.submission_uuid,
    jobId: submission.job_uuid,
    status: submission.status,
    operation: submission.operation,
    marketplaceCode: submission.marketplace_code,
    asin: submission.asin,
    sku: submission.sku,
    parentSku: submission.parent_sku || null,
    effectiveSku: submission.effective_sku || null,
    vendorCode: submission.vendor_code,
    feedId: submission.feed_id || null,
    issues,
    amazon,
    errorMessage: submission.error_message || null
  };
}

module.exports = { forward, forwardPatch, forwardFeed, buildResponseFromSubmission, capturePriorState, statusFromAmazon, scheduleReconciliation, summarizeIssues, isVendorSkuChangeError, isAlreadyListedError, isInternalRetryableError, extractVendorSkuFromIssues, isPackageLevelRequiredError, splitPatchBody, splitFeedPayload };
