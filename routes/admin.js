// Operational + admin API.
//   GET  /healthz            public liveness probe.
//   POST /admin/login        verify ListingApp credentials -> short-lived JWT.
//   POST /admin/logout       clear the session cookie.
//   GET  /admin/me           current operator identity.
//   GET  /admin/status       admin: config + dependency health snapshot.
//   GET  /admin/queue        admin: recent submissions (JSON, for the UI).
//   GET  /admin/jobs         admin: recent jobs (JSON, for the UI).
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { adminAuth, serviceTokens, signAdminJwt, verifyCredentials, TOKEN_TTL_SECONDS } = require('../middleware/auth');
const { writeGate } = require('../middleware/writeGate');
const submissions = require('../src/submissions');
const errorReport = require('../src/errorReport');
const changeDetails = require('../src/changeDetails');
const jobs = require('../src/jobs');
const reconciliation = require('../src/reconciliation');
const audit = require('../src/audit/auditEvents');
const approvalQueue = require('../src/approvalQueue');
const metrics = require('../src/metrics');
const { recomputeJobStatus } = require('../src/jobOrchestrator');
const la = require('../src/sot/listingAppClient');
const contentSource = require('../src/sot/contentSource');
const spClient = require('../src/spapi/client');
const aiResolver = require('../src/aiResolver');
const aiResolutions = require('../src/aiResolutions');
const packageValidator = require('../src/packageValidator');
const { buildRequestBody } = require('../src/packageRequestBody');
const forwarder = require('../src/forwarder');
const { resolveByCode } = require('../config/marketplaces');

const router = express.Router();
const newUuid = () => crypto.randomUUID();

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

router.get('/admin/metrics', adminAuth, (req, res) => {
  res.json({
    ...metrics.getDashboard(),
    approvalQueueDepth: approvalQueue.size()
  });
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
// submission failed without expanding the row. Shared with the Errors tab /
// Excel export via src/errorReport.
const summarizeErrorDetails = errorReport.summarizeErrorDetails;

// Recent submissions for the console. Supports keyset pagination so the UI can
// load the full history in batches: pass `beforeId` (the `nextBeforeId` from the
// previous response) to fetch the next, older page. `total` lets the client know
// when it has everything. The internal autoincrement `id` is used only as the
// pagination cursor and is stripped from the per-row payload.
router.get('/admin/queue', adminAuth, (req, res) => {
  const beforeId = req.query.beforeId != null && req.query.beforeId !== '' ? Number(req.query.beforeId) : null;
  const raw = submissions.listRecent({ limit: req.query.limit || 200, beforeId });
  const rows = raw.map((r) => {
    const { id, flyapp_meta_json, issues_json, amazon_response_json, ...rest } = r;
    let meta = null;
    if (flyapp_meta_json) {
      try { meta = JSON.parse(flyapp_meta_json); } catch (_) { meta = null; }
    }
    const errorDetails = summarizeErrorDetails({ issues_json, amazon_response_json });
    return { ...rest, meta, errorDetails };
  });
  const nextBeforeId = raw.length ? raw[raw.length - 1].id : null;
  res.json({ submissions: rows, total: submissions.count(), nextBeforeId });
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
  approvalQueue.enqueue(approved);
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

function resolveJobBatch(body) {
  const jobIds = Array.isArray(body && body.jobIds) ? body.jobIds.slice(0, 100) : [];
  const out = [];
  const seen = new Set();
  for (const id of jobIds) {
    const jobId = String(id || '').trim();
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    const job = jobs.getByUuid(jobId);
    if (job) out.push(job);
  }
  return out;
}

function approvePendingRows(rows, actor, via) {
  const pending = rows.filter((s) => s.status === 'PENDING_APPROVAL');
  pending.forEach((s) => approveOne(s, actor, { via }));
  return { pending, skipped: rows.length - pending.length };
}

// Group ("total submission") approval: approve every PENDING_APPROVAL row in the
// posted set in one click. Non-pending rows are left untouched and reported as
// skipped. One group audit event is recorded alongside the per-submission events.
router.post('/admin/group/approve', adminAuth, express.json(), async (req, res, next) => {
  try {
    const rows = resolveUuidBatch(req.body);
    if (!rows.length) return res.status(400).json({ error: 'no_submissions' });
    const actor = operatorName(req);
    const { pending, skipped } = approvePendingRows(rows, actor, 'console_group');
    if (pending.length) {
      audit.record({ event: 'approved_group', actor, details: { via: 'console', count: pending.length, submissionUuids: pending.map((s) => s.submission_uuid) } });
    }
    res.json({ ok: true, approved: pending.length, skipped, queued: approvalQueue.size() });
  } catch (err) { next(err); }
});

// Job approval: approve every pending submission belonging to the selected jobs.
// The actual SP-API writes are queued one-at-a-time by approvalQueue.
router.post('/admin/jobs/approve', adminAuth, express.json(), async (req, res, next) => {
  try {
    const selectedJobs = resolveJobBatch(req.body);
    if (!selectedJobs.length) return res.status(400).json({ error: 'no_jobs' });
    const actor = operatorName(req);
    const rows = [];
    for (const job of selectedJobs) rows.push(...submissions.listForJob(job.job_uuid));
    const uniqueRows = [];
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.submission_uuid)) continue;
      seen.add(row.submission_uuid);
      uniqueRows.push(row);
    }
    const { pending, skipped } = approvePendingRows(uniqueRows, actor, 'console_jobs');
    if (pending.length) {
      audit.record({
        event: 'approved_jobs',
        actor,
        details: {
          via: 'console',
          jobUuids: selectedJobs.map((j) => j.job_uuid),
          count: pending.length,
          submissionUuids: pending.map((s) => s.submission_uuid)
        }
      });
    }
    res.json({ ok: true, jobs: selectedJobs.length, approved: pending.length, skipped, queued: approvalQueue.size() });
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
        approver_comment: s.approver_comment || null,
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
    pendingApprovalCount: submissions.listForJob(j.job_uuid).filter((s) => s.status === 'PENDING_APPROVAL').length,
    label: j.label, createdAt: j.created_at, completedAt: j.completed_at
  })) });
});

// Every submission carrying an Amazon error/diagnostic, distilled for the
// Errors tab. Each record exposes the full issue list (code/message/severity/
// attributeNames) plus the raw envelope for the expandable detail panel.
router.get('/admin/errors', adminAuth, (req, res) => {
  const records = errorReport.listErrorSubmissions({ limit: req.query.limit || 1000 }).map(errorReport.toRecord);
  // Attach any existing AI-resolution state so the Errors tab can render a
  // per-row badge ("AI: proposed / applied / rejected") in a single query.
  const resState = aiResolutions.statusMap(records.map((r) => r.submission_uuid));
  for (const r of records) {
    const rs = resState[r.submission_uuid];
    r.aiResolution = rs ? { status: rs.status, confidence: rs.confidence, resolvable: rs.resolvable, appliedSubmissionUuid: rs.appliedSubmissionUuid } : null;
  }
  res.json({ count: records.length, errors: records, resolverEnabled: aiResolver.isEnabled() });
});

// Excel (.xlsx) export of all error submissions — one row per Amazon issue so
// every code/message lands on its own line. Served as a file download; the
// console passes the operator JWT via ?token= since <a> downloads can't set an
// Authorization header.
router.get('/admin/errors/export', adminAuth, async (req, res, next) => {
  try {
    const { workbook } = await errorReport.buildWorkbook({ limit: req.query.limit || 5000 });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="amazon-push-errors-${stamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// ── AI error resolution ─────────────────────────────────────────────────────
// An OpenAI model reviews a FAILED submission, diagnoses the Amazon error, and
// drafts a corrected SP-API package. Nothing reaches Amazon until an operator
// approves the proposal here (POST .../apply), which forwards it as a NEW
// audited submission linked back to the original via resolves_uuid.

// Map the resolver's structured result to an HTTP response, distinguishing the
// "feature off" / "not found" / "model failed" cases for the UI.
function sendResolutionResult(res, result) {
  if (!result) return res.status(500).json({ error: 'resolver_error' });
  if (result.reason === 'resolver_disabled') return res.status(503).json({ error: 'resolver_disabled', message: 'OPENAI_API_KEY is not configured (AI resolver is off).' });
  if (result.reason === 'submission_not_found') return res.status(404).json({ error: 'submission_not_found' });
  if (result.reason === 'llm_failed') return res.status(502).json({ error: 'llm_failed', message: result.error || 'model call failed', resolution: result.resolution || null });
  return res.json({ ok: true, cached: !!result.cached, resolution: result.resolution });
}

// Run (or re-run with ?force=1) the AI review for one failed submission.
router.post('/admin/errors/:uuid/review', adminAuth, async (req, res, next) => {
  try {
    if (!aiResolver.isEnabled()) return res.status(503).json({ error: 'resolver_disabled', message: 'OPENAI_API_KEY is not configured (AI resolver is off).' });
    const force = req.query.force === '1' || req.query.force === 'true';
    const actor = operatorName(req);
    const result = await aiResolver.reviewSubmission(req.params.uuid, { force, reviewedBy: actor });
    if (result.ok && !result.cached) {
      audit.record({ event: 'ai_review', submissionUuid: req.params.uuid, actor, details: { confidence: result.resolution && result.resolution.confidence, resolvable: result.resolution && result.resolution.resolvable, model: result.resolution && result.resolution.model, force } });
    }
    sendResolutionResult(res, result);
  } catch (err) { next(err); }
});

// Fetch the cached AI resolution for one submission (no model call).
router.get('/admin/errors/:uuid/review', adminAuth, (req, res) => {
  const row = aiResolutions.getBySubmission(req.params.uuid);
  if (!row) return res.status(404).json({ error: 'no_resolution' });
  res.json({ ok: true, resolution: aiResolutions.toRecord(row) });
});

// Bounded fan-out: review every currently-FAILED submission that has no
// resolution yet (sequentially, to respect OpenAI rate limits).
router.post('/admin/errors/review-batch', adminAuth, express.json(), async (req, res, next) => {
  try {
    if (!aiResolver.isEnabled()) return res.status(503).json({ error: 'resolver_disabled', message: 'OPENAI_API_KEY is not configured (AI resolver is off).' });
    const cap = Math.max(1, Math.min(50, Number(req.body && req.body.limit) || 25));
    const force = !!(req.body && req.body.force);
    const actor = operatorName(req);
    const failed = submissions.listErrors({ limit: 1000 }).filter((r) => r.status === 'FAILED');
    let reviewed = 0; let skipped = 0; let failedCount = 0;
    for (const row of failed) {
      if (reviewed >= cap) break;
      if (!force && aiResolutions.getBySubmission(row.submission_uuid)) { skipped++; continue; }
      const result = await aiResolver.reviewSubmission(row.submission_uuid, { force, reviewedBy: actor });
      if (result.ok && !result.cached) {
        reviewed++;
        audit.record({ event: 'ai_review', submissionUuid: row.submission_uuid, actor, details: { batch: true, confidence: result.resolution && result.resolution.confidence, resolvable: result.resolution && result.resolution.resolvable } });
      } else if (result.cached) {
        skipped++;
      } else {
        failedCount++;
      }
    }
    res.json({ ok: true, reviewed, skipped, failed: failedCount, totalFailed: failed.length });
  } catch (err) { next(err); }
});

// Reject a proposal: discard it, never sent to Amazon.
router.post('/admin/errors/:uuid/reject', adminAuth, express.json(), (req, res) => {
  const existing = aiResolutions.getBySubmission(req.params.uuid);
  if (!existing) return res.status(404).json({ error: 'no_resolution' });
  const actor = operatorName(req);
  const updated = aiResolutions.setStatus(req.params.uuid, { status: 'REJECTED', reviewedBy: actor });
  audit.record({ event: 'ai_fix_rejected', submissionUuid: req.params.uuid, actor, details: { via: 'console' } });
  res.json({ ok: true, resolution: aiResolutions.toRecord(updated) });
});

// Operator approval: take the (optionally edited) proposed package, re-validate
// it, create a NEW submission linked to the original failure, and forward it to
// Amazon immediately (the console approval is the human gate). Gated by the
// master kill switch like every other write path.
router.post('/admin/errors/:uuid/apply', adminAuth, writeGate, express.json(), async (req, res, next) => {
  try {
    const original = submissions.getByUuid(req.params.uuid);
    if (!original) return res.status(404).json({ error: 'submission_not_found' });

    const stored = aiResolutions.getBySubmission(req.params.uuid);
    const storedRec = stored ? aiResolutions.toRecord(stored) : null;

    // The package + operation come from the request body when the operator
    // edited the proposal, else from the stored resolution.
    const body = req.body || {};
    const operation = (body.operation === 'patchItem' || body.operation === 'submitJsonListingsFeed')
      ? body.operation
      : (storedRec && storedRec.operation) || original.operation;
    const pkg = body.package || (storedRec && storedRec.proposedPackage) || null;
    if (!pkg || typeof pkg !== 'object') {
      return res.status(400).json({ error: 'no_package', message: 'No proposed package to apply. Run a review first, or supply a package in the request body.' });
    }

    const marketplaceCode = String(original.marketplace_code || '').toUpperCase();
    if (!resolveByCode(marketplaceCode)) return res.status(400).json({ error: 'unknown_marketplace', message: `Unknown marketplace: ${original.marketplace_code}` });
    const productType = original.product_type;
    if (!productType) return res.status(400).json({ error: 'missing_product_type' });

    const validated = await packageValidator.validatePackage({
      pkg, operation, productType, marketplaceCode, allowUnknownAttributes: false
    });
    if (!validated.ok) {
      return res.status(400).json({ error: 'package_invalid', problems: validated.problems, droppedAttrNames: validated.droppedAttrNames || [] });
    }

    const actor = operatorName(req);
    const requestBody = buildRequestBody({ operation, marketplaceCode, productType, validated });

    // Parent job so the fix is visible in the Jobs tab and status recomputes.
    const jobUuid = newUuid();
    jobs.create({
      jobUuid, kind: 'ai_fix', caller: actor, asin: original.asin, itemNumber: original.item_number,
      marketplaceCode, productType, label: `AI fix of ${original.submission_uuid}`, targetCount: 1
    });
    jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });

    const submissionUuid = newUuid();
    const submission = submissions.insert({
      submissionUuid, jobUuid, caller: actor, scope: original.scope, operation,
      vendorCode: original.vendor_code, sku: original.effective_sku || original.sku, parentSku: original.parent_sku,
      asin: original.asin, itemNumber: original.item_number, marketplaceCode, productType,
      requestBody, status: 'IN_PROGRESS', payloadOrigin: 'ai_resolved', rawPackage: pkg,
      flyappMeta: { resolvesUuid: original.submission_uuid, aiModel: storedRec && storedRec.model, aiConfidence: storedRec && storedRec.confidence },
      resolvesUuid: original.submission_uuid, approverComment: body.comment || null
    });
    audit.record({ event: 'ai_fix_applied', submissionUuid, jobUuid, actor, details: { resolvesUuid: original.submission_uuid, operation, changedAttrNames: validated.changedAttrNames, edited: !!body.package } });

    const finalRow = await forwarder.forward(submission);
    recomputeJobStatus(jobUuid);
    aiResolutions.setStatus(req.params.uuid, { status: 'APPLIED', reviewedBy: actor, appliedSubmissionUuid: submissionUuid });

    res.status(202).json({
      ok: true,
      submissionId: submissionUuid,
      jobId: jobUuid,
      status: finalRow.status,
      issues: forwarder.buildResponseFromSubmission(finalRow).issues,
      errorMessage: finalRow.error_message || null
    });
  } catch (err) { next(err); }
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
