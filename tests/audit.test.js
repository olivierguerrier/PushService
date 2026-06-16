const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const { getDb } = require('../src/db');
const audit = require('../src/audit/auditEvents');

test('audit_events is hash-chained and verifies', () => {
  audit.record({ event: 'a', actor: 'test', details: { n: 1 } });
  audit.record({ event: 'b', actor: 'test', details: { n: 2 } });
  audit.record({ event: 'c', submissionUuid: 's1', actor: 'test' });
  const result = audit.verifyChain();
  assert.equal(result.ok, true);
  assert.ok(result.checked >= 3);
});

test('secrets are scrubbed before storage', () => {
  audit.record({ event: 'with-secret', actor: 'test', details: { refresh_token: 'super-secret', note: 'ok' } });
  const events = audit.query({ event: 'with-secret', limit: 1 });
  assert.equal(events[0].details.refresh_token, '[redacted]');
  assert.equal(events[0].details.note, 'ok');
});

test('audit_events blocks UPDATE and DELETE (insert-only)', () => {
  const db = getDb();
  audit.record({ event: 'immutable-test', actor: 'test' });
  const row = db.prepare("SELECT id FROM audit_events WHERE event = 'immutable-test' LIMIT 1").get();
  assert.throws(() => db.prepare('UPDATE audit_events SET event = ? WHERE id = ?').run('tampered', row.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run(row.id), /append-only/);
});

test('listForSubmission returns the submission timeline', () => {
  audit.record({ event: 'x1', submissionUuid: 'sub-xyz', actor: 'test' });
  audit.record({ event: 'x2', submissionUuid: 'sub-xyz', actor: 'test' });
  const timeline = audit.listForSubmission('sub-xyz');
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].event, 'x1');
});
