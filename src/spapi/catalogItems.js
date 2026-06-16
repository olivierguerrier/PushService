// Catalog Items API wrapper — read-only catalogue lookups used to verify an
// ASIN/SKU exists and to surface summaries in the preview/audit trail.
const { regionFor, amazonMarketplaceId } = require('./regions');
const client = require('./client');

const API_BASE = '/catalog/2022-04-01/items';

async function getCatalogItem({ asin, marketplaceCode, includedData = ['summaries', 'identifiers', 'productTypes'] }) {
  if (!asin) throw new Error('asin is required');
  const region = regionFor(marketplaceCode);
  const marketplaceId = amazonMarketplaceId(marketplaceCode);
  return client.request('GET', region, `${API_BASE}/${encodeURIComponent(asin)}`, {
    query: { marketplaceIds: marketplaceId, includedData: includedData.join(',') },
    marketplaceCode
  });
}

module.exports = { getCatalogItem };
