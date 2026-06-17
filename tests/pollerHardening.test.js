const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
require('./helpers').isolate();

const jobs = require('../src/jobs');
const submissions = require('../src/submissions');
const feeds = require('../src/spapi/feeds');
const poller = require('../src/poller');

const newId = () => crypto.randomUUID();

function insertFeedSubmission({ marketplaceCode = 'US', feedId = 'feed-x' } = {}) {
  const jobUuid = newId();
  const submissionUuid = newId();
  jobs.create({ jobUuid, kind: 'submitJsonListingsFeed', targetCount: 1 });
  jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });
  submissions.insert({
    submissionUuid,
    jobUuid,
    caller: 'test',
    scope: 'content',
    operation: 'submitJsonListingsFeed',
    marketplaceCode,
    status: 'IN_PROGRESS',
    requestBody: { payload: {} }
  });
  submissions.update(submissionUuid, { feed_id: feedId });
  return { jobUuid, submissionUuid };
}

test('poller abandons a feed submission with no marketplace_code immediately', async () => {
  const realGetFeed = feeds.getFeed;
  let getFeedCalls = 0;
  feeds.getFeed = async () => { getFeedCalls += 1; return { processingStatus: 'IN_PROGRESS' }; };
  try {
    const { submissionUuid, jobUuid } = insertFeedSubmission({ marketplaceCode: null });

    await poller.runOnce();

    const settled = submissions.getByUuid(submissionUuid);
    assert.equal(settled.status, 'FAILED');
    assert.match(settled.error_message, /marketplace_code/);
    assert.equal(getFeedCalls, 0, 'should not even attempt a status read without a marketplace');
    assert.equal(jobs.getByUuid(jobUuid).status, 'failed');
  } finally {
    feeds.getFeed = realGetFeed;
  }
});

test('poller abandons a feed submission after POLLER_MAX_FEED_ERRORS consecutive errors', async () => {
  const realGetFeed = feeds.getFeed;
  const prevMax = process.env.POLLER_MAX_FEED_ERRORS;
  process.env.POLLER_MAX_FEED_ERRORS = '3';
  feeds.getFeed = async () => { throw new Error('boom'); };
  try {
    const { submissionUuid } = insertFeedSubmission({ marketplaceCode: 'US' });

    // First two polls accumulate errors but keep the row IN_PROGRESS.
    await poller.runOnce();
    assert.equal(submissions.getByUuid(submissionUuid).status, 'IN_PROGRESS');
    assert.equal(submissions.getByUuid(submissionUuid).poll_error_count, 1);

    await poller.runOnce();
    assert.equal(submissions.getByUuid(submissionUuid).status, 'IN_PROGRESS');
    assert.equal(submissions.getByUuid(submissionUuid).poll_error_count, 2);

    // Third crosses the limit and abandons it.
    await poller.runOnce();
    const settled = submissions.getByUuid(submissionUuid);
    assert.equal(settled.status, 'FAILED');
    assert.match(settled.error_message, /Abandoned after 3 consecutive poll errors/);
  } finally {
    feeds.getFeed = realGetFeed;
    if (prevMax === undefined) delete process.env.POLLER_MAX_FEED_ERRORS;
    else process.env.POLLER_MAX_FEED_ERRORS = prevMax;
  }
});

test('poller resets the error count after a successful status read', async () => {
  const realGetFeed = feeds.getFeed;
  let calls = 0;
  // First call fails, second succeeds (still IN_PROGRESS at Amazon).
  feeds.getFeed = async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return { processingStatus: 'IN_PROGRESS' };
  };
  try {
    const { submissionUuid } = insertFeedSubmission({ marketplaceCode: 'US' });

    await poller.runOnce();
    assert.equal(submissions.getByUuid(submissionUuid).poll_error_count, 1);

    await poller.runOnce();
    const row = submissions.getByUuid(submissionUuid);
    assert.equal(row.status, 'IN_PROGRESS');
    assert.equal(row.poll_error_count, 0, 'a healthy read clears the transient-error tally');
  } finally {
    feeds.getFeed = realGetFeed;
  }
});
