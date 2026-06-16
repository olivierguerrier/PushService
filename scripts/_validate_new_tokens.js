// Throwaway: validate the CA + FR refresh tokens do a clean LWA exchange with
// their intended LWA client (CA -> global/NA client from vault, FR -> EU client).
require('../config/env');

async function main() {
  await require('../config/env').ready.catch(() => {});
  const client = require('../src/spapi/client');
  const env = require('../config/env');

  for (const [region, mkt] of [['NA', 'CA'], ['EU', 'FR']]) {
    const creds = env.spApiCredentialsForMarketplace(mkt, region);
    process.stdout.write(`\n[${mkt}] region=${region} source=${creds.source} missing=[${creds.missing.join(',')}] ` +
      `clientId=${creds.clientId ? creds.clientId.slice(0, 24) + '…' : '(none)'} ` +
      `refresh=${creds.refreshToken ? creds.refreshToken.slice(0, 10) + '…' : '(none)'}\n`);
    try {
      const token = await client.getAccessToken(region, mkt);
      console.log(`[${mkt}] LWA exchange OK — access token length ${token.length}`);
    } catch (err) {
      console.log(`[${mkt}] LWA exchange FAILED — ${err.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
