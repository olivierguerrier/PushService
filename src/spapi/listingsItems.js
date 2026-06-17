// Listings Items API wrapper (v2021-08-01). patchItem submits a JSON-Patch
// attributes change for one (sellerId, sku); getItem reads the current
// listing + issues. Ported from FlyApp.
const { regionFor, amazonMarketplaceId } = require('./regions');
const client = require('./client');

const API_BASE = '/listings/2021-08-01/items';

function pathFor({ sellerId, sku }) {
  if (!sellerId) throw new Error('sellerId (vendor_code) is required');
  if (!sku) throw new Error('sku is required');
  return `${API_BASE}/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
}

// `mode` = 'VALIDATION_PREVIEW' for dry-run (no persistence), null for live.
async function patchItem({ sellerId, sku, marketplaceCode, productType, patches, mode = 'VALIDATION_PREVIEW' }) {
  if (!productType) throw new Error('productType is required');
  if (!Array.isArray(patches) || !patches.length) {
    throw new Error('patches array is required and must be non-empty');
  }
  const region = regionFor(marketplaceCode);
  const marketplaceId = amazonMarketplaceId(marketplaceCode);
  const query = { marketplaceIds: marketplaceId };
  if (mode === 'VALIDATION_PREVIEW') query.mode = 'VALIDATION_PREVIEW';
  return client.request('PATCH', region, pathFor({ sellerId, sku }), {
    body: { productType, patches },
    query,
    contentType: 'application/json',
    marketplaceCode,
    rateLimitKey: 'patchListingsItem'
  });
}

async function getItem({ sellerId, sku, marketplaceCode, includedData = ['summaries', 'issues', 'attributes'] }) {
  const region = regionFor(marketplaceCode);
  const marketplaceId = amazonMarketplaceId(marketplaceCode);
  return client.request('GET', region, pathFor({ sellerId, sku }), {
    query: { marketplaceIds: marketplaceId, includedData: includedData.join(',') },
    marketplaceCode,
    rateLimitKey: 'getListingsItem'
  });
}

async function getItemIssues({ sellerId, sku, marketplaceCode }) {
  const item = await getItem({ sellerId, sku, marketplaceCode, includedData: ['issues', 'summaries'] });
  return {
    issues: (item && item.issues) || [],
    summaries: (item && item.summaries) || [],
    raw: item
  };
}

function isInvalidSellerMarketplaceError(err) {
  const text = `${err && err.message ? err.message : ''}\n${err && err.responseText ? err.responseText : ''}`.toLowerCase();
  return text.includes('invalid')
    && text.includes('sellerid')
    && (
      text.includes('marketplaceid')
      || text.includes('vendor code')
    );
}

function invalidSellerMarketplaceMessage({ sellerId, sku, marketplaceCode }) {
  const pieces = [`sellerId/vendorCode '${sellerId || ''}' is not valid for marketplace '${marketplaceCode || ''}'`];
  if (sku) pieces.push(`sku '${sku}'`);
  pieces.push('provide the Amazon vendor code authorized for that marketplace');
  return `invalid Amazon listing coordinates: ${pieces.join('; ')}`;
}

module.exports = {
  patchItem,
  getItem,
  getItemIssues,
  isInvalidSellerMarketplaceError,
  invalidSellerMarketplaceMessage
};
