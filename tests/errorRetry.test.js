const { test } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
helpers.isolate();
process.env.SPAPI_WRITES_ENABLED = 'false';

const crypto = require('node:crypto');
const submissions = require('../src/submissions');
const errorRetry = require('../src/errorRetry');

test('isRetryable accepts FAILED and BLOCKED rows with a stored body', () => {
  const uuid = crypto.randomUUID();
  submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'VCFIX', operation: 'patchItem',
    vendorCode: 'V1', sku: 'SKU1', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [] },
    status: 'FAILED'
  });
  submissions.update(uuid, { error_message: 'bad' });
  const row = submissions.getByUuid(uuid);
  assert.equal(errorRetry.isRetryable(row), true);
  submissions.update(uuid, { status: 'APPLIED', error_message: null });
  assert.equal(errorRetry.isRetryable(submissions.getByUuid(uuid)), false);
});

test('retrySubmission clears stale diagnostics before forwarding', async () => {
  const uuid = crypto.randomUUID();
  submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'VCFIX', operation: 'patchItem',
    vendorCode: 'V1', sku: 'SKU1', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [] },
    status: 'FAILED'
  });
  submissions.update(uuid, {
    error_message: 'old error',
    effective_sku: 'OTHER',
    issues_json: [{ code: '999', message: 'stale' }],
    package_level_readded: 1
  });
  const result = await errorRetry.retrySubmission(uuid, { actor: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'BLOCKED');
  const row = submissions.getByUuid(uuid);
  assert.equal(row.issues_json, '[]');
  assert.equal(row.package_level_readded, 0);
  assert.equal(row.effective_sku, null);
  assert.match(row.error_message, /kill switch/i);
});
