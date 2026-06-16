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
