const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const { getDb } = require('../src/db');
const submissions = require('../src/submissions');

function insertSubmission(uuid, overrides = {}) {
  return submissions.insert({
    submissionUuid: uuid,
    caller: 'test',
    scope: 'listing',
    operation: 'patch',
    status: 'PENDING_APPROVAL',
    requestBody: {},
    ...overrides
  });
}

test('listChanges returns rows newer than afterId', () => {
  insertSubmission('sub-inc-1');
  const first = submissions.listRecent({ limit: 10 })[0];
  insertSubmission('sub-inc-2');
  const changes = submissions.listChanges({ afterId: first.id, limit: 10 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].submission_uuid, 'sub-inc-2');
});

test('listChanges returns updated rows since timestamp', () => {
  insertSubmission('sub-inc-old');
  const afterId = submissions.maxId();
  const db = getDb();
  db.prepare(`UPDATE push_submissions SET updated_at = datetime('now', '-5 minutes') WHERE submission_uuid = ?`).run('sub-inc-old');
  const since = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  submissions.update('sub-inc-old', { status: 'APPLIED' });
  const changes = submissions.listChanges({ afterId, updatedSince: since, limit: 10 });
  const updated = changes.filter((r) => r.submission_uuid === 'sub-inc-old');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, 'APPLIED');
});

test('maxId tracks highest submission id', () => {
  const before = submissions.maxId();
  insertSubmission('sub-inc-max');
  assert.ok(submissions.maxId() > before);
});
