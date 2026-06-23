const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const aiResolver = require('../src/aiResolver');
const sotClient = require('../src/sot/sotClient');
const la = require('../src/sot/listingAppClient');

// Minimal FAILED submission with NO product_type / vendor_code so gatherContext
// skips the live-listing and schema fetches and we exercise only the SoT path.
function fakeSubmission(overrides = {}) {
  return {
    submission_uuid: 'sub-1',
    scope: 'CONTENT_MATCH',
    operation: 'patchItem',
    asin: 'B0TESTASIN',
    sku: 'SKU-1',
    effective_sku: null,
    vendor_code: null,
    item_number: 'BT1234',
    marketplace_code: 'US',
    product_type: null,
    status: 'FAILED',
    error_message: 'missing required attributes',
    issues_json: JSON.stringify([{ code: '90220', message: 'required attr missing', severity: 'ERROR', attributeNames: ['material'] }]),
    amazon_response_json: null,
    request_body_json: JSON.stringify({ patches: [] }),
    raw_package_json: null,
    flyapp_meta_json: JSON.stringify({ productId: 4242 }),
    resolves_uuid: null,
    ...overrides
  };
}

test('gatherContext surfaces the raw PIM, pricing and product rows (empties stripped)', async () => {
  const origSnapshot = sotClient.buildSnapshot;
  const origProduct = la.getProductRecord;
  sotClient.buildSnapshot = async () => ({
    snapshot: { identity: { brand: 'Battat' } },
    sources: {
      pim: { item_number: 'BT1234', material_composition: 'Plastic', target_gender: 'unisex', blank_field: '', empty_field: null },
      pricing: { retail_price: 19.99, sell_price: 8.5 },
      content: null
    },
    warnings: []
  });
  la.getProductRecord = async () => ({ product_id: 4242, brand: 'Battat', description: 'Toy', empty: '' });

  try {
    const ctx = await aiResolver.gatherContext(fakeSubmission());
    const sot = ctx.promptPayload.source_of_truth;
    assert.ok(sot, 'source_of_truth block present');
    assert.equal(sot.pim_raw.material_composition, 'Plastic');
    assert.equal(sot.pim_raw.target_gender, 'unisex');
    assert.ok(!('blank_field' in sot.pim_raw), 'blank string field stripped');
    assert.ok(!('empty_field' in sot.pim_raw), 'null field stripped');
    assert.equal(sot.pricing_raw.retail_price, 19.99);
    assert.equal(sot.product_raw.product_id, 4242);
    assert.ok(!('empty' in sot.product_raw), 'blank product field stripped');
  } finally {
    sotClient.buildSnapshot = origSnapshot;
    la.getProductRecord = origProduct;
  }
});

test('gatherContext records a warning when no product row matches', async () => {
  const origSnapshot = sotClient.buildSnapshot;
  const origProduct = la.getProductRecord;
  sotClient.buildSnapshot = async () => ({ snapshot: {}, sources: { pim: null, pricing: null, content: null }, warnings: [] });
  la.getProductRecord = async () => null;

  try {
    const ctx = await aiResolver.gatherContext(fakeSubmission());
    assert.equal(ctx.promptPayload.source_of_truth.pim_raw, null);
    assert.equal(ctx.promptPayload.source_of_truth.product_raw, null);
    assert.ok(ctx.gatherWarnings.some((w) => /no product row matched/.test(w)));
  } finally {
    sotClient.buildSnapshot = origSnapshot;
    la.getProductRecord = origProduct;
  }
});

test('systemPrompt documents the full source-of-truth and forbids invented values', () => {
  const sp = aiResolver._internal.systemPrompt();
  assert.match(sp, /source_of_truth/);
  assert.match(sp, /pim_raw/);
  assert.match(sp, /product_raw/);
  assert.match(sp, /NEVER invent/);
  assert.match(sp, /value_sources/);
  assert.match(sp, /unresolved/);
});
