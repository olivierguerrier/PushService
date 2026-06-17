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
const { referenceForCodes } = require('./spapi/errorCodeReference');

// Cap big blobs so a single review can't blow the prompt budget.
const MAX_SCHEMA_ATTRS = 40;
const MAX_JSON_CHARS = 24000;

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

  // Product type schema (trimmed to the attributes in play).
  let trimmedSchema = null;
  let allowedAttributeNames = [];
  if (submission.product_type && submission.marketplace_code) {
    try {
      const schemaPayload = await productTypes.getSchema({
        productType: submission.product_type,
        marketplaceCode: submission.marketplace_code
      });
      allowedAttributeNames = productTypes.listAttributeNames(schemaPayload);
      const names = relevantAttributeNames({ details, requestBody, liveAttributes });
      trimmedSchema = extractSchemaForAttributes(schemaPayload, names);
    } catch (err) {
      gatherWarnings.push(`product type schema unavailable: ${err.message}`);
    }
  } else {
    gatherWarnings.push('product type schema not read: missing productType/marketplace');
  }

  // Fresh PIM/pricing snapshot (source of truth values the model may need).
  let snapshot = null;
  if (submission.item_number || submission.asin) {
    try {
      const built = await sotClient.buildSnapshot({
        itemNumber: submission.item_number,
        productId: (flyappMeta && (flyappMeta.productId || flyappMeta.product_id)) || null,
        asin: submission.asin,
        marketplaceCode: submission.marketplace_code
      });
      snapshot = built.snapshot;
      if (built.warnings && built.warnings.length) gatherWarnings.push(...built.warnings.map((w) => `snapshot: ${w}`));
    } catch (err) {
      gatherWarnings.push(`source snapshot unavailable: ${err.message}`);
    }
  } else {
    gatherWarnings.push('source snapshot not built: missing item_number/asin');
  }

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
    flyapp_meta: capped(flyappMeta),
    gather_warnings: gatherWarnings
  };

  return { details, codes, requestBody, gatherWarnings, promptPayload };
}

function systemPrompt() {
  return [
    'You are a senior Amazon Selling Partner API (SP-API) listings specialist for Battat, an established toy manufacturer.',
    'A push submission to Amazon FAILED. Your job is to (1) diagnose the root cause from the Amazon issues, and (2) draft a CORRECTED SP-API package that resolves the error, for a human operator to review and approve. You never push to Amazon yourself.',
    '',
    'Inputs you are given (in the DATA payload):',
    '  - submission: the listing coordinates (asin, sku, vendor_code, marketplace, product_type) and the operation used (patchItem or submitJsonListingsFeed).',
    '  - amazon_issues: the structured issues Amazon returned (code, message, severity, attributeNames).',
    '  - error_code_reference: a curated meaning + typical fix for each issue code. Use it to ground your diagnosis.',
    '  - submitted_package: the exact package that was submitted and rejected.',
    '  - live_listing_attributes: the current attribute state of the listing on Amazon (may be null).',
    '  - product_type_schema: the trimmed Product Type Definition for the attributes in play — the AUTHORITY on valid shape/enums/units/required-ness.',
    '  - allowed_attribute_names: every attribute name valid for this product type. NEVER emit an attribute not in this list.',
    '  - source_snapshot: fresh PIM/pricing values from Battat\'s source of truth (dimensions, weights, brand, manufacturer, pricing, etc.).',
    '',
    'Rules:',
    '  1. Build the corrected package using the SAME operation as the submission unless the error clearly requires switching.',
    '  2. For patchItem, output JSON-Patch operations targeting /attributes/<name>. For submitJsonListingsFeed, output messages[] each with { sku, attributes }.',
    '  3. Emit ONLY attributes valid for the product type (present in allowed_attribute_names) and shaped EXACTLY as product_type_schema requires (arrays of objects with value + marketplace_id + units where applicable).',
    '  4. For "required but missing" errors, fill the value from source_snapshot. If the needed value is genuinely absent from every input, DO NOT invent it — list it in `unresolved` with the field name and why.',
    '  5. For transient codes (e.g. 4000000) or "already listed" no-ops, set resolvable=false and explain; do not fabricate attribute changes.',
    '  6. Keep the package minimal — change only what is needed to clear the reported issues.',
    '  7. In `changed_attr_names`, list the attribute names your package modifies. In `diagnosis`/`root_cause`, cite the specific issue code(s) you are addressing.',
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
    '    "unresolved": [ { "field": string, "reason": string } ],',
    '    "warnings": string[]',
    '  }',
    'Return ONLY the JSON object, no prose, no markdown fences.'
  ].join('\n');
}

async function callModel({ systemMsg, userPayload, model }) {
  const OpenAI = loadOpenAI();
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
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
  const proposedPackage = normalizePackage(output, operation);
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
    ...((validation && validation.warnings) || [])
  ];

  const rec = aiResolutions.upsert(submissionUuid, {
    status: 'PROPOSED',
    diagnosis: output.diagnosis || null,
    root_cause: output.root_cause || null,
    confidence: Number.isFinite(output.confidence) ? output.confidence : null,
    resolvable: !!output.resolvable && hasContent,
    operation,
    proposed_package: proposedPackage,
    changed_attr_names: Array.isArray(output.changed_attr_names) && output.changed_attr_names.length
      ? output.changed_attr_names
      : (validation ? validation.changedAttrNames : []),
    unresolved: Array.isArray(output.unresolved) ? output.unresolved : [],
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
  _internal: { systemPrompt, normalizePackage, extractSchemaForAttributes, relevantAttributeNames }
};
