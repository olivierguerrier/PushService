const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').isolate();

process.env.JWT_SECRET = 'test-secret-for-auth-must-be-32-chars-min';
process.env.LISTINGAPP_API_BASE_URL = 'http://listingapp.test';
process.env.LISTINGAPP_SERVICE_TOKEN = 'test-token';

const listingAppClient = require('../src/sot/listingAppClient');
const auth = require('../middleware/auth');

const sampleUser = { id: 7, username: 'operator', role: 'admin', is_active: true, full_name: 'Op' };

beforeEach(() => {
  auth.resetUserCache();
});

test('seedUserCache makes findActiveUserByIdCached return without calling ListingApp', async () => {
  let calls = 0;
  const orig = listingAppClient.getUser;
  listingAppClient.getUser = async () => { calls += 1; return sampleUser; };
  try {
    auth.seedUserCache(sampleUser);
    const row = await auth.findActiveUserByIdCached(sampleUser.id);
    assert.equal(row.username, 'operator');
    assert.equal(calls, 0);
  } finally {
    listingAppClient.getUser = orig;
  }
});

test('a freshly logged-in user is not booted when /auth/verify omits is_active', async () => {
  // The LA bridge's verify endpoint only returns active accounts and omits the
  // is_active flag. seedUserCache must treat that as active so the operator's
  // first authenticated request (served from the seeded cache) is not 401'd.
  const verifyUser = { id: 11, username: 'op', role: 'admin', full_name: 'Op' }; // no is_active
  auth.seedUserCache(verifyUser);

  const token = auth.signAdminJwt(verifyUser);
  const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
  let statusCode = null;
  const res = { status(code) { statusCode = code; return { json() {} }; } };

  await new Promise((resolve, reject) => {
    auth.adminAuth(req, res, (err) => (err ? reject(err) : resolve()));
  });

  assert.equal(statusCode, null, 'should not respond with an error status');
  assert.equal(req.admin.username, 'op');
});

test('findActiveUserByIdCached serves stale row immediately when cache expired', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });

  let calls = 0;
  const orig = listingAppClient.getUser;
  listingAppClient.getUser = async () => {
    calls += 1;
    if (calls === 1) return sampleUser;
    await new Promise(() => {}); // background refresh never completes
  };

  try {
    const first = await auth.findActiveUserByIdCached(sampleUser.id);
    assert.equal(first.username, 'operator');
    assert.equal(calls, 1);

    t.mock.timers.tick(31_000);

    const t0 = Date.now();
    const second = await auth.findActiveUserByIdCached(sampleUser.id);
    const elapsed = Date.now() - t0;

    assert.equal(second.username, 'operator');
    assert.ok(elapsed < 200, `expected immediate stale serve, took ${elapsed}ms`);
    assert.equal(calls, 2, 'background refresh should start without blocking caller');
  } finally {
    listingAppClient.getUser = orig;
    t.mock.timers.reset();
  }
});

test('findActiveUserByIdCached opens circuit after ListingApp failure on cold miss', async () => {
  let calls = 0;
  const orig = listingAppClient.getUser;
  listingAppClient.getUser = async () => {
    calls += 1;
    throw new Error('fetch failed');
  };
  try {
    await assert.rejects(() => auth.findActiveUserByIdCached(99));
    assert.equal(calls, 1);
    await assert.rejects(() => auth.findActiveUserByIdCached(99));
    assert.equal(calls, 1, 'circuit open — no second ListingApp call');
  } finally {
    listingAppClient.getUser = orig;
  }
});

test('adminAuth does not block a valid JWT on cold ListingApp cache', async () => {
  let calls = 0;
  const orig = listingAppClient.getUser;
  listingAppClient.getUser = async () => {
    calls += 1;
    await new Promise(() => {});
  };

  const token = auth.signAdminJwt(sampleUser);
  const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
  const res = { status() { throw new Error('status should not be called'); } };

  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        auth.adminAuth(req, res, (err) => (err ? reject(err) : resolve()));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('adminAuth blocked on ListingApp')), 50))
    ]);
    assert.equal(req.admin.username, 'operator');
    assert.equal(calls, 1);
  } finally {
    listingAppClient.getUser = orig;
  }
});
