// Source-of-truth assembler. Given a push target (item number, product id,
// marketplace, ...), it reads the ListingApp PIM/pricing bridge and the
// content adapter, and returns a normalized snapshot the translator can
// consume — plus the raw source rows and a content hash for the audit trail.
const crypto = require('crypto');
const la = require('./listingAppClient');
const contentSource = require('./contentSource');
const env = require('../../config/env');
const { resolveByCode } = require('../../config/marketplaces');

function firstNonEmpty(row, keys) {
  for (const k of keys) {
    if (row && row[k] != null && String(row[k]).trim() !== '') return row[k];
  }
  return null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Map a raw PIM row (item_numbers SELECT *) into the snapshot's identity /
// dimensions / weights / compliance sections. PIM has 150+ columns and the
// exact names vary; we probe the common ones and leave anything unknown
// null (the translator simply omits null fields). The raw row is always
// returned for the audit trail so a missing mapping is diagnosable.
function mapPimRow(row) {
  if (!row) return { identity: {}, dimensions: {}, weights: {}, compliance: {} };
  const identity = {
    brand: firstNonEmpty(row, ['brand_product_line', 'brand', 'brand_name']),
    manufacturer: firstNonEmpty(row, ['manufacturer', 'manufacturer_name', 'legal_name']),
    item_number: firstNonEmpty(row, ['model_number', 'product_number', 'item_number']),
    upc: firstNonEmpty(row, ['upc_number', 'upc'])
  };
  const dimensions = {
    item: {
      length: num(firstNonEmpty(row, ['item_length_in', 'product_length_in', 'length_in'])),
      width: num(firstNonEmpty(row, ['item_width_in', 'product_width_in', 'width_in'])),
      height: num(firstNonEmpty(row, ['item_height_in', 'product_height_in', 'height_in']))
    },
    package: {
      length: num(firstNonEmpty(row, ['package_length_in', 'carton_length_in'])),
      width: num(firstNonEmpty(row, ['package_width_in', 'carton_width_in'])),
      height: num(firstNonEmpty(row, ['package_height_in', 'carton_height_in']))
    }
  };
  const weights = {
    item: { value: num(firstNonEmpty(row, ['item_weight_lb', 'product_weight_lb', 'weight_lb'])) },
    package: { value: num(firstNonEmpty(row, ['package_weight_lb', 'carton_weight_lb'])) }
  };
  const compliance = {
    country_of_origin: firstNonEmpty(row, ['country_of_origin', 'coo', 'made_in'])
  };
  return { identity, dimensions, weights, compliance };
}

function hashSnapshot(snapshot) {
  const json = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

// Assemble the SoT snapshot for a single target.
//   target = { itemNumber, productId, asin, marketplaceCode, fieldNames }
// Returns { snapshot, sources, hash, warnings }.
async function buildSnapshot(target) {
  const { itemNumber, productId, asin, marketplaceCode } = target;
  const warnings = [];
  const sources = { pim: null, pricing: null, content: null };

  // PIM
  let pimMapped = { identity: {}, dimensions: {}, weights: {}, compliance: {} };
  if (itemNumber && la.isConfigured()) {
    try {
      const rows = await la.getPimData({ itemNumbers: [itemNumber] });
      const row = Array.isArray(rows) ? rows.find((r) => String(r.item_number) === String(itemNumber)) || rows[0] : null;
      if (row) { sources.pim = row; pimMapped = mapPimRow(row); }
      else warnings.push(`no PIM row for item_number ${itemNumber}`);
    } catch (err) {
      warnings.push(`PIM fetch failed: ${err.message}`);
    }
  } else if (!la.isConfigured()) {
    warnings.push(`source of truth unavailable: ${la.unavailableReason()}`);
  }

  // Pricing (active season).
  const mp = resolveByCode(marketplaceCode);
  let pricing = { list_price: null, cost_price: null, currency: mp ? mp.currency : null };
  if (productId && la.isConfigured()) {
    try {
      const rows = await la.getSeasonPricing({ productIds: [productId], timeoutMs: 8000, maxAttempts: 2 });
      const seasonId = env.EFFECTIVE_PRICING_SEASON_ID;
      const candidates = (rows || []).filter((r) => !seasonId || Number(r.season_id) === Number(seasonId));
      const row = candidates[0] || (rows || [])[0] || null;
      if (row) {
        sources.pricing = row;
        pricing = {
          list_price: num(row.retail_price),
          cost_price: num(row.sell_price),
          currency: mp ? mp.currency : null
        };
      } else {
        warnings.push(`no pricing row for product_id ${productId}`);
      }
    } catch (err) {
      warnings.push(`pricing fetch failed: ${err.message}`);
    }
  }

  // Content (via adapter).
  let content = null;
  try {
    content = await contentSource.getContent({ asin, marketplaceCode, itemNumber });
    if (content) sources.content = content;
  } catch (err) {
    warnings.push(`content fetch failed: ${err.message}`);
  }

  const snapshot = {
    content: content || {},
    pricing,
    identity: pimMapped.identity,
    dimensions: pimMapped.dimensions,
    weights: pimMapped.weights,
    compliance: pimMapped.compliance
  };
  if (target.packageLevel) snapshot.package_level = target.packageLevel;

  return { snapshot, sources, hash: hashSnapshot(snapshot), warnings };
}

module.exports = { buildSnapshot, mapPimRow, hashSnapshot };
