const { test } = require('node:test');
const assert = require('node:assert');

const listingsItems = require('../src/spapi/listingsItems');

test('detects invalid sellerId and marketplaceId combination errors', () => {
  const err = new Error(`SP-API GET /listings/2021-08-01/items/YX13W/BX2148Z failed (400): {
    "errors": [{
      "code": "InvalidInput",
      "message": "Invalid 'sellerId' and 'marketplaceId' combination provided.",
      "details": ""
    }]
  }`);

  assert.equal(listingsItems.isInvalidSellerMarketplaceError(err), true);
});

test('formats an actionable invalid listing coordinate message', () => {
  assert.equal(
    listingsItems.invalidSellerMarketplaceMessage({ sellerId: 'YX13W', sku: 'BX2148Z', marketplaceCode: 'DE' }),
    "invalid Amazon listing coordinates: sellerId/vendorCode 'YX13W' is not valid for marketplace 'DE'; sku 'BX2148Z'; provide the Amazon vendor code authorized for that marketplace"
  );
});
