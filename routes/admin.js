// Operational + admin API.
//   GET  /healthz            public liveness probe.
//   POST /admin/login        verify ListingApp credentials -> short-lived JWT.
//   POST /admin/logout       clear the session cookie.
//   GET  /admin/me           current operator identity.
//   GET  /admin/status       admin: config + dependency health snapshot.
//   GET  /admin/queue        admin: recent submissions (JSON, for the UI).
//   GET  /admin/jobs         admin: recent jobs (JSON, for the UI).
const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { adminAuth, serviceTokens, signAdminJwt, verifyCredentials, TOKEN_TTL_SECONDS } = require('../middleware/auth');
const submissions = require('../src/submissions');
const changeDetails = require('../src/changeDetails');
const jobs = require('../src/jobs');
const reconciliation = require('../src/reconciliation');
const audit = require('../src/audit/auditEvents');
const forwarder = require('../src/forwarder');
const { recomputeJobStatus } = require('../src/jobOrchestrator');
const la = require('../src/sot/listingAppClient');
const contentSource = require('../src/sot/contentSource');
const spClient = require('../src/spapi/client');

const router = express.Router();

// IP-based throttle on /admin/login. Successful logins still count so a
// compromised credential can't replay at full speed.
const loginLimiter = rateLimit({
  windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
  max: env.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_login_attempts' }
});

function setSessionCookie(res, jwtToken) {
  res.cookie
    ? res.cookie('aps_jwt', jwtToken, { httpOnly: true, sameSite: 'lax', maxAge: TOKEN_TTL_SECONDS * 1000 })
    : res.set('Set-Cookie', `aps_jwt=${jwtToken}; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL_SECONDS}`);
}

router.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'amazon-push-service',
    version: env.VERSION,
    writesEnabled: env.SPAPI_WRITES_ENABLED,
    callersConfigured: serviceTokens().size,
    approversConfigured: env.APPROVERS.length,
    time: new Date().toISOString()
  });
});

// Verify a ListingApp account over the bridge, then mint this service's own
// short-lived JWT (set as an httpOnly cookie AND returned for Bearer use).
// Same model as FlyApp: password hashes never leave the ListingApp process.
router.post('/admin/login', loginLimiter, express.json(), async (req, res) => {
  if (!env.JWT_SECRET) return res.status(500).json({ error: 'jwt_secret_not_configured' });
  const username = String((req.body && req.body.username) || '').slice(0, 200);
  const password = (req.body && req.body.password) || '';
  const peerIp = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

  // Break-glass: when LISTINGAPP_FALLBACK_TOKEN auth is needed (bridge down),
  // the static ADMIN_TOKEN can still be posted as `token` to get a JWT.
  const adminToken = (req.body && req.body.token) || '';
  if (adminToken && env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN) {
    const jwtToken = signAdminJwt('admin-token');
    setSessionCookie(res, jwtToken);
    return res.json({ ok: true, token: jwtToken, user: { username: 'admin-token', role: 'admin' } });
  }

  try {
    const user = await verifyCredentials(username, password);
    if (!user) {
      console.warn(`[AUTH] login failed ip=${peerIp} user=${username.slice(0, 80)}`);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const jwtToken = signAdminJwt(user);
    setSessionCookie(res, jwtToken);
    console.log(`[AUTH] login ok ip=${peerIp} user=${user.username} role=${user.role}`);
    res.json({ ok: true, token: jwtToken, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
  } catch (err) {
    console.error('[AUTH] login error:', err.message);
    res.status(503).json({ error: 'auth_unavailable', detail: err.message });
  }
});

router.post('/admin/logout', (req, res) => {
  res.cookie
    ? res.clearCookie('aps_jwt')
    : res.set('Set-Cookie', 'aps_jwt=; Max-Age=0');
  res.json({ ok: true });
});

router.get('/admin/me', adminAuth, (req, res) => {
  res.json({ user: req.admin || (req.caller ? { username: req.caller, role: 'service' } : null) });
});

router.get('/admin/status', adminAuth, async (req, res) => {
  let listingApp = null;
  try { listingApp = await la.checkHealth(); } catch (err) { listingApp = { ok: false, reason: err.message }; }
  res.json({
    version: env.VERSION,
    writesEnabled: env.SPAPI_WRITES_ENABLED,
    spApi: {
      clientIdConfigured: !!env.SP_API_LWA_CLIENT_ID,
      refreshTokenConfigured: !!env.SP_API_REFRESH_TOKEN,
      tokenCachedUntil: spClient.getCachedTokenExpiry() ? new Date(spClient.getCachedTokenExpiry()).toISOString() : null
    },
    listingApp,
    contentSource: contentSource.describe(),
    callersConfigured: serviceTokens().size,
    approversConfigured: env.APPROVERS.length,
    auditChain: audit.verifyChain()
  });
});

// Distil the persisted error envelope (issues_json / amazon_response_json) into
// a compact, UI-friendly list of diagnostics so operators can see *why* a
// submission failed without expanding the row. Returns [] when there is nothing
// useful to show. The raw blobs are intentionally NOT shipped to the queue list.
function summarizeErrorDetails({ issues_json, amazon_response_json }) {
  const out = [];
  let issues = null;
  try { issues = issues_json ? JSON.parse(issues_json) : null; } catch (_) { issues = null; }
  if (Array.isArray(issues)) {
    for (const i of issues) {
      if (!i) continue;
      out.push({
        code: i.code || null,
        message: i.message || (typeof i === 'string' ? i : null),
        severity: i.severity || null,
        attributeNames: Array.isArray(i.attributeNames) ? i.attributeNames : (i.attributeName ? [i.attributeName] : [])
      });
    }
  }
  if (!out.length && amazon_response_json) {
    let amazon = null;
    try { amazon = JSON.parse(amazon_response_json); } catch (_) { amazon = null; }
    if (amazon && typeof amazon === 'object' && amazon.error) {
      const msg = typeof amazon.error === 'string' ? amazon.error : JSON.stringify(amazon.error);
      out.push({ code: null, message: String(msg).slice(0, 2000), severity: 'ERROR', attributeNames: [] });
    }
  }
  return out;
}

router.get('/admin/queue', adminAuth, (req, res) => {
  const rows = submissions.listRecent({ limit: req.query.limit || 200 }).map((r) => {
    const { flyapp_meta_json, issues_json, amazon_response_json, ...rest } = r;
    let meta = null;
    if (flyapp_meta_json) {
      try { meta = JSON.parse(flyapp_meta_json); } catch (_) { meta = null; }
    }
    const errorDetails = summarizeErrorDetails({ issues_json, amazon_response_json });
    return { ...rest, meta, errorDetails };
  });
  res.json({ submissions: rows });
});

// Per-field change details for one submission: flyapp source value -> submitted
// value, for each changed attribute. Read-only; used by the console's
// expandable submission row.
router.get('/admin/submissions/:uuid/changes', adminAuth, async (req, res, next) => {
  try {
    const submission = submissions.getByUuid(req.params.uuid);
    if (!submission) return res.status(404).json({ error: 'submission_not_found' });
    if (submission.status === 'APPLIED') {
      const { changes, warnings, pushedAt, currentAt, currentSource } = await changeDetails.computeAppliedChanges(submission);
      return res.json({ applied: true, changes, warnings, pushedAt, currentAt, currentSource });
    }
    const { changes, warnings } = await changeDetails.computeChanges(submission);
    res.json({ changes, warnings });
  } catch (err) { next(err); }
});

// Identity to stamp on an approval decision: the logged-in operator, the
// break-glass admin token, or a machine caller — whichever authenticated.
function operatorName(req) {
  if (req.admin) return req.admin.username || req.admin.user || 'operator';
  if (req.caller) return req.caller;
  return 'operator';
}

// Flip one held submission to IN_PROGRESS and forward it to Amazon in the
// background so the click isn't blocked on the SP-API round-trip. Shared by the
// single-submission endpoint and the group ("approve all") endpoint. Assumes
// the caller has already checked status === 'PENDING_APPROVAL'.
function approveOne(submission, actor, { via = 'console' } = {}) {
  const approved = submissions.update(submission.submission_uuid, {
    status: 'IN_PROGRESS', approved_by: actor, approved_at: new Date().toISOString()
  });
  audit.record({ event: 'approved', submissionUuid: approved.submission_uuid, actor, details: { via } });
  setImmediate(() => {
    forwarder.forward(approved)
      .then(() => recomputeJobStatus(approved.job_uuid))
      .catch((err) => console.error(`[admin] forward after approval failed for ${approved.submission_uuid}:`, err.message));
  });
  return approved;
}

// Reject one held submission: the write is discarded and never sent to Amazon.
function rejectOne(submission, actor, { via = 'console' } = {}) {
  const rejected = submissions.update(submission.submission_uuid, {
    status: 'REJECTED', approved_by: actor, approved_at: new Date().toISOString()
  });
  audit.record({ event: 'rejected', submissionUuid: rejected.submission_uuid, actor, details: { via } });
  recomputeJobStatus(rejected.job_uuid);
  return rejected;
}

// In-app approval: flip a held submission to IN_PROGRESS and forward it to
// Amazon. This is the operator-console equivalent of the emailed approval link.
router.post('/admin/submissions/:uuid/approve', adminAuth, async (req, res, next) => {
  try {
    const submission = submissions.getByUuid(req.params.uuid);
    if (!submission) return res.status(404).json({ error: 'submission_not_found' });
    if (submission.status !== 'PENDING_APPROVAL') {
      return res.status(409).json({ error: 'not_pending_approval', status: submission.status });
    }
    const approved = approveOne(submission, operatorName(req));
    res.json({ ok: true, submissionId: approved.submission_uuid, status: 'IN_PROGRESS' });
  } catch (err) { next(err); }
});

// In-app rejection: the write is discarded and never sent to Amazon.
router.post('/admin/submissions/:uuid/reject', adminAuth, async (req, res, next) => {
  try {
    const submission = submissions.getByUuid(req.params.uuid);
    if (!submission) return res.status(404).json({ error: 'submission_not_found' });
    if (submission.status !== 'PENDING_APPROVAL') {
      return res.status(409).json({ error: 'not_pending_approval', status: submission.status });
    }
    const rejected = rejectOne(submission, operatorName(req));
    res.json({ ok: true, submissionId: rejected.submission_uuid, status: 'REJECTED' });
  } catch (err) { next(err); }
});

// Resolve a posted list of submission UUIDs to existing rows, preserving the
// caller's order and capping the batch size. Used by the grouped-queue batch
// endpoints, where a "group" is an arbitrary client-side set of submissions
// (e.g. the same item pushed across multiple vendor codes / marketplaces).
function resolveUuidBatch(body) {
  const uuids = Array.isArray(body && body.uuids) ? body.uuids.slice(0, 500) : [];
  const out = [];
  for (const u of uuids) {
    const s = submissions.getByUuid(u);
    if (s) out.push(s);
  }
  return out;
}

// Group ("total submission") approval: approve every PENDING_APPROVAL row in the
// posted set in one click. Non-pending rows are left untouched and reported as
// skipped. One group audit event is recorded alongside the per-submission events.
router.post('/admin/group/approve', adminAuth, express.json(), async (req, res, next) => {
  try {
    const rows = resolveUuidBatch(req.body);
    if (!rows.length) return res.status(400).json({ error: 'no_submissions' });
    const actor = operatorName(req);
    const pending = rows.filter((s) => s.status === 'PENDING_APPROVAL');
    pending.forEach((s) => approveOne(s, actor, { via: 'console_group' }));
    if (pending.length) {
      audit.record({ event: 'approved_group', actor, details: { via: 'console', count: pending.length, submissionUuids: pending.map((s) => s.submission_uuid) } });
    }
    res.json({ ok: true, approved: pending.length, skipped: rows.length - pending.length });
  } catch (err) { next(err); }
});

// Group rejection: reject every PENDING_APPROVAL row in the posted set at once.
router.post('/admin/group/reject', adminAuth, express.json(), async (req, res, next) => {
  try {
    const rows = resolveUuidBatch(req.body);
    if (!rows.length) return res.status(400).json({ error: 'no_submissions' });
    const actor = operatorName(req);
    const pending = rows.filter((s) => s.status === 'PENDING_APPROVAL');
    pending.forEach((s) => rejectOne(s, actor, { via: 'console_group' }));
    if (pending.length) {
      audit.record({ event: 'rejected_group', actor, details: { via: 'console', count: pending.length, submissionUuids: pending.map((s) => s.submission_uuid) } });
    }
    res.json({ ok: true, rejected: pending.length, skipped: rows.length - pending.length });
  } catch (err) { next(err); }
});

// Per-field before/posted/after changes for every submission in a group. Powers
// the grouped queue's expandable table. Computed sequentially per submission so
// the prior-state / live reads don't stampede the SP-API.
router.post('/admin/group/changes', adminAuth, express.json(), async (req, res, next) => {
  try {
    const rows = resolveUuidBatch(req.body);
    const items = [];
    for (const s of rows) {
      const review = await changeDetails.computeReview(s);
      let meta = null;
      if (s.flyapp_meta_json) {
        try { meta = JSON.parse(s.flyapp_meta_json); } catch (_) { meta = null; }
      }
      items.push({
        submission_uuid: s.submission_uuid,
        vendor_code: s.vendor_code,
        sku: s.sku,
        asin: s.asin,
        item_number: s.item_number,
        marketplace_code: s.marketplace_code,
        status: s.status,
        meta,
        changes: review.changes,
        warnings: review.warnings,
        applied: review.applied
      });
    }
    res.json({ submissions: items });
  } catch (err) { next(err); }
});

router.get('/admin/jobs', adminAuth, (req, res) => {
  res.json({ jobs: jobs.list({ limit: req.query.limit || 100 }).map((j) => ({
    jobId: j.job_uuid, kind: j.kind, caller: j.caller, asin: j.asin, marketplaceCode: j.marketplace_code,
    status: j.status, okCount: j.ok_count, failedCount: j.failed_count, targetCount: j.target_count,
    label: j.label, createdAt: j.created_at, completedAt: j.completed_at
  })) });
});

// Recent over-time reconciliation checks (read-only, for the console).
router.get('/admin/reconciliation', adminAuth, (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  res.json({ checks: reconciliation.listRecent({ limit: req.query.limit || 200, status }).map((c) => ({
    checkId: c.check_uuid, submissionId: c.submission_uuid, sku: c.sku, vendorCode: c.vendor_code,
    asin: c.asin, marketplaceCode: c.marketplace_code, productType: c.product_type, attempt: c.attempt_index,
    status: c.status, scheduledAt: c.scheduled_at, checkedAt: c.checked_at, error: c.error_message, createdAt: c.created_at
  })) });
});

module.exports = router;
