// Approval-link landing page.
//   GET /approve/:token?decision=approve|reject[&approver=email]
//
// PUBLIC (no bearer) — the random 24-byte approval token IS the credential.
// One-time, expires after APPROVAL_TTL_MIN minutes. On approve we flip the
// submission to IN_PROGRESS and forward to Amazon in the background so the
// reviewer's click isn't blocked by the SP-API round-trip.
const fs = require('fs');
const path = require('path');
const express = require('express');
const env = require('../config/env');
const submissions = require('../src/submissions');
const approvalQueue = require('../src/approvalQueue');
const audit = require('../src/audit/auditEvents');
const { recomputeJobStatus } = require('../src/jobOrchestrator');

const router = express.Router();
const RESULT_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'approval-result.html'), 'utf8');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderResult(vars) {
  return RESULT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, k) => escapeHtml(vars[k]));
}
function sendResultPage(res, vars) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.status(vars.httpStatus || 200).send(renderResult({
    title: vars.title || 'Approval result',
    statusClass: vars.statusClass || 'ok',
    statusLabel: vars.statusLabel || 'OK',
    message: vars.message || '',
    submissionUuid: vars.submissionUuid || '',
    caller: vars.caller || '',
    scope: vars.scope || '',
    asin: vars.asin || '—',
    vendorCode: vars.vendorCode || '—',
    sku: vars.sku || '—',
    marketplaceCode: vars.marketplaceCode || '—',
    approvedBy: vars.approvedBy || '—',
    approvedAt: vars.approvedAt || '—',
    comment: vars.comment || '—'
  }));
}

function isExpired(submission) {
  if (!submission || !submission.created_at) return false;
  const created = new Date(submission.created_at + 'Z');
  return (Date.now() - created.getTime()) / 60000 > env.APPROVAL_TTL_MIN;
}

async function handleApprovalClick(req, res) {
  const token = req.params.token;
  const decision = String(req.query.decision || '').toLowerCase();
  const approver = String(req.query.approver || '').trim() || 'email-link';

  const submission = submissions.getByApprovalToken(token);
  if (!submission) {
    return sendResultPage(res, { httpStatus: 404, title: 'Approval link not found', statusClass: 'bad', statusLabel: 'Unknown', message: 'This approval link is invalid or has already been used.' });
  }
  if (submission.status !== 'PENDING_APPROVAL') {
    return sendResultPage(res, { title: 'Already decided', statusClass: 'warn', statusLabel: submission.status, message: `This submission was already ${submission.status.toLowerCase()}.`, submissionUuid: submission.submission_uuid, caller: submission.caller, scope: submission.scope, asin: submission.asin, vendorCode: submission.vendor_code, sku: submission.sku, marketplaceCode: submission.marketplace_code, comment: submission.approver_comment, approvedBy: submission.approved_by, approvedAt: submission.approved_at });
  }
  if (isExpired(submission)) {
    submissions.update(submission.submission_uuid, { status: 'EXPIRED', error_message: 'approval window elapsed' });
    audit.record({ event: 'expired', submissionUuid: submission.submission_uuid, actor: 'system', details: { ttlMin: env.APPROVAL_TTL_MIN } });
    recomputeJobStatus(submission.job_uuid);
    return sendResultPage(res, { httpStatus: 410, title: 'Approval link expired', statusClass: 'bad', statusLabel: 'Expired', message: `Links expire after ${env.APPROVAL_TTL_MIN} minutes. The write must be re-submitted.`, submissionUuid: submission.submission_uuid, caller: submission.caller, scope: submission.scope, asin: submission.asin, vendorCode: submission.vendor_code, sku: submission.sku, marketplaceCode: submission.marketplace_code, comment: submission.approver_comment });
  }
  if (decision !== 'approve' && decision !== 'reject') {
    return sendResultPage(res, { httpStatus: 400, title: 'Invalid decision', statusClass: 'bad', statusLabel: 'Bad request', message: 'The decision query parameter must be "approve" or "reject".' });
  }

  const nowIso = new Date().toISOString();
  if (decision === 'reject') {
    const rejected = submissions.update(submission.submission_uuid, { status: 'REJECTED', approved_by: approver, approved_at: nowIso });
    audit.record({ event: 'rejected', submissionUuid: submission.submission_uuid, actor: approver });
    recomputeJobStatus(submission.job_uuid);
    return sendResultPage(res, { title: 'Submission rejected', statusClass: 'warn', statusLabel: 'REJECTED', message: 'The write was rejected and will not be sent to Amazon.', submissionUuid: rejected.submission_uuid, caller: rejected.caller, scope: rejected.scope, asin: rejected.asin, vendorCode: rejected.vendor_code, sku: rejected.sku, marketplaceCode: rejected.marketplace_code, comment: rejected.approver_comment, approvedBy: approver, approvedAt: nowIso });
  }

  const approved = submissions.update(submission.submission_uuid, { status: 'IN_PROGRESS', approved_by: approver, approved_at: nowIso });
  audit.record({ event: 'approved', submissionUuid: submission.submission_uuid, actor: approver });
  approvalQueue.enqueue(approved);
  return sendResultPage(res, { title: 'Submission approved', statusClass: 'ok', statusLabel: 'APPROVED', message: 'The write is now being forwarded to Amazon. Refresh the queue to see the outcome.', submissionUuid: approved.submission_uuid, caller: approved.caller, scope: approved.scope, asin: approved.asin, vendorCode: approved.vendor_code, sku: approved.sku, marketplaceCode: approved.marketplace_code, comment: approved.approver_comment, approvedBy: approver, approvedAt: nowIso });
}

router.get('/:token', (req, res, next) => { handleApprovalClick(req, res).catch(next); });

module.exports = router;
