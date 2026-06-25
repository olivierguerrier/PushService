// Sibling-ASIN attribute repurposing for the AI error resolver.
//
// When a push fails because required attributes are missing AND Battat's own
// source-of-truth data (PIM/pricing/product) has no value to ground them with,
// the same ASIN often already carries those values on ANOTHER accepted record:
// a different vendor code, SKU, or marketplace that was pushed and applied. This
// module gathers candidate values for the failing attributes from those sibling
// records (and, as a last resort, from Amazon's live catalogue for the ASIN),
// re-shapes them to the target listing's marketplace, and trims them to the
// product type schema.
//
// These values are NEVER auto-applied. They flow into the resolver's proposal
// (with explicit provenance) for an operator to review/approve, because — unlike
// Battat PIM — they originate from another vendor's listing and must be scrutinized
// by a human before they reach Amazon under this vendor code.
//
// Priority order:
//   1. Accepted push_submissions rows for the same ASIN (DB), ranked so a row in
//      the same marketplace + product type wins, then same marketplace, then
//      same product type, then any, most-recent first.
//   2. Amazon Catalog Items attributes for the ASIN (live SP-API), only when the
//      catalogue fallback is enabled and no DB sibling supplied the attribute.
'use strict';

const { resolveByCode } = require('../../config/marketplaces');
const { languageTagFor } = require('../../config/languages');
const translator = require('../translator');
const packageValidator = require('../packageValidator');
const submissions = require('../submissions');
const catalogItems = require('../spapi/catalogItems');
const env = require('../../config/env');

function parseJson(s) {
  if (s == null || s === '') return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// Pull the raw attribute value (Amazon envelope — usually an array of value
// objects) for `attrName` out of one stored submission row. We prefer the
// attribute as it was SUBMITTED (request_body_json), then fall back to the
// listing state captured before the write (prior_state_json.attributes).
function envelopeFromSubmissionRow(row, attrName) {
  if (!row) return null;
  const body = parseJson(row.request_body_json);
  if (body) {
    const patches = Array.isArray(body.patches) ? body.patches : null;
    if (patches) {
      for (const p of patches) {
        if (!p || !p.path) continue;
        if ((p.op === 'add' || p.op === 'replace') && p.value != null
          && packageValidator.attrNameFromPatchPath(p.path) === attrName) {
          return p.value;
        }
      }
    }
    // Feed payloads: { header, messages: [{ attributes: { name: envelope } }] }
    const messages = Array.isArray(body.messages)
      ? body.messages
      : (body.payload && Array.isArray(body.payload.messages) ? body.payload.messages : null);
    if (messages) {
      for (const m of messages) {
        const attrs = m && m.attributes;
        if (attrs && attrs[attrName] != null) return attrs[attrName];
      }
    }
  }
  const prior = parseJson(row.prior_state_json);
  if (prior && prior.attributes && prior.attributes[attrName] != null) return prior.attributes[attrName];
  return null;
}

// Full attribute map (name -> raw envelope) carried by one stored submission,
// pulled from its submitted package (patches or feed messages) then topped up
// from the listing state captured before the write. Used to score how
// "complete" a sibling vendor's record is and to borrow its values wholesale.
function attributesFromSubmissionRow(row) {
  const out = {};
  if (!row) return out;
  const body = parseJson(row.request_body_json);
  if (body) {
    if (Array.isArray(body.patches)) {
      for (const p of body.patches) {
        if (!p || !p.path) continue;
        const nm = packageValidator.attrNameFromPatchPath(p.path);
        if (nm && (p.op === 'add' || p.op === 'replace') && p.value != null && !(nm in out)) out[nm] = p.value;
      }
    }
    const messages = Array.isArray(body.messages)
      ? body.messages
      : (body.payload && Array.isArray(body.payload.messages) ? body.payload.messages : null);
    if (messages) {
      for (const m of messages) {
        const attrs = m && m.attributes;
        if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null && !(k in out)) out[k] = v;
      }
    }
  }
  const prior = parseJson(row.prior_state_json);
  if (prior && prior.attributes) {
    for (const [k, v] of Object.entries(prior.attributes)) if (v != null && !(k in out)) out[k] = v;
  }
  return out;
}

// Re-shape a borrowed envelope onto the target marketplace: rewrite any
// marketplace_id to the target's and any language_tag to the target language.
// Accepts an array of value objects or a single object; returns an array.
function reshapeEnvelope(envelope, { marketplaceId, languageTag }) {
  let arr = envelope;
  if (!Array.isArray(arr)) {
    if (arr && typeof arr === 'object') arr = [arr];
    else return null;
  }
  const out = arr.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const e = { ...entry };
    if ('marketplace_id' in e) e.marketplace_id = marketplaceId;
    if ('language_tag' in e && languageTag) e.language_tag = languageTag;
    return e;
  });
  return out.length ? out : null;
}

// Re-shape to the target marketplace, then trim disallowed keys to the schema.
function shapeForTarget(raw, attrName, ctx, schemaPayload) {
  let envelope = reshapeEnvelope(raw, ctx);
  if (!envelope) return null;
  if (schemaPayload) {
    const trimmed = translator.trimEnvelopeToSchema(envelope, schemaPayload, attrName);
    if (trimmed && (!Array.isArray(trimmed) || trimmed.length)) envelope = trimmed;
  }
  if (!envelope || (Array.isArray(envelope) && !envelope.length)) return null;
  return envelope;
}

// Build repurposed candidate values for `attrNames` on the target ASIN.
//   returns { candidates: { attr: envelope }, provenance: { attr: label },
//             warnings: string[], usedCatalog: boolean }
async function buildSiblingCandidates({
  attrNames = [], asin, marketplaceCode, productType, excludeUuid = null, schemaPayload = null
} = {}) {
  const result = { candidates: {}, provenance: {}, warnings: [], usedCatalog: false };
  const names = [...new Set((attrNames || []).filter(Boolean).map(String))];
  if (!env.SIBLING_REPURPOSE_ENABLED) return result;
  if (!asin || !names.length) return result;

  const mp = resolveByCode(marketplaceCode);
  if (!mp) {
    result.warnings.push(`sibling repurpose skipped: unknown marketplace ${marketplaceCode}`);
    return result;
  }
  const ctx = { marketplaceId: mp.amazonMarketplaceId, languageTag: languageTagFor(marketplaceCode) };

  const remaining = new Set(names);

  // 1) Accepted DB siblings (ranked by listAcceptedByAsin).
  let rows = [];
  try {
    rows = submissions.listAcceptedByAsin(asin, { excludeUuid, marketplaceCode, productType, limit: 50 }) || [];
  } catch (err) {
    result.warnings.push(`sibling DB lookup failed: ${err.message}`);
  }
  for (const row of rows) {
    if (!remaining.size) break;
    for (const name of [...remaining]) {
      const raw = envelopeFromSubmissionRow(row, name);
      if (raw == null) continue;
      const shaped = shapeForTarget(raw, name, ctx, schemaPayload);
      if (!shaped) continue;
      result.candidates[name] = shaped;
      result.provenance[name] = `sibling:${row.submission_uuid} vendor ${row.vendor_code || '?'} (${row.marketplace_code || '?'})`;
      remaining.delete(name);
    }
  }

  // 2) Amazon Catalog Items fallback for whatever the DB siblings could not cover.
  if (remaining.size && env.SIBLING_REPURPOSE_USE_CATALOG) {
    try {
      const item = await catalogItems.getCatalogItem({ asin, marketplaceCode, includedData: ['attributes'] });
      const attrs = item && item.attributes ? item.attributes : null;
      if (attrs) {
        result.usedCatalog = true;
        for (const name of [...remaining]) {
          const raw = attrs[name];
          if (raw == null) continue;
          const shaped = shapeForTarget(raw, name, ctx, schemaPayload);
          if (!shaped) continue;
          result.candidates[name] = shaped;
          result.provenance[name] = `amazon-catalog:${asin}`;
          remaining.delete(name);
        }
      }
    } catch (err) {
      result.warnings.push(`catalog fallback failed: ${err.message}`);
    }
  }

  const count = Object.keys(result.candidates).length;
  if (count) {
    result.warnings.push(`repurposed ${count} attribute(s) from other records of ASIN ${asin} — these come from another vendor's listing/catalogue, review before approving`);
  }
  return result;
}

module.exports = {
  buildSiblingCandidates,
  attributesFromSubmissionRow,
  // exposed for tests
  _internal: { envelopeFromSubmissionRow, reshapeEnvelope, shapeForTarget }
};
