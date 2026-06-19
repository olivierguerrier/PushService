// Dashboard throughput metrics for the operator console.
const { getDb } = require('./db');

const ACTIVE_SUB_STATUSES = ['PENDING_APPROVAL', 'IN_PROGRESS', 'SUBMITTED'];
const SETTLED_SUB_STATUSES = ['APPLIED', 'FAILED', 'REJECTED', 'EXPIRED', 'BLOCKED', 'SKIPPED'];
const THROUGHPUT_WINDOW_MIN = 15;
const DASHBOARD_WINDOW_HOURS = 24;

function countByStatus(table, statusCol, statuses) {
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${statusCol} IN (${placeholders})`
  ).get(...statuses);
  return Number(row && row.n) || 0;
}

function settledInWindow(minutes) {
  const db = getDb();
  const placeholders = SETTLED_SUB_STATUSES.map(() => '?').join(', ');
  const modifier = minutes >= 1
    ? `-${minutes} minutes`
    : `-${Math.max(1, Math.round(minutes * 60))} seconds`;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM push_submissions
    WHERE status IN (${placeholders})
      AND updated_at >= datetime('now', ?)
  `).get(...SETTLED_SUB_STATUSES, modifier);
  return Number(row && row.n) || 0;
}

function activeThroughputStart() {
  const db = getDb();
  const settledPh = SETTLED_SUB_STATUSES.map(() => '?').join(', ');
  const activePh = ACTIVE_SUB_STATUSES.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT MIN(COALESCE(j.started_at, j.created_at)) AS started
    FROM push_jobs j
    WHERE j.created_at >= datetime('now', ?)
      AND (
        j.status IN ('pending', 'running')
        OR EXISTS (
          SELECT 1 FROM push_submissions s
          WHERE s.job_uuid = j.job_uuid
            AND (
              s.status IN (${activePh})
              OR (
                s.status IN (${settledPh})
                AND s.updated_at >= datetime('now', ?)
              )
            )
        )
      )
  `).get(
    `-${DASHBOARD_WINDOW_HOURS} hours`,
    ...ACTIVE_SUB_STATUSES,
    ...SETTLED_SUB_STATUSES,
    `-${THROUGHPUT_WINDOW_MIN} minutes`
  );
  return row && row.started ? row.started : null;
}

function computeThroughput() {
  const startIso = activeThroughputStart();
  if (!startIso) {
    const settled = settledInWindow(THROUGHPUT_WINDOW_MIN);
    return {
      windowMinutes: THROUGHPUT_WINDOW_MIN,
      sinceStart: false,
      settled,
      perMinute: settled / THROUGHPUT_WINDOW_MIN
    };
  }

  const elapsedMinutes = Math.max(0, (Date.now() - new Date(startIso).getTime()) / 60000);
  if (elapsedMinutes >= THROUGHPUT_WINDOW_MIN) {
    const settled = settledInWindow(THROUGHPUT_WINDOW_MIN);
    return {
      windowMinutes: THROUGHPUT_WINDOW_MIN,
      sinceStart: false,
      settled,
      perMinute: settled / THROUGHPUT_WINDOW_MIN
    };
  }

  const windowMinutes = Math.max(elapsedMinutes, 1 / 60);
  const settled = settledInWindow(windowMinutes);
  return {
    windowMinutes: Math.round(windowMinutes * 10) / 10,
    sinceStart: true,
    settled,
    perMinute: settled / windowMinutes
  };
}

function jobsInWindow(hours) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM push_jobs
    WHERE created_at >= datetime('now', ?)
  `).get(`-${hours} hours`);
  return {
    total: Number(row.total) || 0,
    running: Number(row.running) || 0,
    pending: Number(row.pending) || 0,
    completed: Number(row.completed) || 0,
    partial: Number(row.partial) || 0,
    failed: Number(row.failed) || 0,
    finished: (Number(row.completed) || 0) + (Number(row.partial) || 0) + (Number(row.failed) || 0)
  };
}

function submissionProgressInWindow(hours) {
  const db = getDb();
  const settledPh = SETTLED_SUB_STATUSES.map(() => '?').join(', ');
  const activePh = ACTIVE_SUB_STATUSES.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN s.status IN (${settledPh}) THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN s.status IN (${activePh}) THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN s.status = 'PENDING_APPROVAL' THEN 1 ELSE 0 END) AS pending_approval,
      SUM(CASE WHEN s.status IN ('IN_PROGRESS', 'SUBMITTED') THEN 1 ELSE 0 END) AS in_flight,
      SUM(CASE WHEN s.status = 'APPLIED' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN s.status IN ('FAILED', 'REJECTED', 'EXPIRED', 'BLOCKED') THEN 1 ELSE 0 END) AS failed
    FROM push_submissions s
    INNER JOIN push_jobs j ON j.job_uuid = s.job_uuid
    WHERE j.created_at >= datetime('now', ?)
  `).get(...SETTLED_SUB_STATUSES, ...ACTIVE_SUB_STATUSES, `-${hours} hours`);
  const total = Number(row.total) || 0;
  const done = Number(row.done) || 0;
  const remaining = Math.max(0, total - done);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    total,
    done,
    remaining,
    active: Number(row.active) || 0,
    pendingApproval: Number(row.pending_approval) || 0,
    inFlight: Number(row.in_flight) || 0,
    ok: Number(row.ok) || 0,
    failed: Number(row.failed) || 0,
    percent
  };
}

function getDashboard() {
  const jobs24h = jobsInWindow(DASHBOARD_WINDOW_HOURS);
  const progress24h = submissionProgressInWindow(DASHBOARD_WINDOW_HOURS);
  const throughput = computeThroughput();
  const { settled, perMinute } = throughput;
  const remaining = progress24h.remaining;
  let etaSeconds = null;
  if (remaining > 0 && perMinute > 0) {
    etaSeconds = Math.round((remaining / perMinute) * 60);
  }
  return {
    windowHours: DASHBOARD_WINDOW_HOURS,
    jobs24h,
    // Legacy fields kept for compatibility; now scoped to the 24h window.
    jobsRunning: jobs24h.running,
    jobsPending: jobs24h.pending,
    submissionsActive: progress24h.active,
    submissionsPendingApproval: progress24h.pendingApproval,
    submissionsInFlight: progress24h.inFlight,
    progress24h,
    progress: progress24h,
    throughput: {
      windowMinutes: throughput.windowMinutes,
      sinceStart: throughput.sinceStart,
      settled,
      perMinute: Math.round(perMinute * 10) / 10
    },
    eta: {
      remaining,
      seconds: etaSeconds,
      available: etaSeconds != null
    }
  };
}

module.exports = { getDashboard, THROUGHPUT_WINDOW_MIN, DASHBOARD_WINDOW_HOURS };
