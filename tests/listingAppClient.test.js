const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

process.env.LISTINGAPP_API_BASE_URL = 'http://listingapp.test';
process.env.LISTINGAPP_SERVICE_TOKEN = 'test-token';

const listingAppClient = require('../src/sot/listingAppClient');

test('collectAsinsFromRows extracts normalized ASINs from ListingApp-shaped rows', () => {
  const asins = listingAppClient.collectAsinsFromRows([
    { asin: ' b012345678 ' },
    { amazon_asin: 'B0ABCDEFGH, not-an-asin' },
    { nested: { marketplaceAsins: ['c012345678', 'too-short'] } },
    { customer_name: 'Amazon EU', customer_number: 'B01N1IFNA0' },
    { customer_group_name: 'Amazon', secondary_customer_number: 'B01SECOND0' },
    { customer_name: 'Other Retailer', customer_number: 'B01IGNORED' },
    { product_id: 'B099999999' }
  ]);

  assert.deepEqual([...asins].sort(), ['B012345678', 'B01N1IFNA0', 'B01SECOND0', 'B0ABCDEFGH', 'C012345678']);
});

test('getKnownAsins fetches ListingApp products and caches the ASIN set', async () => {
  listingAppClient.clearKnownAsinsCache();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url, opts) => {
    calls += 1;
    assert.equal(String(url), 'http://listingapp.test/api/flyapp-bridge/products?limit=5000&offset=0');
    assert.equal(opts.headers.Authorization, 'Bearer test-token');
    return {
      ok: true,
      json: async () => ({
        rows: [{ asin: 'B012345678' }, { amazonAsin: 'B0ABCDEFGH' }],
        truncated: false
      })
    };
  };

  try {
    const first = await listingAppClient.getKnownAsins({ refresh: true });
    const second = await listingAppClient.getKnownAsins();

    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.deepEqual([...second].sort(), ['B012345678', 'B0ABCDEFGH']);
  } finally {
    global.fetch = originalFetch;
    listingAppClient.clearKnownAsinsCache();
  }
});

test('getProductRecord resolves a product by product_id or item_number from one cached fetch', async () => {
  listingAppClient.clearProductsIndexCache();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        rows: [
          { product_id: 4242, item_number: 'BT1234', brand: 'Battat' },
          { product_id: 9999, item_number: 'BT9999', brand: 'B. toys' }
        ],
        truncated: false
      })
    };
  };

  try {
    const byId = await listingAppClient.getProductRecord({ productId: 4242 });
    const byItem = await listingAppClient.getProductRecord({ itemNumber: 'bt9999' });
    const miss = await listingAppClient.getProductRecord({ productId: 1 });

    assert.equal(calls, 1, 'index built from a single cached fetch');
    assert.equal(byId.brand, 'Battat');
    assert.equal(byItem.brand, 'B. toys', 'item_number lookup is case-insensitive');
    assert.equal(miss, null);
  } finally {
    global.fetch = originalFetch;
    listingAppClient.clearProductsIndexCache();
  }
});

test('getProductRecord returns null without identifiers', async () => {
  assert.equal(await listingAppClient.getProductRecord({}), null);
});
