const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const approvalQueue = require('../src/approvalQueue');
const forwarder = require('../src/forwarder');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('manual approval forwards run one at a time', async () => {
  const realForward = forwarder.forward;
  const events = [];
  forwarder.forward = async (submission) => {
    events.push(`start:${submission.submission_uuid}`);
    await sleep(5);
    events.push(`end:${submission.submission_uuid}`);
    return submission;
  };

  try {
    const rows = ['a', 'b', 'c'].map((submission_uuid) => ({ submission_uuid, job_uuid: null }));
    await Promise.all(rows.map((row) => approvalQueue.enqueue(row)));
    assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    assert.equal(approvalQueue.size(), 0);
  } finally {
    forwarder.forward = realForward;
    await approvalQueue.idle();
  }
});
