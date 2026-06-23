// Grant a ControlTower vault provider to the Amazon Push Service app.
// Run: $env:NODE_PATH="I:\ControlTower\node_modules"; node scripts/grant-vault-provider.js openai
'use strict';

const path = require('path');

const CT_DIR = process.env.CONTROLTOWER_DIR || 'I:\\ControlTower';
const DB_PATH = process.env.CONTROLTOWER_DB || path.join(CT_DIR, 'data', 'database.db');
const APP_SHORT = process.env.APP_SHORT || 'AmazonPushService';
const PROVIDER = (process.argv[2] || 'openai').toLowerCase();

let sqlite3, secretsService;
try {
  require(path.join(CT_DIR, 'node_modules', 'dotenv')).config({ path: path.join(CT_DIR, '.env') });
  sqlite3 = require('sqlite3');
  secretsService = require(path.join(CT_DIR, 'services', 'secretsService.js'));
} catch (err) {
  console.error('FATAL:', err.message);
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

async function main() {
  await new Promise((res, rej) => db.run('PRAGMA busy_timeout = 8000', (e) => (e ? rej(e) : res())));
  secretsService.init(db);

  const app = await get('SELECT id, short_name, name FROM apps WHERE short_name = ?', [APP_SHORT]);
  if (!app) throw new Error(`App '${APP_SHORT}' not found in ControlTower`);

  const provider = await get('SELECT id, key, name FROM secret_providers WHERE key = ?', [PROVIDER]);
  if (!provider) throw new Error(`Provider '${PROVIDER}' not found`);

  const secret = await secretsService.listSecretsForProvider(provider.id).then((rows) => rows.find((r) => r.is_active));
  if (!secret) throw new Error(`No active secret for provider '${PROVIDER}'`);

  await secretsService.grantAccess({ appId: app.id, secretId: secret.id });
  console.log(`[grant] granted '${PROVIDER}' (secret id=${secret.id}) to app '${app.short_name}' (id=${app.id})`);
}

main()
  .then(() => db.close(() => process.exit(0)))
  .catch((err) => { console.error('[grant] FAILED:', err.message); db.close(() => process.exit(1)); });
