// Thin Selling Partner API client — LWA token lifecycle + per-region request
// helper. SP-API dropped the AWS SigV4 requirement in 2023, so an LWA bearer
// plus the right headers is enough for NA/EU/FE. Ported from FlyApp with no
// FlyApp-specific dependencies.
const env = require('../../config/env');
const { endpointFor } = require('./regions');
const { scrubText } = require('../../lib/safeError');

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

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
    marketplaceCode = null
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

  const res = await fetch(url, {
    method,
    headers,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
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

module.exports = { getAccessToken, getCachedTokenExpiry, clearTokenCache, request };
