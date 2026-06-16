// Validates a FlyApp-supplied, pre-built Amazon package (the "thin" ingestion
// path). Unlike the fat path (pusher.buildPlan), the payload is built by the
// CALLER — so this is the safety net that the fat path gets for free:
//
//   1. structural checks (right shape for the operation),
//   2. a schema gate — every targeted attribute must be valid for the
//      productType (Product Type Definitions), unknown attributes are dropped
//      and reported (so a typo'd attribute can't silently no-op on Amazon),
//   3. extraction of the changed attribute names + their expected values, so
//      revert and over-time reconciliation work exactly like the fat path.
//
// A schema miss (Amazon unreachable) does NOT block ingestion — we fall back
// to accepting all attributes and record the reason, mirroring pusher.js.
const productTypes = require('./spapi/productTypes');
const env = require('../config/env');

// JSON Pointer segment unescape (RFC 6901): ~1 -> '/', ~0 -> '~'.
function unescapePointer(seg) {
  return String(seg).replace(/~1/g, '/').replace(/~0/g, '~');
}

// '/attributes/item_name' or '/attributes/item_name/0/value' -> 'item_name'.
function attrNameFromPatchPath(pathStr) {
  const parts = String(pathStr || '').split('/').filter(Boolean).map(unescapePointer);
  if (parts.length >= 2 && parts[0] === 'attributes') return parts[1];
  return null;
}

// Pull the per-attribute "expected" values out of a package. For patches we
// only trust whole-attribute writes (path === /attributes/<name>) as the
// expected value; deeper paths still register the attribute name as changed
// (so it gets reconciled) but carry no standalone expected value.
function extractExpected({ pkg, operation }) {
  const changed = new Set();
  const expected = {};

  if (operation === 'submitJsonListingsFeed') {
    const messages = Array.isArray(pkg && pkg.messages) ? pkg.messages : [];
    for (const msg of messages) {
      const attrs = (msg && msg.attributes) || {};
      for (const [name, value] of Object.entries(attrs)) {
        changed.add(name);
        expected[name] = value;
      }
    }
    return { changedAttrNames: [...changed], expected };
  }

  // patchItem
  const patches = Array.isArray(pkg && pkg.patches) ? pkg.patches : [];
  for (const p of patches) {
    const name = attrNameFromPatchPath(p && p.path);
    if (!name) continue;
    changed.add(name);
    const isWholeAttr = String(p.path).split('/').filter(Boolean).length === 2;
    if (isWholeAttr && (p.op === 'replace' || p.op === 'add') && 'value' in p) {
      expected[name] = p.value;
    }
  }
  return { changedAttrNames: [...changed], expected };
}

// Structural validation — returns an array of human-readable problems.
function structuralProblems({ pkg, operation }) {
  const problems = [];
  if (!pkg || typeof pkg !== 'object') return ['package must be an object'];

  if (operation === 'submitJsonListingsFeed') {
    if (!Array.isArray(pkg.messages) || !pkg.messages.length) {
      problems.push('feed package requires a non-empty messages[] array');
    } else {
      pkg.messages.forEach((m, i) => {
        if (!m || typeof m !== 'object') problems.push(`messages[${i}] must be an object`);
        else {
          if (!m.sku) problems.push(`messages[${i}].sku is required`);
          if (!m.attributes || typeof m.attributes !== 'object') problems.push(`messages[${i}].attributes object is required`);
        }
      });
    }
    return problems;
  }

  // patchItem (productType may come from the target coordinates, so it is
  // validated by validatePackage, not required inside the package here).
  if (!Array.isArray(pkg.patches) || !pkg.patches.length) {
    problems.push('patchItem package requires a non-empty patches[] array');
  } else {
    pkg.patches.forEach((p, i) => {
      if (!p || typeof p !== 'object') { problems.push(`patches[${i}] must be an object`); return; }
      if (!['add', 'replace', 'delete'].includes(p.op)) problems.push(`patches[${i}].op must be add|replace|delete`);
      if (!attrNameFromPatchPath(p.path)) problems.push(`patches[${i}].path must target /attributes/<name>`);
      if ((p.op === 'add' || p.op === 'replace') && !('value' in p)) problems.push(`patches[${i}] requires a value`);
    });
  }
  return problems;
}

// Resolve the productType schema; null + reason on miss (does not throw).
async function resolveSchema({ productType, marketplaceCode }) {
  if (!productType) return { schema: null, error: 'productType not provided' };
  try {
    const payload = await productTypes.getSchema({ productType, marketplaceCode });
    return { schema: payload, error: null };
  } catch (err) {
    return { schema: null, error: err.message };
  }
}

// Validate a caller-supplied package.
//   { pkg, operation, productType, marketplaceCode, allowUnknownAttributes }
// Returns:
//   { ok, problems[], changedAttrNames[], expected{}, droppedAttrNames[],
//     sanitizedPackage, schemaMeta, warnings[] }
async function validatePackage({ pkg, operation, productType, marketplaceCode, allowUnknownAttributes = false }) {
  const warnings = [];
  const problems = structuralProblems({ pkg, operation });
  if (problems.length) {
    return { ok: false, problems, changedAttrNames: [], expected: {}, droppedAttrNames: [], sanitizedPackage: pkg, schemaMeta: null, warnings };
  }

  const effectiveProductType = productType || (pkg && pkg.productType) || null;
  if (!effectiveProductType) {
    return { ok: false, problems: ['productType is required (on the target or inside the package)'], changedAttrNames: [], expected: {}, droppedAttrNames: [], sanitizedPackage: pkg, schemaMeta: null, warnings };
  }
  const { schema, error: schemaError } = await resolveSchema({ productType: effectiveProductType, marketplaceCode });
  if (schemaError) warnings.push(`schema unavailable: ${schemaError}`);

  const { changedAttrNames, expected } = extractExpected({ pkg, operation });

  let allowed = null;
  if (schema) allowed = new Set(productTypes.listAttributeNames(schema));

  // 1P-vendor attributes (e.g. `procurement`/replenishment_status) are valid on
  // Amazon but never declared in the public seller LISTING schema. Treat them as
  // allowed so they are neither dropped nor rejected — Amazon's vendor Listings
  // Items endpoint is the final authority once the package is forwarded.
  const passthrough = new Set(env.VENDOR_PASSTHROUGH_ATTRS || []);

  const droppedAttrNames = [];
  let keptNames = changedAttrNames;
  if (allowed) {
    keptNames = changedAttrNames.filter((n) => allowed.has(n) || passthrough.has(n));
    for (const n of changedAttrNames) if (!allowed.has(n) && !passthrough.has(n)) droppedAttrNames.push(n);
    const forwarded = changedAttrNames.filter((n) => !allowed.has(n) && passthrough.has(n));
    if (forwarded.length) warnings.push(`forwarding vendor passthrough attribute(s) not in LISTING schema: ${forwarded.join(', ')}`);
  }

  // Strict mode (allowUnknownAttributes=false) rejects the whole submission if
  // any attribute is unknown to the schema; lenient mode drops + warns.
  if (droppedAttrNames.length && !allowUnknownAttributes) {
    return {
      ok: false,
      problems: [`attributes not valid for productType ${effectiveProductType}: ${droppedAttrNames.join(', ')}`],
      changedAttrNames, expected, droppedAttrNames,
      sanitizedPackage: pkg,
      schemaMeta: schema ? schemaMeta(schema) : null,
      warnings
    };
  }
  if (droppedAttrNames.length) warnings.push(`dropped unknown attributes: ${droppedAttrNames.join(', ')}`);

  const sanitizedPackage = droppedAttrNames.length
    ? stripAttributes({ pkg, operation, drop: new Set(droppedAttrNames) })
    : pkg;

  // Recompute expected over the kept names only.
  const keptSet = new Set(keptNames);
  const keptExpected = {};
  for (const [k, v] of Object.entries(expected)) if (keptSet.has(k)) keptExpected[k] = v;

  if (!keptNames.length) {
    return { ok: false, problems: ['no valid attributes remain after schema filtering'], changedAttrNames, expected: {}, droppedAttrNames, sanitizedPackage, schemaMeta: schema ? schemaMeta(schema) : null, warnings };
  }

  return {
    ok: true,
    problems: [],
    changedAttrNames: keptNames,
    expected: keptExpected,
    droppedAttrNames,
    sanitizedPackage,
    schemaMeta: schema ? schemaMeta(schema) : null,
    warnings
  };
}

function schemaMeta(schema) {
  return { productType: schema.productType, productTypeVersion: schema.productTypeVersion, schemaVersion: schema.schemaVersion };
}

// Return a copy of the package with the named attributes removed.
function stripAttributes({ pkg, operation, drop }) {
  if (operation === 'submitJsonListingsFeed') {
    const messages = (pkg.messages || []).map((m) => {
      const attrs = {};
      for (const [k, v] of Object.entries(m.attributes || {})) if (!drop.has(k)) attrs[k] = v;
      return { ...m, attributes: attrs };
    });
    return { ...pkg, messages };
  }
  const patches = (pkg.patches || []).filter((p) => {
    const name = attrNameFromPatchPath(p.path);
    return name ? !drop.has(name) : true;
  });
  return { ...pkg, patches };
}

module.exports = { validatePackage, attrNameFromPatchPath, extractExpected, structuralProblems };
