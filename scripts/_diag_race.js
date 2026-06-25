// #region agent log (debug session 42d124 — audit chain race reproduction)
// Reproduces the concurrent-writer fork against a TEMP db using the REAL
// src/audit/auditEvents.record path. Runner spawns two worker processes that
// hammer record() at once; afterwards it walks the chain and reports whether
// it forked. Logs evidence to debug-42d124.log.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const LOG = path.join(__dirname, '..', 'debug-42d124.log');
function emit(message, data) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({
      sessionId: '42d124', runId: process.env.DIAG_RUN_ID || 'race', hypothesisId: 'A',
      location: '_diag_race.js', message, data, timestamp: Date.now()
    }) + '\n');
  } catch (_) { /* ignore */ }
}

const MODE = process.argv[2];
const COUNT = Number(process.argv[3] || 400);

if (MODE === 'worker') {
  // Worker process: env (PUSH_DB_PATH / AUDIT_DIR / DATA_DIR) already points at
  // the temp sandbox set by the runner. Exercise the real recorder.
  const audit = require('../src/audit/auditEvents');
  const tag = process.argv[4] || 'w';
  for (let i = 0; i < COUNT; i++) {
    audit.record({ event: 'race_probe', actor: 'system', details: { tag, i } });
  }
  process.exit(0);
}

// ---- Runner ----
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-race-'));
const dbPath = path.join(sandbox, 'push.db');
const auditDir = path.join(sandbox, 'audit-log');
fs.mkdirSync(auditDir, { recursive: true });

const childEnv = {
  ...process.env,
  DATA_DIR: sandbox,
  PUSH_DB_PATH: dbPath,
  AUDIT_DIR: auditDir
};

// Seed the schema first (single connection) so both workers start from a real,
// empty audit_events table.
{
  const Database = require('better-sqlite3');
  const { ensureSchema } = require('../src/db');
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  ensureSchema(seed);
  seed.close();
}

function runWorker(tag) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [__filename, 'worker', String(COUNT), tag], { env: childEnv, stdio: 'ignore' });
    cp.on('exit', (code) => resolve(code));
  });
}

(async () => {
  emit('race run start', { dbPath, count: COUNT, runId: process.env.DIAG_RUN_ID || 'race' });
  await Promise.all([runWorker('A'), runWorker('B')]);

  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id, event_uuid, submission_uuid, job_uuid, event, actor, details_json, prev_hash, hash, at FROM audit_events ORDER BY id ASC').all();

  function canonical(obj) { return JSON.stringify(obj, (k, v) => v, 0); }
  let prev = '';
  let brokenAtId = null;
  let forks = 0;
  for (const r of rows) {
    const body = {
      event_uuid: r.event_uuid, submission_uuid: r.submission_uuid, job_uuid: r.job_uuid,
      event: r.event, actor: r.actor, details: r.details_json ? JSON.parse(r.details_json) : null, at: r.at
    };
    const expect = crypto.createHash('sha256').update(prev + canonical(body)).digest('hex');
    if (expect !== r.hash || r.prev_hash !== prev) {
      forks += 1;
      if (brokenAtId == null) brokenAtId = r.id;
    }
    prev = r.hash;
  }
  db.close();
  emit('race run result', { totalRows: rows.length, chainOk: brokenAtId == null, firstBrokenAtId: brokenAtId, forkCount: forks });
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(0);
})();
// #endregion
