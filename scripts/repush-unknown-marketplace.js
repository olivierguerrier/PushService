// Re-push listings that FAILED with "Unknown marketplace: <CODE>" — rows that
// were rejected at the coordinate-validation gate because their marketplace was
// not yet defined in config/marketplaces.js (e.g. NL, PL). Once the marketplace
// is added to the config, those rows can be re-forwarded as-is: flyapp supplied
// a fully-built prebuilt package which we preserved verbatim in raw_package_json
// (request_body_json was overwritten with the rejection marker at insert time).
//
// For each candidate this script restores request_body_json from the preserved
// raw_package_json, re-queues the row, and runs it through the live forwarder —
// the same path a normal push takes, so prior-state capture, package_level
// deferral, already-listed folding, and reconciliation scheduling all apply.
//
//   node scripts/repush-unknown-marketplace.js                      # dry-run
//   node scripts/repush-unknown-marketplace.js --apply              # re-push
//   node scripts/repush-unknown-marketplace.js --apply --limit 50
//   node scripts/repush-unknown-marketplace.js --code NL            # one mp
//   node scripts/repush-unknown-marketplace.js --submission <uuid>  # one row
//   node scripts/repush-unknown-marketplace.js --submission <uuid> --apply
//
// Re-pushing is safe: a CONTENT_MATCH patch is an idempotent `replace`, a row
// whose marketplace is STILL unknown is skipped, and a row that fails again
// simply settles FAILED. Honors the master kill switch (SPAPI_WRITES_ENABLED).
const env = require('../config/env');
const { getDb } = require('../src/db');
const submissions = require('../src/submissions');
const forwarder = require('../src/forwarder');
const audit = require('../src/audit/auditEvents');
const { resolveByCode } = require('../config/marketplaces');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || null) : null;
}

function parsePackage(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && Array.isArray(v.patches) ? v : null;
  } catch { return null; }
}

function findCandidates({ limit, submissionUuid, code }) {
  const db = getDb();
  if (submissionUuid) {
    const row = db.prepare('SELECT * FROM push_submissions WHERE submission_uuid = ?').get(submissionUuid);
    return row ? [row] : [];
  }
  const cap = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const params = [];
  let codeClause = '';
  if (code) {
    codeClause = 'AND marketplace_code = ?';
    params.push(String(code).toUpperCase());
  }
  // Always match rows rejected at the coordinate gate ("Unknown marketplace").
  // The credential-error signature ("... not set for SP-API ...") is ALSO a
  // symptom of a not-yet-configured marketplace, but it is shared by unrelated
  // marketplaces whose creds are genuinely missing for other reasons (e.g. a
  // separate per-marketplace LWA app). So only fold it in when the run is scoped
  // to a specific marketplace (--code) — otherwise a no-filter run would sweep in
  // every marketplace's credential failures.
  const credClause = code
    ? "OR error_message LIKE '%not set for SP-API%'"
    : '';
  return db.prepare(`
    SELECT * FROM push_submissions
    WHERE operation = 'patchItem'
      AND status = 'FAILED'
      AND (
        error_message LIKE '%Unknown marketplace%'
        OR request_body_json LIKE '%Unknown marketplace%'
        ${credClause}
      )
      ${codeClause}
    ORDER BY id DESC
    LIMIT ${cap}
  `).all(...params);
}

async function main() {
  // Wait for the ControlTower vault to finish hydrating SP-API credentials —
  // it bootstraps asynchronously, so without this the forwarder would run with
  // empty credentials (the server awaits the same promise at boot).
  await env.ready.catch(() => {});

  const apply = process.argv.includes('--apply');
  const submissionUuid = arg('--submission');
  const limit = arg('--limit');
  const code = arg('--code');

  const rows = findCandidates({ limit, submissionUuid, code });
  if (!rows.length) {
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', candidates: 0, note: 'no FAILED "Unknown marketplace" patchItem submissions found' }, null, 2));
    return;
  }

  if (apply && !env.SPAPI_WRITES_ENABLED) {
    console.error('Refusing to --apply: SPAPI_WRITES_ENABLED is false (kill switch). Flip it on to re-push.');
    process.exit(2);
  }

  const db = getDb();
  const planned = [];
  const results = [];
  for (const row of rows) {
    const mp = resolveByCode(row.marketplace_code);
    const pkg = parsePackage(row.raw_package_json);
    const entry = {
      submission_uuid: row.submission_uuid,
      marketplace: row.marketplace_code,
      asin: row.asin,
      vendor_code: row.vendor_code,
      sku: row.sku
    };

    if (!mp) { entry.skipped = `marketplace ${row.marketplace_code} still unknown — add it to config/marketplaces.js first`; planned.push(entry); continue; }
    if (!pkg) { entry.skipped = 'no usable raw_package_json to re-send'; planned.push(entry); continue; }
    planned.push(entry);

    if (apply) {
      // Restore the real package the caller supplied (request_body_json was
      // clobbered with the rejection marker) and re-queue, then forward.
      db.prepare("UPDATE push_submissions SET request_body_json = ?, status = 'QUEUED', error_message = NULL, updated_at = datetime('now') WHERE submission_uuid = ?")
        .run(JSON.stringify(pkg), row.submission_uuid);
      audit.record({
        event: 'repush_unknown_marketplace',
        submissionUuid: row.submission_uuid,
        actor: 'system',
        details: { marketplace: row.marketplace_code, reason: 'marketplace added to config; re-forwarding preserved package' }
      });
      const fresh = submissions.getByUuid(row.submission_uuid);
      const settled = await forwarder.forward(fresh);
      results.push({
        submission_uuid: row.submission_uuid,
        marketplace: row.marketplace_code,
        status: settled.status,
        effective_sku: settled.effective_sku || null,
        error: settled.error_message || null
      });
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    candidates: rows.length,
    actionable: planned.filter((p) => !p.skipped).length,
    skipped: planned.filter((p) => p.skipped).length,
    by_marketplace: planned.reduce((acc, p) => { (acc[p.marketplace] = acc[p.marketplace] || { actionable: 0, skipped: 0 })[p.skipped ? 'skipped' : 'actionable']++; return acc; }, {}),
    planned,
    results: apply ? results : undefined,
    applied_ok: apply ? results.filter((r) => r.status === 'APPLIED').length : 0,
    applied_failed: apply ? results.filter((r) => r.status !== 'APPLIED').length : 0
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
