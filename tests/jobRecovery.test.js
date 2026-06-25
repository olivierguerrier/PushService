const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
require('./helpers').isolate();

const jobs = require('../src/jobs');
const submissions = require('../src/submissions');
const jobRecovery = require('../src/jobRecovery');
const jobFanOutResume = require('../src/jobFanOutResume');
const approvalQueue = require('../src/approvalQueue');
const forwarder = require('../src/forwarder');

const newId = () => crypto.randomUUID();

test('resumeInterruptedForwards re-enqueues queued rows without a feed_id', async () => {
  const realForward = forwarder.forward;
  const forwarded = [];
  forwarder.forward = async (submission) => {
    forwarded.push(submission.submission_uuid);
    submissions.update(submission.submission_uuid, { status: 'APPLIED' });
    return submissions.getByUuid(submission.submission_uuid);
  };

  try {
    const jobUuid = newId();
    const submissionUuid = newId();
    jobs.create({ jobUuid, kind: 'patchItem', targetCount: 1 });
    jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });

    submissions.insert({
      submissionUuid,
      jobUuid,
      caller: 'test',
      scope: 'content',
      operation: 'patchItem',
      status: 'QUEUED',
      requestBody: { patches: [] }
    });

    const summary = jobRecovery.resumeInterruptedForwards();
    assert.ok(summary.resumed >= 1);

    await approvalQueue.idle();
    assert.ok(forwarded.includes(submissionUuid));
  } finally {
    forwarder.forward = realForward;
    await approvalQueue.idle();
  }
});

test('resumeInterruptedForwards skips in-flight feeds that already have a feed_id', () => {
  const jobUuid = newId();
  jobs.create({ jobUuid, kind: 'submitJsonListingsFeed', targetCount: 1 });

  submissions.insert({
    submissionUuid: newId(),
    jobUuid,
    caller: 'test',
    scope: 'content',
    operation: 'submitJsonListingsFeed',
    status: 'IN_PROGRESS',
    requestBody: { payload: {} }
  });
  const withFeed = submissions.listForJob(jobUuid)[0];
  submissions.update(withFeed.submission_uuid, { feed_id: 'feed-123' });

  const before = jobRecovery.listInterruptedForwards().length;
  const summary = jobRecovery.resumeInterruptedForwards();
  const after = jobRecovery.listInterruptedForwards().length;
  assert.equal(summary.resumed, after - before);
  assert.equal(after, before);
});

test('recoverStuckJobs keeps jobs with full fan-out open and recomputes them', () => {
  const jobUuid = newId();
  jobs.create({ jobUuid, kind: 'patchItem', targetCount: 2 });
  const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  jobs.update(jobUuid, { status: 'running', started_at: staleIso, target_count: 2 });

  submissions.insert({
    submissionUuid: newId(),
    jobUuid,
    caller: 'test',
    scope: 'content',
    operation: 'patchItem',
    status: 'APPLIED',
    requestBody: {}
  });
  submissions.insert({
    submissionUuid: newId(),
    jobUuid,
    caller: 'test',
    scope: 'content',
    operation: 'patchItem',
    status: 'IN_PROGRESS',
    requestBody: {}
  });

  jobs.recoverStuckJobs({ staleAfterMinutes: 15 });

  const job = jobs.getByUuid(jobUuid);
  assert.equal(job.status, 'running');
  assert.equal(job.error_message, null);
});

test('recoverStuckJobs still closes legacy jobs interrupted mid-fan-out', () => {
  const jobUuid = newId();
  jobs.create({ jobUuid, kind: 'patchItem', targetCount: 3 });
  const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  jobs.update(jobUuid, { status: 'running', started_at: staleIso, target_count: 3 });

  submissions.insert({
    submissionUuid: newId(),
    jobUuid,
    caller: 'test',
    scope: 'content',
    operation: 'patchItem',
    status: 'APPLIED',
    requestBody: {}
  });

  jobs.recoverStuckJobs({ staleAfterMinutes: 15 });

  const job = jobs.getByUuid(jobUuid);
  assert.equal(job.status, 'partial');
  assert.match(job.error_message, /mid-fan-out/);
  assert.equal(job.failed_count, 2);
});

test('recoverStuckJobs leaves resumable mid-fan-out jobs open', () => {
  const jobUuid = newId();
  jobs.create({
    jobUuid,
    kind: 'patchItem',
    targetCount: 3,
    requestPayload: {
      path: 'push',
      scope: 'VCFIX',
      operation: 'patchItem',
      targets: [
        { asin: 'B001', marketplaceCode: 'US', productType: 'TOY', sellerId: 'V1', sku: 'S1' },
        { asin: 'B002', marketplaceCode: 'US', productType: 'TOY', sellerId: 'V1', sku: 'S2' },
        { asin: 'B003', marketplaceCode: 'US', productType: 'TOY', sellerId: 'V1', sku: 'S3' }
      ]
    }
  });
  const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  jobs.update(jobUuid, { status: 'running', started_at: staleIso, target_count: 3 });

  submissions.insert({
    submissionUuid: newId(),
    jobUuid,
    caller: 'test',
    scope: 'content',
    operation: 'patchItem',
    status: 'APPLIED',
    requestBody: {}
  });

  jobs.recoverStuckJobs({ staleAfterMinutes: 15 });

  const job = jobs.getByUuid(jobUuid);
  assert.equal(job.status, 'running');
  assert.equal(job.error_message, null);
});

test('resumeIncompleteFanOuts continues remaining targets after a crash', async () => {
  const push = require('../routes/push');
  const realHandlers = push.pushHandlers;
  const created = [];
  push.pushHandlers = {
    loadContentMatchAsinGate: async () => null,
    handleTarget: async ({ jobUuid, target }) => {
      const submissionUuid = newId();
      submissions.insert({
        submissionUuid,
        jobUuid,
        caller: 'test-caller',
        scope: 'content',
        operation: 'patchItem',
        asin: target.asin,
        marketplaceCode: target.marketplaceCode,
        sku: target.sku,
        status: 'APPLIED',
        requestBody: {}
      });
      created.push(submissionUuid);
      return { submissionId: submissionUuid, status: 'APPLIED', marketplaceCode: target.marketplaceCode };
    },
    handlePackageTarget: async () => {
      throw new Error('not expected in this test');
    }
  };

  try {
    const jobUuid = newId();
    const firstSubmissionUuid = newId();
    jobs.create({
      jobUuid,
      kind: 'patchItem',
      caller: 'test-caller',
      targetCount: 2,
      requestPayload: {
        path: 'push',
        scope: 'VCFIX',
        operation: 'patchItem',
        targets: [
          { asin: 'B001', marketplaceCode: 'US', productType: 'TOY', sellerId: 'V1', sku: 'S1' },
          { asin: 'B002', marketplaceCode: 'US', productType: 'TOY', sellerId: 'V1', sku: 'S2' }
        ]
      }
    });
    jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });

    submissions.insert({
      submissionUuid: firstSubmissionUuid,
      jobUuid,
      caller: 'test-caller',
      scope: 'content',
      operation: 'patchItem',
      asin: 'B001',
      marketplaceCode: 'US',
      sku: 'S1',
      status: 'APPLIED',
      requestBody: {}
    });

    const rows = jobFanOutResume.listIncompleteJobs().filter((r) => r.job_uuid === jobUuid);
    assert.equal(rows.length, 1);
    const result = await jobFanOutResume.resumeOneJob(rows[0]);
    await approvalQueue.idle();
    assert.ok(result.resumed);
    assert.equal(submissions.listForJob(jobUuid).length, 2);
    assert.equal(created.length, 1);

    const job = jobs.getByUuid(jobUuid);
    assert.equal(job.status, 'completed');
  } finally {
    push.pushHandlers = realHandlers;
    await approvalQueue.idle();
  }
});

test('recomputeOpenJobs settles completed jobs after children finish', () => {
  const jobUuid = newId();
  jobs.create({ jobUuid, kind: 'patchItem', targetCount: 1 });
  jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });

  submissions.insert({
    submissionUuid: newId(),
    jobUuid,
    caller: 'test',
    scope: 'content',
    operation: 'patchItem',
    status: 'APPLIED',
    requestBody: {}
  });

  jobRecovery.recomputeOpenJobs();

  const job = jobs.getByUuid(jobUuid);
  assert.equal(job.status, 'completed');
  assert.ok(job.completed_at);
});
