// ControlTower Vault — minimal Node client SDK (self-contained copy).
//
// Exchanges CT_CLIENT_ID / CT_CLIENT_SECRET for an app token and fetches
// per-provider credential bundles, caching them in-process. Zero runtime
// dependencies beyond Node's global fetch.
//
// This is an intentionally standalone copy so the push service shares no
// code with FlyApp. Configure via .env:
//   CONTROLTOWER_URL=https://10.10.10.52:9999
//   CT_CLIENT_ID=ct-amazonpush-xxxxxxxx
//   CT_CLIENT_SECRET=...
//   CT_TLS_REJECT_UNAUTHORIZED=0   # only when ControlTower uses a self-signed TLS cert

const CT_URL = (process.env.CT_BASE_URL || process.env.CONTROLTOWER_URL || 'http://10.10.10.52:9999').replace(/\/+$/, '');
const CLIENT_ID = process.env.CT_CLIENT_ID;
const CLIENT_SECRET = process.env.CT_CLIENT_SECRET;
const APP_NAME = process.env.CT_APP_NAME || 'AmazonPushService';

const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

let _token = null;
let _tokenExpiresAt = 0;
let _tokenInflight = null;
const _secretCache = new Map();

function _tlsRejectUnauthorized() {
  const v = String(process.env.CT_TLS_REJECT_UNAUTHORIZED ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

let _fetchDispatcher;
function _fetchInit(extra = {}) {
  const init = { ...extra };
  if (CT_URL.startsWith('https://') && !_tlsRejectUnauthorized()) {
    if (!_fetchDispatcher) {
      const https = require('https');
      _fetchDispatcher = new https.Agent({ rejectUnauthorized: false });
    }
    init.agent = _fetchDispatcher;
  }
  return init;
}

function _request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? require('https') : require('http');
    const init = _fetchInit(opts);
    const headers = { ...(init.headers || {}) };
    const body = init.body;
    if (body != null && headers['Content-Length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(String(body));
    }
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers,
      agent: init.agent
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          async text() { return text; },
          async json() { return JSON.parse(text); }
        });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(String(body));
    req.end();
  });
}

function _hasCredentials() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function _missingCredsError() {
  return new Error(
    `ControlTower Vault SDK: CT_CLIENT_ID and CT_CLIENT_SECRET must be set (App: ${APP_NAME}).`
  );
}

async function _getToken() {
  const now = Date.now();
  if (_token && _tokenExpiresAt > now + TOKEN_REFRESH_LEEWAY_MS) return _token;
  if (_tokenInflight) return _tokenInflight;
  if (!_hasCredentials()) throw _missingCredsError();

  _tokenInflight = (async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });
    const res = await _request(`${CT_URL}/api/auth/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ControlTower OAuth failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    _token = json.access_token;
    _tokenExpiresAt = Date.now() + (json.expires_in * 1000);
    return _token;
  })();

  try {
    return await _tokenInflight;
  } finally {
    _tokenInflight = null;
  }
}

async function _authedFetch(path, opts = {}) {
  const token = await _getToken();
  const init = {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
  };
  let res = await _request(`${CT_URL}${path}`, init);
  if (res.status === 401) {
    _token = null;
    _tokenExpiresAt = 0;
    const fresh = await _getToken();
    init.headers.Authorization = `Bearer ${fresh}`;
    res = await _request(`${CT_URL}${path}`, init);
  }
  return res;
}

async function get(provider) {
  if (!provider) throw new Error('provider is required');
  const key = String(provider).toLowerCase();
  const now = Date.now();
  const cached = _secretCache.get(key);
  if (cached && cached.expires > now) return cached.value;

  const res = await _authedFetch(`/api/secrets/${encodeURIComponent(key)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`ControlTower Vault: ${res.status} ${body.error || res.statusText} (provider=${key})`);
  }
  const body = await res.json();
  const value = body.value;
  const ttl = (body.cached_for_sec ? body.cached_for_sec * 1000 : SECRET_CACHE_TTL_MS);
  _secretCache.set(key, { value, expires: now + ttl });
  return value;
}

function invalidate(provider) {
  if (provider) _secretCache.delete(String(provider).toLowerCase());
  else _secretCache.clear();
}

function isConfigured() {
  return _hasCredentials();
}

module.exports = { get, invalidate, isConfigured };
