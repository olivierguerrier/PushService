const { test } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
helpers.isolate();
process.env.SPAPI_WRITES_ENABLED = 'false';

const crypto = require('node:crypto');
const submissions = require('../src/submissions');
const forwarder = require('../src/forwarder');

test('forwarder refuses to write when the kill switch is off', async () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'VCFIX', operation: 'patchItem',
    vendorCode: 'V1', sku: 'SKU1', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] }] },
    status: 'IN_PROGRESS'
  });
  const result = await forwarder.forward(row);
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.error_message, /kill switch/i);
});
