// AI error resolver. Reviews a FAILED push submission, diagnoses the Amazon
// error, and drafts a corrected SP-API package the operator can review, edit,
// approve, and push. The model NEVER writes to Amazon — it only produces a
// proposal that is persisted in ai_resolutions for human approval.
//
// Mirrors FlyApp's OpenAI integration (services/historicalListings/llmAssess.js):
// load the openai SDK lazily, prefer the Responses API and fall back to Chat
// Completions, and retry on transient (408/409/425/429/5xx) errors.
//
// Grounding the model: we feed it (1) the persisted failure envelope (issues +
// raw Amazon response + the package that was submitted), (2) a curated SP-API
// error-code reference, (3) the live Listings item state, (4) the trimmed
// Product Type schema for the attributes in play, and (5) a fresh PIM/pricing
// snapshot so it can fill required-but-missing values from the source of truth
// instead of inventing them.
'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const submissions = require('./submissions');
const aiResolutions = require('./aiResolutions');
const errorReport = require('./errorReport');
const packageValidator = require('./packageValidator');
const listingsItems = require('./spapi/listingsItems');
const productTypes = require('./spapi/productTypes');
const sotClient = require('./sot/sotClient');
const la = require('./sot/listingAppClient');
const attributeSourceMap = require('./sot/attributeSourceMap');
const siblingAttributeSource = require('./sot/siblingAttributeSource');
const openaiCredentials = require('./openaiCredentials');
const { referenceForCodes } = require('./spapi/errorCodeReference');

// Cap big blobs so a single review can't blow the prompt budget.
const MAX_SCHEMA_ATTRS = 40;
const MAX_JSON_CHARS = 24000;
// Per-row cap for raw source-of-truth rows (PIM/pricing/product). Each row can
// carry 150+ columns; we drop empties and cap the rest so the full context is
// available without blowing the prompt budget.
const MAX_ROW_CHARS = 12000;

function isEnabled() {
  return !!env.OPENAI_RESOLVER_ENABLED;
}

function loadOpenAI() {
  let OpenAI;
  try { OpenAI = require('openai'); }
  catch (e) { throw new Error('openai SDK not installed. Run `npm install openai`.'); }
  return OpenAI.OpenAI || OpenAI.default || OpenAI;
}

function parseJson(s) {
  if (s == null || s === '') return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function hash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// Trim arbitrarily large objects for the prompt: stringify, and if oversized,
// replace with a short marker so we never ship a multi-MB blob to the model.
function capped(value, max = MAX_JSON_CHARS) {
  if (value == null) return null;
  let json;
  try { json = JSON.stringify(value); } catch { return null; }
  if (json.length <= max) return value;
  return { __truncated: true, bytes: json.length, preview: json.slice(0, max) };
}

// Trim a raw source row (PIM/pricing/product) for the prompt: drop null/empty/
// blank fields so the model sees only fields that actually carry a value, then
// apply the per-row cap. Returns null when the row has no usable content.
function compactRow(row, max = MAX_ROW_CHARS) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  if (!Object.keys(out).length) return null;
  return capped(out, max);
}

// Pull the per-attribute schema definitions for just the attributes in play so
// the model sees the exact shape/enum/required-ness it must satisfy, without
// shipping the entire (often huge) product type schema.
function extractSchemaForAttributes(schemaPayload, names) {
  if (!schemaPayload || !schemaPayload.schema) return null;
  const props = schemaPayload.schema.properties || {};
  const required = Array.isArray(schemaPayload.schema.required) ? schemaPayload.schema.required : [];
  const picked = {};
  let n = 0;
  for (const name of names) {
    if (n >= MAX_SCHEMA_ATTRS) break;
    if (props[name] && !(name in picked)) {
      picked[name] = capped(props[name], 6000);
      n++;
    }
  }
  return {
    productType: schemaPayload.productType || null,
    productTypeVersion: schemaPayload.productTypeVersion || null,
    schemaVersion: schemaPayload.schemaVersion || null,
    required_attributes: required,
    attribute_definitions: picked
  };
}

// Names of every attribute that matters for this fix: the ones the issues
// blame, the ones already present in the submitted package, and the ones live
// on Amazon. The trimmed schema is built from this set.
function relevantAttributeNames({ details, requestBody, liveAttributes }) {
  const set = new Set();
  for (const d of details || []) {
    for (const a of (d.attributeNames || [])) if (a) set.add(String(a));
  }
  const patches = requestBody && Array.isArray(requestBody.patches) ? requestBody.patches : [];
  for (const p of patches) {
    const nm = packageValidator.attrNameFromPatchPath(p && p.path);
    if (nm) set.add(nm);
  }
  const payload = requestBody && requestBody.payload;
  const messages = payload && Array.isArray(payload.messages) ? payload.messages
    : (requestBody && Array.isArray(requestBody.messages) ? requestBody.messages : []);
  for (const m of messages) {
    for (const k of Object.keys((m && m.attributes) || {})) set.add(k);
  }
  if (liveAttributes && typeof liveAttributes === 'object') {
    for (const k of Object.keys(liveAttributes)) set.add(k);
  }
  return [...set];
}

// Walk the resolves_uuid chain backwards (this submission -> the failure it was
// trying to fix -> that one's parent, ...) and assemble the cumulative history.
//
// This is the heart of "build on yourself": each prior fix attempt was REJECTED
// ATOMICALLY by Amazon, so none of its changes persisted. When a fix for error
// A (e.g. missing package_level) re-pushes and Amazon then surfaces error B
// (e.g. a weight discrepancy), the next package must STILL carry the package_level
// correction AND fix the weight — otherwise we ping-pong between the two errors.
// We give the model every prior error + attempted package + diagnosis, plus the
// union of attributes touched so far, so it can produce one cumulative package.
function buildResolutionHistory(submission, { maxDepth = 8 } = {}) {
  const ancestors = [];
  const seen = new Set([submission.submission_uuid]);
  let cur = submission;
  while (cur && cur.resolves_uuid && !seen.has(cur.resolves_uuid) && ancestors.length < maxDepth) {
    const parent = submissions.getByUuid(cur.resolves_uuid);
    if (!parent) break;
    seen.add(parent.submission_uuid);
    ancestors.unshift(parent); // oldest first
    cur = parent;
  }

  const entries = [];
  const cumulative = new Set();
  for (const a of ancestors) {
    const details = errorReport.summarizeErrorDetails({
      issues_json: a.issues_json,
      amazon_response_json: a.amazon_response_json
    });
    const resRow = aiResolutions.getBySubmission(a.submission_uuid);
    const resRec = resRow ? aiResolutions.toRecord(resRow) : null;
    const changed = (resRec && resRec.changedAttrNames) || [];
    for (const n of changed) cumulative.add(n);
    entries.push({
      submission_uuid: a.submission_uuid,
      status: a.status,
      operation: a.operation,
      error_codes: [...new Set(details.map((d) => d.code).filter(Boolean).map(String))],
      amazon_issues: details,
      attempted_package: capped(parseJson(a.raw_package_json) || parseJson(a.request_body_json), 8000),
      ai_diagnosis: resRec ? resRec.diagnosis : null,
      ai_changed_attr_names: changed,
      // The fix package proposed for THIS step (i.e. what the next attempt then
      // carried forward). Lets the model see exactly what each prior fix added.
      ai_fix_package: resRec ? capped(resRec.proposedPackage, 8000) : null
    });
  }
  return { entries, cumulativeChangedAttrs: [...cumulative], depth: entries.length };
}

// Assemble the full context object (and the prompt payload derived from it)
// for one failed submission. Every external fetch is best-effort: a failure is
// recorded as a gather warning and the review proceeds on whatever is available.
async function gatherContext(submission) {
  const gatherWarnings = [];
  const details = errorReport.summarizeErrorDetails({
    issues_json: submission.issues_json,
    amazon_response_json: submission.amazon_response_json
  });
  const codes = [...new Set(details.map((d) => d.code).filter(Boolean).map(String))];
  const requestBody = parseJson(submission.request_body_json) || {};
  const rawPackage = parseJson(submission.raw_package_json);
  const flyappMeta = parseJson(submission.flyapp_meta_json);

  // Resolution chain: if this failure is itself an AI-resolved re-push, walk
  // back to the original error so the model can build cumulatively.
  const history = buildResolutionHistory(submission);
  if (history.depth) {
    gatherWarnings.push(`this is attempt #${history.depth + 1} in a resolution chain — the corrected package MUST be cumulative (retain every prior fix AND solve the current error)`);
  }

  // Live Amazon listing (current attribute state + issues).
  let liveListing = null;
  let liveAttributes = null;
  if (submission.vendor_code && (submission.effective_sku || submission.sku)) {
    try {
      liveListing = await listingsItems.getItem({
        sellerId: submission.vendor_code,
        sku: submission.effective_sku || submission.sku,
        marketplaceCode: submission.marketplace_code,
        includedData: ['summaries', 'attributes', 'issues']
      });
      liveAttributes = liveListing && liveListing.attributes ? liveListing.attributes : null;
    } catch (err) {
      gatherWarnings.push(`live listing read failed: ${err.message}`);
    }
  } else {
    gatherWarnings.push('live listing not read: missing vendor_code/sku coordinates');
  }

  // Product type schema (trimmed to the attributes in play). We keep the FULL
  // schemaPayload too (returned in the context) so the deterministic grounding
  // step can shape each envelope exactly to the product type.
  let trimmedSchema = null;
  let allowedAttributeNames = [];
  let schemaPayload = null;
  if (submission.product_type && submission.marketplace_code) {
    try {
      schemaPayload = await productTypes.getSchema({
        productType: submission.product_type,
        marketplaceCode: submission.marketplace_code
      });
      allowedAttributeNames = productTypes.listAttributeNames(schemaPayload);
      const names = relevantAttributeNames({ details, requestBody, liveAttributes });
      // Also include attributes touched anywhere in the resolution chain so the
      // model still sees the schema shape for prior fixes it must carry forward.
      for (const n of history.cumulativeChangedAttrs) if (!names.includes(n)) names.push(n);
      trimmedSchema = extractSchemaForAttributes(schemaPayload, names);
    } catch (err) {
      gatherWarnings.push(`product type schema unavailable: ${err.message}`);
    }
  } else {
    gatherWarnings.push('product type schema not read: missing productType/marketplace');
  }

  // Fresh PIM/pricing snapshot (source of truth values the model may need).
  // We keep BOTH the normalized snapshot AND the raw source rows: the raw PIM
  // row carries 150+ columns (materials, age grade, gender, keywords, ...) that
  // the narrow snapshot omits but that Amazon often requires. The model maps
  // those raw fields onto attributes instead of inventing placeholders.
  const productId = (flyappMeta && (flyappMeta.productId || flyappMeta.product_id)) || null;
  let snapshot = null;
  let pimRaw = null;
  let pricingRaw = null;
  let contentRaw = null;
  // Raw (uncompacted) rows kept for the deterministic grounding step, which
  // reads exact values rather than the prompt-trimmed view.
  let pimRowRaw = null;
  let pricingRowRaw = null;
  if (submission.item_number || submission.asin) {
    try {
      const built = await sotClient.buildSnapshot({
        itemNumber: submission.item_number,
        productId,
        asin: submission.asin,
        marketplaceCode: submission.marketplace_code
      });
      snapshot = built.snapshot;
      if (built.sources) {
        pimRowRaw = built.sources.pim || null;
        pricingRowRaw = built.sources.pricing || null;
        pimRaw = compactRow(built.sources.pim);
        pricingRaw = compactRow(built.sources.pricing);
        contentRaw = built.sources.content || null;
      }
      if (built.warnings && built.warnings.length) gatherWarnings.push(...built.warnings.map((w) => `snapshot: ${w}`));
    } catch (err) {
      gatherWarnings.push(`source snapshot unavailable: ${err.message}`);
    }
  } else {
    gatherWarnings.push('source snapshot not built: missing item_number/asin');
  }

  // Full product row (one row per product) from ListingApp — adds brand /
  // identity / lifecycle context beyond the PIM item row.
  let productRaw = null;
  let productRowRaw = null;
  if (productId != null || submission.item_number) {
    try {
      const prod = await la.getProductRecord({ productId, itemNumber: submission.item_number });
      productRowRaw = prod || null;
      productRaw = compactRow(prod);
      if (!prod) gatherWarnings.push('no product row matched product_id/item_number');
    } catch (err) {
      gatherWarnings.push(`product row unavailable: ${err.message}`);
    }
  } else {
    gatherWarnings.push('product row not read: missing product_id/item_number');
  }

  // Sibling-ASIN repurposing: for the attributes Amazon's issues blame, gather
  // candidate values from OTHER accepted records of this same ASIN (different
  // vendor code / SKU / marketplace) and, as a last resort, from Amazon's live
  // catalogue. These fill gaps Battat PIM cannot ground, and are surfaced (with
  // provenance) for operator review — never auto-applied.
  const issueAttrNames = new Set();
  for (const d of details || []) {
    for (const a of (d.attributeNames || [])) if (a) issueAttrNames.add(String(a));
  }
  let siblings = { candidates: {}, provenance: {} };
  if (issueAttrNames.size) {
    try {
      const sib = await siblingAttributeSource.buildSiblingCandidates({
        attrNames: [...issueAttrNames],
        asin: submission.asin,
        marketplaceCode: submission.marketplace_code,
        productType: submission.product_type,
        excludeUuid: submission.submission_uuid,
        schemaPayload
      });
      siblings = { candidates: sib.candidates, provenance: sib.provenance };
      if (sib.warnings && sib.warnings.length) gatherWarnings.push(...sib.warnings);
    } catch (err) {
      gatherWarnings.push(`sibling repurpose unavailable: ${err.message}`);
    }
  }

  // Namespaced source bag used by the deterministic grounding step
  // (attributeSourceMap.buildGroundedPackage).
  const sources = {
    pim: pimRowRaw,
    pricing: pricingRowRaw,
    product: productRowRaw,
    content: contentRaw,
    snapshot,
    live: liveAttributes,
    siblings
  };

  const promptPayload = {
    submission: {
      submission_uuid: submission.submission_uuid,
      scope: submission.scope,
      operation: submission.operation,
      asin: submission.asin,
      sku: submission.sku,
      effective_sku: submission.effective_sku || null,
      vendor_code: submission.vendor_code,
      item_number: submission.item_number,
      marketplace_code: submission.marketplace_code,
      product_type: submission.product_type,
      status: submission.status,
      error_message: submission.error_message || null
    },
    amazon_issues: details,
    error_code_reference: referenceForCodes(codes),
    submitted_package: capped(rawPackage || requestBody),
    live_listing_attributes: capped(liveAttributes),
    product_type_schema: capped(trimmedSchema),
    allowed_attribute_names: allowedAttributeNames,
    source_snapshot: capped(snapshot),
    // Full Battat source-of-truth context. source_snapshot is the convenient
    // normalized view (a small mapped subset); source_of_truth carries the raw
    // rows so the model can ground EVERY required value in a real field instead
    // of inventing placeholders. snapshot is the normalized subset, *_raw are
    // the unmapped rows straight from ListingApp.
    source_of_truth: {
      snapshot: capped(snapshot),
      pim_raw: pimRaw,
      pricing_raw: pricingRaw,
      product_raw: productRaw,
      content: capped(contentRaw)
    },
    flyapp_meta: capped(flyappMeta),
    // Cumulative resolution context. is_resolution_chain=true means earlier
    // fixes were attempted (and rejected atomically) — resolution_chain lists
    // them oldest-first, and cumulative_changed_attributes is the union of every
    // attribute corrected so far that the new package must retain.
    is_resolution_chain: history.depth > 0,
    resolution_chain: history.entries,
    cumulative_changed_attributes: history.cumulativeChangedAttrs,
    gather_warnings: gatherWarnings
  };

  return { details, codes, requestBody, history, gatherWarnings, promptPayload, sources, schemaPayload };
}

function systemPrompt() {
  return [
    'You are a senior Amazon Selling Partner API (SP-API) listings specialist for Battat, an established toy manufacturer.',
    'A push submission to Amazon FAILED. Your job is to (1) diagnose the root cause from the Amazon issues, and (2) decide WHICH attributes must be set/corrected to resolve the error. You never push to Amazon yourself.',
    '',
    'IMPORTANT — HOW VALUES ARE FILLED: You do NOT supply attribute VALUES. The service fills every value DETERMINISTICALLY from Battat\'s source-of-truth data using a fixed field mapping, and OMITS any attribute it cannot source. Your job is to identify the attribute NAMES the error requires (in changed_attr_names) and to diagnose the cause. Do NOT invent or guess values — any value you put in proposed_package is ignored and replaced by the mapped source value (or dropped if none exists). This is the guardrail that stops fabricated values like a made-up manufacturer, material, dimensions, or price from ever reaching the package.',
    '',
    'Inputs you are given (in the DATA payload):',
    '  - submission: the listing coordinates (asin, sku, vendor_code, marketplace, product_type) and the operation used (patchItem or submitJsonListingsFeed).',
    '  - amazon_issues: the structured issues Amazon returned (code, message, severity, attributeNames).',
    '  - error_code_reference: a curated meaning + typical fix for each issue code. Use it to ground your diagnosis.',
    '  - submitted_package: the exact package that was submitted and rejected.',
    '  - live_listing_attributes: the current attribute state of the listing on Amazon (may be null).',
    '  - product_type_schema: the trimmed Product Type Definition for the attributes in play — the AUTHORITY on valid shape/enums/units/required-ness.',
    '  - allowed_attribute_names: every attribute name valid for this product type. NEVER emit an attribute not in this list.',
    '  - source_snapshot: a small NORMALIZED subset of Battat\'s source of truth (dimensions, weights, brand, manufacturer, pricing, etc.) — convenient but incomplete.',
    '  - source_of_truth: the FULL Battat product context from ListingApp. This is your authoritative data. It contains:',
    '      • snapshot   — same normalized subset as source_snapshot.',
    '      • pim_raw     — the complete raw PIM row (item_numbers) with 150+ columns: materials, age grade/range, gender, item type, container/pack quantities, safety warnings, dimensions, weights, country of origin, identifiers, and more. Field names are snake_case Battat columns (e.g. material_composition, age_grade_min_months, target_gender, item_type, legal_name, series).',
    '      • pricing_raw — the raw seasonal pricing row (retail_price, sell_price, season, currency, ...).',
    '      • product_raw — the raw product row (brand, identity, lifecycle, customer cross-references, ...).',
    '      • content     — listing copy (title/description/bullets) when a content source is configured.',
    '    Empty/null fields are stripped, so any field PRESENT carries a real value. These rows are the ONLY legitimate source for required-but-missing values.',
    '  - is_resolution_chain / resolution_chain / cumulative_changed_attributes: present when this failure is itself the result of an earlier AI fix. resolution_chain lists every prior attempt (oldest first) with the error it hit, the package that was tried, and the diagnosis.',
    '',
    'Rules:',
    '  1. Use the SAME operation as the submission unless the error clearly requires switching (set the operation field accordingly).',
    '  2. In `changed_attr_names`, list EVERY attribute name the error requires to be set/corrected. Use ONLY names present in allowed_attribute_names. This list is what the service acts on — be complete but do not pad it with attributes the error does not require.',
    '  3. NEVER invent, guess, or use placeholder/dummy values anywhere (no "N/A", no "Unknown", no fabricated enums, no made-up weights/dimensions/prices/manufacturer/material). Even if you populate proposed_package, those values are discarded — the service re-derives each value from the mapped Battat source field. So focus your effort on naming the right attributes, not on guessing values.',
    '  4. The service will OMIT any attribute it cannot ground in real source data and report it under `unresolved` for a human to complete. That is the correct, safe outcome — a smaller, fully-grounded package is always preferred over one padded with invented values.',
    '  5. For transient codes (e.g. 4000000) or "already listed" no-ops, set resolvable=false and explain; do not request attribute changes.',
    '  6. In `diagnosis`/`root_cause`, cite the specific issue code(s) you are addressing. You MAY still populate proposed_package and value_sources as hints, but understand the service treats them as advisory only.',
    '',
    'CUMULATIVE RESOLUTION (resolution chains) — CRITICAL:',
    '  - Amazon rejects each submission ATOMICALLY: when a package fails, NONE of its attribute changes persist on the listing. So a fix that resolved an earlier error did NOT actually stick if that same submission then failed on a different error.',
    '  - When is_resolution_chain is true, your corrected package MUST BE CUMULATIVE: it must re-include EVERY corrective change from the prior attempts (see resolution_chain[].attempted_package and cumulative_changed_attributes) AND additionally resolve the CURRENT error in amazon_issues.',
    '  - Concretely: if a prior attempt added package_level to fix error 90220, and this attempt now fails on a weight discrepancy (e.g. 90147), your package must STILL set package_level AND fix the weight values. Never drop an attribute that fixed an earlier error in the chain — that would just re-trigger that earlier error.',
    '  - Resolve internal contradictions using source_snapshot as the source of truth (e.g. if item_weight must be <= package_weight, set both to consistent values from the snapshot).',
    '  - Treat cumulative_changed_attributes as the minimum set of attributes your package must cover, then add whatever else the current error requires.',
    '',
    'Output: return a SINGLE JSON object with exactly these keys:',
    '  {',
    '    "diagnosis": string,            // 1-3 sentences, plain English',
    '    "root_cause": string,           // the underlying cause, citing code(s)',
    '    "confidence": integer 0-100,    // your confidence the package resolves the error',
    '    "resolvable": boolean,          // true only if you produced an actionable package',
    '    "operation": "patchItem" | "submitJsonListingsFeed",',
    '    "proposed_package": { "patches": [ { "op": "add|replace|delete", "path": "/attributes/<name>", "value": <any> } ] }  // OR { "messages": [ { "sku": string, "attributes": { ... } } ] }',
    '    "changed_attr_names": string[],',
    '    "value_sources": { "<attribute_name>": "<source field/path the value was read from>" },',
    '    "unresolved": [ { "field": string, "reason": string } ],',
    '    "warnings": string[]',
    '  }',
    'Return ONLY the JSON object, no prose, no markdown fences.'
  ].join('\n');
}

async function callModel({ systemMsg, userPayload, model }) {
  const apiKey = await openaiCredentials.getApiKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const OpenAI = loadOpenAI();
  const openai = new OpenAI({ apiKey });
  const userText = `${systemMsg}\n\nDATA:\n${JSON.stringify(userPayload)}`;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (openai.responses && typeof openai.responses.create === 'function') {
        const resp = await openai.responses.create({
          model,
          input: [{ role: 'user', content: [{ type: 'input_text', text: userText }] }],
          text: { format: { type: 'json_object' } }
        });
        const text = resp.output_text
          || (resp.output && resp.output[0] && resp.output[0].content && resp.output[0].content[0] && resp.output[0].content[0].text)
          || '{}';
        return JSON.parse(text);
      }
      const chat = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: `DATA:\n${JSON.stringify(userPayload)}` }
        ],
        response_format: { type: 'json_object' }
      });
      const txt = chat.choices && chat.choices[0] && chat.choices[0].message && chat.choices[0].message.content;
      return JSON.parse(txt || '{}');
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      if (status && ![408, 409, 425, 429, 500, 502, 503, 504].includes(status)) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1) ** 2));
    }
  }
  throw lastErr || new Error('LLM call failed');
}

// Coerce the model's package into the canonical thin-path shape for the
// resolved operation. Accepts the package nested under proposed_package or at
// the top level. Returns null when there is no actionable content.
function normalizePackage(output, operation) {
  const pp = (output && output.proposed_package) || output || {};
  if (operation === 'submitJsonListingsFeed') {
    const messages = Array.isArray(pp.messages) ? pp.messages
      : (Array.isArray(output && output.messages) ? output.messages : []);
    if (!messages.length) return null;
    return { messages };
  }
  const patches = Array.isArray(pp.patches) ? pp.patches
    : (Array.isArray(output && output.patches) ? output.patches : []);
  if (!patches.length) return null;
  const out = { patches };
  if (pp.productType) out.productType = pp.productType;
  return out;
}

function packageHasContent(pkg, operation) {
  if (!pkg) return false;
  if (operation === 'submitJsonListingsFeed') return Array.isArray(pkg.messages) && pkg.messages.length > 0;
  return Array.isArray(pkg.patches) && pkg.patches.length > 0;
}

// The attribute-bearing package a submission actually carried, read from its
// stored request body (post-validation, so it reflects exactly what was sent).
function packageFromSubmission(sub) {
  const body = parseJson(sub.request_body_json) || {};
  if (sub.operation === 'submitJsonListingsFeed') {
    const messages = (body.payload && Array.isArray(body.payload.messages)) ? body.payload.messages
      : (Array.isArray(body.messages) ? body.messages : []);
    return { messages };
  }
  return { patches: Array.isArray(body.patches) ? body.patches : [] };
}

// Full submission chain, oldest first, including the current submission.
function chainSubmissions(submission, { maxDepth = 8 } = {}) {
  const chain = [submission];
  const seen = new Set([submission.submission_uuid]);
  let cur = submission;
  while (cur && cur.resolves_uuid && !seen.has(cur.resolves_uuid) && chain.length <= maxDepth) {
    const parent = submissions.getByUuid(cur.resolves_uuid);
    if (!parent) break;
    seen.add(parent.submission_uuid);
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

// Merge a list of packages (oldest first) into one cumulative package so that no
// previously-corrected attribute is ever dropped. Later packages override
// earlier ones per attribute (patchItem) or per sku+attribute (feed). This is
// the DETERMINISTIC guarantee that resolutions are additive and stop ping-ponging
// between errors — it does not rely on the model complying with the prompt.
function mergeCumulativePackage(operation, packages) {
  const pkgs = (packages || []).filter(Boolean);
  if (!pkgs.length) return null;

  if (operation === 'submitJsonListingsFeed') {
    const bySku = new Map();
    for (const pkg of pkgs) {
      const msgs = Array.isArray(pkg.messages) ? pkg.messages : [];
      for (const m of msgs) {
        if (!m || !m.sku) continue;
        const prev = bySku.get(m.sku);
        const attributes = Object.assign({}, prev ? prev.attributes : {}, m.attributes || {});
        bySku.set(m.sku, Object.assign({}, prev || {}, m, { attributes }));
      }
    }
    const messages = [...bySku.values()];
    return messages.length ? { messages } : null;
  }

  const byKey = new Map();
  let productType = null;
  for (const pkg of pkgs) {
    if (pkg.productType) productType = pkg.productType;
    const patches = Array.isArray(pkg.patches) ? pkg.patches : [];
    for (const p of patches) {
      if (!p || !p.path) continue;
      const name = packageValidator.attrNameFromPatchPath(p.path);
      // Whole-attribute writes dedupe by attribute name; deeper (sub-path) ops
      // dedupe by full path so distinct sub-edits aren't collapsed together.
      const isWholeAttr = name && String(p.path).split('/').filter(Boolean).length === 2;
      byKey.set(isWholeAttr ? `attr:${name}` : `path:${p.path}`, p);
    }
  }
  const patches = [...byKey.values()];
  if (!patches.length) return null;
  const out = { patches };
  if (productType) out.productType = productType;
  return out;
}

// Validate a proposed package against the live product type schema. Returns a
// compact, persistable summary (never throws).
async function validateProposal({ pkg, operation, productType, marketplaceCode }) {
  try {
    const v = await packageValidator.validatePackage({
      pkg, operation, productType, marketplaceCode, allowUnknownAttributes: false
    });
    return {
      ok: v.ok,
      problems: v.problems || [],
      changedAttrNames: v.changedAttrNames || [],
      droppedAttrNames: v.droppedAttrNames || [],
      warnings: v.warnings || [],
      schemaMeta: v.schemaMeta || null
    };
  } catch (err) {
    return { ok: false, problems: [`validation error: ${err.message}`], changedAttrNames: [], droppedAttrNames: [], warnings: [], schemaMeta: null };
  }
}

// Public entry: review one FAILED submission and persist a proposal.
//   { force }       — bypass the cached resolution and re-run the model.
//   { reviewedBy }  — operator name to stamp on the resolution.
// Returns { ok, cached?, reason?, resolution } — never throws on LLM/data
// failures (those are persisted as a FAILED resolution).
async function reviewSubmission(submissionUuid, { force = false, reviewedBy = null } = {}) {
  if (!isEnabled()) return { ok: false, reason: 'resolver_disabled' };
  const submission = submissions.getByUuid(submissionUuid);
  if (!submission) return { ok: false, reason: 'submission_not_found' };
  // Archived errors are intentionally excluded from AI resolution: no fix is
  // assessed (single or batch) until an operator un-archives them.
  if (submission.archived_at) return { ok: false, reason: 'archived' };

  if (!force) {
    const existing = aiResolutions.getBySubmission(submissionUuid);
    if (existing) return { ok: true, cached: true, resolution: aiResolutions.toRecord(existing) };
  }

  const context = await gatherContext(submission);
  const model = env.OPENAI_MODEL;
  const systemMsg = systemPrompt();
  const inputHash = hash({ model, systemMsg, userPayload: context.promptPayload });

  let output = null;
  let callError = null;
  try {
    output = await callModel({ systemMsg, userPayload: context.promptPayload, model });
  } catch (err) {
    callError = err;
  }

  if (!output || typeof output !== 'object') {
    const rec = aiResolutions.upsert(submissionUuid, {
      status: 'FAILED',
      model,
      input_hash: inputHash,
      resolvable: false,
      error_message: callError ? callError.message : 'LLM produced no usable output',
      warnings: context.gatherWarnings
    });
    return { ok: false, reason: 'llm_failed', error: callError && callError.message, resolution: aiResolutions.toRecord(rec) };
  }

  const operation = (output.operation === 'submitJsonListingsFeed' || output.operation === 'patchItem')
    ? output.operation
    : submission.operation;

  // DETERMINISTIC GROUNDING. The model is trusted only to DIAGNOSE and to name
  // which attributes the error requires — never to supply their VALUES (left to
  // itself it invents placeholders like "Battat Inc." / "Plastic" / 1x1x1). We
  // take the union of the attributes Amazon's issues blame and the attributes
  // the model proposed, then fill each value DETERMINISTICALLY from Battat's
  // source-of-truth data via the fixed attributeSourceMap. Any attribute with
  // no mapped source value is OMITTED and reported as unresolved — nothing is
  // fabricated.
  const targetAttrNames = attributeSourceMap.collectTargetAttrNames({ details: context.details, output });
  const grounded = attributeSourceMap.buildGroundedPackage({
    attrNames: targetAttrNames,
    operation,
    sources: context.sources,
    marketplaceCode: submission.marketplace_code,
    schemaPayload: context.schemaPayload,
    sku: submission.effective_sku || submission.sku
  });
  let proposedPackage = grounded.package;
  const groundingNote = `values filled deterministically from Battat source data via field mapping — ${grounded.resolved.length} attribute(s) grounded, ${grounded.unresolved.length} omitted (no source value)`;

  // Make the package CUMULATIVE across the resolution chain. Amazon rejects
  // every failed submission atomically, so each prior AI fix's changes never
  // persisted — re-pushing only the latest error's fix re-triggers the earlier
  // error. We deterministically union the packages of every prior AI-fix attempt
  // in the chain (oldest first) under the new grounded proposal, so all
  // corrections accumulate instead of oscillating.
  let cumulativeNote = null;
  if (proposedPackage) {
    const fixPkgs = chainSubmissions(submission)
      .filter((s) => s.payload_origin === 'ai_resolved')
      .map(packageFromSubmission);
    if (fixPkgs.length) {
      const merged = mergeCumulativePackage(operation, [...fixPkgs, proposedPackage]);
      if (merged && packageHasContent(merged, operation)) {
        proposedPackage = merged;
        cumulativeNote = `package made cumulative over ${fixPkgs.length} prior AI-fix attempt(s) so earlier corrections are retained`;
      }
    }
  }
  const hasContent = packageHasContent(proposedPackage, operation);

  let validation = null;
  if (hasContent) {
    validation = await validateProposal({
      pkg: proposedPackage,
      operation,
      productType: submission.product_type,
      marketplaceCode: submission.marketplace_code
    });
  }

  const warnings = [
    ...(context.gatherWarnings || []),
    ...(Array.isArray(output.warnings) ? output.warnings : []),
    ...((validation && validation.warnings) || []),
    groundingNote,
    ...(cumulativeNote ? [cumulativeNote] : [])
  ];

  // Provenance is now CODE-generated: attribute -> the exact source field the
  // value was pulled from. Truthful by construction (the model no longer
  // supplies values), so a reviewer can audit every value back to real data.
  const valueSources = Object.keys(grounded.valueSources || {}).length ? grounded.valueSources : null;

  // Unresolved = attributes the fix needed but could not be grounded from any
  // source field. Merge the deterministic omissions with anything the model
  // flagged, deduped by field name (the grounded reason wins).
  const unresolvedByField = new Map();
  for (const u of (Array.isArray(output.unresolved) ? output.unresolved : [])) {
    if (u && u.field) unresolvedByField.set(String(u.field), { field: String(u.field), reason: u.reason || null });
  }
  for (const u of (grounded.unresolved || [])) {
    if (u && u.field) unresolvedByField.set(String(u.field), u);
  }
  const unresolved = [...unresolvedByField.values()];

  const rec = aiResolutions.upsert(submissionUuid, {
    status: 'PROPOSED',
    diagnosis: output.diagnosis || null,
    root_cause: output.root_cause || null,
    confidence: Number.isFinite(output.confidence) ? output.confidence : null,
    resolvable: !!output.resolvable && hasContent,
    operation,
    proposed_package: proposedPackage,
    // Prefer the validator's view (computed from the actual stored package, so
    // it reflects the cumulative merge) over the model's self-reported list.
    changed_attr_names: (validation && validation.changedAttrNames && validation.changedAttrNames.length)
      ? validation.changedAttrNames
      : grounded.resolved,
    value_sources: valueSources,
    unresolved,
    warnings,
    validation,
    model,
    input_hash: inputHash,
    reviewed_by: reviewedBy
  });

  return { ok: true, resolution: aiResolutions.toRecord(rec) };
}

module.exports = {
  isEnabled,
  reviewSubmission,
  gatherContext,
  // exposed for tests
  _internal: { systemPrompt, normalizePackage, extractSchemaForAttributes, relevantAttributeNames, buildResolutionHistory, chainSubmissions, packageFromSubmission, mergeCumulativePackage }
};
