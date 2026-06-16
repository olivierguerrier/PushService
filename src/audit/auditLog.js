// Append-only JSONL mirror of the audit trail — defence-in-depth alongside
// the audit_events table. Synchronous fs.appendFileSync so the line hits
// disk before the caller's await resolves; a process kill in the next
// instant cannot lose it. Monthly files rotate by filename automatically.
//
// Ported in spirit from FlyApp's publishAuditLog.js, scrubbed of secrets.
const fs = require('fs');
const path = require('path');
const { AUDIT_DIR } = require('../../config/paths');
const { scrubObject } = require('../../lib/safeError');

let dirEnsured = false;
function ensureDir() {
  if (dirEnsured) return;
  try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); dirEnsured = true; }
  catch (err) { console.warn(`[audit-log] could not create ${AUDIT_DIR}: ${err.message}`); }
}

function fileForNow(now = new Date()) {
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(AUDIT_DIR, `audit-${ym}.jsonl`);
}

function listFiles() {
  let entries;
  try { entries = fs.readdirSync(AUDIT_DIR); }
  catch { return []; }
  return entries
    .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
    .map((f) => path.join(AUDIT_DIR, f))
    .sort();
}

function append(event) {
  if (!event || typeof event !== 'object') return;
  ensureDir();
  const payload = { ts: new Date().toISOString(), pid: process.pid, ...scrubObject(event) };
  let line;
  try { line = JSON.stringify(payload) + '\n'; }
  catch (err) {
    line = JSON.stringify({ ts: payload.ts, pid: payload.pid, event: event.event || 'unknown', __serialise_error: String(err && err.message || err) }) + '\n';
  }
  try { fs.appendFileSync(fileForNow(), line, 'utf8'); }
  catch (err) { console.warn(`[audit-log] failed to append: ${err.message}`); }
}

function* readAll() {
  for (const file of listFiles()) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { yield JSON.parse(trimmed); }
      catch (err) { console.warn(`[audit-log] skipping malformed line in ${path.basename(file)}: ${err.message}`); }
    }
  }
}

module.exports = { append, readAll, listFiles, fileForNow };
