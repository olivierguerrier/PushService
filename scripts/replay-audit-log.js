// Audit-log tooling. The JSONL mirror is the durable record; the SQLite
// audit_events table is the queryable one. This script reconciles them and,
// with --rebuild, restores audit_events from the JSONL files (verbatim,
// preserving the original hash chain) when the DB has been lost.
//
//   node scripts/replay-audit-log.js            # report counts only
//   node scripts/replay-audit-log.js --rebuild  # rebuild empty audit_events
require('../config/env');
const auditLog = require('../src/audit/auditLog');
const { getDb } = require('../src/db');

function countJsonl() {
  let n = 0;
  for (const _ of auditLog.readAll()) n += 1; // eslint-disable-line no-unused-vars
  return n;
}

function main() {
  const rebuild = process.argv.includes('--rebuild');
  const db = getDb();
  const dbCount = db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c;
  const jsonlCount = countJsonl();
  console.log(`audit_events rows in DB:   ${dbCount}`);
  console.log(`events in JSONL mirror:    ${jsonlCount}`);

  if (!rebuild) {
    if (dbCount !== jsonlCount) console.log('NOTE: counts differ — run with --rebuild to restore the DB from JSONL.');
    return;
  }
  if (dbCount > 0) {
    console.error('Refusing to rebuild: audit_events is not empty. The table is append-only by design.');
    process.exit(2);
  }

  // Direct insert (not via the recorder) so we preserve the original
  // event_uuid / hash / prev_hash chain exactly as first written.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO audit_events (event_uuid, submission_uuid, job_uuid, event, actor, details_json, prev_hash, hash, at)
    VALUES (@event_uuid, @submission_uuid, @job_uuid, @event, @actor, @details_json, @prev_hash, @hash, @at)
  `);
  let restored = 0;
  const tx = db.transaction(() => {
    for (const e of auditLog.readAll()) {
      if (!e.event_uuid || !e.hash) continue;
      insert.run({
        event_uuid: e.event_uuid,
        submission_uuid: e.submission_uuid || null,
        job_uuid: e.job_uuid || null,
        event: e.event,
        actor: e.actor || null,
        details_json: e.details == null ? null : JSON.stringify(e.details),
        prev_hash: e.prev_hash || '',
        hash: e.hash,
        at: e.ts || e.at || new Date().toISOString()
      });
      restored += 1;
    }
  });
  tx();
  console.log(`restored ${restored} event(s) into audit_events`);
}

main();
process.exit(0);
