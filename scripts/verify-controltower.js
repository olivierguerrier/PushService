// Verify the ControlTower wiring end-to-end:
//   1. Boot config/env -> triggers vault hydration.
//   2. Confirm SP-API credentials landed in process.env (values never printed).
//   3. Mint a real LWA access token from Amazon to prove the creds work.
'use strict';

const env = require('../config/env');

function mask(name) {
  const v = process.env[name];
  return v ? `set (len=${v.length})` : 'MISSING';
}

(async () => {
  await env.ready; // wait for vault hydration to finish

  console.log('--- after vault hydration ---');
  console.log('SP_API_LWA_CLIENT_ID    :', mask('SP_API_LWA_CLIENT_ID'));
  console.log('SP_API_LWA_CLIENT_SECRET:', mask('SP_API_LWA_CLIENT_SECRET'));
  console.log('SP_API_REFRESH_TOKEN    :', mask('SP_API_REFRESH_TOKEN'));

  if (!process.env.SP_API_LWA_CLIENT_ID || !process.env.SP_API_REFRESH_TOKEN) {
    console.error('\nFAIL: credentials were not hydrated from ControlTower.');
    process.exit(1);
  }

  const { getAccessToken, getCachedTokenExpiry } = require('../src/spapi/client');
  try {
    const token = await getAccessToken();
    console.log('\nLWA token minted        :', token ? `ok (len=${token.length})` : 'EMPTY');
    console.log('expires_at              :', new Date(getCachedTokenExpiry()).toISOString());
    console.log('\nPASS: push service fetched SP-API tokens from ControlTower and authenticated with Amazon.');
    process.exit(0);
  } catch (err) {
    console.error('\nLWA exchange failed:', err.message);
    process.exit(2);
  }
})();
