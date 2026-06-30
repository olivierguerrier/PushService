// Deterministic Amazon-attribute -> Battat-source-field mapping for the AI
// error resolver.
//
// The LLM is good at DIAGNOSING which attributes an Amazon error requires, but
// it cannot be trusted to fill their VALUES — left to itself it invents
// plausible-looking placeholders ("Battat Inc.", "Plastic", 1x1x1 dimensions,
// 9.99 price). To stop that, value-filling is moved OUT of the model and into
// this fixed mapping: for each attribute the error needs, we look up the
// candidate source fields here, pull the first real value present in the
// gathered source-of-truth data, and shape it to the Amazon envelope. If NO
// mapped source field has a value, the attribute is simply OMITTED (and
// reported as unresolved) — never fabricated.
//
// The column aliases below are ported from the Customer Template Filler app
// (i:/CustomerTemplateFill: modules/mcpAdapter/listingFieldAliases.ts
// CANONICAL_PIM_ALIASES, modules/fieldCatalog Amazon VC column patterns, and
// modules/vcFixFieldMap.ts SCALAR_MAP + bullet/dimension fan-out). Those names
// are validated against live ListingApp data, so they replace the guesses this
// module started with. Anything CTF does not map (most EU safety / electrical /
// warranty enums, gender, battery flags) is intentionally left unmapped here
// too, so those values are omitted for a human rather than invented.
//
// `sources` is the namespaced bag assembled by aiResolver.gatherContext:
//   { pim, pricing, product, content, snapshot, live }
// where pim/pricing/product are the raw ListingApp rows, snapshot is the
// normalized SoT snapshot, and live is the current Amazon attribute map.
'use strict';

const { resolveByCode } = require('../../config/marketplaces');
const { languageTagFor } = require('../../config/languages');
const units = require('../units');
const translator = require('../translator');
const packageValidator = require('../packageValidator');

function getByPath(sources, path) {
  if (!sources || !path) return undefined;
  let cur = sources;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function isPresent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// First source path that holds a usable value. Returns { value, source } or null.
function firstPresent(sources, paths) {
  for (const p of paths || []) {
    const v = getByPath(sources, p);
    if (isPresent(v)) return { value: v, source: p };
  }
  return null;
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(Number(n) * f) / f;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Loose numeric parse that tolerates units/labels (e.g. "5 in", "0.4 lb").
function looseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Build candidate dotted paths for a list of bare column names across the raw
// source rows CTF reads from (pim row, then product row).
function cols(...names) {
  const out = [];
  for (const n of names) {
    out.push(`pim.${n}`);
    out.push(`product.${n}`);
  }
  return out;
}

// ── Fan-out / parse helpers (ported from CTF vcFixFieldMap.ts) ──────────────

// Extract bullet strings from a value that may be an array, a JSON-array
// string, or a pipe/newline-delimited string.
function parseBullets(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
      } catch { /* fall through */ }
    }
    if (s.includes('|')) return s.split('|').map((b) => b.trim()).filter(Boolean);
    if (s.includes('\n')) return s.split(/\r?\n/).map((b) => b.trim()).filter(Boolean);
    return [s];
  }
  return [];
}

// Parse a dimension expressed as a {l,w,h} object or "L x W x H" string into
// { length, width, height } numbers. Units are tolerated but not converted.
function parseDimensions(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw;
    const get = (...keys) => {
      for (const k of keys) {
        if (obj[k] != null && obj[k] !== '') return looseNum(obj[k]);
      }
      return null;
    };
    const length = get('length', 'l', 'depth', 'd');
    const width = get('width', 'w');
    const height = get('height', 'h');
    if (length != null || width != null || height != null) return { length, width, height };
    return null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (s.startsWith('{')) {
      try { return parseDimensions(JSON.parse(s)); } catch { /* fall through */ }
    }
    const parts = s.split(/[xX×*]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      return { length: looseNum(parts[0]), width: looseNum(parts[1]), height: looseNum(parts[2]) };
    }
  }
  return null;
}

// ── Envelope builders (each returns the Amazon attribute value array) ────────
// ctx = { marketplaceId, languageTag, currency }
const BUILDERS = {
  text: (v, ctx) => [{ value: String(v), language_tag: ctx.languageTag, marketplace_id: ctx.marketplaceId }],
  textNoLang: (v, ctx) => [{ value: String(v), marketplace_id: ctx.marketplaceId }],
  bullets: (v, ctx) => {
    const arr = parseBullets(v);
    const out = arr.slice(0, 5)
      .map((b) => ({ value: String(b), language_tag: ctx.languageTag, marketplace_id: ctx.marketplaceId }))
      .filter((e) => e.value.trim());
    return out.length ? out : null;
  },
  upc: (v, ctx) => [{ type: 'upc', value: String(v).trim(), marketplace_id: ctx.marketplaceId }],
  listPrice: (v, ctx) => {
    const n = looseNum(v);
    if (n == null || n <= 0 || !ctx.currency) return null;
    return [{ currency: ctx.currency, marketplace_id: ctx.marketplaceId, value: round(n) }];
  },
  costPrice: (v, ctx) => {
    const n = looseNum(v);
    if (n == null || n <= 0 || !ctx.currency) return null;
    return [{ currency: ctx.currency, value: round(n) }];
  },
  countryOfOrigin: (v, ctx) => [{ value: String(v).trim().toUpperCase(), marketplace_id: ctx.marketplaceId }],
  packageLevel: (v, ctx) => {
    const s = String(v).trim().toLowerCase();
    return translator.PACKAGE_LEVEL_VALUES.has(s) ? [{ value: s, marketplace_id: ctx.marketplaceId }] : null;
  },
  dimensions: (v, ctx) => {
    if (!v || typeof v !== 'object') return null;
    // Source dimensions are inches; convert to the marketplace unit system.
    const length = looseNum(v.length);
    const width = looseNum(v.width);
    const height = looseNum(v.height);
    if (length == null && width == null && height == null) return null;
    const unit = units.lengthUnit(ctx.units);
    const entry = { marketplace_id: ctx.marketplaceId };
    if (length != null) entry.length = { value: units.convertLength(length, ctx.units), unit };
    if (width != null) entry.width = { value: units.convertLength(width, ctx.units), unit };
    if (height != null) entry.height = { value: units.convertLength(height, ctx.units), unit };
    return [entry];
  },
  weight: (v, ctx) => {
    const raw = (v && typeof v === 'object') ? v.value : v;
    const n = looseNum(raw);
    if (n == null || n <= 0) return null;
    // Source weight is pounds; convert to the marketplace unit system.
    return [{ value: units.convertWeight(n, ctx.units), unit: units.weightUnit(ctx.units), marketplace_id: ctx.marketplaceId }];
  },
  integer: (v, ctx) => {
    const n = looseNum(v);
    if (n == null) return null;
    const i = Math.round(n);
    if (!(i > 0)) return null;
    return [{ value: i, marketplace_id: ctx.marketplaceId }];
  }
};

// ── Complex resolvers: assemble a value from the snapshot object, raw PIM
// columns, or a combined dimension string. Return { value, source } or null.

function dimResolve(snapKey, axisAliases, comboAliases) {
  return (sources) => {
    const snap = getByPath(sources, `snapshot.dimensions.${snapKey}`);
    if (snap && typeof snap === 'object' && (snap.length != null || snap.width != null || snap.height != null)) {
      return { value: snap, source: `snapshot.dimensions.${snapKey}` };
    }
    const L = firstPresent(sources, cols(...axisAliases.length));
    const W = firstPresent(sources, cols(...axisAliases.width));
    const H = firstPresent(sources, cols(...axisAliases.height));
    if (L || W || H) {
      return {
        value: { length: L ? L.value : null, width: W ? W.value : null, height: H ? H.value : null },
        source: (L || W || H).source
      };
    }
    for (const c of comboAliases || []) {
      const hit = firstPresent(sources, [`pim.${c}`, `product.${c}`]);
      if (hit) {
        const parsed = parseDimensions(hit.value);
        if (parsed) return { value: parsed, source: hit.source };
      }
    }
    return null;
  };
}

function weightResolve(snapKey, aliases) {
  return (sources) => {
    const snap = getByPath(sources, `snapshot.weights.${snapKey}`);
    const sv = (snap && typeof snap === 'object') ? snap.value : snap;
    if (sv != null && sv !== '') return { value: sv, source: `snapshot.weights.${snapKey}` };
    const hit = firstPresent(sources, cols(...aliases));
    return hit ? { value: hit.value, source: hit.source } : null;
  };
}

// ── The mapping. Each rule targets one or more Amazon attribute names. `paths`
// are tried in order (snapshot first — it's the cleaned/normalized view — then
// the raw PIM/product columns from CTF's verified alias lists). `resolve` is an
// optional complex assembler tried before paths. `kind` selects the envelope
// builder. Attributes Battat cannot source are deliberately absent, so they are
// omitted (never invented) and surface as unresolved for a human.
const RULES = [
  // ── Identity ──
  {
    names: ['brand'],
    kind: 'text',
    paths: ['snapshot.identity.brand', 'product.brand', ...cols('brand', 'brand_name', 'pim_brand', 'brand_product_line')]
  },
  {
    // CTF keeps manufacturer distinct from brand on purpose (aliasing the two
    // produced wrong outputs on VC templates that carry both columns).
    names: ['manufacturer'],
    kind: 'text',
    paths: ['snapshot.identity.manufacturer', 'product.manufacturer', ...cols('manufacturer', 'manufacturer_name', 'legal_manufacturer')]
  },
  {
    names: ['item_name', 'title'],
    kind: 'text',
    paths: ['snapshot.content.title', 'content.title', ...cols('legal_name', 'pim_legal_name', 'product_title', 'listing_title', 'title', 'item_name')]
  },
  {
    names: ['product_description', 'rtip_product_description'],
    kind: 'text',
    paths: ['snapshot.content.description', 'content.description', ...cols('description', 'long_description', 'product_description')]
  },
  {
    names: ['bullet_point'],
    kind: 'bullets',
    paths: ['snapshot.content.bullets', 'content.bullets', ...cols('bullets', 'bullet_points')]
  },
  {
    names: ['externally_assigned_product_identifier', 'external_product_id'],
    kind: 'upc',
    paths: ['snapshot.identity.upc', ...cols('upc_number', 'pim_upc_number', 'upc', 'gtin', 'barcode')]
  },
  {
    names: ['model_number', 'part_number'],
    kind: 'textNoLang',
    paths: ['snapshot.identity.item_number', ...cols('product_number', 'pim_product_number', 'mfr_part_number', 'part_number', 'item_number')]
  },

  // ── Pricing ──
  { names: ['list_price'], kind: 'listPrice', paths: ['snapshot.pricing.list_price', ...cols('retail_price', 'msrp'), 'pricing.retail_price', 'pricing.msrp'] },
  { names: ['cost_price'], kind: 'costPrice', paths: ['snapshot.pricing.cost_price', 'pricing.sell_price', ...cols('sell_price')] },

  // ── Dimensions & weights ──
  // PIM has no standalone product (item) dimensions — only the single consumer
  // package. Per product decision, item_dimensions reuses that single-package
  // measurement (same source as item_package_dimensions).
  {
    names: ['item_dimensions', 'item_length_width_height', 'item_package_dimensions'],
    kind: 'dimensions',
    resolve: dimResolve('package',
      {
        length: ['package_length', 'pim_package_length', 'item_package_length', 'consumer_package_length', 'single_unit_package_length', 'pkg_length'],
        width: ['package_width', 'pim_package_width', 'item_package_width', 'consumer_package_width', 'single_unit_package_width', 'pkg_width'],
        height: ['package_height', 'pim_package_height', 'item_package_height', 'consumer_package_height', 'single_unit_package_height', 'pkg_height']
      },
      ['package_dimensions', 'item_package_dimensions'])
  },
  // PIM has only the single consumer-package weight. Per product decision,
  // item_weight reuses that single-package measurement (same source as
  // item_package_weight), which also keeps item_weight <= item_package_weight
  // (error 90147) satisfied since the two are equal.
  {
    names: ['item_weight', 'item_package_weight'],
    kind: 'weight',
    resolve: weightResolve('package', ['package_weight', 'pim_package_weight', 'item_package_weight', 'consumer_package_weight', 'shipping_weight', 'pkg_weight'])
  },

  // ── Compliance ──
  {
    names: ['country_of_origin'],
    kind: 'countryOfOrigin',
    paths: ['snapshot.compliance.country_of_origin', ...cols('country_of_origin', 'pim_country_of_origin', 'coo', 'origin_country', 'made_in')]
  },
  {
    names: ['material'],
    kind: 'text',
    paths: cols('material', 'pim_material', 'materials', 'material_type', 'material_composition')
  },
  {
    names: ['age_range_description'],
    kind: 'text',
    paths: cols('age_range_description', 'pim_age_range_description', 'age_range', 'target_age', 'age_grade', 'pim_age_grade', 'age_rating')
  },
  {
    // PIM owns the consumer safety warning text (CTF resolveSafetyWarning).
    names: ['rtip_safety_warning', 'safety_warning'],
    kind: 'text',
    paths: cols('safety_warning', 'pim_safety_warning', 'safety_warning_text', 'pim_safety_warning_text', 'packaging_safety_warning_text', 'statement_of_safety', 'warning_text')
  },
  {
    // Units per inner pack — PIM inner_pack_qty.
    names: ['rtip_items_per_inner_pack'],
    kind: 'integer',
    paths: cols('inner_pack_qty', 'pim_inner_pack_qty', 'inner_pack', 'inner_qty')
  },

  // ── Taxonomy (CTF maps item_type_keyword -> subcategory) ──
  {
    names: ['item_type_keyword', 'item_type_name'],
    kind: 'text',
    paths: cols('product_taxonomy_subcategory', 'pim_taxonomy_subcategory', 'taxonomy_subcategory', 'subcategory', 'product_subcategory')
  },
  {
    names: ['product_category'],
    kind: 'text',
    paths: cols('product_taxonomy_category', 'pim_taxonomy_category', 'taxonomy_category', 'category', 'product_category')
  },
  {
    names: ['product_subcategory'],
    kind: 'text',
    paths: cols('product_taxonomy_subcategory', 'pim_taxonomy_subcategory', 'subcategory', 'product_subcategory')
  },

  // package_level is normally deferred, but if the snapshot carries it we can ground it.
  { names: ['package_level'], kind: 'packageLevel', paths: ['snapshot.package_level', ...cols('package_level')] }
];

const RULE_BY_ATTR = new Map();
for (const rule of RULES) {
  for (const name of rule.names) if (!RULE_BY_ATTR.has(name)) RULE_BY_ATTR.set(name, rule);
}

function ruleFor(attrName) {
  return RULE_BY_ATTR.get(attrName) || null;
}

// Resolve a single attribute deterministically. Returns { envelope, source } or
// null when no mapped source field holds a value (or the value can't be shaped).
function resolveGroundedValue(attrName, { sources, ctx, schemaPayload }) {
  const rule = ruleFor(attrName);
  if (!rule) return null;

  let value;
  let source;
  if (typeof rule.resolve === 'function') {
    const r = rule.resolve(sources, ctx);
    if (r && r.value != null) { value = r.value; source = r.source; }
  }
  if (value == null && rule.paths) {
    const hit = firstPresent(sources, rule.paths);
    if (hit) { value = hit.value; source = hit.source; }
  }
  if (value == null) return null;

  const build = BUILDERS[rule.kind];
  if (!build) return null;
  let envelope = build(value, ctx);
  if (!envelope || (Array.isArray(envelope) && !envelope.length)) return null;
  // Shape exactly to the schema (drops keys the product type disallows, e.g. a
  // language_tag where none is permitted).
  if (schemaPayload) {
    const trimmed = translator.trimEnvelopeToSchema(envelope, schemaPayload, attrName);
    if (trimmed && (!Array.isArray(trimmed) || trimmed.length)) envelope = trimmed;
  }
  return { envelope, source };
}

// Repurposed value for `attrName` from another accepted record of the same ASIN
// (a sibling submission or Amazon's catalogue), assembled upstream in
// aiResolver.gatherContext via siblingAttributeSource. Returns { envelope, source }
// with provenance, or null. Only consulted after PIM grounding yields nothing.
function siblingValueFor(sources, attrName, schemaPayload) {
  const sib = sources && sources.siblings;
  if (!sib || !sib.candidates) return null;
  let envelope = sib.candidates[attrName];
  if (envelope == null) return null;
  if (schemaPayload) {
    const trimmed = translator.trimEnvelopeToSchema(envelope, schemaPayload, attrName);
    if (trimmed && (!Array.isArray(trimmed) || trimmed.length)) envelope = trimmed;
  }
  if (!envelope || (Array.isArray(envelope) && !envelope.length)) return null;
  const source = (sib.provenance && sib.provenance[attrName]) || 'sibling-asin-record';
  return { envelope, source };
}

function unique(list) {
  return [...new Set((list || []).filter(Boolean).map(String))];
}

// Build a fully-grounded package for the given target attribute names. Every
// value comes from the source data via the mapping; attributes with no source
// value are omitted and listed in `unresolved`. Nothing is invented.
//
//   { attrNames, operation, sources, marketplaceCode, schemaPayload, sku }
// returns { package, resolved: string[], unresolved: [{field,reason}], valueSources: {attr: source} }
function buildGroundedPackage({ attrNames, operation, sources, marketplaceCode, schemaPayload = null, sku = null } = {}) {
  const names = unique(attrNames);
  const mp = resolveByCode(marketplaceCode);
  const result = { package: null, resolved: [], unresolved: [], valueSources: {} };
  if (!mp) {
    for (const n of names) result.unresolved.push({ field: n, reason: `unknown marketplace ${marketplaceCode}` });
    return result;
  }
  const currency = (sources && sources.snapshot && sources.snapshot.pricing && sources.snapshot.pricing.currency) || mp.currency || null;
  const ctx = { marketplaceId: mp.amazonMarketplaceId, languageTag: languageTagFor(marketplaceCode), currency, units: mp.units || 'metric' };

  const attrs = {};
  for (const name of names) {
    // PIM/source-of-truth always wins: try the deterministic field mapping first.
    let got = ruleFor(name) ? resolveGroundedValue(name, { sources, ctx, schemaPayload }) : null;
    // Fallback: repurpose a value from another accepted record of this ASIN
    // (sibling submission or Amazon catalogue). Covers attributes PIM cannot
    // ground, including ones with no source-field mapping at all.
    if (!got) {
      const sib = siblingValueFor(sources, name, schemaPayload);
      if (sib) got = sib;
    }
    if (!got) {
      result.unresolved.push({
        field: name,
        reason: ruleFor(name)
          ? 'no value found in Battat source data or sibling ASIN records'
          : 'no source-field mapping defined for this attribute and no sibling ASIN value'
      });
      continue;
    }
    attrs[name] = got.envelope;
    result.valueSources[name] = got.source;
    result.resolved.push(name);
  }

  if (!Object.keys(attrs).length) return result;

  if (operation === 'submitJsonListingsFeed') {
    result.package = { messages: [{ sku: sku || 'PLACEHOLDER', attributes: attrs }] };
  } else {
    const patches = Object.entries(attrs).map(([name, value]) => ({ op: 'replace', path: `/attributes/${name}`, value }));
    result.package = { patches };
  }
  return result;
}

// Collect the attribute names a fix must address: the ones Amazon's issues
// blame, plus any the model proposed (names only — never its values).
function collectTargetAttrNames({ details = [], output = {} } = {}) {
  const set = new Set();
  for (const d of details || []) {
    for (const a of (d.attributeNames || [])) if (a) set.add(String(a));
  }
  for (const n of (Array.isArray(output.changed_attr_names) ? output.changed_attr_names : [])) if (n) set.add(String(n));
  const pp = output.proposed_package || output;
  for (const p of (Array.isArray(pp.patches) ? pp.patches : [])) {
    const nm = packageValidator.attrNameFromPatchPath(p && p.path);
    if (nm) set.add(nm);
  }
  for (const m of (Array.isArray(pp.messages) ? pp.messages : [])) {
    for (const k of Object.keys((m && m.attributes) || {})) set.add(k);
  }
  return [...set];
}

module.exports = {
  RULES,
  ruleFor,
  resolveGroundedValue,
  buildGroundedPackage,
  collectTargetAttrNames,
  // exposed for tests
  _internal: { getByPath, firstPresent, parseBullets, parseDimensions, BUILDERS }
};
