// The "fat push service" core. Given a target's listing coordinates plus the
// fields to push, it: resolves the productType schema, assembles the SoT
// snapshot (PIM + pricing + content), translates it into schema-filtered
// Amazon attributes, and returns a fully-built plan (patches / feed payload).
// It can also run Amazon's VALIDATION_PREVIEW dry-run.
//
// Listing coordinates (sellerId/vendor_code, sku, productType, asin) are
// supplied by the caller — that ASIN<->SKU<->vendor topology is not part of
// the ListingApp PIM. Everything that goes INTO the payload is built here
// from the source of truth, which is what makes this a fat (not pass-through)
// service.
const sotClient = require('./sot/sotClient');
const translator = require('./translator');
const productTypes = require('./spapi/productTypes');
const listingsItems = require('./spapi/listingsItems');
const { resolveByCode } = require('../config/marketplaces');

async function resolveSchema({ productType, marketplaceCode }) {
  if (!productType) return null;
  try {
    return await productTypes.getSchema({ productType, marketplaceCode });
  } catch (err) {
    // A schema miss must not block the build — we fall back to the
    // unfiltered attribute set and record the reason.
    return { __schema_error: err.message };
  }
}

// Build the complete push plan for one target. Does NOT call any write API.
//   target = { sellerId, sku, asin, itemNumber, productId, marketplaceCode,
//              productType, fieldNames, packageLevel }
async function buildPlan(target) {
  const marketplaceCode = String(target.marketplaceCode || '').toUpperCase();
  if (!resolveByCode(marketplaceCode)) throw new Error(`Unknown marketplace: ${target.marketplaceCode}`);
  if (!target.productType) throw new Error('productType is required');

  const schemaPayloadResult = await resolveSchema({ productType: target.productType, marketplaceCode });
  const schemaPayload = (schemaPayloadResult && !schemaPayloadResult.__schema_error) ? schemaPayloadResult : null;
  const schemaError = schemaPayloadResult && schemaPayloadResult.__schema_error ? schemaPayloadResult.__schema_error : null;

  const { snapshot, sources, hash, warnings } = await sotClient.buildSnapshot({
    itemNumber: target.itemNumber,
    productId: target.productId,
    asin: target.asin,
    marketplaceCode,
    packageLevel: target.packageLevel,
    fieldNames: target.fieldNames
  });

  const attrs = translator.buildAttributes(snapshot, {
    marketplaceCode,
    schemaPayload,
    fieldNames: target.fieldNames
  });

  // When we have a schema, double-check the filter so the preview can list
  // what was dropped; without a schema we keep everything (and warn).
  const filtered = schemaPayload ? translator.filterBySchema(attrs, schemaPayload) : { kept: attrs, dropped: [], allowed_count: null };
  const patches = translator.buildPatchOps(filtered.kept);

  return {
    marketplaceCode,
    sellerId: target.sellerId || null,
    sku: target.sku || null,
    asin: target.asin || null,
    itemNumber: target.itemNumber || null,
    productId: target.productId || null,
    productType: target.productType,
    snapshot,
    sources,
    sourceHash: hash,
    warnings: [...(warnings || []), ...(schemaError ? [`schema unavailable: ${schemaError}`] : [])],
    schemaMeta: schemaPayload ? { productType: schemaPayload.productType, productTypeVersion: schemaPayload.productTypeVersion, schemaVersion: schemaPayload.schemaVersion } : null,
    attributes: { kept: filtered.kept, dropped: filtered.dropped },
    changedAttrNames: Object.keys(filtered.kept),
    patches
  };
}

// Amazon VALIDATION_PREVIEW dry-run for a built plan. Requires sellerId+sku.
async function dryRunPlan(plan) {
  if (!plan.sellerId || !plan.sku) throw new Error('sellerId and sku are required for a dry-run');
  if (!plan.patches.length) return { skipped: true, reason: 'no_attributes_to_submit' };
  return listingsItems.patchItem({
    sellerId: plan.sellerId,
    sku: plan.sku,
    marketplaceCode: plan.marketplaceCode,
    productType: plan.productType,
    patches: plan.patches,
    mode: 'VALIDATION_PREVIEW'
  });
}

module.exports = { buildPlan, dryRunPlan };
