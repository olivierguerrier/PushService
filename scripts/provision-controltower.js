// One-off provisioning to wire this service into ControlTower (CT):
//
//   1. Load the SP-API LWA credentials into CT's encrypted vault under the
//      `amazon_sp_api` provider (only if no active secret exists yet).
//   2. Register this service as a CT app.
//   3. Issue it a machine credential (client_id + client_secret).
//   4. Grant the app read access to the SP-API secret.
//
// It uses CT's OWN modules (sqlite3, bcryptjs, services/secretsService) so the
// secret is encrypted with CT's master key and the credential hash matches the
// live CT server exactly. Run from this repo with CT's node_modules on
// NODE_PATH (PowerShell):
//
//   $env:NODE_PATH="I:\ControlTower\node_modules"
//   node scripts/provision-controltower.js
//
// Source of the SP-API values (first match wins):
//   - env: SP_API_LWA_CLIENT_ID / SP_API_LWA_CLIENT_SECRET / SP_API_REFRESH_TOKEN
//   - file: FlyApp's data/.env (SP_API_LWA_* / SP_API_REFRESH_TOKEN)
//
// Prints the issued client_id + client_secret ONCE. SP-API values are never
// printed.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CT_DIR = process.env.CONTROLTOWER_DIR || 'I:\\ControlTower';
const DB_PATH = process.env.CONTROLTOWER_DB || path.join(CT_DIR, 'data', 'database.db');
const APP_NAME = process.env.APP_NAME || 'Amazon Push Service';
const APP_SHORT = process.env.APP_SHORT || 'AmazonPushService';
const PROVIDER = (process.env.PROVIDER || 'amazon_sp_api').toLowerCase();
const FLYAPP_ENV = process.env.FLYAPP_ENV || 'I:\\FlyApp\\data\\.env';

// CT's .env must be loaded before secretsService so the vault backend picks up
// SECRET_VAULT_MASTER_KEY / SECRET_VAULT_BACKEND.
let sqlite3, bcrypt, secretsService;
try {
  require(path.join(CT_DIR, 'node_modules', 'dotenv')).config({ path: path.join(CT_DIR, '.env') });
  sqlite3 = require('sqlite3');
  bcrypt = require('bcryptjs');
  secretsService = require(path.join(CT_DIR, 'services', 'secretsService.js'));
} catch (err) {
  console.error('FATAL: could not load CT modules. Set NODE_PATH to CT node_modules, e.g.:');
  console.error('  $env:NODE_PATH="I:\\ControlTower\\node_modules"; node scripts/provision-controltower.js');
  console.error('Original error:', err.message);
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); }));

function readEnvFile(file, keys) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (keys.includes(k)) out[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function resolveSpApiCreds() {
  const fromEnv = {
    lwa_client_id: process.env.SP_API_LWA_CLIENT_ID,
    lwa_client_secret: process.env.SP_API_LWA_CLIENT_SECRET,
    refresh_token: process.env.SP_API_REFRESH_TOKEN,
  };
  if (fromEnv.lwa_client_id && fromEnv.lwa_client_secret && fromEnv.refresh_token) {
    return { source: 'env', creds: fromEnv };
  }
  const f = readEnvFile(FLYAPP_ENV, ['SP_API_LWA_CLIENT_ID', 'SP_API_LWA_CLIENT_SECRET', 'SP_API_REFRESH_TOKEN', 'SP_API_REGION', 'SP_API_MARKETPLACE_ID']);
  if (f.SP_API_LWA_CLIENT_ID && f.SP_API_LWA_CLIENT_SECRET && f.SP_API_REFRESH_TOKEN) {
    return {
      source: FLYAPP_ENV,
      creds: {
        lwa_client_id: f.SP_API_LWA_CLIENT_ID,
        lwa_client_secret: f.SP_API_LWA_CLIENT_SECRET,
        refresh_token: f.SP_API_REFRESH_TOKEN,
        region: f.SP_API_REGION || 'na',
        marketplace_id: f.SP_API_MARKETPLACE_ID || undefined,
      },
    };
  }
  return null;
}

async function main() {
  await run('PRAGMA busy_timeout = 8000');
  secretsService.init(db);

  // 1) Provider must exist.
  const provider = await get('SELECT id, key, name FROM secret_providers WHERE key = ?', [PROVIDER]);
  if (!provider) throw new Error(`Provider '${PROVIDER}' not found. Run CT seed-providers first.`);

  // 2) Ensure an active secret exists; load from FlyApp/env if missing.
  let secret = await secretsService.listSecretsForProvider(provider.id).then(rows => rows.find(r => r.is_active));
  if (!secret) {
    const resolved = resolveSpApiCreds();
    if (!resolved) {
      throw new Error(
        `No active '${PROVIDER}' secret in CT and no SP-API creds found in env or ${FLYAPP_ENV}. ` +
        `Load credentials via CT → Admin → Secrets Vault, or set SP_API_LWA_* env vars, then re-run.`
      );
    }
    const plaintext = {};
    for (const [k, v] of Object.entries(resolved.creds)) if (v) plaintext[k] = v;
    const row = await secretsService.writeSecret({ providerId: provider.id, environment: 'production', plaintext });
    secret = await secretsService.getSecretRow(row.id);
    console.log(`[provision] loaded SP-API secret into vault from ${resolved.source} (secret id=${secret.id})`);
  } else {
    console.log(`[provision] reusing existing active SP-API secret (id=${secret.id})`);
  }

  // 3) App row (create if missing).
  let app = await get('SELECT id, short_name FROM apps WHERE short_name = ? OR name = ?', [APP_SHORT, APP_NAME]);
  if (!app) {
    const ins = await run(
      `INSERT INTO apps (name, short_name, description, category, color)
       VALUES (?, ?, ?, ?, ?)`,
      [APP_NAME, APP_SHORT, 'Standalone, segregated SP-API write/push service with full audit trail', 'integration', '#FF8C42']
    );
    app = { id: ins.lastID, short_name: APP_SHORT };
    console.log(`[provision] created app '${APP_NAME}' (id=${app.id})`);
  } else {
    console.log(`[provision] app already exists '${APP_NAME}' (id=${app.id})`);
  }

  // 4) Issue a machine credential.
  const slug = String(app.short_name || APP_SHORT).toLowerCase().replace(/[^a-z0-9]/g, '');
  const clientId = `ct-${slug}-${crypto.randomBytes(6).toString('hex')}`;
  const clientSecret = crypto.randomBytes(32).toString('base64url');
  const hash = bcrypt.hashSync(clientSecret, 12);
  const credIns = await run(
    `INSERT INTO app_credentials (app_id, client_id, client_secret_hash, label, scopes)
     VALUES (?, ?, ?, ?, ?)`,
    [app.id, clientId, hash, 'amazon-push-service auto-provision', JSON.stringify(['secrets:read'])]
  );
  console.log(`[provision] issued credential id=${credIns.lastID} client_id=${clientId}`);

  // 5) Grant the secret to the app.
  await secretsService.grantAccess({ appId: app.id, secretId: secret.id });
  console.log(`[provision] granted '${PROVIDER}' (secret id=${secret.id}) to app id=${app.id}`);

  console.log('\n=== COPY THESE INTO data/.env (shown once) ===');
  console.log(`CT_BASE_URL=http://127.0.0.1:9999`);
  console.log(`CT_CLIENT_ID=${clientId}`);
  console.log(`CT_CLIENT_SECRET=${clientSecret}`);
  console.log(`CT_VAULT_PROVIDERS=${PROVIDER}`);
  console.log('==============================================\n');
  console.log('PROVISION_RESULT ' + JSON.stringify({ appId: app.id, clientId, clientSecret, provider: PROVIDER, secretId: secret.id }));
}

main()
  .then(() => db.close(() => process.exit(0)))
  .catch((err) => { console.error('[provision] FAILED:', err.message); db.close(() => process.exit(1)); });
