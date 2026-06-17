const { test } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
helpers.isolate();
process.env.SPAPI_WRITES_ENABLED = 'true';
process.env.RECON_ENABLED = 'false';

const crypto = require('node:crypto');
const submissions = require('../src/submissions');
const forwarder = require('../src/forwarder');
const listingsItems = require('../src/spapi/listingsItems');

const VENDOR_SKU_ISSUE = {
  code: '101168',
  message: "You can't change Vendor SKU from its original value 'BX1170C6Z'. Revert to the original value, or contact Amazon Support if you believe it's incorrect.",
  severity: 'ERROR',
  attributeNames: ['vendor_sku']
};

function withMockedSpApi({ patch, getItem }, fn) {
  const realPatch = listingsItems.patchItem;
  const realGet = listingsItems.getItem;
  listingsItems.patchItem = patch;
  listingsItems.getItem = getItem || (async () => ({ attributes: {} }));
  return Promise.resolve()
    .then(fn)
    .finally(() => { listingsItems.patchItem = realPatch; listingsItems.getItem = realGet; });
}

test('vendor_sku 101168 failure retries the same vendor code with the parent SKU and applies', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: '6W6GA', sku: 'B0080AHI5M', parentSku: 'BX1170C6Z',
    asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: 'B0080AHI5M' }] }] },
    status: 'IN_PROGRESS'
  });

  const calls = [];
  await withMockedSpApi({
    patch: async ({ sellerId, sku }) => {
      calls.push({ sellerId, sku });
      if (sku === 'B0080AHI5M') return { sku, status: 'INVALID', issues: [VENDOR_SKU_ISSUE] };
      return { sku, status: 'ACCEPTED', issues: [] };
    }
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'APPLIED');
    assert.equal(settled.effective_sku, 'BX1170C6Z');
  });

  assert.equal(calls.length, 2, 'documented SKU attempt + parent SKU retry');
  assert.deepEqual(calls[0], { sellerId: '6W6GA', sku: 'B0080AHI5M' });
  assert.deepEqual(calls[1], { sellerId: '6W6GA', sku: 'BX1170C6Z' }, 'retry keeps the original vendor code, swaps to the parent SKU');
});

test('no parent SKU and no NEW inferable SKU → the failure stands', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: '6W6GA', sku: 'B0080AHI5M',
    asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: 'B0080AHI5M' }] }] },
    status: 'IN_PROGRESS'
  });

  let calls = 0;
  await withMockedSpApi({
    // 101168 names the SAME documented SKU, so inference yields nothing new.
    patch: async ({ sku }) => {
      calls += 1;
      return { sku, status: 'INVALID', issues: [{ code: '101168', message: "You can't change Vendor SKU from its original value 'B0080AHI5M'.", attributeNames: ['vendor_sku'] }] };
    }
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'FAILED');
    assert.equal(settled.effective_sku, null);
  });
  assert.equal(calls, 1, 'no parent SKU and the error names the already-tried SKU → no retry');
});

test('a non-vendor_sku failure does not trigger the parent SKU fallback', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: '6W6GA', sku: 'B0080AHI5M', parentSku: 'BX1170C6Z',
    asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] }] },
    status: 'IN_PROGRESS'
  });

  let calls = 0;
  await withMockedSpApi({
    patch: async ({ sku }) => { calls += 1; return { sku, status: 'INVALID', issues: [{ code: '90220', message: 'some other validation error', attributeNames: ['item_name'] }] }; }
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'FAILED');
    assert.equal(settled.effective_sku, null);
  });
  assert.equal(calls, 1, 'unrelated errors are not retried with the parent SKU');
});

function vendorSkuIssue(original) {
  return {
    code: '101168',
    message: `You can't change Vendor SKU from its original value '${original}'. Revert to the original value, or contact Amazon Support if you believe it's incorrect.`,
    severity: 'ERROR',
    attributeNames: ['vendor_sku']
  };
}

test('when the parent SKU also gets 101168, the canonical SKU is inferred from the error and applied', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: '6W6GA', sku: 'B0080AHI5M', parentSku: 'WRONGPARENT',
    asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: 'B0080AHI5M' }] }] },
    status: 'IN_PROGRESS'
  });

  const calls = [];
  await withMockedSpApi({
    patch: async ({ sellerId, sku }) => {
      calls.push({ sellerId, sku });
      // documented + the (wrong) parent SKU both 101168, each naming the real one.
      if (sku === 'B0080AHI5M' || sku === 'WRONGPARENT') return { sku, status: 'INVALID', issues: [vendorSkuIssue('BX1170C6Z')] };
      return { sku, status: 'ACCEPTED', issues: [] };
    }
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'APPLIED');
    assert.equal(settled.effective_sku, 'BX1170C6Z');
  });

  assert.deepEqual(calls.map((c) => c.sku), ['B0080AHI5M', 'WRONGPARENT', 'BX1170C6Z'],
    'documented -> FlyApp parent -> inferred-from-error');
  assert.ok(calls.every((c) => c.sellerId === '6W6GA'), 'vendor code never changes');
});

test('with no parent SKU, the canonical SKU is inferred from the 101168 error', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: '6W6GA', sku: 'B0080AHI5M',
    asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: 'B0080AHI5M' }] }] },
    status: 'IN_PROGRESS'
  });

  const calls = [];
  await withMockedSpApi({
    patch: async ({ sku }) => {
      calls.push(sku);
      if (sku === 'B0080AHI5M') return { sku, status: 'INVALID', issues: [vendorSkuIssue('BX1170C6Z')] };
      return { sku, status: 'ACCEPTED', issues: [] };
    }
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'APPLIED');
    assert.equal(settled.effective_sku, 'BX1170C6Z');
  });
  assert.deepEqual(calls, ['B0080AHI5M', 'BX1170C6Z']);
});

test('inference does not loop when the named SKU keeps getting rejected', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: '6W6GA', sku: 'B0080AHI5M', parentSku: 'BX1170C6Z',
    asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: 'B0080AHI5M' }] }] },
    status: 'IN_PROGRESS'
  });

  const calls = [];
  await withMockedSpApi({
    patch: async ({ sku }) => { calls.push(sku); return { sku, status: 'INVALID', issues: [vendorSkuIssue('BX1170C6Z')] }; }
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'FAILED');
  });
  // documented -> parent (BX1170C6Z); inference names BX1170C6Z which is already
  // tried, so no further attempts.
  assert.deepEqual(calls, ['B0080AHI5M', 'BX1170C6Z']);
});

test('extractVendorSkuFromIssues parses EN + DE + IT + FR 101168 messages', () => {
  assert.equal(forwarder.extractVendorSkuFromIssues([vendorSkuIssue('BX1170C6Z')]), 'BX1170C6Z');
  assert.equal(forwarder.extractVendorSkuFromIssues([{ code: '101168', message: 'Du kannst Händler-SKU nicht vom ursprünglichen Wert ‚AN2876C1Z‘ ändern.' }]), 'AN2876C1Z');
  // IT: "valore originale AN2871C1Z" — SKU follows the phrase directly, no quotes.
  assert.equal(forwarder.extractVendorSkuFromIssues([{ code: '101168', message: 'Non è possibile modificare SKU venditore dal suo valore originale AN2871C1Z. Ripristina il valore originale oppure contatta l’assistenza Amazon se ritieni che non sia corretto.' }]), 'AN2871C1Z');
  // FR: SKU wrapped in guillemets with a no-break space — « AN2945Z ».
  assert.equal(forwarder.extractVendorSkuFromIssues([{ code: '101168', message: 'Vous ne pouvez pas modifier la valeur Référence SKU du produit par défaut « AN2945Z ». Revenez à la valeur d\u2019origine ou contactez le support Amazon si vous pensez qu\u2019elle est incorrecte.' }]), 'AN2945Z');
  // FR with a narrow no-break space (U+202F) before the SKU — still parses.
  assert.equal(forwarder.extractVendorSkuFromIssues([{ code: '101168', message: 'par défaut «\u202FAN2945Z\u202F».' }]), 'AN2945Z');
  assert.equal(forwarder.extractVendorSkuFromIssues([{ code: '90220', message: "original value 'X'" }]), null);
  assert.equal(forwarder.extractVendorSkuFromIssues([]), null);
});

test('101161 "already listed" on the inferred SKU settles as a successful no-op', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: '1N6BB', sku: 'B0080AHI5M',
    asin: 'B0080AHI5M', marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: 'B0080AHI5M' }] }] },
    status: 'IN_PROGRESS'
  });

  const calls = [];
  await withMockedSpApi({
    patch: async ({ sku }) => {
      calls.push(sku);
      if (sku === 'B0080AHI5M') return { sku, status: 'INVALID', issues: [vendorSkuIssue('BX1170C6Z')] };
      // The canonical SKU exists already and is matched to this ASIN.
      return { sku, status: 'INVALID', issues: [{ code: '101161', message: 'matches another product (SKU: BX1170C6Z; ASIN: B0080AHI5M) already in your catalogue. SKUs cannot be duplicated.', attributeNames: ['merchant_suggested_asin'] }] };
    }
  }, async () => {
    const settled = await forwarder.forward(row);
    assert.equal(settled.status, 'APPLIED', 'already-listed is a successful no-op, not a failure');
    assert.equal(settled.effective_sku, 'BX1170C6Z');
    assert.equal(settled.error_message, null);
  });
  assert.deepEqual(calls, ['B0080AHI5M', 'BX1170C6Z']);
});

test('isAlreadyListedError matches 101161 / 101165 and ignores others', () => {
  assert.equal(forwarder.isAlreadyListedError([{ code: '101161' }]), true);
  assert.equal(forwarder.isAlreadyListedError([{ code: '101165' }]), true);
  assert.equal(forwarder.isAlreadyListedError([{ code: '90220' }, { code: '101161' }]), true);
  assert.equal(forwarder.isAlreadyListedError([{ code: '90220' }]), false);
  assert.equal(forwarder.isAlreadyListedError([{ code: '101168' }]), false);
  assert.equal(forwarder.isAlreadyListedError([]), false);
  assert.equal(forwarder.isAlreadyListedError(null), false);
});

test('isVendorSkuChangeError matches 101168 / vendor_sku and ignores others', () => {
  assert.equal(forwarder.isVendorSkuChangeError([VENDOR_SKU_ISSUE]), true);
  assert.equal(forwarder.isVendorSkuChangeError([{ code: '101168' }]), true);
  assert.equal(forwarder.isVendorSkuChangeError([{ attributeNames: ['vendor_sku'] }]), true);
  assert.equal(forwarder.isVendorSkuChangeError([{ code: '90220', attributeNames: ['item_name'] }]), false);
  assert.equal(forwarder.isVendorSkuChangeError([]), false);
  assert.equal(forwarder.isVendorSkuChangeError(null), false);
});
