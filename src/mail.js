// Minimal nodemailer wrapper (self-contained copy of FlyApp's services/mail.js).
// Defaults target Battat's internal Office 365 relay which is IP-allow-listed
// and rejects basic auth, so we only attach `auth` when SMTP_USER is set.
// sendMail() always resolves with a { ok | skipped | error } envelope.
const DEFAULT_SMTP_HOST = 'battatco-com.mail.protection.outlook.com';
const DEFAULT_SMTP_PORT = 25;
const DEFAULT_SENDER = 'python.notification@battatco.com';
const DEFAULT_SENDER_NAME = 'Amazon Push Service';

let _transport = null;
let _transportSig = '';

const getSmtpHost = () => process.env.SMTP_SERVER || process.env.SMTP_HOST || DEFAULT_SMTP_HOST;
function getSmtpPort() {
  const n = parseInt(process.env.SMTP_PORT, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SMTP_PORT;
}
const getSenderEmail = () => process.env.SMTP_FROM || process.env.EMAIL_SENDER || DEFAULT_SENDER;
const getSenderName = () => process.env.EMAIL_SENDER_NAME || DEFAULT_SENDER_NAME;

function sendingEnabled() {
  const v = String(process.env.SEND_EMAILS || '').trim().toLowerCase();
  if (!v) return true;
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

function transportSignature() {
  return [getSmtpHost(), getSmtpPort(), process.env.SMTP_SECURE || '', process.env.SMTP_USER || '', process.env.SMTP_PASS || '', process.env.SMTP_TLS_REJECT_UNAUTHORIZED || ''].join('|');
}

function getTransport() {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (err) { console.warn('[mail] nodemailer not installed:', err.message); return null; }
  const sig = transportSignature();
  if (_transport && _transportSig === sig) return _transport;
  const port = getSmtpPort();
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  const opts = {
    host: getSmtpHost(),
    port,
    secure,
    tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== '0' },
    pool: true,
    maxConnections: 3
  };
  if (process.env.SMTP_USER) opts.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' };
  _transport = nodemailer.createTransport(opts);
  _transportSig = sig;
  return _transport;
}

async function sendMail({ to, cc, bcc, subject, html, text }) {
  if (!to || (Array.isArray(to) && !to.length)) return { ok: false, skipped: true, reason: 'no_recipient' };
  if (!sendingEnabled()) return { ok: false, skipped: true, reason: 'sending_disabled' };
  const transport = getTransport();
  if (!transport) return { ok: false, skipped: true, reason: 'transport_unavailable' };
  const from = getSenderName() ? `"${getSenderName()}" <${getSenderEmail()}>` : getSenderEmail();
  try {
    const info = await transport.sendMail({ from, to, cc, bcc, subject, html, text });
    return { ok: true, messageId: info && info.messageId };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[mail] sendMail failed:', msg);
    return { ok: false, error: msg };
  }
}

module.exports = { sendMail, describeTransport() {
  return { host: getSmtpHost(), port: getSmtpPort(), sender: getSenderEmail(), auth: !!process.env.SMTP_USER, sending_enabled: sendingEnabled() };
} };
