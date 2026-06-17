// Serial executor for manual approvals. Operators can approve many held
// submissions at once, but each resulting SP-API write should run one after the
// other so a bulk click does not burst into Amazon and cause avoidable 429s.
const forwarder = require('./forwarder');
const { recomputeJobStatus } = require('./jobOrchestrator');

let tail = Promise.resolve();
let pending = 0;

function enqueue(submission) {
  pending += 1;
  const task = tail.then(async () => {
    try {
      const settled = await forwarder.forward(submission);
      recomputeJobStatus(submission.job_uuid);
      return settled;
    } catch (err) {
      console.error(`[approvalQueue] forward failed for ${submission.submission_uuid}:`, err.message);
      try { recomputeJobStatus(submission.job_uuid); } catch (_) {}
      return null;
    } finally {
      pending -= 1;
    }
  });
  tail = task.catch(() => null);
  return task;
}

function enqueueMany(rows) {
  return rows.map((row) => enqueue(row));
}

function size() {
  return pending;
}

function idle() {
  return tail;
}

module.exports = { enqueue, enqueueMany, size, idle };
