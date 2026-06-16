// Per-field change details for a submission: render each changed attribute as
// `current Amazon value -> submitted value`, so a reviewer can see exactly
// what each push will overwrite. The submitted (TO) value comes from the
// stored JSON-Patch payload; the current/replaced (FROM) value is the live
// Amazon listing attribute — taken from the already-captured prior state when
// present, otherwise fetched on demand via the Listings Items API. Both sides
// share the same Amazon attribute envelope shape, so they compare directly.
// Resolution is best-effort: when the current value cannot be read (listing
// not found, missing creds), the change is still returned with
// `sourceAvailable: false`.
const listingsItems = require('./spapi/listingsItems');
const translator = require('./translator');
const reconciliation = require('./reconciliation');
const audit = require('./audit/auditEvents');

function parse(json) {
  if (json == null) return null;
  if (typeof json === 'object') return json;
  try { return JSON.parse(json); } catch { return null; }
}

// Amazon attribute name -> Battat/flyapp field label (inverse of the
// translator's FIELD_TO_AMAZON_ATTRS table) for friendlier display.
const ATTR_TO_FIELD = (() => {
  const out = {};
  for (const [field, attrs] of Object.entries(translator.FIELD_TO_AMAZON_ATTRS || {})) {
    for (const a of attrs) if (!(a in out)) out[a] = field;
  }
  return out;
})();

function attrNameFromPath(path) {
  // `/attributes/<name>` (and possibly deeper). We key on <name>.
  const parts = String(path || '').split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'attributes') return parts[1];
  return null;
}

// Render a single Amazon attribute envelope (array of value objects) as a
// short human-readable string.
function formatEnvelope(value) {
  if (value == null) return '';
  if (!Array.isArray(value)) {
    if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return String(value); } }
    return String(value);
  }
  const pieces = value.map(formatEntry).filter((s) => s != null && s !== '');
  return pieces.join(' | ');
}

function formatEntry(entry) {
  if (entry == null) return '';
  if (typeof entry !== 'object') return String(entry);
  // Price: { currency, value }
  if ('value' in entry && entry.currency != null && (typeof entry.value === 'number' || typeof entry.value === 'string')) {
    return `${entry.value} ${entry.currency}`;
  }
  // Dimensions: { length:{value,unit}, width:{...}, height:{...} }
  if (entry.length || entry.width || entry.height) {
    const dim = (d) => (d && d.value != null ? `${d.value}${d.unit ? ' ' + d.unit : ''}` : '-');
    if (entry.length || entry.width || entry.height) {
      return `L ${dim(entry.length)} x W ${dim(entry.width)} x H ${dim(entry.height)}`;
    }
  }
  // Weight: { value, unit }
  if ('value' in entry && entry.unit != null && entry.currency == null && !entry.language_tag) {
    return `${entry.value} ${entry.unit}`;
  }
  // Image locator: { media_location }
  if (entry.media_location != null) return String(entry.media_location);
  // Identifier: { type, value }
  if (entry.type != null && 'value' in entry) return `${entry.value} (${entry.type})`;
  // Generic text envelope: { value, language_tag, marketplace_id }
  if ('value' in entry && (typeof entry.value === 'string' || typeof entry.value === 'number')) {
    return String(entry.value);
  }
  try { return JSON.stringify(entry); } catch { return String(entry); }
}

// Parse the submitted patch payload into [{ attribute, op, to }].
function parsePatchValues(requestBody) {
  const body = parse(requestBody) || {};
  const patches = Array.isArray(body.patches) ? body.patches : [];
  const out = [];
  const seen = new Set();
  for (const p of patches) {
    const attribute = attrNameFromPath(p && p.path);
    if (!attribute || seen.has(attribute)) continue;
    seen.add(attribute);
    out.push({
      attribute,
      op: (p && p.op) || 'replace',
      to: p && p.op === 'delete' ? '(deleted)' : formatEnvelope(p && p.value)
    });
  }
  return out;
}

// Build the current Amazon attribute map (same envelope shape as patches) for
// a submission — i.e. the values this push will replace. Prefers the prior
// state captured at push time (no API call); otherwise reads the live listing.
// Returns { attrs, warnings, source }.
async function buildCurrentAmazonAttrs(submission) {
  if (!submission) return { attrs: {}, warnings: ['no submission'], source: null };

  const prior = parse(submission.prior_state_json);
  if (prior && prior.attributes && Object.keys(prior.attributes).length) {
    return { attrs: prior.attributes, warnings: [], source: 'prior_state' };
  }

  if (!submission.vendor_code || !submission.sku) {
    return { attrs: {}, warnings: ['cannot read current Amazon value: missing seller/sku'], source: null };
  }
  try {
    const item = await listingsItems.getItem({
      sellerId: submission.vendor_code,
      sku: submission.sku,
      marketplaceCode: submission.marketplace_code,
      includedData: ['attributes', 'summaries']
    });
    const attrs = (item && item.attributes) || {};
    const warnings = Object.keys(attrs).length ? [] : ['no attributes returned from Amazon for this listing'];
    return { attrs, warnings, source: 'live' };
  } catch (err) {
    return { attrs: {}, warnings: [`current Amazon value unavailable: ${err.message}`], source: null };
  }
}

// Find the current value for a changed attribute, tolerating attribute name
// aliases (e.g. external_product_id vs externally_assigned_product_identifier).
function sourceValueForAttr(attribute, sourceAttrs) {
  if (!sourceAttrs) return undefined;
  if (attribute in sourceAttrs) return sourceAttrs[attribute];
  const field = ATTR_TO_FIELD[attribute];
  const candidates = field ? (translator.FIELD_TO_AMAZON_ATTRS[field] || []) : [];
  for (const c of candidates) if (c in sourceAttrs) return sourceAttrs[c];
  return undefined;
}

// Most recent reconciliation snapshot for a submission that actually read the
// live listing (MATCH/DRIFT have observed_json). Returns { attrs, at } or null.
function latestObservedAttrs(submission) {
  if (!submission || !submission.submission_uuid) return null;
  const checks = reconciliation.listForSubmission(submission.submission_uuid) || [];
  let best = null;
  for (const c of checks) {
    if (c.status !== 'MATCH' && c.status !== 'DRIFT') continue;
    const obs = parse(c.observed_json);
    if (!obs || !Object.keys(obs).length) continue;
    // listForSubmission orders ascending; keep the latest checked_at.
    if (!best || (c.checked_at && c.checked_at >= (best.checked_at || ''))) best = c;
  }
  if (!best) return null;
  return { attrs: parse(best.observed_json) || {}, at: best.checked_at || null };
}

// Build the CURRENT value on Amazon for an APPLIED submission. Prefers the
// latest reconciliation snapshot (no API call); otherwise reads the live
// listing now. Returns { attrs, warnings, source, at }.
async function buildCurrentValue(submission) {
  const observed = latestObservedAttrs(submission);
  if (observed) {
    return { attrs: observed.attrs, warnings: [], source: 'reconciliation', at: observed.at };
  }
  if (!submission || !submission.vendor_code || !submission.sku) {
    return { attrs: {}, warnings: ['cannot read current Amazon value: missing seller/sku'], source: null, at: null };
  }
  try {
    const item = await listingsItems.getItem({
      sellerId: submission.vendor_code,
      sku: submission.sku,
      marketplaceCode: submission.marketplace_code,
      includedData: ['attributes', 'summaries']
    });
    const attrs = (item && item.attributes) || {};
    const warnings = Object.keys(attrs).length ? [] : ['no attributes returned from Amazon for this listing'];
    return { attrs, warnings, source: 'live', at: new Date().toISOString() };
  } catch (err) {
    return { attrs: {}, warnings: [`current Amazon value unavailable: ${err.message}`], source: null, at: null };
  }
}

// Timestamp of the push itself: the latest spapi_response audit event for the
// submission, falling back to the submission's updated_at.
function resolvePushedAt(submission) {
  try {
    const events = audit.query({ submissionUuid: submission.submission_uuid, event: 'spapi_response', limit: 1 });
    if (events && events.length && events[0].at) return events[0].at;
  } catch { /* fall through to updated_at */ }
  return submission.updated_at || null;
}

// Top-level for APPLIED submissions: per changed attribute, the old value
// (captured before push), the value pushed, and the current value on Amazon —
// plus the push timestamp and the current-value timestamp/source.
async function computeAppliedChanges(submission) {
  const pushed = parsePatchValues(submission && submission.request_body_json);
  if (!pushed.length) {
    return { applied: true, changes: [], warnings: [], pushedAt: resolvePushedAt(submission), currentAt: null, currentSource: null };
  }

  const prior = parse(submission.prior_state_json);
  const oldAttrs = (prior && prior.attributes) || {};
  const { attrs: currentAttrs, warnings, source: currentSource, at: currentAt } = await buildCurrentValue(submission);

  const changes = pushed.map(({ attribute, op, to }) => {
    const oldVal = sourceValueForAttr(attribute, oldAttrs);
    const oldAvailable = oldVal !== undefined;
    const currentVal = sourceValueForAttr(attribute, currentAttrs);
    const currentAvailable = currentVal !== undefined;
    return {
      attribute,
      field: ATTR_TO_FIELD[attribute] || attribute,
      op,
      old: oldAvailable ? formatEnvelope(oldVal) : null,
      pushed: to,
      current: currentAvailable ? formatEnvelope(currentVal) : null,
      oldAvailable,
      currentAvailable
    };
  });

  return {
    applied: true,
    changes,
    warnings: warnings || [],
    pushedAt: resolvePushedAt(submission),
    currentAt,
    currentSource
  };
}

// Top-level: compute [{ attribute, field, from, to, sourceAvailable }] plus
// warnings and the source ('prior_state' | 'live' | null) of the FROM values.
async function computeChanges(submission) {
  const toValues = parsePatchValues(submission && submission.request_body_json);
  if (!toValues.length) return { changes: [], warnings: [], source: null };

  const { attrs: currentAttrs, warnings, source } = await buildCurrentAmazonAttrs(submission);

  const changes = toValues.map(({ attribute, op, to }) => {
    const currentVal = sourceValueForAttr(attribute, currentAttrs);
    const sourceAvailable = currentVal !== undefined;
    return {
      attribute,
      field: ATTR_TO_FIELD[attribute] || attribute,
      op,
      from: sourceAvailable ? formatEnvelope(currentVal) : null,
      to,
      sourceAvailable
    };
  });

  return { changes, warnings: warnings || [], source };
}

// Uniform before/posted/after review shape for ANY submission status, so the
// grouped queue can render one consistent table regardless of whether a child
// is still pending or already applied. Semantics by status:
//   - APPLIED  -> before = value captured before push (prior_state),
//                 posted = value pushed, after = current value on Amazon
//                 (reconciliation snapshot or live read).
//   - otherwise -> before = current value on Amazon now (what the push will
//                  replace), posted = value to push, after = null (not pushed
//                  yet, so nothing to read back).
async function computeReview(submission) {
  if (submission && submission.status === 'APPLIED') {
    const r = await computeAppliedChanges(submission);
    return {
      applied: true,
      source: r.currentSource,
      pushedAt: r.pushedAt,
      afterAt: r.currentAt,
      warnings: r.warnings || [],
      changes: r.changes.map((c) => ({
        attribute: c.attribute,
        field: c.field,
        op: c.op,
        before: c.old,
        posted: c.pushed,
        after: c.current,
        beforeAvailable: c.oldAvailable,
        afterAvailable: c.currentAvailable
      }))
    };
  }
  const r = await computeChanges(submission);
  return {
    applied: false,
    source: r.source,
    pushedAt: null,
    afterAt: null,
    warnings: r.warnings || [],
    changes: r.changes.map((c) => ({
      attribute: c.attribute,
      field: c.field,
      op: c.op,
      before: c.from,
      posted: c.to,
      after: null,
      beforeAvailable: c.sourceAvailable,
      afterAvailable: false
    }))
  };
}

module.exports = { computeChanges, computeAppliedChanges, computeReview, parsePatchValues, buildCurrentAmazonAttrs, buildCurrentValue, latestObservedAttrs, formatEnvelope, ATTR_TO_FIELD };
