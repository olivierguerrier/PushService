// Source-of-truth translator: a normalized SoT snapshot -> Amazon JSON
// Listings `attributes` map, plus helpers to turn that into Listings Items
// PATCH ops or a JSON_LISTINGS_FEED message.
//
// The envelope-building logic is ported from FlyApp's
// services/amazonSpApi/translator.js (the pure, DB-free parts). Unlike
// FlyApp, this service is handed a snapshot assembled by the SoT client —
// it does not read any database itself.
const productTypes = require('../spapi/productTypes');
const { resolveByCode } = require('../../config/marketplaces');
const { languageTagFor } = require('../../config/languages');

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// Battat field -> candidate Amazon attribute names (first the schema accepts
// wins). Same table as FlyApp so behaviour matches.
const FIELD_TO_AMAZON_ATTRS = {
  title: ['item_name'],
  description: ['product_description', 'rtip_product_description'],
  bullets: ['bullet_point'],
  brand: ['brand'],
  manufacturer: ['manufacturer'],
  upc: ['externally_assigned_product_identifier', 'external_product_id'],
  item_number: ['model_number'],
  item_dimensions: ['item_dimensions', 'item_length_width_height'],
  package_dimensions: ['item_package_dimensions'],
  item_weight: ['item_weight'],
  package_weight: ['item_package_weight'],
  main_image_url: ['main_product_image_locator'],
  alt_image_url_1: ['other_product_image_locator_1'],
  alt_image_url_2: ['other_product_image_locator_2'],
  alt_image_url_3: ['other_product_image_locator_3'],
  alt_image_url_4: ['other_product_image_locator_4'],
  alt_image_url_5: ['other_product_image_locator_5'],
  swatch_image_url: ['swatch_image_locator'],
  list_price: ['list_price'],
  cost_price: ['cost_price'],
  country_of_origin: ['country_of_origin'],
  package_level: ['package_level']
};

const PACKAGE_LEVEL_VALUES = new Set(['unit', 'case', 'pallet']);

// ── Envelope builders (each Amazon attribute is an array of value objects) ──
function envelopeText(value, { marketplaceId, languageTag }) {
  if (value == null || String(value).trim() === '') return null;
  return [{ value: String(value), language_tag: languageTag, marketplace_id: marketplaceId }];
}
function envelopeBullets(bullets, { marketplaceId, languageTag }) {
  const arr = Array.isArray(bullets) ? bullets : safeJson(bullets);
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.slice(0, 5)
    .map((b) => ({ value: String(b == null ? '' : b), language_tag: languageTag, marketplace_id: marketplaceId }))
    .filter((e) => e.value.trim());
}
function envelopeIdentifier(value, { marketplaceId, type = 'upc' }) {
  if (value == null || String(value).trim() === '') return null;
  return [{ type, value: String(value).trim(), marketplace_id: marketplaceId }];
}
function envelopeBrand(value, { marketplaceId, languageTag }) {
  if (value == null || String(value).trim() === '') return null;
  return [{ value: String(value), language_tag: languageTag, marketplace_id: marketplaceId }];
}
function envelopeModelNumber(value, { marketplaceId }) {
  if (value == null || String(value).trim() === '') return null;
  return [{ value: String(value), marketplace_id: marketplaceId }];
}
function envelopeImageLocator(url, { marketplaceId }) {
  if (!url) return null;
  return [{ media_location: String(url), marketplace_id: marketplaceId }];
}
function envelopeListPrice(value, { marketplaceId, currency }) {
  if (value == null || currency == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return [{ currency, marketplace_id: marketplaceId, value: Math.round(n * 100) / 100 }];
}
function envelopeCostPrice(value, { currency }) {
  if (value == null || currency == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return [{ currency, value: Math.round(n * 100) / 100 }];
}
function envelopePackageLevel(value, { marketplaceId }) {
  if (value == null) return null;
  const v = String(value).toLowerCase().trim();
  if (!PACKAGE_LEVEL_VALUES.has(v)) return null;
  return [{ value: v, marketplace_id: marketplaceId }];
}
function envelopeCountryOfOrigin(value, { marketplaceId }) {
  if (value == null || String(value).trim() === '') return null;
  return [{ value: String(value).trim().toUpperCase(), marketplace_id: marketplaceId }];
}
function pickNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}
function envelopeDimensions(dim, { marketplaceId }) {
  if (!dim) return null;
  const length = pickNumber(dim.length);
  const width = pickNumber(dim.width);
  const height = pickNumber(dim.height);
  if (length == null && width == null && height == null) return null;
  const entry = { marketplace_id: marketplaceId };
  if (length != null) entry.length = { value: length, unit: 'inches' };
  if (width != null) entry.width = { value: width, unit: 'inches' };
  if (height != null) entry.height = { value: height, unit: 'inches' };
  return [entry];
}
function envelopeWeight(weight, { marketplaceId }) {
  if (!weight) return null;
  const value = pickNumber(weight.value);
  if (value == null) return null;
  return [{ value, unit: 'pounds', marketplace_id: marketplaceId }];
}

// ── Schema-aware attribute name picking + envelope trimming ─────────────────
function pickAttributeName(fieldName, schemaPayload) {
  const candidates = FIELD_TO_AMAZON_ATTRS[fieldName] || [];
  if (!candidates.length) return null;
  if (!schemaPayload) return candidates[0];
  const allowed = new Set(productTypes.listAttributeNames(schemaPayload));
  for (const name of candidates) if (allowed.has(name)) return name;
  return candidates[0];
}

function getAttributeItemSchema(schemaPayload, attributeName) {
  if (!schemaPayload || !schemaPayload.schema || !attributeName) return null;
  let result = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || result) return;
    if (node.properties && node.properties[attributeName]) {
      const def = node.properties[attributeName];
      if (def && def.items && def.items.properties) { result = def.items; return; }
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(node[key])) for (const child of node[key]) walk(child);
    }
    if (node.items) walk(node.items);
  };
  walk(schemaPayload.schema);
  return result;
}

function trimEnvelopeToSchema(envelope, schemaPayload, attributeName) {
  if (!Array.isArray(envelope) || !envelope.length) return envelope;
  const itemSchema = getAttributeItemSchema(schemaPayload, attributeName);
  if (!itemSchema || !itemSchema.properties) return envelope;
  if (itemSchema.additionalProperties !== false) return envelope;
  const allowedKeys = new Set(Object.keys(itemSchema.properties));
  return envelope
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const trimmed = {};
      for (const [k, v] of Object.entries(entry)) if (allowedKeys.has(k)) trimmed[k] = v;
      return trimmed;
    })
    .filter((e) => e && Object.keys(e).length > 0);
}

function assignAttribute(attrs, fieldName, envelope, schemaPayload) {
  if (!envelope || (Array.isArray(envelope) && !envelope.length)) return;
  const name = pickAttributeName(fieldName, schemaPayload);
  if (!name) return;
  const trimmed = trimEnvelopeToSchema(envelope, schemaPayload, name);
  if (!trimmed || (Array.isArray(trimmed) && !trimmed.length)) return;
  attrs[name] = trimmed;
}

// ── Top-level builder ───────────────────────────────────────────────────────
//
// snapshot shape (all sections optional):
//   {
//     content:     { title, description, bullets[] },
//     pricing:     { list_price, cost_price, currency },
//     identity:    { brand, manufacturer, item_number, upc },
//     dimensions:  { item: {length,width,height}, package: {...} },
//     weights:     { item: {value}, package: {value} },
//     images:      { main_image_url, alt_image_url_1, ..., swatch_image_url },
//     compliance:  { country_of_origin },
//     package_level: 'unit' | 'case' | 'pallet'
//   }
//
// `fieldNames` (optional) restricts the build to a subset of Battat fields.
function buildAttributes(snapshot, { marketplaceCode, schemaPayload = null, fieldNames = null } = {}) {
  const mp = resolveByCode(marketplaceCode);
  if (!mp) throw new Error(`Unknown marketplace: ${marketplaceCode}`);
  const marketplaceId = mp.amazonMarketplaceId;
  const languageTag = languageTagFor(marketplaceCode);
  const currency = (snapshot.pricing && snapshot.pricing.currency) || mp.currency || null;
  const ctxText = { marketplaceId, languageTag };
  const ctx = { marketplaceId };

  const want = Array.isArray(fieldNames) ? new Set(fieldNames) : null;
  const wants = (f) => !want || want.has(f);

  const attrs = {};
  const content = snapshot.content || {};
  const identity = snapshot.identity || {};
  const pricing = snapshot.pricing || {};
  const dimensions = snapshot.dimensions || {};
  const weights = snapshot.weights || {};
  const images = snapshot.images || {};
  const compliance = snapshot.compliance || {};

  if (wants('title')) assignAttribute(attrs, 'title', envelopeText(content.title, ctxText), schemaPayload);
  if (wants('description')) assignAttribute(attrs, 'description', envelopeText(content.description, ctxText), schemaPayload);
  if (wants('bullets')) assignAttribute(attrs, 'bullets', envelopeBullets(content.bullets, ctxText), schemaPayload);

  if (wants('brand')) assignAttribute(attrs, 'brand', envelopeBrand(identity.brand, ctxText), schemaPayload);
  if (wants('manufacturer')) assignAttribute(attrs, 'manufacturer', envelopeBrand(identity.manufacturer, ctxText), schemaPayload);
  if (wants('item_number')) assignAttribute(attrs, 'item_number', envelopeModelNumber(identity.item_number, ctx), schemaPayload);
  if (wants('upc')) assignAttribute(attrs, 'upc', envelopeIdentifier(identity.upc, { marketplaceId, type: 'upc' }), schemaPayload);

  if (currency) {
    if (wants('list_price')) assignAttribute(attrs, 'list_price', envelopeListPrice(pricing.list_price, { marketplaceId, currency }), schemaPayload);
    if (wants('cost_price')) assignAttribute(attrs, 'cost_price', envelopeCostPrice(pricing.cost_price, { currency }), schemaPayload);
  }

  if (wants('item_dimensions')) assignAttribute(attrs, 'item_dimensions', envelopeDimensions(dimensions.item, ctx), schemaPayload);
  if (wants('package_dimensions')) assignAttribute(attrs, 'package_dimensions', envelopeDimensions(dimensions.package, ctx), schemaPayload);
  if (wants('item_weight')) assignAttribute(attrs, 'item_weight', envelopeWeight(weights.item, ctx), schemaPayload);
  if (wants('package_weight')) assignAttribute(attrs, 'package_weight', envelopeWeight(weights.package, ctx), schemaPayload);

  for (const field of Object.keys(images)) {
    if (!FIELD_TO_AMAZON_ATTRS[field]) continue;
    if (!wants(field)) continue;
    assignAttribute(attrs, field, envelopeImageLocator(images[field], ctx), schemaPayload);
  }

  if (wants('country_of_origin')) assignAttribute(attrs, 'country_of_origin', envelopeCountryOfOrigin(compliance.country_of_origin, ctx), schemaPayload);

  if (snapshot.package_level && wants('package_level')) {
    assignAttribute(attrs, 'package_level', envelopePackageLevel(snapshot.package_level, ctx), schemaPayload);
  }

  return attrs;
}

// Filter an attribute map to names the productType accepts.
function filterBySchema(attrs, schemaPayload) {
  const allowed = new Set(productTypes.listAttributeNames(schemaPayload));
  const kept = {};
  const dropped = [];
  for (const [name, value] of Object.entries(attrs || {})) {
    if (allowed.has(name)) kept[name] = value;
    else dropped.push(name);
  }
  return { kept, dropped, allowed_count: allowed.size };
}

// Listings Items PATCH ops — one `replace` per attribute.
function buildPatchOps(attrs) {
  const ops = [];
  for (const [name, value] of Object.entries(attrs || {})) {
    ops.push({ op: 'replace', path: `/attributes/${name}`, value });
  }
  return ops;
}

// JSON_LISTINGS_FEED message envelope.
function buildFeedMessages(rows, { sellerId = 'PLACEHOLDER', issueLocale = 'en_US' } = {}) {
  const messages = [];
  let id = 1;
  for (const row of rows) {
    if (!row.sku || !row.attributes || !row.productType) continue;
    messages.push({
      messageId: id++,
      sku: row.sku,
      operationType: 'PARTIAL_UPDATE',
      productType: row.productType,
      attributes: row.attributes
    });
  }
  return { header: { sellerId, version: '2.0', issueLocale }, messages };
}

// Build the inverse patches needed to revert a prior live Amazon state.
// `priorAttributes` is the `attributes` object captured by a GET before the
// write; `changedAttrNames` is the set of names the forward push touched.
function buildRevertPatchOps(priorAttributes, changedAttrNames) {
  const ops = [];
  for (const name of changedAttrNames || []) {
    const prior = priorAttributes ? priorAttributes[name] : undefined;
    if (prior === undefined) {
      ops.push({ op: 'delete', path: `/attributes/${name}` });
    } else {
      ops.push({ op: 'replace', path: `/attributes/${name}`, value: prior });
    }
  }
  return ops;
}

module.exports = {
  FIELD_TO_AMAZON_ATTRS,
  PACKAGE_LEVEL_VALUES,
  buildAttributes,
  filterBySchema,
  buildPatchOps,
  buildFeedMessages,
  buildRevertPatchOps,
  pickAttributeName,
  trimEnvelopeToSchema,
  // exported for tests
  _envelopes: { envelopeText, envelopeBullets, envelopeListPrice, envelopeDimensions }
};
