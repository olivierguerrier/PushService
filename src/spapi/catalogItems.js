// Catalog Items API wrapper — read-only catalogue lookups used to verify an
// ASIN/SKU exists and to surface summaries in the preview/audit trail.
const { regionFor, amazonMarketplaceId } = require('./regions');
const client = require('./client');

const API_BASE = '/catalog/2022-04-01/items';

// Valid includedData datasets for Catalog Items 2022-04-01. `attributes` returns
// the ASIN's catalogue attribute map (same envelope shape as Listings Items),
// which the sibling-repurpose path uses to borrow values for a failing listing.
const VALID_INCLUDED_DATA = new Set([
  'summaries', 'identifiers', 'productTypes', 'attributes', 'classifications',
  'dimensions', 'images', 'relationships', 'salesRanks', 'vendorDetails'
]);

async function getCatalogItem({ asin, marketplaceCode, includedData = ['summaries', 'identifiers', 'productTypes'] }) {
  if (!asin) throw new Error('asin is required');
  const region = regionFor(marketplaceCode);
  const marketplaceId = amazonMarketplaceId(marketplaceCode);
  const included = (Array.isArray(includedData) ? includedData : [includedData])
    .filter((d) => VALID_INCLUDED_DATA.has(d));
  if (!included.length) included.push('summaries');
  return client.request('GET', region, `${API_BASE}/${encodeURIComponent(asin)}`, {
    query: { marketplaceIds: marketplaceId, includedData: included.join(',') },
    marketplaceCode
  });
}

module.exports = { getCatalogItem };
