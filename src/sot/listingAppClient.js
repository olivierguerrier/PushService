// HTTP client for ListingApp's /api/flyapp-bridge/* endpoints — the PIM /
// pricing source of truth. Ported (trimmed) from FlyApp's
// services/listingAppClient.js. Read-only: this service only ever GETs from
// the bridge. Auth: Bearer <LISTINGAPP_SERVICE_TOKEN> (a dedicated,
// least-privilege token issued for the push service).
const env = require('../../config/env');

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 1500, 4000];
const PAGE_SIZE = 5000;
const IDS_BATCH_SIZE = 500;
const ASIN_CACHE_TTL_MS = 5 * 60 * 1000;
const PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;
const ASIN_TOKEN_RE = /^[A-Z0-9]{10}$/;
let knownAsinsCache = null;
let productsIndexCache = null;

function isConfigured() {
  return !!(env.LISTINGAPP_API_BASE_URL && env.LISTINGAPP_SERVICE_TOKEN);
}
function unavailableReason() {
  if (!env.LISTINGAPP_API_BASE_URL) return 'LISTINGAPP_API_BASE_URL not set';
  if (!env.LISTINGAPP_SERVICE_TOKEN) return 'LISTINGAPP_SERVICE_TOKEN not set';
  return null;
}

function isTransient(err) {
  if (!err) return false;
  if (err.code === 'LA_CLIENT_TIMEOUT' || err.name === 'AbortError') return true;
  for (const layer of [err, err.cause].filter(Boolean)) {
    const msg = String(layer.message || '').toLowerCase();
    const code = String(layer.code || '');
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
      'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return true;
    if (msg === 'fetch failed' || msg.includes('terminated') || msg.includes('socket hang up')
      || msg.includes('network socket disconnected') || msg.includes('other side closed')) return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function laFetch(pathname, { method = 'GET', body, query, timeoutMs, maxAttempts } = {}) {
  if (!isConfigured()) {
    const err = new Error(`ListingApp client not configured: ${unavailableReason()}`);
    err.code = 'LA_CLIENT_UNCONFIGURED';
    throw err;
  }
  const effTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : env.LISTINGAPP_API_TIMEOUT_MS;
  const effAttempts = (Number.isInteger(maxAttempts) && maxAttempts > 0) ? maxAttempts : MAX_ATTEMPTS;

  let url = `${env.LISTINGAPP_API_BASE_URL}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      params.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const qs = params.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < effAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effTimeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${env.LISTINGAPP_SERVICE_TOKEN}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      if (!res.ok) {
        let payload = null;
        try { payload = await res.json(); } catch { /* ignore */ }
        const err = new Error(`ListingApp ${method} ${pathname} failed: HTTP ${res.status}`);
        err.status = res.status;
        err.body = payload;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`ListingApp ${method} ${pathname} timed out after ${effTimeout}ms`);
        e.code = 'LA_CLIENT_TIMEOUT';
        e.cause = err;
        lastErr = e;
      } else {
        lastErr = err;
      }
      if (attempt < effAttempts - 1 && isTransient(lastErr)) {
        await sleep(RETRY_BACKOFF_MS[attempt] || 4000);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function paginate(pathname, baseQuery = {}, { maxPages = 200, pageSize = PAGE_SIZE, timeoutMs, maxAttempts } = {}) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const envelope = await laFetch(pathname, { query: { ...baseQuery, limit: pageSize, offset }, timeoutMs, maxAttempts });
    const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
    out.push(...rows);
    if (!envelope?.truncated || rows.length < pageSize) break;
    offset += rows.length;
  }
  return out;
}

async function inBatches(values, fetcher, batchSize = IDS_BATCH_SIZE) {
  if (!values || values.length === 0) return [];
  const out = [];
  for (let i = 0; i < values.length; i += batchSize) {
    const rows = await fetcher(values.slice(i, i + batchSize));
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

// Full PIM rows (item_numbers SELECT *) for the given item numbers.
async function getPimData({ itemNumbers } = {}) {
  if (!itemNumbers || itemNumbers.length === 0) return paginate('/api/flyapp-bridge/pim-data');
  return inBatches(itemNumbers, (chunk) =>
    paginate('/api/flyapp-bridge/pim-data', { item_numbers: chunk.join(',') }));
}

// Lean crosswalk rows (item_number -> product_number, brand, upc, ...).
async function getPimItems({ limit } = {}) {
  return laFetch('/api/flyapp-bridge/pim-items', { query: { limit: limit != null ? String(limit) : null } });
}

// Seasonal pricing rows (retail_price + sell_price) for the given product ids.
async function getSeasonPricing({ productIds, timeoutMs, maxAttempts } = {}) {
  if (!productIds || productIds.length === 0) {
    return paginate('/api/flyapp-bridge/season-pricing', {}, { timeoutMs, maxAttempts });
  }
  return inBatches(productIds, (chunk) =>
    paginate('/api/flyapp-bridge/season-pricing', { product_ids: chunk.join(',') }, { timeoutMs, maxAttempts }));
}

// Products (one row per product_id) optionally scoped to a customer.
async function getProducts({ customerGroupId, customerId } = {}) {
  const query = {};
  if (customerGroupId != null) query.customer_group_id = customerGroupId;
  if (customerId != null) query.customer_id = customerId;
  return paginate('/api/flyapp-bridge/products', query);
}

function normalizeAsin(value) {
  const v = value == null ? '' : String(value).trim().toUpperCase();
  return ASIN_TOKEN_RE.test(v) ? v : null;
}

function collectAsinTokens(value, out) {
  if (value == null) return;
  for (const part of String(value).toUpperCase().split(/[^A-Z0-9]+/)) {
    const asin = normalizeAsin(part);
    if (asin) out.add(asin);
  }
}

function collectAsinsFromRows(rows = []) {
  const out = new Set();
  const crossRefKeys = ['customer_number', 'secondary_customer_number', 'cross_reference_3', 'cross_reference_4', 'cross_reference_5'];
  const visit = (value, key = '') => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, key));
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
      return;
    }
    if (/asin/i.test(key)) collectAsinTokens(value, out);
  };
  rows.forEach((row) => {
    visit(row);
    const customerText = `${row?.customer_name || ''} ${row?.customer_group_name || ''}`;
    if (/amazon/i.test(customerText)) {
      for (const key of crossRefKeys) collectAsinTokens(row[key], out);
    }
  });
  return out;
}

async function getKnownAsins({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && knownAsinsCache && knownAsinsCache.expiresAt > now) return knownAsinsCache.asins;
  const rows = await getProducts();
  const asins = collectAsinsFromRows(rows);
  knownAsinsCache = { asins, expiresAt: now + ASIN_CACHE_TTL_MS };
  return asins;
}

function clearKnownAsinsCache() {
  knownAsinsCache = null;
}

// Build (and cache) an index of every product row keyed by both product_id and
// item_number, so a single failed-submission review can resolve its product
// row with one cached full-products fetch (same pattern/TTL as getKnownAsins).
async function getProductsIndex({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && productsIndexCache && productsIndexCache.expiresAt > now) return productsIndexCache.index;
  const rows = await getProducts();
  const index = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    for (const key of ['product_id', 'productId', 'id']) {
      if (row[key] != null && String(row[key]).trim() !== '') index.set(`pid:${String(row[key]).trim()}`, row);
    }
    for (const key of ['item_number', 'itemNumber', 'product_number']) {
      if (row[key] != null && String(row[key]).trim() !== '') {
        const k = `item:${String(row[key]).trim().toUpperCase()}`;
        if (!index.has(k)) index.set(k, row);
      }
    }
  }
  productsIndexCache = { index, expiresAt: now + PRODUCTS_CACHE_TTL_MS };
  return index;
}

// Resolve a single product row by product id (preferred) or item number.
// Returns the matching row or null. Best-effort: callers treat a throw/null as
// "no product context available".
async function getProductRecord({ productId, itemNumber, refresh = false } = {}) {
  if (productId == null && (itemNumber == null || String(itemNumber).trim() === '')) return null;
  const index = await getProductsIndex({ refresh });
  if (productId != null && String(productId).trim() !== '') {
    const byId = index.get(`pid:${String(productId).trim()}`);
    if (byId) return byId;
  }
  if (itemNumber != null && String(itemNumber).trim() !== '') {
    const byItem = index.get(`item:${String(itemNumber).trim().toUpperCase()}`);
    if (byItem) return byItem;
  }
  return null;
}

function clearProductsIndexCache() {
  productsIndexCache = null;
}

async function checkHealth() {
  if (!isConfigured()) return { ok: false, configured: false, reason: unavailableReason() };
  try {
    await laFetch('/api/flyapp-bridge/health', { timeoutMs: 4000, maxAttempts: 1 });
    return { ok: true, configured: true, baseUrl: env.LISTINGAPP_API_BASE_URL };
  } catch (err) {
    return { ok: false, configured: true, reason: err && err.message ? err.message : 'fetch failed', status: err.status || null };
  }
}

// ── Auth (operator login) ───────────────────────────────────────────────────
// Verify credentials + per-id user lookup against ListingApp's users table over
// the same bridge FlyApp uses (services/auth.js). Password hashes never leave
// the LA process. Tight timeout + no/low retry so a slow LA never stalls the
// login page or an authenticated request.

// Returns the user row on success, null on HTTP 401, throws on anything else
// (config / transport / 5xx). The 401-as-null contract lets callers treat
// "null means bad credentials" without introspecting HTTP statuses.
async function verifyCredentials({ login, password } = {}) {
  try {
    const envelope = await laFetch('/api/flyapp-bridge/auth/verify', {
      method: 'POST',
      body: { login, password },
      timeoutMs: 5000,
      maxAttempts: 1
    });
    return envelope && envelope.user ? envelope.user : null;
  } catch (err) {
    if (err && err.status === 401) return null;
    throw err;
  }
}

// Returns the user row by id, or null on 404. Used by the per-request "is this
// user still active?" cache in middleware/auth.js — kept short with a light
// retry since the cache absorbs the latency for repeat calls.
async function getUser(id) {
  try {
    const envelope = await laFetch(`/api/flyapp-bridge/users/${encodeURIComponent(id)}`, {
      timeoutMs: 5000,
      maxAttempts: 2
    });
    return envelope && envelope.user ? envelope.user : null;
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

module.exports = {
  isConfigured,
  unavailableReason,
  checkHealth,
  getPimData,
  getPimItems,
  getSeasonPricing,
  getProducts,
  getKnownAsins,
  getProductsIndex,
  getProductRecord,
  normalizeAsin,
  collectAsinsFromRows,
  clearKnownAsinsCache,
  clearProductsIndexCache,
  verifyCredentials,
  getUser
};
