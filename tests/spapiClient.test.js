const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

process.env.SP_API_LWA_CLIENT_ID = 'na-client';
process.env.SP_API_LWA_CLIENT_SECRET = 'na-secret';
process.env.SP_API_REFRESH_TOKEN = 'na-refresh';
process.env.SP_API_LWA_CLIENT_ID_EU = 'eu-client';
process.env.SP_API_LWA_CLIENT_SECRET_EU = 'eu-secret';
process.env.SP_API_REFRESH_TOKEN_EU = 'eu-refresh';
process.env.SP_API_REFRESH_TOKEN_DE = 'de-refresh';
process.env.SP_API_REFRESH_TOKEN_FR = 'fr-refresh';

const client = require('../src/spapi/client');

test('SP-API LWA tokens are selected and cached per region', async () => {
  const exchanges = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    const params = new URLSearchParams(opts.body);
    const body = Object.fromEntries(params.entries());
    exchanges.push(body);
    return {
      ok: true,
      text: async () => JSON.stringify({
        access_token: `token-for-${body.client_id}`,
        expires_in: 3600
      })
    };
  };

  try {
    client.clearTokenCache();
    assert.equal(await client.getAccessToken('NA'), 'token-for-na-client');
    assert.equal(await client.getAccessToken('EU'), 'token-for-eu-client');
    assert.equal(await client.getAccessToken('EU'), 'token-for-eu-client');

    assert.equal(exchanges.length, 2);
    assert.equal(exchanges[0].client_id, 'na-client');
    assert.equal(exchanges[0].refresh_token, 'na-refresh');
    assert.equal(exchanges[1].client_id, 'eu-client');
    assert.equal(exchanges[1].refresh_token, 'eu-refresh');
    assert.ok(client.getCachedTokenExpiry('NA'));
    assert.ok(client.getCachedTokenExpiry('EU'));
  } finally {
    global.fetch = originalFetch;
    client.clearTokenCache();
  }
});

test('SP-API LWA tokens are selected and cached per marketplace', async () => {
  const exchanges = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    const params = new URLSearchParams(opts.body);
    const body = Object.fromEntries(params.entries());
    exchanges.push(body);
    return {
      ok: true,
      text: async () => JSON.stringify({
        access_token: `token-for-${body.refresh_token}`,
        expires_in: 3600
      })
    };
  };

  try {
    client.clearTokenCache();
    assert.equal(await client.getAccessToken('EU', 'DE'), 'token-for-de-refresh');
    assert.equal(await client.getAccessToken('EU', 'FR'), 'token-for-fr-refresh');
    assert.equal(await client.getAccessToken('EU', 'DE'), 'token-for-de-refresh');

    assert.equal(exchanges.length, 2);
    assert.equal(exchanges[0].client_id, 'eu-client');
    assert.equal(exchanges[0].refresh_token, 'de-refresh');
    assert.equal(exchanges[1].client_id, 'eu-client');
    assert.equal(exchanges[1].refresh_token, 'fr-refresh');
    assert.ok(client.getCachedTokenExpiry('EU', 'DE'));
    assert.ok(client.getCachedTokenExpiry('EU', 'FR'));
  } finally {
    global.fetch = originalFetch;
    client.clearTokenCache();
  }
});

test('partial region-specific credentials do not mix with global credentials', async () => {
  const oldRefresh = process.env.SP_API_REFRESH_TOKEN_EU;
  delete process.env.SP_API_REFRESH_TOKEN_EU;
  client.clearTokenCache('EU');

  try {
    await assert.rejects(
      () => client.getAccessToken('EU'),
      /SP_API_REFRESH_TOKEN_EU not set for SP-API region EU/
    );
  } finally {
    process.env.SP_API_REFRESH_TOKEN_EU = oldRefresh;
    client.clearTokenCache('EU');
  }
});
