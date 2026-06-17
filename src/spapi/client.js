// Thin Selling Partner API client — LWA token lifecycle + per-region request
// helper. SP-API dropped the AWS SigV4 requirement in 2023, so an LWA bearer
// plus the right headers is enough for NA/EU/FE. Ported from FlyApp with no
// FlyApp-specific dependencies.
const env = require('../../config/env');
const { endpointFor } = require('./regions');
const { scrubText } = require('../../lib/safeError');
const rateLimiter = require('./rateLimiter');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read a response header defensively — real fetch Responses expose headers.get,
// but lightweight test doubles may not carry headers at all.
function header(res, name) {
  if (res && res.headers && typeof res.headers.get === 'function') return res.headers.get(name);
  return null;
}

// `Retry-After` is either delta-seconds or an HTTP-date. Return milliseconds to
// wait, or null when there is no usable value.
function retryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// Bucket key for the load-balancing throttle. Callers that know their Amazon
// operation pass an explicit `rateLimitKey` (so every patchListingsItem call
// shares one bucket regardless of seller/sku in the path); otherwise we fall
// back to method + path, which simply over-segregates and is still safe.
function rateLimitKeyFor(region, method, path, explicit) {
  const op = explicit || `${method} ${path.split('?')[0]}`;
  return `${region}:${op}`;
}

const cachedTokens = new Map(); // credential source -> { token, expiresAt }

function credentialsForRegion(region, marketplaceCode = null) {
  const r = String(region || 'NA').toUpperCase();
  const creds = marketplaceCode
    ? env.spApiCredentialsForMarketplace(marketplaceCode, r)
    : env.spApiCredentialsForRegion(r);
  if (creds.missing.length) {
    const scope = marketplaceCode ? `marketplace ${String(marketplaceCode).toUpperCase()} (${r})` : `region ${r}`;
    throw new Error(`${creds.missing.join(', ')} not set for SP-API ${scope}`);
  }
  return {
    region: r,
    source: creds.source || r,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken
  };
}

async function getAccessToken(region = 'NA', marketplaceCode = null) {
  const creds = credentialsForRegion(region, marketplaceCode);
  const cacheKey = `${creds.region}:${creds.source}`;
  const cachedToken = cachedTokens.get(cacheKey);
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret
  }).toString();

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SP-API LWA token exchange failed (${res.status}): ${scrubText(text).slice(0, 400)}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`SP-API LWA token response was not JSON: ${scrubText(text).slice(0, 240)}`); }
  if (!parsed.access_token) {
    throw new Error(`SP-API LWA response missing access_token: ${scrubText(text).slice(0, 240)}`);
  }
  const expiresInMs = Number(parsed.expires_in || 3600) * 1000;
  const nextToken = { token: parsed.access_token, expiresAt: Date.now() + expiresInMs };
  cachedTokens.set(cacheKey, nextToken);
  return nextToken.token;
}

function getCachedTokenExpiry(region = 'NA', marketplaceCode = null) {
  const r = String(region || 'NA').toUpperCase();
  const source = marketplaceCode
    ? String(marketplaceCode).toUpperCase()
    : (env.spApiCredentialsForRegion(r).source || r);
  const cachedToken = cachedTokens.get(`${r}:${source}`);
  return cachedToken ? cachedToken.expiresAt : null;
}

function clearTokenCache(region = null, marketplaceCode = null) {
  if (!region) {
    cachedTokens.clear();
    return;
  }
  const r = String(region).toUpperCase();
  if (marketplaceCode) {
    cachedTokens.delete(`${r}:${String(marketplaceCode).toUpperCase()}`);
    return;
  }
  for (const key of cachedTokens.keys()) {
    if (key === r || key.startsWith(`${r}:`)) cachedTokens.delete(key);
  }
}

function buildQueryString(query) {
  if (!query) return '';
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of entries) {
    if (Array.isArray(v)) usp.append(k, v.join(','));
    else usp.append(k, String(v));
  }
  return `?${usp.toString()}`;
}

// Generic request helper. Returns parsed JSON (or string for non-JSON / 204).
// Throws on any non-2xx with the scrubbed response text attached so callers
// can persist Amazon's error envelope verbatim.
async function request(method, region, path, opts = {}) {
  const {
    body = null,
    query = null,
    accept = 'application/json',
    contentType = 'application/json',
    extraHeaders = null,
    marketplaceCode = null,
    rateLimitKey = null
  } = opts;
  const token = await getAccessToken(region, marketplaceCode);
  const base = endpointFor(region);
  const url = path.startsWith('http')
    ? path
    : `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}${buildQueryString(query)}`;

  const headers = {
    'x-amz-access-token': token,
    'User-Agent': env.SP_API_USER_AGENT,
    Accept: accept
  };
  if (body !== null) headers['Content-Type'] = contentType;
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const throttle = env.SPAPI_RATE_LIMIT_ENABLED;
  const rlKey = rateLimitKeyFor(region, method, path, rateLimitKey);
  const rlOpts = { rate: env.SPAPI_RATE_LIMIT_RATE, burst: env.SPAPI_RATE_LIMIT_BURST };
  const maxRetries = env.SPAPI_RATE_LIMIT_429_RETRY_MAX;
  const backoffs = env.SPAPI_RATE_LIMIT_429_BACKOFF_MS;

  for (let attempt = 0; ; attempt++) {
    // Pace ourselves under Amazon's rate limit before every attempt.
    if (throttle) await rateLimiter.acquire(rlKey, rlOpts);

    const res = await fetch(url, {
      method,
      headers,
      body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    });

    // Self-tune the bucket to the live allocation Amazon advertises.
    if (throttle) rateLimiter.noteLimit(rlKey, header(res, 'x-amzn-RateLimit-Limit'));

    // Throttled. Drain the bucket and wait (honouring Retry-After) before
    // retrying the SAME request in place, so a transient 429 no longer fails
    // the submission outright.
    if (res.status === 429 && attempt < maxRetries) {
      if (throttle) rateLimiter.penalize(rlKey);
      // Drain the body so the underlying socket can be reused.
      await res.text().catch(() => '');
      const waitMs = retryAfterMs(header(res, 'Retry-After'))
        ?? (backoffs[Math.min(attempt, backoffs.length - 1)] || 0);
      if (waitMs > 0) await sleep(waitMs);
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      const safe = scrubText(text);
      const err = new Error(`SP-API ${method} ${path} failed (${res.status}): ${safe.slice(0, 800)}`);
      err.status = res.status;
      err.responseText = safe;
      throw err;
    }
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { return text; }
  }
}

module.exports = { getAccessToken, getCachedTokenExpiry, clearTokenCache, request };
