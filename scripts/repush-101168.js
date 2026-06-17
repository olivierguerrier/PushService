// Re-push listings that FAILED with Amazon error 101168 ("you can't change
// Vendor SKU from its original value 'X'"). Amazon names the canonical seller
// SKU in the rejection; this script re-forwards each failed patchItem through
// the live forwarder, whose tiered vendor_sku fallback re-addresses the SAME
// vendor code by the parent SKU (if known) and, failing that, by the canonical
// SKU inferred from the 101168 message.
//
//   node scripts/repush-101168.js                      # dry-run: report what
//                                                        # canonical SKU each row
//                                                        # would be re-pushed by
//   node scripts/repush-101168.js --apply              # actually re-push
//   node scripts/repush-101168.js --apply --limit 50
//   node scripts/repush-101168.js --submission <uuid>  # one row (dry-run)
//   node scripts/repush-101168.js --submission <uuid> --apply
//
//   node scripts/repush-101168.js --resettle-noop          # report FAILED rows
//                                                            # already carrying a
//                                                            # 101161/101165
//                                                            # "already listed"
//                                                            # verdict
//   node scripts/repush-101168.js --resettle-noop --apply  # flip them to APPLIED
//                                                            # (no Amazon calls —
//                                                            # the verdict is
//                                                            # already captured)
//
// Re-pushing is safe: a CONTENT_MATCH patch is an idempotent `replace`, and a
// row that still can't resolve simply settles FAILED again. Honors the master
// kill switch (SPAPI_WRITES_ENABLED) via the forwarder.
const env = require('../config/env');
const { getDb } = require('../src/db');
const submissions = require('../src/submissions');
const forwarder = require('../src/forwarder');
const audit = require('../src/audit/auditEvents');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || null) : null;
}

function parseIssues(json) {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

function findFailed101168({ limit, submissionUuid }) {
  const db = getDb();
  if (submissionUuid) {
    const row = db.prepare('SELECT * FROM push_submissions WHERE submission_uuid = ?').get(submissionUuid);
    return row ? [row] : [];
  }
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  return db.prepare(`
    SELECT * FROM push_submissions
    WHERE operation = 'patchItem'
      AND status = 'FAILED'
      AND (issues_json LIKE '%101168%' OR error_message LIKE '%101168%')
    ORDER BY id DESC
    LIMIT ${cap}
  `).all();
}

// Re-settle FAILED rows whose stored issues already carry Amazon's
// 101161/101165 "already listed / identifiers not unique" verdict. The SKU↔ASIN
// match already exists, so these are successful no-ops — flip them to APPLIED
// using the verdict we already captured (no fresh Amazon calls).
function resettleNoop({ apply }) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM push_submissions
    WHERE operation = 'patchItem'
      AND status = 'FAILED'
      AND (issues_json LIKE '%101161%' OR issues_json LIKE '%101165%' OR error_message LIKE '%101161%' OR error_message LIKE '%101165%')
    ORDER BY id DESC
  `).all();

  const planned = [];
  for (const row of rows) {
    const issues = parseIssues(row.issues_json);
    if (!forwarder.isAlreadyListedError(issues)) continue; // guard against false LIKE hits
    planned.push({
      submission_uuid: row.submission_uuid,
      asin: row.asin,
      vendor_code: row.vendor_code,
      effective_sku: row.effective_sku || row.sku
    });
    if (apply) {
      submissions.update(row.submission_uuid, { status: 'APPLIED', error_message: null });
      audit.record({
        event: 'noop_already_listed',
        submissionUuid: row.submission_uuid,
        actor: 'system',
        details: { sku: row.effective_sku || row.sku, reason: forwarder.summarizeIssues(issues), resettled: true }
      });
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', action: 'resettle-noop', count: planned.length, planned }, null, 2));
}

async function main() {
  // Wait for the ControlTower vault to finish hydrating SP-API credentials —
  // it bootstraps asynchronously, so without this the forwarder would run with
  // empty credentials (the server awaits the same promise at boot).
  await require('../config/env').ready.catch(() => {});

  const apply = process.argv.includes('--apply');
  const submissionUuid = arg('--submission');
  const limit = arg('--limit');

  if (process.argv.includes('--resettle-noop')) {
    return resettleNoop({ apply });
  }

  const rows = findFailed101168({ limit, submissionUuid });
  if (!rows.length) {
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', candidates: 0, note: 'no FAILED 101168 patchItem submissions found' }, null, 2));
    return;
  }

  if (apply && !env.SPAPI_WRITES_ENABLED) {
    console.error('Refusing to --apply: SPAPI_WRITES_ENABLED is false (kill switch). Flip it on to re-push.');
    process.exit(2);
  }

  const planned = [];
  const results = [];
  for (const row of rows) {
    const issues = parseIssues(row.issues_json);
    const canonicalSku = forwarder.extractVendorSkuFromIssues(issues);
    const entry = {
      submission_uuid: row.submission_uuid,
      asin: row.asin,
      vendor_code: row.vendor_code,
      documented_sku: row.sku,
      parent_sku: row.parent_sku || null,
      inferred_sku: canonicalSku || null,
      marketplace: row.marketplace_code
    };

    // Nothing to re-address by — no parent SKU and the error names no new SKU.
    const haveTarget = (row.parent_sku && row.parent_sku !== row.sku) || (canonicalSku && canonicalSku !== row.sku);
    if (!haveTarget) {
      entry.skipped = 'no parent SKU and no new canonical SKU to infer';
      planned.push(entry);
      continue;
    }
    planned.push(entry);

    if (apply) {
      const fresh = submissions.getByUuid(row.submission_uuid);
      const settled = await forwarder.forward(fresh);
      results.push({
        submission_uuid: row.submission_uuid,
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
    planned,
    results: apply ? results : undefined,
    applied_ok: apply ? results.filter((r) => r.status === 'APPLIED').length : 0,
    applied_failed: apply ? results.filter((r) => r.status !== 'APPLIED').length : 0
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
