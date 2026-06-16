// Secret scrubbing for anything that might land in a log line, an audit
// record, or an HTTP error body. The LWA refresh token / client secret are
// the keys to the kingdom — they must never leak.
'use strict';

const SECRET_KEY_RE = /(token|secret|password|authorization|client_secret|refresh_token)/i;

// Patterns for Amazon-issued tokens that may appear inside free-form text.
function scrubText(text) {
  if (text == null) return text;
  let out = String(text);
  for (const envName of [
    'SP_API_LWA_CLIENT_SECRET',
    'SP_API_REFRESH_TOKEN',
    'LISTINGAPP_SERVICE_TOKEN'
  ]) {
    const v = process.env[envName];
    if (v) out = out.split(v).join(`<redacted-${envName}>`);
  }
  out = out.replace(/Atzr\|[A-Za-z0-9_\-]+/g, '<redacted-amzn-token>');
  out = out.replace(/Atza\|[A-Za-z0-9_\-]+/g, '<redacted-amzn-access-token>');
  out = out.replace(/amzn1\.oa2-cs\.v1\.[A-Za-z0-9]+/g, '<redacted-amzn-client-secret>');
  return out;
}

// Deep-scrub an object: redact values under secret-ish keys, scrub strings,
// and truncate runaway blobs so a single payload can't bloat the audit log.
function scrubObject(value, { maxStringLen = 100000 } = {}) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrubObject(v, { maxStringLen }));
  if (typeof value === 'string') {
    const s = scrubText(value);
    return s.length > maxStringLen ? `${s.slice(0, maxStringLen)}…(+${s.length - maxStringLen} chars)` : s;
  }
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
    else out[k] = scrubObject(v, { maxStringLen });
  }
  return out;
}

module.exports = { scrubText, scrubObject };
