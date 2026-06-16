// Renders views/approval-email.html and sends it via the SMTP wrapper.
// Trivial {{var}} substitution with HTML-escaping; no template engine.
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { sendMail } = require('./mail');

const EMAIL_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'approval-email.html'), 'utf8');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(vars[key]));
}

function previewValue(val) {
  let s;
  try { s = JSON.stringify(val, null, 2); } catch { s = String(val); }
  if (s.length > 800) s = s.slice(0, 800) + '\n… (truncated)';
  return s;
}
function formatPatchSummary(patches) {
  if (!Array.isArray(patches) || !patches.length) return '(empty patch set)';
  return patches.map((p) => `${p.op || '?'} ${p.path || '?'}\n  ${previewValue(p.value).replace(/\n/g, '\n  ')}`).join('\n\n');
}
function formatFeedSummary(payload) {
  if (!payload) return '(empty feed)';
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    const first = messages[0] ? previewValue(messages[0]) : '(no messages)';
    return `Feed with ${messages.length} message(s). First message:\n${first}`;
  }
  return previewValue(payload);
}

async function sendApprovalEmail({ submission, requestBody }) {
  if (!env.APPROVERS.length) {
    console.warn('[approval] APPROVERS empty; approval email skipped');
    return { ok: false, skipped: true, reason: 'no_approvers' };
  }
  const base = env.PUBLIC_URL;
  const approveUrl = `${base}/approve/${encodeURIComponent(submission.approval_token)}?decision=approve`;
  const rejectUrl = `${base}/approve/${encodeURIComponent(submission.approval_token)}?decision=reject`;

  const patchSummary = submission.operation === 'submitJsonListingsFeed'
    ? formatFeedSummary(requestBody && requestBody.payload)
    : formatPatchSummary(requestBody && requestBody.patches);

  const html = render(EMAIL_TEMPLATE, {
    submissionUuid: submission.submission_uuid,
    createdAt: submission.created_at,
    caller: submission.caller,
    scope: submission.scope,
    operation: submission.operation,
    vendorCode: submission.vendor_code || '—',
    sku: submission.sku || '—',
    asin: submission.asin || '—',
    marketplaceCode: submission.marketplace_code || '—',
    productType: (requestBody && requestBody.productType) || '—',
    patchSummary,
    approveUrl,
    rejectUrl,
    ttlMinutes: String(env.APPROVAL_TTL_MIN)
  });

  const subject = `[Amazon push] ${submission.scope} approval — ${submission.asin || ''} ${submission.marketplace_code || ''}`.trim();
  return sendMail({ to: env.APPROVERS, subject, html });
}

module.exports = { sendApprovalEmail, formatPatchSummary, formatFeedSummary };
