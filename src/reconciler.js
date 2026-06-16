// Over-time reconciliation poller. Async sibling of poller.js: instead of
// settling in-flight feeds, it confirms that APPLIED writes are STILL
// reflected live on Amazon. For each due reconciliation_check it GETs the
// listing, diffs expected-vs-observed for the pushed attributes, and settles
// the check to MATCH / DRIFT / MISSING / ERROR — recording the outcome on the
// submission's hash-chained audit timeline. Drift can optionally email an alert.
const cron = require('node-cron');
const env = require('../config/env');
const reconciliation = require('./reconciliation');
const listingsItems = require('./spapi/listingsItems');
const audit = require('./audit/auditEvents');
const reconcileDiff = require('./reconcileDiff');
const { scrubObject } = require('../lib/safeError');

let task = null;
let running = false;

const RETRY_BACKOFF_MS = 10 * 60 * 1000; // 10m between transient retries.

function parseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

async function maybeAlert({ check, diffs }) {
  if (!env.RECON_ALERT_ENABLED || !env.RECON_ALERT_EMAIL.length) return;
  try {
    const { sendMail } = require('./mail');
    const lines = diffs.map((d) => `• ${d.attr} (${d.reason})`).join('\n');
    const subject = `[Amazon push] DRIFT — ${check.sku} ${check.marketplace_code}`;
    const html = `<h2>Reconciliation drift detected</h2>
      <p><b>SKU:</b> ${check.sku} &nbsp; <b>Vendor:</b> ${check.vendor_code} &nbsp; <b>Marketplace:</b> ${check.marketplace_code}</p>
      <p><b>Submission:</b> ${check.submission_uuid}</p>
      <p>The following pushed attributes are no longer reflected on Amazon:</p>
      <pre>${lines}</pre>`;
    await sendMail({ to: env.RECON_ALERT_EMAIL, subject, html });
    audit.record({ event: 'drift_alert_sent', submissionUuid: check.submission_uuid, actor: 'reconciler', details: { to: env.RECON_ALERT_EMAIL.length } });
  } catch (err) {
    audit.record({ event: 'drift_alert_error', submissionUuid: check.submission_uuid, actor: 'reconciler', details: { message: err.message } });
  }
}

async function checkOne(check) {
  const expected = parseJson(check.expected_json) || {};
  const attempts = Number(check.attempts || 0) + 1;

  let item;
  try {
    item = await listingsItems.getItem({
      sellerId: check.vendor_code,
      sku: check.sku,
      marketplaceCode: check.marketplace_code,
      includedData: ['attributes', 'summaries', 'issues']
    });
  } catch (err) {
    // Transient: retry a few times before giving up as ERROR.
    if (attempts < env.RECON_MAX_ATTEMPTS) {
      reconciliation.update(check.check_uuid, { attempts, scheduled_at: new Date(Date.now() + RETRY_BACKOFF_MS).toISOString() });
      audit.record({ event: 'reconcile_retry', submissionUuid: check.submission_uuid, actor: 'reconciler', details: { attempt: attempts, message: err.message } });
      return;
    }
    reconciliation.update(check.check_uuid, { status: 'ERROR', attempts, checked_at: new Date().toISOString(), error_message: err.message.slice(0, 500) });
    audit.record({ event: 'reconcile_error', submissionUuid: check.submission_uuid, actor: 'reconciler', details: { message: err.message } });
    return;
  }

  const observedAttributes = (item && item.attributes) || null;
  if (!observedAttributes) {
    reconciliation.update(check.check_uuid, { status: 'MISSING', attempts, checked_at: new Date().toISOString(), observed_json: scrubObject(item || {}), error_message: 'listing returned no attributes' });
    audit.record({ event: 'reconcile_missing', submissionUuid: check.submission_uuid, actor: 'reconciler', details: { sku: check.sku, marketplace: check.marketplace_code } });
    return;
  }

  const { match, diffs, checkedAttrNames } = reconcileDiff.diffAttributes(expected, observedAttributes);
  // Store only the observed values for the attributes we cared about (keeps the
  // row small and the diff legible).
  const observedSubset = {};
  for (const name of checkedAttrNames) if (name in observedAttributes) observedSubset[name] = observedAttributes[name];

  reconciliation.update(check.check_uuid, {
    status: match ? 'MATCH' : 'DRIFT',
    attempts,
    checked_at: new Date().toISOString(),
    observed_json: scrubObject(observedSubset),
    diff_json: match ? null : scrubObject(diffs)
  });

  if (match) {
    audit.record({ event: 'reconciled_ok', submissionUuid: check.submission_uuid, actor: 'reconciler', details: { attempt: check.attempt_index, checked: checkedAttrNames.length } });
  } else {
    audit.record({ event: 'drift_detected', submissionUuid: check.submission_uuid, actor: 'reconciler', details: { attempt: check.attempt_index, drifted: diffs.map((d) => ({ attr: d.attr, reason: d.reason })) } });
    await maybeAlert({ check, diffs });
  }
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const dueChecks = reconciliation.due({ limit: 50 });
    for (const c of dueChecks) {
      try { await checkOne(c); }
      catch (err) { console.warn(`[reconciler] error on ${c.check_uuid}: ${err.message}`); }
    }
  } finally {
    running = false;
  }
}

function start(cronExpr) {
  if (task) return task;
  if (!env.RECON_ENABLED) { console.log('[reconciler] disabled (RECON_ENABLED=false)'); return null; }
  let expr = cronExpr;
  if (!cron.validate(expr)) {
    console.warn(`[reconciler] invalid cron '${expr}', defaulting to */15 * * * *`);
    expr = '*/15 * * * *';
  }
  task = cron.schedule(expr, () => { runOnce().catch((err) => console.warn('[reconciler] runOnce failed:', err.message)); });
  console.log(`[reconciler] scheduled '${expr}' (offsets: ${env.RECON_OFFSETS})`);
  return task;
}

function stop() { if (task) { task.stop(); task = null; } }

module.exports = { start, stop, runOnce, checkOne };
