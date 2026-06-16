const { test } = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
helpers.isolate();

const crypto = require('node:crypto');
const submissions = require('../src/submissions');
const reconciliation = require('../src/reconciliation');

test('parseOffsets parses a duration list and skips junk', () => {
  assert.deepEqual(reconciliation.parseOffsets('1h,24h,7d'), [3600000, 86400000, 604800000]);
  assert.deepEqual(reconciliation.parseOffsets('30m, bogus, 2d'), [1800000, 172800000]);
  assert.deepEqual(reconciliation.parseOffsets(''), []);
});

test('expectedFromSubmission derives values for patch + feed submissions', () => {
  const patchSub = { operation: 'patchItem', request_body_json: JSON.stringify({ patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] }] }) };
  assert.deepEqual(reconciliation.expectedFromSubmission(patchSub).item_name, [{ value: 'X' }]);

  const feedSub = { operation: 'submitJsonListingsFeed', request_body_json: JSON.stringify({ payload: { messages: [{ sku: 'S1', attributes: { brand: [{ value: 'B' }] } }] } }) };
  assert.deepEqual(reconciliation.expectedFromSubmission(feedSub).brand, [{ value: 'B' }]);
});

test('enqueueForSubmission schedules one check per offset', () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: 'V1', sku: 'SKU1', asin: 'B01', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] }] },
    status: 'APPLIED'
  });
  const res = reconciliation.enqueueForSubmission(row, { offsets: [0, 3600000], now: Date.now() });
  assert.equal(res.scheduled, 2);
  const checks = reconciliation.listForSubmission(uuid);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].status, 'PENDING');
});

test('enqueueForSubmission skips submissions with no expected attributes', () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: 'V1', sku: 'SKU2', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [] }, status: 'APPLIED'
  });
  const res = reconciliation.enqueueForSubmission(row);
  assert.equal(res.scheduled, 0);
});

test('due() returns only checks whose scheduled_at has passed', () => {
  const uuid = crypto.randomUUID();
  const row = submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'CONTENT_MATCH', operation: 'patchItem',
    vendorCode: 'V1', sku: 'SKU3', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES',
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [{ op: 'replace', path: '/attributes/brand', value: [{ value: 'B' }] }] },
    status: 'APPLIED'
  });
  reconciliation.enqueueForSubmission(row, { offsets: [0, 7 * 86400000], now: Date.now() });
  const dueNow = reconciliation.due({ now: Date.now() }).filter((c) => c.submission_uuid === uuid);
  assert.equal(dueNow.length, 1, 'only the +0 check is due now');
});
