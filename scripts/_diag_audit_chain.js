// #region agent log (debug session 42d124 — read-only audit chain diagnostic)
// Read-only diagnostic: recompute the audit hash chain exactly like
// verifyChain() and write evidence about the break to the debug log.
require('../config/env');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PUSH_DB_PATH } = require('../config/paths');

const LOG = path.join(__dirname, '..', 'debug-42d124.log');
function emit(message, data) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({
      sessionId: '42d124', runId: 'diag', hypothesisId: 'A,B,C,D',
      location: '_diag_audit_chain.js', message, data, timestamp: Date.now()
    }) + '\n');
  } catch (_) { /* ignore */ }
}

function canonical(obj) { return JSON.stringify(obj, (key, value) => value, 0); }

const db = new Database(PUSH_DB_PATH, { readonly: true, timeout: 30000 });
const rows = db.prepare('SELECT * FROM audit_events ORDER BY id ASC').all();
emit('row count', { total: rows.length, firstId: rows[0] && rows[0].id, lastId: rows[rows.length - 1] && rows[rows.length - 1].id });

let prev = '';
let brokenAtId = null;
let brokenIdx = -1;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const body = {
    event_uuid: r.event_uuid,
    submission_uuid: r.submission_uuid,
    job_uuid: r.job_uuid,
    event: r.event,
    actor: r.actor,
    details: r.details_json ? JSON.parse(r.details_json) : null,
    at: r.at
  };
  const expect = crypto.createHash('sha256').update(prev + canonical(body)).digest('hex');
  if (expect !== r.hash || r.prev_hash !== prev) {
    brokenAtId = r.id;
    brokenIdx = i;
    emit('FIRST BREAK', {
      id: r.id,
      hashMatches: expect === r.hash,
      prevLinkMatches: r.prev_hash === prev,
      stored_hash: r.hash,
      recomputed_expect: expect,
      stored_prev_hash: r.prev_hash,
      expected_prev_from_prior_row: prev
    });
    break;
  }
  prev = r.hash;
}

if (brokenAtId == null) {
  emit('no break found via full walk', {});
}

// Dump a window of rows around 79324 (and around the detected break) with the
// raw fields and the recomputed hash, so we can see which field diverges.
const targets = new Set();
for (let id = 79320; id <= 79328; id++) targets.add(id);
if (brokenAtId != null) {
  for (let d = -3; d <= 1; d++) targets.add(brokenAtId + d);
}

// Build id->row and id->prevRowHash maps for window inspection.
const byId = new Map(rows.map((r) => [r.id, r]));
const idsSorted = rows.map((r) => r.id);
function priorHashOf(id) {
  const idx = idsSorted.indexOf(id);
  if (idx <= 0) return '';
  return byId.get(idsSorted[idx - 1]).hash;
}

for (const id of [...targets].sort((a, b) => a - b)) {
  const r = byId.get(id);
  if (!r) { emit('window row MISSING', { id }); continue; }
  const body = {
    event_uuid: r.event_uuid,
    submission_uuid: r.submission_uuid,
    job_uuid: r.job_uuid,
    event: r.event,
    actor: r.actor,
    details: r.details_json ? JSON.parse(r.details_json) : null,
    at: r.at
  };
  const priorHash = priorHashOf(id);
  const expect = crypto.createHash('sha256').update(priorHash + canonical(body)).digest('hex');
  emit('window row', {
    id: r.id,
    event: r.event,
    actor: r.actor,
    at: r.at,
    event_uuid: r.event_uuid,
    details_len: r.details_json ? r.details_json.length : 0,
    stored_prev_hash: r.prev_hash,
    priorRowHash: priorHash,
    prevLinkMatches: r.prev_hash === priorHash,
    stored_hash: r.hash,
    recomputed_expect: expect,
    hashMatches: expect === r.hash
  });
}

db.close();
emit('diag done', { brokenAtId });
// #endregion
