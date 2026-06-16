// The reconciliation comparator. Compares the attribute values we PUSHED
// (expected) against what Amazon reports LIVE (observed, from a Listings Items
// GET). Amazon frequently echoes values back reshaped — re-ordered entries,
// numbers as strings, added/normalized units, casing on enums — so a naive
// deep-equal produces false drift. This module normalizes both sides into a
// canonical comparable form first.
//
// IMPORTANT: this is the one genuinely fuzzy part of the system. It is meant to
// run in log-only mode first (RECON_ALERT_ENABLED=false) so real Amazon
// responses can be inspected and the rules below tuned before drift alerts are
// trusted. Keep it conservative: prefer a missed drift over a false alarm.

// Keys that are pure addressing/metadata and never carry the business value;
// ignoring them avoids drift when Amazon adds/normalizes them.
const META_KEYS = new Set(['marketplace_id']);

function isNumericString(s) {
  return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s.trim());
}

function normalizeScalar(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Math.round(v * 10000) / 10000;
  if (typeof v === 'boolean') return v;
  if (isNumericString(v)) return Math.round(Number(v) * 10000) / 10000;
  // collapse internal whitespace + trim so cosmetic spacing isn't drift.
  return String(v).replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (META_KEYS.has(key)) continue;
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return normalizeScalar(value);
}

// "Is what we pushed still reflected on Amazon?" — a CONTAINMENT check rather
// than strict equality. Amazon enriches the values it echoes back (adds
// language_tag, marketplace_id, units, currency, etc.), so we only require
// that every value WE set is still present; extra keys Amazon added are fine.
//   - scalars: normalized-equal
//   - objects: every key in `expected` is contained in `observed` (observed
//     may carry additional keys)
//   - arrays:  every `expected` entry is contained in SOME `observed` entry,
//     order-insensitive (single-entry attributes dominate; this also tolerates
//     Amazon re-ordering multi-entry attributes like bullets)
function contains(expected, observed) {
  const e = normalize(expected);
  const o = normalize(observed);
  return containsNorm(e, o);
}

function containsNorm(e, o) {
  if (Array.isArray(e)) {
    if (!Array.isArray(o)) return false;
    return e.every((ei) => o.some((oi) => containsNorm(ei, oi)));
  }
  if (e && typeof e === 'object') {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    return Object.keys(e).every((k) => k in o && containsNorm(e[k], o[k]));
  }
  return e === o;
}

// Back-compat alias: equality in the reconciliation sense is "expected is still
// reflected in observed".
function equal(expected, observed) {
  return contains(expected, observed);
}

// Compare expected (map attrName -> value) against an observed listing's
// attributes map. Returns { match, diffs[], checkedAttrNames[] }.
//   diffs: [{ attr, reason: 'value_mismatch'|'missing_on_amazon', expected, observed }]
function diffAttributes(expected, observedAttributes) {
  const observed = observedAttributes || {};
  const diffs = [];
  const checkedAttrNames = Object.keys(expected || {});

  for (const attr of checkedAttrNames) {
    const exp = expected[attr];
    const obs = observed[attr];
    if (obs === undefined) {
      diffs.push({ attr, reason: 'missing_on_amazon', expected: exp, observed: null });
      continue;
    }
    if (!contains(exp, obs)) {
      diffs.push({ attr, reason: 'value_mismatch', expected: exp, observed: obs });
    }
  }
  return { match: diffs.length === 0, diffs, checkedAttrNames };
}

module.exports = { diffAttributes, normalize, equal, contains };
