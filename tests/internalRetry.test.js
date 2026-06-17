const { test } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
helpers.isolate();
process.env.SPAPI_WRITES_ENABLED = 'true';
process.env.RECON_ENABLED = 'false';
process.env.SPAPI_INTERNAL_RETRY_MAX = '2';
process.env.SPAPI_INTERNAL_RETRY_BACKOFF_MS = '0';

const crypto = require('node:crypto');
const submissions = require('../src/submissions');
const forwarder = require('../src/forwarder');
const listingsItems = require('../src/spapi/listingsItems');

const INTERNAL_ISSUE = { code: '4000000', message: 'An internal error has occurred. Try again.', severity: 'ERROR', attributeNames: ['merchant_suggested_asin'] };

function withMockedSpApi(patch, fn) {
  const realPatch = listingsItems.patchItem;
  const realGet = listingsItems.getItem;
  listingsItems.patchItem = patch;
  listingsItems.getItem = async () => ({ attributes: {} });
  return Promise.resolve().then(fn).finally(() => { listingsItems.patchItem = realPatch; listingsItems.getItem = realGet; });
}

function newRow(extra = {}) {
  const uuid = crypto.randomUUID();
  return submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: 'V1', sku: 'SKU1', asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: 'B0080AHI5M' }] }] },
    status: 'IN_PROGRESS', ...extra
  });
}

test('4000000 internal error is retried and can succeed on a later attempt', async () => {
  const row = newRow();
  let calls = 0;
  await withMockedSpApi(async ({ sku }) => {
    calls += 1;
    if (calls < 3) return { sku, status: 'INVALID', issues: [INTERNAL_ISSUE] };
    return { sku, status: 'ACCEPTED', issues: [] };
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'APPLIED');
  });
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('4000000 that never clears settles FAILED after exhausting retries', async () => {
  const row = newRow();
  let calls = 0;
  await withMockedSpApi(async ({ sku }) => { calls += 1; return { sku, status: 'INVALID', issues: [INTERNAL_ISSUE] }; }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'FAILED');
  });
  assert.equal(calls, 3, 'initial attempt + 2 retries, then give up');
});

test('a non-4000000 failure is not retried', async () => {
  const row = newRow();
  let calls = 0;
  await withMockedSpApi(async ({ sku }) => { calls += 1; return { sku, status: 'INVALID', issues: [{ code: '90220', message: 'real validation error', attributeNames: ['item_name'] }] }; }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'FAILED');
  });
  assert.equal(calls, 1, 'genuine validation errors are not retried');
});

test('internal retry composes with the vendor_sku fallback', async () => {
  const row = newRow({ parentSku: 'BX1170C6Z' });
  const calls = [];
  await withMockedSpApi(async ({ sku }) => {
    calls.push(sku);
    if (sku === 'SKU1') {
      // documented SKU: a transient 4000000, then the vendor_sku rejection.
      const internalCount = calls.filter((s) => s === 'SKU1').length;
      if (internalCount === 1) return { sku, status: 'INVALID', issues: [INTERNAL_ISSUE] };
      return { sku, status: 'INVALID', issues: [{ code: '101168', message: "You can't change Vendor SKU from its original value 'BX1170C6Z'.", attributeNames: ['vendor_sku'] }] };
    }
    return { sku, status: 'ACCEPTED', issues: [] };
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'APPLIED');
    assert.equal(settled.effective_sku, 'BX1170C6Z');
  });
  assert.deepEqual(calls, ['SKU1', 'SKU1', 'BX1170C6Z'], 'retry on documented SKU, then fallback to parent SKU');
});

test('isInternalRetryableError matches only 4000000', () => {
  assert.equal(forwarder.isInternalRetryableError([INTERNAL_ISSUE]), true);
  assert.equal(forwarder.isInternalRetryableError([{ code: '101168' }]), false);
  assert.equal(forwarder.isInternalRetryableError([]), false);
  assert.equal(forwarder.isInternalRetryableError(null), false);
});
