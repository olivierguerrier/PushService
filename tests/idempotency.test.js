const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const crypto = require('node:crypto');
const submissions = require('../src/submissions');
const idempotency = require('../src/idempotency');

test('lookupReplay returns the original submission for a repeated key', () => {
  const uuid = crypto.randomUUID();
  const key = 'idem-key-123';
  submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'VCFIX', operation: 'patchItem',
    marketplaceCode: 'US', productType: 'TOYS_AND_GAMES', idempotencyKey: key,
    requestBody: { productType: 'TOYS_AND_GAMES', patches: [] }, status: 'APPLIED'
  });
  submissions.update(uuid, { amazon_response_json: { status: 'ACCEPTED', issues: [] } });

  const replay = idempotency.lookupReplay(key);
  assert.ok(replay);
  assert.equal(replay.submission.submission_uuid, uuid);
  assert.equal(replay.response.replayed, true);
  assert.equal(replay.response.submissionId, uuid);
});

test('lookupReplay returns null for an unknown key', () => {
  assert.equal(idempotency.lookupReplay('never-seen'), null);
  assert.equal(idempotency.lookupReplay(null), null);
});

test('duplicate idempotency key is rejected by the UNIQUE constraint', () => {
  const key = 'dup-key';
  submissions.insert({
    submissionUuid: crypto.randomUUID(), caller: 'test', scope: 'VCFIX', operation: 'patchItem',
    marketplaceCode: 'US', productType: 'X', idempotencyKey: key,
    requestBody: { patches: [] }, status: 'APPLIED'
  });
  assert.throws(() => submissions.insert({
    submissionUuid: crypto.randomUUID(), caller: 'test', scope: 'VCFIX', operation: 'patchItem',
    marketplaceCode: 'US', productType: 'X', idempotencyKey: key,
    requestBody: { patches: [] }, status: 'APPLIED'
  }), /UNIQUE/);
});
