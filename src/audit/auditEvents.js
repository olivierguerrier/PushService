// The audit trail recorder. Every meaningful lifecycle event is recorded
// in TWO places for durability and tamper-evidence:
//   1. audit_events (SQLite, insert-only, hash-chained).
//   2. audit-YYYY-MM.jsonl (append-only file mirror).
//
// Hash chain: each row's `hash` = sha256(prev_hash + canonical(payload)).
// Because the table blocks UPDATE/DELETE (triggers in db.js) and every row
// commits the previous row's hash, any after-the-fact edit to a row breaks
// the chain from that point forward and is detectable by verifyChain().
const crypto = require('crypto');
const { getDb } = require('../db');
const auditLog = require('./auditLog');
const { scrubObject } = require('../../lib/safeError');

function canonical(obj) {
  return JSON.stringify(obj, (key, value) => value, 0);
}

function lastHash(db) {
  const row = db.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').get();
  return row ? row.hash : '';
}

// Record one audit event. `details` is scrubbed of secrets before storage.
// Never throws — losing an audit line must not abort the push it describes,
// but the JSONL mirror still captures the attempt.
function record({ event, submissionUuid = null, jobUuid = null, actor = null, details = null }) {
  const safeDetails = details == null ? null : scrubObject(details);
  const at = new Date().toISOString();
  const eventUuid = crypto.randomUUID();
  let hash = null;
  let prev = '';
  try {
    const db = getDb();
    const body = { event_uuid: eventUuid, submission_uuid: submissionUuid, job_uuid: jobUuid, event, actor, details: safeDetails, at };
    // Reading the chain head and inserting the new row must be atomic with
    // respect to every other writer — including a *separate process* (WAL
    // allows concurrent connections, e.g. an instance booting while the
    // outgoing one is still forwarding). A BEGIN IMMEDIATE transaction takes
    // the write lock before reading lastHash, so two writers can't both branch
    // off the same prev_hash and fork the chain.
    const append = db.transaction(() => {
      prev = lastHash(db);
      hash = crypto.createHash('sha256').update(prev + canonical(body)).digest('hex');
      db.prepare(`
        INSERT INTO audit_events (event_uuid, submission_uuid, job_uuid, event, actor, details_json, prev_hash, hash, at)
        VALUES (@event_uuid, @submission_uuid, @job_uuid, @event, @actor, @details_json, @prev_hash, @hash, @at)
      `).run({
        event_uuid: eventUuid,
        submission_uuid: submissionUuid,
        job_uuid: jobUuid,
        event,
        actor,
        details_json: safeDetails == null ? null : JSON.stringify(safeDetails),
        prev_hash: prev,
        hash,
        at
      });
    });
    append.immediate();
  } catch (err) {
    console.warn(`[audit] DB record failed for '${event}': ${err.message}`);
  }
  // JSONL mirror always runs (even if the DB write failed) so nothing is
  // silently lost.
  auditLog.append({ event, event_uuid: eventUuid, submission_uuid: submissionUuid, job_uuid: jobUuid, actor, hash, prev_hash: prev, details: safeDetails });
  return { eventUuid, hash };
}

function listForSubmission(submissionUuid) {
  const db = getDb();
  return db.prepare('SELECT event, actor, details_json, hash, at FROM audit_events WHERE submission_uuid = ? ORDER BY id ASC')
    .all(submissionUuid)
    .map((r) => ({ event: r.event, actor: r.actor, details: r.details_json ? JSON.parse(r.details_json) : null, hash: r.hash, at: r.at }));
}

function listForJob(jobUuid) {
  const db = getDb();
  return db.prepare('SELECT event, actor, submission_uuid, details_json, hash, at FROM audit_events WHERE job_uuid = ? ORDER BY id ASC')
    .all(jobUuid)
    .map((r) => ({ event: r.event, actor: r.actor, submission_uuid: r.submission_uuid, details: r.details_json ? JSON.parse(r.details_json) : null, hash: r.hash, at: r.at }));
}

function query({ submissionUuid, jobUuid, event, sinceIso, limit = 200 } = {}) {
  const db = getDb();
  const conds = [];
  const params = [];
  if (submissionUuid) { conds.push('submission_uuid = ?'); params.push(submissionUuid); }
  if (jobUuid) { conds.push('job_uuid = ?'); params.push(jobUuid); }
  if (event) { conds.push('event = ?'); params.push(event); }
  if (sinceIso) { conds.push('at >= ?'); params.push(sinceIso); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  return db.prepare(`SELECT id, event_uuid, submission_uuid, job_uuid, event, actor, details_json, hash, at FROM audit_events ${where} ORDER BY id DESC LIMIT ${cap}`)
    .all(...params)
    .map((r) => ({ id: r.id, event_uuid: r.event_uuid, submission_uuid: r.submission_uuid, job_uuid: r.job_uuid, event: r.event, actor: r.actor, details: r.details_json ? JSON.parse(r.details_json) : null, hash: r.hash, at: r.at }));
}

// Walk the chain in insert order and confirm each row's stored hash matches
// the recomputed hash. Returns { ok, checked, brokenAtId }.
function verifyChain() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY id ASC').all();
  let prev = '';
  for (const r of rows) {
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
      return { ok: false, checked: rows.length, brokenAtId: r.id };
    }
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAtId: null };
}

module.exports = { record, listForSubmission, listForJob, query, verifyChain };
