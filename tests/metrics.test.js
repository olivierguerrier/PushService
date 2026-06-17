const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const { getDb } = require('../src/db');
const metrics = require('../src/metrics');
const jobs = require('../src/jobs');
const submissions = require('../src/submissions');

test('dashboard metrics reflect 24h jobs including finished work', () => {
  const runningUuid = 'job-metrics-running';
  jobs.create({
    jobUuid: runningUuid,
    kind: 'patchItem',
    targetCount: 5,
    asin: 'B000TEST01'
  });
  jobs.update(runningUuid, { status: 'running', started_at: new Date().toISOString(), ok_count: 2, failed_count: 0 });

  submissions.insert({
    submissionUuid: 'sub-metrics-running',
    jobUuid: runningUuid,
    caller: 'test',
    scope: 'listing',
    operation: 'patch',
    status: 'IN_PROGRESS',
    requestBody: {}
  });

  const completedUuid = 'job-metrics-done';
  jobs.create({
    jobUuid: completedUuid,
    kind: 'patchItem',
    targetCount: 3,
    asin: 'B000TEST02'
  });
  jobs.update(completedUuid, {
    status: 'completed',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ok_count: 3,
    failed_count: 0
  });

  for (const [i, status] of ['APPLIED', 'APPLIED', 'APPLIED'].entries()) {
    submissions.insert({
      submissionUuid: `sub-metrics-done-${i}`,
      jobUuid: completedUuid,
      caller: 'test',
      scope: 'listing',
      operation: 'patch',
      status,
      requestBody: {}
    });
  }

  const m = metrics.getDashboard();
  assert.equal(m.jobs24h.total, 2);
  assert.equal(m.jobs24h.running, 1);
  assert.equal(m.jobs24h.completed, 1);
  assert.equal(m.progress24h.total, 4);
  assert.equal(m.progress24h.done, 3);
  assert.equal(m.progress24h.ok, 3);
  assert.equal(m.progress24h.percent, 75);
  assert.equal(m.progress24h.remaining, 1);
  assert.ok(m.throughput.settled >= 0);
  assert.ok(m.eta.available);

  const oldUuid = 'job-metrics-old';
  jobs.create({
    jobUuid: oldUuid,
    kind: 'patchItem',
    targetCount: 10,
    asin: 'B000OLD001'
  });
  const db = getDb();
  db.prepare(`UPDATE push_jobs SET created_at = datetime('now', '-30 hours') WHERE job_uuid = ?`).run(oldUuid);
  submissions.insert({
    submissionUuid: 'sub-metrics-old',
    jobUuid: oldUuid,
    caller: 'test',
    scope: 'listing',
    operation: 'patch',
    status: 'APPLIED',
    requestBody: {}
  });

  const m2 = metrics.getDashboard();
  assert.equal(m2.jobs24h.total, 2);
  assert.equal(m2.progress24h.total, 4);
});
