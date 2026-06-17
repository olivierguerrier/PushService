const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

// Pace fast in tests: tiny 429 backoff, no real waiting.
process.env.SP_API_LWA_CLIENT_ID = 'na-client';
process.env.SP_API_LWA_CLIENT_SECRET = 'na-secret';
process.env.SP_API_REFRESH_TOKEN = 'na-refresh';
process.env.SPAPI_RATE_LIMIT_429_RETRY_MAX = '3';
process.env.SPAPI_RATE_LIMIT_429_BACKOFF_MS = '0';

const rateLimiter = require('../src/spapi/rateLimiter');
const client = require('../src/spapi/client');

function makeRes({ status = 200, body = '', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    text: async () => body
  };
}

// A fetch double that always satisfies the LWA token exchange and delegates
// SP-API calls to `onApi`, tracking how many SP-API attempts were made.
function mockFetch(onApi) {
  const state = { apiCalls: 0 };
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/auth/o2/token')) {
      return makeRes({ body: JSON.stringify({ access_token: 'tok', expires_in: 3600 }) });
    }
    state.apiCalls += 1;
    return onApi(state.apiCalls, url, opts);
  };
  state.restore = () => { global.fetch = original; };
  return state;
}

test('token bucket paces a burst beyond capacity', async () => {
  rateLimiter.reset();
  const key = 'NA:test';
  const opts = { rate: 100, burst: 2 };
  // First `burst` acquisitions are free; the next goes negative and must wait.
  await rateLimiter.acquire(key, opts);
  await rateLimiter.acquire(key, opts);
  const start = Date.now();
  await rateLimiter.acquire(key, opts);
  const waited = Date.now() - start;
  assert.ok(waited >= 5, `third acquire should wait for a refill (waited ${waited}ms)`);
  rateLimiter.reset();
});

test('noteLimit retunes the bucket rate; penalize empties it', () => {
  rateLimiter.reset();
  const key = 'NA:tune';
  // Prime the bucket.
  rateLimiter.acquire(key, { rate: 5, burst: 10 });
  rateLimiter.noteLimit(key, '0.5');
  assert.equal(rateLimiter.snapshot()[key].rate, 0.5);
  rateLimiter.penalize(key);
  assert.ok(rateLimiter.snapshot()[key].tokens <= 0);
  rateLimiter.reset();
});

test('a transient 429 is retried in place and then succeeds', async () => {
  client.clearTokenCache();
  rateLimiter.reset();
  const f = mockFetch((n) => {
    if (n < 3) return makeRes({ status: 429, body: 'Too many requests' });
    return makeRes({ body: JSON.stringify({ ok: true }) });
  });
  try {
    const out = await client.request('GET', 'NA', '/listings/2021-08-01/items/SELLER/SKU', { rateLimitKey: 'getListingsItem' });
    assert.deepEqual(out, { ok: true });
    assert.equal(f.apiCalls, 3, 'two 429s then a success');
  } finally {
    f.restore();
    client.clearTokenCache();
    rateLimiter.reset();
  }
});

test('a 429 that never clears throws after exhausting retries', async () => {
  client.clearTokenCache();
  rateLimiter.reset();
  const f = mockFetch(() => makeRes({ status: 429, body: 'Too many requests' }));
  try {
    await assert.rejects(
      () => client.request('PATCH', 'NA', '/listings/2021-08-01/items/SELLER/SKU', { body: {}, rateLimitKey: 'patchListingsItem' }),
      (err) => { assert.equal(err.status, 429); return true; }
    );
    // initial attempt + SPAPI_RATE_LIMIT_429_RETRY_MAX (3) retries
    assert.equal(f.apiCalls, 4, 'initial attempt + 3 retries');
  } finally {
    f.restore();
    client.clearTokenCache();
    rateLimiter.reset();
  }
});

test('Retry-After header drives the 429 wait', async () => {
  client.clearTokenCache();
  rateLimiter.reset();
  const f = mockFetch((n) => {
    if (n < 2) return makeRes({ status: 429, headers: { 'Retry-After': '0.05' } });
    return makeRes({ body: JSON.stringify({ ok: true }) });
  });
  try {
    const start = Date.now();
    const out = await client.request('GET', 'NA', '/listings/2021-08-01/items/SELLER/SKU', { rateLimitKey: 'getListingsItem' });
    const waited = Date.now() - start;
    assert.deepEqual(out, { ok: true });
    assert.ok(waited >= 40, `should honour Retry-After ~50ms (waited ${waited}ms)`);
  } finally {
    f.restore();
    client.clearTokenCache();
    rateLimiter.reset();
  }
});
