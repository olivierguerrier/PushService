// push.db — the service's own SQLite database (separate failure domain from
// FlyApp). Four tables:
//   push_jobs             — one parent row per user/trigger "push" action.
//   push_submissions      — one child row per (sku x marketplace) write.
//   audit_events          — append-only, immutable event stream (hash-chained).
//   reconciliation_checks — scheduled SP-API read-backs that verify a write is
//                           still reflected live on Amazon over time.
//
// audit_events is protected by triggers that block UPDATE and DELETE: the
// audit trail is insert-only at the database level, so a bug or a
// compromised caller cannot rewrite history.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PUSH_DB_PATH } = require('../config/paths');

let _db = null;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_uuid TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      caller TEXT,
      requested_by TEXT,
      asin TEXT,
      item_number TEXT,
      marketplace_code TEXT,
      product_type TEXT,
      label TEXT,
      request_payload_json TEXT,
      field_names_json TEXT,
      target_count INTEGER NOT NULL DEFAULT 0,
      ok_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      result_summary_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_jobs_status ON push_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_push_jobs_asin ON push_jobs(asin, marketplace_code);

    CREATE TABLE IF NOT EXISTS push_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_uuid TEXT UNIQUE NOT NULL,
      job_uuid TEXT,
      idempotency_key TEXT UNIQUE,
      caller TEXT,
      scope TEXT NOT NULL,
      operation TEXT NOT NULL,
      vendor_code TEXT,
      sku TEXT,
      asin TEXT,
      item_number TEXT,
      marketplace_code TEXT,
      product_type TEXT,
      source_hash TEXT,
      source_snapshot_json TEXT,
      request_body_json TEXT NOT NULL,
      prior_state_json TEXT,
      amazon_response_json TEXT,
      issues_json TEXT,
      status TEXT NOT NULL,
      approval_token TEXT,
      approved_by TEXT,
      approved_at TEXT,
      error_message TEXT,
      feed_id TEXT,
      feed_document_id TEXT,
      revert_of_uuid TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_sub_status ON push_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_push_sub_job ON push_submissions(job_uuid);
    CREATE INDEX IF NOT EXISTS idx_push_sub_approval ON push_submissions(approval_token);
    CREATE INDEX IF NOT EXISTS idx_push_sub_created ON push_submissions(created_at);

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_uuid TEXT UNIQUE NOT NULL,
      submission_uuid TEXT,
      job_uuid TEXT,
      event TEXT NOT NULL,
      actor TEXT,
      details_json TEXT,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_submission ON audit_events(submission_uuid);
    CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_events(job_uuid);
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);

    -- Over-time reconciliation: after a write APPLIES, we schedule N read-backs
    -- (e.g. +1h, +24h, +7d). Each row is one scheduled check that the reconciler
    -- cron picks up when due, GETs the live listing, diffs expected vs observed,
    -- and settles to MATCH / DRIFT / MISSING / ERROR.
    CREATE TABLE IF NOT EXISTS reconciliation_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_uuid TEXT UNIQUE NOT NULL,
      submission_uuid TEXT NOT NULL,
      job_uuid TEXT,
      attempt_index INTEGER NOT NULL DEFAULT 0,
      vendor_code TEXT,
      sku TEXT,
      asin TEXT,
      marketplace_code TEXT,
      product_type TEXT,
      expected_json TEXT,
      observed_json TEXT,
      diff_json TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      scheduled_at TEXT NOT NULL,
      checked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recon_due ON reconciliation_checks(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_recon_submission ON reconciliation_checks(submission_uuid);

    -- AI error resolutions: one latest LLM review per FAILED submission. The
    -- model diagnoses the Amazon error and drafts a corrected SP-API package;
    -- an operator reviews/edits/approves it in the console, at which point a NEW
    -- push_submissions row (linked back via resolves_uuid) is forwarded. This
    -- table only stores the proposal + its lifecycle; the audit trail
    -- (audit_events) remains the immutable record of every review/apply/reject.
    CREATE TABLE IF NOT EXISTS ai_resolutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_uuid TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'PROPOSED',
      diagnosis TEXT,
      root_cause TEXT,
      confidence INTEGER,
      resolvable INTEGER NOT NULL DEFAULT 0,
      operation TEXT,
      proposed_package_json TEXT,
      changed_attr_names_json TEXT,
      unresolved_json TEXT,
      warnings_json TEXT,
      validation_json TEXT,
      model TEXT,
      input_hash TEXT,
      error_message TEXT,
      applied_submission_uuid TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_res_status ON ai_resolutions(status);
    CREATE INDEX IF NOT EXISTS idx_ai_res_submission ON ai_resolutions(submission_uuid);

    -- Immutability: the audit trail is insert-only. These triggers make
    -- UPDATE / DELETE impossible at the database level.
    CREATE TRIGGER IF NOT EXISTS audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
  `);
}

// SQLite has no `ADD COLUMN IF NOT EXISTS`, so we additively migrate columns
// onto existing tables by inspecting PRAGMA table_info. Idempotent: only adds
// a column when it is missing. Keeps the "schema is reconciled on boot" model.
function migrateColumns(db) {
  const ADDITIONS = {
    push_submissions: [
      // 'built' (fat path, assembled from SoT) | 'flyapp_prebuilt' (caller-supplied JSON package).
      { name: 'payload_origin', ddl: "payload_origin TEXT NOT NULL DEFAULT 'built'" },
      // The exact JSON the caller submitted, before any normalization — kept verbatim for audit fidelity.
      { name: 'raw_package_json', ddl: 'raw_package_json TEXT' },
      // Free-form caller metadata (customer, season, lifecycle status, etc.). Descriptive only.
      { name: 'flyapp_meta_json', ddl: 'flyapp_meta_json TEXT' },
      // Caller-supplied parent vendor code SKU — used as the fallback path SKU
      // when Amazon rejects the documented SKU with vendor_sku error 101168.
      { name: 'parent_sku', ddl: 'parent_sku TEXT' },
      // The SKU the write actually used at Amazon. NULL means the documented
      // `sku` was used; set to the parent SKU when the vendor_sku fallback fired.
      // Reconciliation/revert target this when present so they hit the listing
      // that was really written.
      { name: 'effective_sku', ddl: 'effective_sku TEXT' },
      // Requester's free-text note for the human approver (one per push, copied
      // onto every submission it creates). Descriptive only — shown in the
      // approval email/page, console, and audit; never sent to Amazon.
      { name: 'approver_comment', ddl: 'approver_comment TEXT' },
      // package_level is deferred: never sent on the initial write, only re-added
      // when Amazon rejects with a package_level-referencing issue. This flag is
      // set to 1 once we resubmit WITH package_level included, and guards against
      // re-add loops (feeds) and keeps reconciliation from expecting an attribute
      // we never sent.
      { name: 'package_level_readded', ddl: 'package_level_readded INTEGER NOT NULL DEFAULT 0' },
      // When this submission is an AI-resolved re-push of a previously FAILED
      // submission, this points back to that original submission_uuid (analogous
      // to revert_of_uuid). NULL for ordinary pushes.
      { name: 'resolves_uuid', ddl: 'resolves_uuid TEXT' },
      // Consecutive feed-status poll errors for an async feed submission. The
      // poller increments this when getFeed throws and abandons the submission
      // as FAILED once it crosses POLLER_MAX_FEED_ERRORS, so an unpollable feed
      // can't loop forever. Reset to 0 on any successful status read.
      { name: 'poll_error_count', ddl: 'poll_error_count INTEGER NOT NULL DEFAULT 0' },
      // Operator-archived error: when set, the submission is excluded from AI
      // error resolution (no single or batch AI review is assessed for it). The
      // row still appears in the Errors tab marked as archived. NULL = active.
      { name: 'archived_at', ddl: 'archived_at TEXT' },
      { name: 'archived_by', ddl: 'archived_by TEXT' }
    ]
  };
  for (const [table, cols] of Object.entries(ADDITIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const col of cols) {
      if (!existing.has(col.name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.ddl}`);
    }
  }
}

function getDb() {
  if (_db) return _db;
  const dir = path.dirname(PUSH_DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(PUSH_DB_PATH, { timeout: 30000 });
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  ensureSchema(_db);
  migrateColumns(_db);
  return _db;
}

function closeDb() {
  if (_db) { try { _db.close(); } catch { /* ignore */ } _db = null; }
}

module.exports = { getDb, ensureSchema, migrateColumns, closeDb };
