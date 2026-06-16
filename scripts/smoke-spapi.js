// Read-only SP-API smoke test. Verifies the LWA credential chain works and,
// if given an ASIN, performs a harmless catalogue read. Performs NO writes.
//
//   node scripts/smoke-spapi.js
//   node scripts/smoke-spapi.js --asin B0XXXX --marketplace US
require('../config/env');

async function main() {
  await require('../config/env').ready.catch(() => {});
  const client = require('../src/spapi/client');
  const catalog = require('../src/spapi/catalogItems');
  const { regionFor } = require('../src/spapi/regions');

  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const asin = get('--asin');
  const marketplace = get('--marketplace') || 'US';
  const region = regionFor(marketplace);

  console.log(`1) Acquiring ${region} LWA access token …`);
  const token = await client.getAccessToken(region);
  console.log(`   ok — token length ${token.length}, cached until ${new Date(client.getCachedTokenExpiry(region)).toISOString()}`);

  if (asin) {
    console.log(`2) Catalog read for ${asin} @ ${marketplace} …`);
    const item = await catalog.getCatalogItem({ asin, marketplaceCode: marketplace });
    const summary = item && item.summaries && item.summaries[0];
    console.log('   ok —', summary ? `${summary.itemName || '(no name)'} [${summary.productType || '?'}]` : 'no summary returned');
  } else {
    console.log('2) Skipping catalogue read (pass --asin B0XXXX --marketplace US to exercise it).');
  }
  console.log('SMOKE OK');
}

main().catch((err) => { console.error('SMOKE FAILED:', err.message); process.exit(1); });
