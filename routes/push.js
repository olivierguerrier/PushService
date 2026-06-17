// Push API — the service's main write surface.
//
//   POST /push/preview            build payload + (optional) Amazon dry-run.
//   POST /push                     build + push (fan-out to submissions).
//   GET  /push/jobs/:jobUuid       parent job status + child submissions.
//   GET  /push/submissions/:uuid   one submission's status + audit timeline.
//   POST /push/revert/:uuid        inverse patch from captured prior state.
//
// All endpoints require a bearer service token. Writes additionally pass the
// kill switch (writeGate) and run the per-scope approval policy.
const crypto = require('crypto');
const express = require('express');
const { bearerAuth } = require('../middleware/auth');
const { writeGate } = require('../middleware/writeGate');
const validation = require('../src/validation');
const pusher = require('../src/pusher');
const jobs = require('../src/jobs');
const submissions = require('../src/submissions');
const forwarder = require('../src/forwarder');
const idempotency = require('../src/idempotency');
const approvalPolicy = require('../src/approvalPolicy');
const audit = require('../src/audit/auditEvents');
const { recomputeJobStatus } = require('../src/jobOrchestrator');
const { sendApprovalEmail } = require('../src/approvalEmail');
const translator = require('../src/translator');
const packageValidator = require('../src/packageValidator');
const { buildRequestBody } = require('../src/packageRequestBody');
const listingsItems = require('../src/spapi/listingsItems');
const reconciliation = require('../src/reconciliation');
const listingAppClient = require('../src/sot/listingAppClient');
const { resolveByCode } = require('../config/marketplaces');

const router = express.Router();

const newUuid = () => crypto.randomUUID();
const newApprovalToken = () => crypto.randomBytes(24).toString('hex');
const headerIdemKey = (req) => req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || null;

function isContentMatchScope(scope) {
  return String(scope || '').toUpperCase() === 'CONTENT_MATCH';
}

async function loadContentMatchAsinGate(scope) {
  if (!isContentMatchScope(scope)) return null;
  if (!listingAppClient.isConfigured()) {
    return { error: `ListingApp ASIN check unavailable: ${listingAppClient.unavailableReason()}` };
  }
  try {
    return { asins: await listingAppClient.getKnownAsins() };
  } catch (err) {
    return { error: `ListingApp ASIN check failed: ${err.message}` };
  }
}

function contentMatchAsinProblem(target, gate) {
  if (!gate) return null;
  if (gate.error) return gate.error;
  const asin = listingAppClient.normalizeAsin(target.asin);
  if (!asin) return `ASIN ${target.asin || ''} is not valid for ListingApp matching`;
  return gate.asins.has(asin) ? null : `ASIN ${asin} is not present in ListingApp`;
}

async function preflightPatchCoordinates({ operation, target, marketplaceCode }) {
  if (operation !== 'patchItem' || !target.sellerId || !target.sku) return null;
  try {
    await listingsItems.getItem({
      sellerId: target.sellerId,
      sku: target.sku,
      marketplaceCode,
      includedData: ['summaries']
    });
    return null;
  } catch (err) {
    if (listingsItems.isInvalidSellerMarketplaceError(err)) {
      return listingsItems.invalidSellerMarketplaceMessage({
        sellerId: target.sellerId,
        sku: target.sku,
        marketplaceCode
      });
    }
    // Other read failures (for example a not-yet-readable SKU) are surfaced by
    // the existing best-effort current-value warning and must not block review.
    return null;
  }
}

// ── POST /push/preview ──────────────────────────────────────────────────────
router.post('/preview', bearerAuth, async (req, res, next) => {
  try {
    const target = validation.parse(validation.previewSchema, req.body || {});
    const plan = await pusher.buildPlan(target);
    audit.record({ event: 'preview', actor: req.caller, details: { asin: plan.asin, marketplace: plan.marketplaceCode, sourceHash: plan.sourceHash, kept: Object.keys(plan.attributes.kept), dropped: plan.attributes.dropped } });

    const wantDryRun = req.query.dryRun === '1' || req.body.dryRun === true;
    let dryRun = null;
    if (wantDryRun) {
      try { dryRun = await pusher.dryRunPlan(plan); }
      catch (err) { dryRun = { error: err.message, status: err.status || null }; }
    }
    res.json({
      marketplaceCode: plan.marketplaceCode,
      asin: plan.asin,
      productType: plan.productType,
      schemaMeta: plan.schemaMeta,
      sourceHash: plan.sourceHash,
      warnings: plan.warnings,
      attributes: plan.attributes,
      patches: plan.patches,
      sources: plan.sources,
      dryRun
    });
  } catch (err) { next(err); }
});

// ── POST /push ──────────────────────────────────────────────────────────────
router.post('/', bearerAuth, writeGate, async (req, res, next) => {
  try {
    const parsed = validation.parse(validation.pushSchema, req.body || {});
    const jobUuid = newUuid();
    const first = parsed.targets[0];
    jobs.create({
      jobUuid,
      kind: parsed.operation,
      caller: req.caller,
      asin: first.asin || null,
      itemNumber: first.itemNumber || null,
      marketplaceCode: parsed.targets.length === 1 ? first.marketplaceCode : null,
      productType: first.productType || null,
      label: parsed.label || null,
      requestPayload: {
        path: 'push',
        scope: parsed.scope,
        operation: parsed.operation,
        targetCount: parsed.targets.length,
        targets: parsed.targets,
        fieldNames: parsed.fieldNames || null,
        label: parsed.label || null,
        comment: parsed.comment || null
      },
      fieldNames: parsed.fieldNames || null,
      targetCount: parsed.targets.length
    });
    jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });
    audit.record({ event: 'job_created', jobUuid, actor: req.caller, details: { scope: parsed.scope, operation: parsed.operation, targets: parsed.targets.length } });

    const listingAppAsinGate = await loadContentMatchAsinGate(parsed.scope);
    const results = [];
    for (const target of parsed.targets) {
      const result = await handleTarget({ req, jobUuid, parsed, target, listingAppAsinGate });
      results.push(result);
    }

    const job = recomputeJobStatus(jobUuid);
    res.status(202).json({
      jobId: jobUuid,
      status: job ? job.status : 'running',
      submissions: results
    });
  } catch (err) { next(err); }
});

// ── POST /push/package ───────────────────────────────────────────────────────
// The "thin" path: the caller (FlyApp) supplies a pre-built Amazon package per
// target. We validate it against the live productType schema, gate on approval
// policy, then forward it through the SAME forwarder as the fat path. The
// payload is stored verbatim (raw_package_json) for audit fidelity.
router.post('/package', bearerAuth, writeGate, async (req, res, next) => {
  try {
    const parsed = validation.parse(validation.pushPackageSchema, req.body || {});
    const jobUuid = newUuid();
    const first = parsed.targets[0];
    jobs.create({
      jobUuid,
      kind: `package:${parsed.operation}`,
      caller: req.caller,
      asin: first.asin || null,
      itemNumber: first.itemNumber || null,
      marketplaceCode: parsed.targets.length === 1 ? first.marketplaceCode : null,
      productType: first.productType || null,
      label: parsed.label || null,
      requestPayload: {
        path: 'package',
        scope: parsed.scope,
        operation: parsed.operation,
        targetCount: parsed.targets.length,
        targets: parsed.targets,
        label: parsed.label || null,
        comment: parsed.comment || null,
        allowUnknownAttributes: parsed.allowUnknownAttributes,
        origin: 'flyapp_prebuilt'
      },
      targetCount: parsed.targets.length
    });
    jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });
    audit.record({ event: 'job_created', jobUuid, actor: req.caller, details: { scope: parsed.scope, operation: parsed.operation, targets: parsed.targets.length, origin: 'flyapp_prebuilt' } });

    const listingAppAsinGate = await loadContentMatchAsinGate(parsed.scope);
    const results = [];
    for (const target of parsed.targets) {
      const result = await handlePackageTarget({ req, jobUuid, parsed, target, listingAppAsinGate });
      results.push(result);
    }

    const job = recomputeJobStatus(jobUuid);
    res.status(202).json({ jobId: jobUuid, status: job ? job.status : 'running', submissions: results });
  } catch (err) { next(err); }
});

// ── POST /push/package/preview ───────────────────────────────────────────────
// No-write validation of a caller-built package. Validates each target against
// the live productType schema and (for patchItem) runs an Amazon
// VALIDATION_PREVIEW dry-run. Creates NO job, NO submission, sends NO email,
// and never forwards — so it is intentionally NOT behind writeGate and stays
// usable while the master kill switch is off. FlyApp's "Preview"/"dry-run"
// buttons hit this path.
router.post('/package/preview', bearerAuth, async (req, res, next) => {
  try {
    const parsed = validation.parse(validation.pushPackageSchema, req.body || {});
    const listingAppAsinGate = await loadContentMatchAsinGate(parsed.scope);
    const results = [];
    for (const target of parsed.targets) {
      const marketplaceCode = String(target.marketplaceCode || '').toUpperCase();
      const effectiveProductType = target.productType || (target.package && target.package.productType) || null;
      const asinProblem = contentMatchAsinProblem(target, listingAppAsinGate);
      const coordError = asinProblem || (!resolveByCode(marketplaceCode) ? `Unknown marketplace: ${target.marketplaceCode}`
        : !effectiveProductType ? 'productType is required (on the target or inside the package)'
          : null);

      let validated = null;
      let dryRun = null;
      let coordinateProblem = null;
      if (!coordError) {
        validated = await packageValidator.validatePackage({
          pkg: target.package,
          operation: parsed.operation,
          productType: effectiveProductType,
          marketplaceCode,
          allowUnknownAttributes: parsed.allowUnknownAttributes
        });
        if (validated.ok) {
          coordinateProblem = await preflightPatchCoordinates({ operation: parsed.operation, target, marketplaceCode });
          if (coordinateProblem) {
            validated = { ...validated, ok: false, problems: [coordinateProblem] };
          }
        }
        if (validated.ok && parsed.operation === 'patchItem' && target.sellerId && target.sku) {
          try {
            dryRun = await listingsItems.patchItem({
              sellerId: target.sellerId, sku: target.sku, marketplaceCode,
              productType: effectiveProductType,
              patches: validated.sanitizedPackage.patches,
              mode: 'VALIDATION_PREVIEW'
            });
          } catch (err) {
            dryRun = { error: err.message, status: err.status || null, body: err.responseText || null };
          }
        }
      }

      results.push({
        asin: target.asin || null,
        sellerId: target.sellerId || null,
        sku: target.sku || null,
        marketplaceCode: target.marketplaceCode,
        productType: effectiveProductType,
        ok: coordError ? false : validated.ok,
        problems: coordError ? [coordError] : validated.problems,
        changedAttrNames: validated ? validated.changedAttrNames : [],
        droppedAttrNames: validated ? validated.droppedAttrNames : [],
        warnings: validated ? validated.warnings : [],
        schemaMeta: validated ? validated.schemaMeta : null,
        dryRun
      });
    }
    audit.record({ event: 'package_preview', actor: req.caller, details: { operation: parsed.operation, targets: parsed.targets.length } });
    res.json({ previewOnly: true, operation: parsed.operation, results });
  } catch (err) { next(err); }
});

// Validate + create + (auto-forward | email) one pre-built package target.
async function handlePackageTarget({ req, jobUuid, parsed, target, listingAppAsinGate = null }) {
  const idemKey = target.idempotencyKey || (parsed.targets.length === 1 ? headerIdemKey(req) : null);

  if (idemKey) {
    const replay = idempotency.lookupReplay(idemKey);
    if (replay) {
      audit.record({ event: 'idempotency_replay', submissionUuid: replay.submission.submission_uuid, actor: req.caller, details: { idempotencyKey: idemKey } });
      return { submissionId: replay.submission.submission_uuid, status: replay.submission.status, replayed: true, marketplaceCode: replay.submission.marketplace_code };
    }
  }

  // ASIN is the required canonical identifier. Rather than 400 the whole batch,
  // fail just this target with a visible FAILED submission so operators can see
  // that the caller omitted it.
  if (!target.asin || !String(target.asin).trim()) {
    const submissionUuid = newUuid();
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, asin: null,
      itemNumber: target.itemNumber, marketplaceCode: target.marketplaceCode,
      productType: target.productType || (target.package && target.package.productType) || null,
      requestBody: { error: 'asin_missing' }, status: 'FAILED',
      payloadOrigin: 'flyapp_prebuilt', rawPackage: target.package, flyappMeta: target.meta
    });
    submissions.update(submissionUuid, { error_message: 'asin missing: ASIN is the required canonical identifier; caller did not provide it' });
    audit.record({ event: 'asin_missing', submissionUuid, jobUuid, actor: req.caller, details: { sku: target.sku, vendorCode: target.sellerId } });
    return { submissionId: submissionUuid, status: 'FAILED', error: 'asin_missing', marketplaceCode: target.marketplaceCode };
  }

  const asinProblem = contentMatchAsinProblem(target, listingAppAsinGate);
  if (asinProblem) {
    const submissionUuid = newUuid();
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, asin: target.asin,
      itemNumber: target.itemNumber, marketplaceCode: target.marketplaceCode,
      productType: target.productType || (target.package && target.package.productType) || null,
      requestBody: { error: 'asin_not_in_listingapp' }, status: 'FAILED',
      payloadOrigin: 'flyapp_prebuilt', rawPackage: target.package, flyappMeta: target.meta
    });
    submissions.update(submissionUuid, { error_message: asinProblem });
    audit.record({ event: 'asin_not_in_listingapp', submissionUuid, jobUuid, actor: req.caller, details: { asin: target.asin, sku: target.sku, vendorCode: target.sellerId, reason: asinProblem } });
    return { submissionId: submissionUuid, status: 'FAILED', error: 'asin_not_in_listingapp', message: asinProblem, marketplaceCode: target.marketplaceCode };
  }

  const marketplaceCode = String(target.marketplaceCode || '').toUpperCase();
  const effectiveProductType = target.productType || (target.package && target.package.productType) || null;

  // Coordinate sanity before we call Amazon for the schema.
  const coordError = !resolveByCode(marketplaceCode) ? `Unknown marketplace: ${target.marketplaceCode}`
    : !effectiveProductType ? 'productType is required (on the target or inside the package)'
      : (parsed.operation === 'submitJsonListingsFeed' && !target.sellerId) ? 'sellerId is required for a feed package'
        : null;

  let validated = null;
  let coordinateProblem = null;
  if (!coordError) {
    validated = await packageValidator.validatePackage({
      pkg: target.package,
      operation: parsed.operation,
      productType: effectiveProductType,
      marketplaceCode,
      allowUnknownAttributes: parsed.allowUnknownAttributes
    });
    if (validated.ok) {
      coordinateProblem = await preflightPatchCoordinates({ operation: parsed.operation, target, marketplaceCode });
    }
  }

  // Rejected: structural / schema / coordinate problem — record a FAILED row.
  if (coordError || coordinateProblem || !validated.ok) {
    const submissionUuid = newUuid();
    const problems = coordError ? [coordError] : coordinateProblem ? [coordinateProblem] : validated.problems;
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, asin: target.asin,
      itemNumber: target.itemNumber, marketplaceCode: target.marketplaceCode, productType: effectiveProductType,
      requestBody: { error: 'package_rejected', problems }, status: 'FAILED',
      payloadOrigin: 'flyapp_prebuilt', rawPackage: target.package, flyappMeta: target.meta
    });
    submissions.update(submissionUuid, { error_message: `package rejected: ${problems.join('; ')}`.slice(0, 1000) });
    audit.record({ event: 'package_rejected', submissionUuid, jobUuid, actor: req.caller, details: { problems, droppedAttrNames: validated ? validated.droppedAttrNames : [] } });
    return { submissionId: submissionUuid, status: 'FAILED', error: problems.join('; '), marketplaceCode: target.marketplaceCode };
  }

  audit.record({ event: 'package_validated', actor: req.caller, jobUuid, details: { changedAttrNames: validated.changedAttrNames, droppedAttrNames: validated.droppedAttrNames, schemaMeta: validated.schemaMeta, warnings: validated.warnings } });

  // Optional pre-push dry-run against Amazon (patchItem only).
  if ((req.query.dryRun === '1' || req.body.dryRun === true) && parsed.operation === 'patchItem' && target.sellerId && target.sku) {
    try {
      await listingsItems.patchItem({ sellerId: target.sellerId, sku: target.sku, marketplaceCode, productType: effectiveProductType, patches: validated.sanitizedPackage.patches, mode: 'VALIDATION_PREVIEW' });
      audit.record({ event: 'package_dry_run_ok', actor: req.caller, jobUuid, details: { asin: target.asin, sku: target.sku } });
    } catch (err) {
      audit.record({ event: 'package_dry_run_failed', actor: req.caller, jobUuid, details: { message: err.message, status: err.status || null } });
    }
  }

  const requestBody = buildRequestBody({
    operation: parsed.operation,
    marketplaceCode,
    productType: effectiveProductType,
    validated
  });

  const policy = approvalPolicy.resolve({ scope: parsed.scope, caller: req.caller });
  const submissionUuid = newUuid();
  const approvalToken = policy.policy === 'email' ? newApprovalToken() : null;
  const initialStatus = policy.policy === 'auto' ? 'IN_PROGRESS' : 'PENDING_APPROVAL';

  let submission;
  try {
    submission = submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: policy.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, parentSku: target.parentSku,
      asin: target.asin,
      itemNumber: target.itemNumber, marketplaceCode, productType: effectiveProductType,
      requestBody, status: initialStatus, approvalToken,
      payloadOrigin: 'flyapp_prebuilt', rawPackage: target.package, flyappMeta: target.meta,
      approverComment: parsed.comment
    });
  } catch (e) {
    if (idemKey && /UNIQUE/i.test(String(e.message))) {
      const replay = idempotency.lookupReplay(idemKey);
      if (replay) return { submissionId: replay.submission.submission_uuid, status: replay.submission.status, replayed: true, marketplaceCode: replay.submission.marketplace_code };
    }
    throw e;
  }
  audit.record({ event: 'received', submissionUuid, jobUuid, actor: req.caller, details: { scope: policy.scope, policy: policy.policy, origin: 'flyapp_prebuilt', changedAttrNames: validated.changedAttrNames, comment: parsed.comment || null } });

  if (policy.policy === 'auto') {
    audit.record({ event: 'auto_approved', submissionUuid, jobUuid, actor: 'system' });
    const finalRow = await forwarder.forward(submission);
    return { submissionId: submissionUuid, status: finalRow.status, marketplaceCode, issues: forwarder.buildResponseFromSubmission(finalRow).issues };
  }

  // Held for human approval. Nothing reaches Amazon until a reviewer approves
  // (email link for 'email', operator console for 'manual').
  if (policy.policy === 'email') {
    const mail = await sendApprovalEmail({ submission, requestBody });
    audit.record({ event: 'approval_emailed', submissionUuid, jobUuid, actor: 'system', details: { ok: mail.ok, reason: mail.reason || null } });
    return { submissionId: submissionUuid, status: 'PENDING_APPROVAL', approvalEmailSent: !!mail.ok, marketplaceCode };
  }
  audit.record({ event: 'awaiting_approval', submissionUuid, jobUuid, actor: 'system', details: { policy: policy.policy } });
  return { submissionId: submissionUuid, status: 'PENDING_APPROVAL', approvalEmailSent: false, marketplaceCode };
}

// Build + create + (auto-forward | email) one target's submission.
async function handleTarget({ req, jobUuid, parsed, target, listingAppAsinGate = null }) {
  const fieldNames = target.fieldNames || parsed.fieldNames || null;
  const idemKey = target.idempotencyKey || (parsed.targets.length === 1 ? headerIdemKey(req) : null);

  // Idempotency replay.
  if (idemKey) {
    const replay = idempotency.lookupReplay(idemKey);
    if (replay) {
      audit.record({ event: 'idempotency_replay', submissionUuid: replay.submission.submission_uuid, actor: req.caller, details: { idempotencyKey: idemKey } });
      return { submissionId: replay.submission.submission_uuid, status: replay.submission.status, replayed: true, marketplaceCode: replay.submission.marketplace_code };
    }
  }

  // ASIN is the required canonical identifier. Fail just this target (visible
  // FAILED submission) instead of 400-ing the whole batch when it is missing.
  if (!target.asin || !String(target.asin).trim()) {
    const submissionUuid = newUuid();
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, asin: null,
      itemNumber: target.itemNumber, marketplaceCode: target.marketplaceCode, productType: target.productType,
      requestBody: { error: 'asin_missing' }, status: 'FAILED', flyappMeta: target.meta
    });
    submissions.update(submissionUuid, { error_message: 'asin missing: ASIN is the required canonical identifier; caller did not provide it' });
    audit.record({ event: 'asin_missing', submissionUuid, jobUuid, actor: req.caller, details: { sku: target.sku, vendorCode: target.sellerId } });
    return { submissionId: submissionUuid, status: 'FAILED', error: 'asin_missing', marketplaceCode: target.marketplaceCode };
  }

  const asinProblem = contentMatchAsinProblem(target, listingAppAsinGate);
  if (asinProblem) {
    const submissionUuid = newUuid();
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, asin: target.asin,
      itemNumber: target.itemNumber, marketplaceCode: target.marketplaceCode, productType: target.productType,
      requestBody: { error: 'asin_not_in_listingapp' }, status: 'FAILED', flyappMeta: target.meta
    });
    submissions.update(submissionUuid, { error_message: asinProblem });
    audit.record({ event: 'asin_not_in_listingapp', submissionUuid, jobUuid, actor: req.caller, details: { asin: target.asin, sku: target.sku, vendorCode: target.sellerId, reason: asinProblem } });
    return { submissionId: submissionUuid, status: 'FAILED', error: 'asin_not_in_listingapp', message: asinProblem, marketplaceCode: target.marketplaceCode };
  }

  const marketplaceCode = String(target.marketplaceCode || '').toUpperCase();
  const coordinateProblem = !resolveByCode(marketplaceCode)
    ? `Unknown marketplace: ${target.marketplaceCode}`
    : await preflightPatchCoordinates({ operation: parsed.operation, target, marketplaceCode });
  if (coordinateProblem) {
    const submissionUuid = newUuid();
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, asin: target.asin,
      itemNumber: target.itemNumber, marketplaceCode: target.marketplaceCode, productType: target.productType,
      requestBody: { error: 'invalid_listing_coordinates' }, status: 'FAILED', flyappMeta: target.meta
    });
    submissions.update(submissionUuid, { error_message: coordinateProblem.slice(0, 1000) });
    audit.record({ event: 'invalid_listing_coordinates', submissionUuid, jobUuid, actor: req.caller, details: { asin: target.asin, sku: target.sku, vendorCode: target.sellerId, marketplaceCode, reason: coordinateProblem } });
    return { submissionId: submissionUuid, status: 'FAILED', error: coordinateProblem, marketplaceCode: target.marketplaceCode };
  }

  let plan;
  try {
    plan = await pusher.buildPlan({ ...target, fieldNames });
  } catch (err) {
    const submissionUuid = newUuid();
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: target.sellerId, sku: target.sku, asin: target.asin,
      itemNumber: target.itemNumber, marketplaceCode: target.marketplaceCode, productType: target.productType,
      requestBody: { error: 'build_failed' }, status: 'FAILED', flyappMeta: target.meta
    });
    submissions.update(submissionUuid, { error_message: `build failed: ${err.message}` });
    audit.record({ event: 'build_failed', submissionUuid, jobUuid, actor: req.caller, details: { message: err.message } });
    return { submissionId: submissionUuid, status: 'FAILED', error: err.message, marketplaceCode: target.marketplaceCode };
  }

  // Nothing to push (all fields empty / dropped by schema).
  if (parsed.operation === 'patchItem' && !plan.patches.length) {
    const submissionUuid = newUuid();
    submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: parsed.scope,
      operation: parsed.operation, vendorCode: plan.sellerId, sku: plan.sku, asin: plan.asin,
      itemNumber: plan.itemNumber, marketplaceCode: plan.marketplaceCode, productType: plan.productType,
      sourceHash: plan.sourceHash, sourceSnapshot: plan.snapshot,
      requestBody: { productType: plan.productType, patches: [], note: 'no attributes resolved' }, status: 'SKIPPED',
      flyappMeta: target.meta
    });
    audit.record({ event: 'skipped_empty', submissionUuid, jobUuid, actor: req.caller, details: { warnings: plan.warnings } });
    return { submissionId: submissionUuid, status: 'SKIPPED', reason: 'no_attributes_resolved', warnings: plan.warnings, marketplaceCode: plan.marketplaceCode };
  }

  const requestBody = parsed.operation === 'submitJsonListingsFeed'
    ? { marketplaceCode: plan.marketplaceCode, payload: translator.buildFeedMessages([{ sku: plan.sku, attributes: plan.attributes.kept, productType: plan.productType }], { sellerId: plan.sellerId || 'PLACEHOLDER' }), changedAttrNames: plan.changedAttrNames, productType: plan.productType }
    : { productType: plan.productType, patches: plan.patches, changedAttrNames: plan.changedAttrNames };

  const policy = approvalPolicy.resolve({ scope: parsed.scope, caller: req.caller });
  const submissionUuid = newUuid();
  const approvalToken = policy.policy === 'email' ? newApprovalToken() : null;
  const initialStatus = policy.policy === 'auto' ? 'IN_PROGRESS' : 'PENDING_APPROVAL';

  let submission;
  try {
    submission = submissions.insert({
      submissionUuid, jobUuid, idempotencyKey: idemKey, caller: req.caller, scope: policy.scope,
      operation: parsed.operation, vendorCode: plan.sellerId, sku: plan.sku, parentSku: target.parentSku,
      asin: plan.asin,
      itemNumber: plan.itemNumber, marketplaceCode: plan.marketplaceCode, productType: plan.productType,
      sourceHash: plan.sourceHash, sourceSnapshot: plan.snapshot, requestBody, status: initialStatus, approvalToken,
      flyappMeta: target.meta, approverComment: parsed.comment
    });
  } catch (e) {
    if (idemKey && /UNIQUE/i.test(String(e.message))) {
      const replay = idempotency.lookupReplay(idemKey);
      if (replay) return { submissionId: replay.submission.submission_uuid, status: replay.submission.status, replayed: true, marketplaceCode: replay.submission.marketplace_code };
    }
    throw e;
  }
  audit.record({ event: 'received', submissionUuid, jobUuid, actor: req.caller, details: { scope: policy.scope, policy: policy.policy, sourceHash: plan.sourceHash, changedAttrNames: plan.changedAttrNames, comment: parsed.comment || null } });

  if (policy.policy === 'auto') {
    audit.record({ event: 'auto_approved', submissionUuid, jobUuid, actor: 'system' });
    const finalRow = await forwarder.forward(submission);
    return { submissionId: submissionUuid, status: finalRow.status, marketplaceCode: plan.marketplaceCode, issues: forwarder.buildResponseFromSubmission(finalRow).issues };
  }

  // Held for human approval. Nothing reaches Amazon until a reviewer approves
  // (email link for 'email', operator console for 'manual').
  if (policy.policy === 'email') {
    const mail = await sendApprovalEmail({ submission, requestBody });
    audit.record({ event: 'approval_emailed', submissionUuid, jobUuid, actor: 'system', details: { ok: mail.ok, reason: mail.reason || null } });
    return { submissionId: submissionUuid, status: 'PENDING_APPROVAL', approvalEmailSent: !!mail.ok, marketplaceCode: plan.marketplaceCode };
  }
  audit.record({ event: 'awaiting_approval', submissionUuid, jobUuid, actor: 'system', details: { policy: policy.policy } });
  return { submissionId: submissionUuid, status: 'PENDING_APPROVAL', approvalEmailSent: false, marketplaceCode: plan.marketplaceCode };
}

// ── GET /push/jobs/:jobUuid ─────────────────────────────────────────────────
router.get('/jobs/:jobUuid', bearerAuth, (req, res) => {
  const job = jobs.getByUuid(req.params.jobUuid);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  if (job.caller && job.caller !== req.caller) return res.status(404).json({ error: 'job_not_found' });
  const subs = submissions.listForJob(req.params.jobUuid).map(forwarder.buildResponseFromSubmission);
  res.json({ job: { jobId: job.job_uuid, kind: job.kind, status: job.status, okCount: job.ok_count, failedCount: job.failed_count, targetCount: job.target_count, createdAt: job.created_at, completedAt: job.completed_at, label: job.label }, submissions: subs });
});

// ── GET /push/submissions/:uuid ─────────────────────────────────────────────
router.get('/submissions/:uuid', bearerAuth, (req, res) => {
  const submission = submissions.getByUuid(req.params.uuid);
  if (!submission) return res.status(404).json({ error: 'submission_not_found' });
  if (submission.caller && submission.caller !== req.caller) return res.status(404).json({ error: 'submission_not_found' });
  const envelope = forwarder.buildResponseFromSubmission(submission);
  envelope.audit = audit.listForSubmission(submission.submission_uuid);
  envelope.createdAt = submission.created_at;
  envelope.updatedAt = submission.updated_at;
  envelope.sourceHash = submission.source_hash;
  envelope.payloadOrigin = submission.payload_origin || 'built';
  envelope.reconciliation = reconciliation.listForSubmission(submission.submission_uuid).map((c) => ({
    checkId: c.check_uuid, attempt: c.attempt_index, status: c.status,
    scheduledAt: c.scheduled_at, checkedAt: c.checked_at,
    diff: c.diff_json ? JSON.parse(c.diff_json) : null, error: c.error_message || null
  }));
  res.json(envelope);
});

// ── POST /push/revert/:uuid ─────────────────────────────────────────────────
router.post('/revert/:uuid', bearerAuth, writeGate, async (req, res, next) => {
  try {
    const original = submissions.getByUuid(req.params.uuid);
    if (!original) return res.status(404).json({ error: 'submission_not_found' });
    if (original.operation !== 'patchItem') return res.status(400).json({ error: 'revert_only_supported_for_patchItem' });
    const prior = original.prior_state_json ? JSON.parse(original.prior_state_json) : null;
    const reqBody = original.request_body_json ? JSON.parse(original.request_body_json) : {};
    const changed = reqBody.changedAttrNames || [];
    if (!changed.length) return res.status(400).json({ error: 'no_changed_attributes_recorded' });

    const revertPatches = translator.buildRevertPatchOps(prior && prior.attributes ? prior.attributes : {}, changed);
    const jobUuid = newUuid();
    jobs.create({ jobUuid, kind: 'revert', caller: req.caller, asin: original.asin, itemNumber: original.item_number, marketplaceCode: original.marketplace_code, productType: original.product_type, label: `revert of ${original.submission_uuid}`, targetCount: 1 });
    jobs.update(jobUuid, { status: 'running', started_at: new Date().toISOString() });

    const policy = approvalPolicy.resolve({ scope: 'REVERT', caller: req.caller });
    const submissionUuid = newUuid();
    const approvalToken = policy.policy === 'email' ? newApprovalToken() : null;
    const initialStatus = policy.policy === 'auto' ? 'IN_PROGRESS' : 'PENDING_APPROVAL';
    const requestBody = { productType: original.product_type, patches: revertPatches, changedAttrNames: changed };
    const submission = submissions.insert({
      submissionUuid, jobUuid, caller: req.caller, scope: 'REVERT', operation: 'patchItem',
      vendorCode: original.vendor_code, sku: original.effective_sku || original.sku, parentSku: original.parent_sku,
      asin: original.asin, itemNumber: original.item_number,
      marketplaceCode: original.marketplace_code, productType: original.product_type,
      requestBody, status: initialStatus, approvalToken, revertOfUuid: original.submission_uuid
    });
    audit.record({ event: 'revert_received', submissionUuid, jobUuid, actor: req.caller, details: { revertOf: original.submission_uuid, attrs: changed, policy: policy.policy } });

    if (policy.policy === 'auto') {
      const finalRow = await forwarder.forward(submission);
      recomputeJobStatus(jobUuid);
      return res.status(202).json({ jobId: jobUuid, ...forwarder.buildResponseFromSubmission(finalRow) });
    }

    // Held for human approval — the revert is forwarded only after a reviewer
    // approves it (email link for 'email', operator console for 'manual').
    if (policy.policy === 'email') {
      const mail = await sendApprovalEmail({ submission, requestBody });
      audit.record({ event: 'approval_emailed', submissionUuid, jobUuid, actor: 'system', details: { ok: mail.ok, reason: mail.reason || null } });
    } else {
      audit.record({ event: 'awaiting_approval', submissionUuid, jobUuid, actor: 'system', details: { policy: policy.policy } });
    }
    recomputeJobStatus(jobUuid);
    res.status(202).json({ jobId: jobUuid, ...forwarder.buildResponseFromSubmission(submission) });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.pushHandlers = {
  handleTarget,
  handlePackageTarget,
  loadContentMatchAsinGate
};
