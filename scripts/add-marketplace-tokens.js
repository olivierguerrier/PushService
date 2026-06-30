// Merge per-marketplace SP-API refresh tokens into the ControlTower vault's
// `amazon_sp_api` secret bundle (so they live alongside the existing GB/DE/FR/
// IT/ES tokens instead of in this app's data/.env).
//
// For each marketplace code it reads SP_API_REFRESH_TOKEN_<CODE> (from this
// repo's data/.env or the process env) and writes it into the bundle under the
// field name refresh_token_<code> — the exact convention lib/vault.js maps back
// to SP_API_REFRESH_TOKEN_<CODE> at hydration. The full existing bundle is read,
// the new fields are merged in, a NEW active secret version is written, and every
// grant on the prior version is re-pointed at it (so consumer apps keep access).
//
// Uses CT's OWN modules so the secret is encrypted with CT's master key, exactly
// like scripts/provision-controltower.js. Run with CT node_modules on NODE_PATH:
//
//   $env:NODE_PATH="I:\ControlTower\node_modules"
//   node scripts/add-marketplace-tokens.js                 # dry-run (default)
//   node scripts/add-marketplace-tokens.js --apply         # write to the vault
//   node scripts/add-marketplace-tokens.js --codes NL,PL --apply
//
// Secret VALUES are never printed (only field names + lengths).
'use strict';

const fs = require('fs');
const path = require('path');

const CT_DIR = process.env.CONTROLTOWER_DIR || 'I:\\ControlTower';
const DB_PATH = process.env.CONTROLTOWER_DB || path.join(CT_DIR, 'data', 'database.db');
const PROVIDER = (process.env.PROVIDER || 'amazon_sp_api').toLowerCase();
const APP_ENV = process.env.APP_ENV_FILE || path.join(__dirname, '..', 'data', '.env');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || null) : null;
}
const APPLY = process.argv.includes('--apply');
const CODES = String(arg('--codes') || 'NL,PL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

let sqlite3, secretsService;
try {
  require(path.join(CT_DIR, 'node_modules', 'dotenv')).config({ path: path.join(CT_DIR, '.env') });
  sqlite3 = require(path.join(CT_DIR, 'node_modules', 'sqlite3'));
  secretsService = require(path.join(CT_DIR, 'services', 'secretsService.js'));
} catch (err) {
  console.error('FATAL: could not load CT modules. Set NODE_PATH to CT node_modules, e.g.:');
  console.error('  $env:NODE_PATH="I:\\ControlTower\\node_modules"; node scripts/add-marketplace-tokens.js');
  console.error('Original error:', err.message);
  process.exit(1);
}

// Read SP_API_REFRESH_TOKEN_<CODE> values from process.env first, then data/.env.
function readEnvFile(file, keys) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (keys.includes(k)) out[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function collectTokens() {
  const envKeys = CODES.map((c) => `SP_API_REFRESH_TOKEN_${c}`);
  const fromFile = readEnvFile(APP_ENV, envKeys);
  const tokens = {};
  for (const code of CODES) {
    const key = `SP_API_REFRESH_TOKEN_${code}`;
    const val = process.env[key] || fromFile[key] || '';
    if (val) tokens[code] = val;
  }
  return tokens;
}

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); }));

async function main() {
  await run('PRAGMA busy_timeout = 8000');
  secretsService.init(db);

  const tokens = collectTokens();
  const missing = CODES.filter((c) => !tokens[c]);
  if (missing.length) {
    throw new Error(`No SP_API_REFRESH_TOKEN_* value found for: ${missing.join(', ')} (looked in process.env and ${APP_ENV})`);
  }

  const provider = await secretsService.getProviderByKey(PROVIDER);
  if (!provider) throw new Error(`Provider '${PROVIDER}' not found in ControlTower.`);

  const active = (await secretsService.listSecretsForProvider(provider.id)).find((r) => r.is_active);
  if (!active) throw new Error(`No active '${PROVIDER}' secret in ControlTower to merge into.`);

  const current = await secretsService.readSecretMaterial(active.id);
  if (!current || typeof current !== 'object') throw new Error('Could not read current secret bundle.');

  console.log(`provider=${PROVIDER} active secret id=${active.id} env=${active.environment} label=${active.label || '(none)'}`);
  console.log('current bundle fields:', Object.keys(current).sort().join(', '));

  const merged = { ...current };
  const changes = [];
  for (const code of CODES) {
    const field = `refresh_token_${code.toLowerCase()}`;
    const newVal = tokens[code];
    const existed = merged[field] != null && String(merged[field]).length > 0;
    const changed = !existed || String(merged[field]) !== String(newVal);
    merged[field] = newVal;
    changes.push({ field, action: existed ? (changed ? 'update' : 'unchanged') : 'add', len: String(newVal).length });
  }
  console.log('planned field changes:', JSON.stringify(changes));

  if (changes.every((c) => c.action === 'unchanged')) {
    console.log('Nothing to do — all tokens already present with the same value.');
    return;
  }

  if (!APPLY) {
    console.log('\nDRY-RUN — re-run with --apply to write the new secret version to the vault.');
    return;
  }

  const grantsBefore = await secretsService.listGrantsForSecret(active.id);
  const newSecret = await secretsService.writeSecret({
    providerId: provider.id,
    environment: active.environment,
    label: active.label || null,
    plaintext: merged
  });
  console.log(`wrote new secret version id=${newSecret.id} (deactivated old id=${active.id})`);

  // writeSecret created a new row; re-point every grant from the old secret to it
  // so consumer apps (this service, FlyApp, …) keep read access.
  let regranted = 0;
  for (const g of grantsBefore) {
    await secretsService.grantAccess({ appId: g.app_id, secretId: newSecret.id });
    regranted++;
  }
  console.log(`re-granted ${regranted} app grant(s) to new secret id=${newSecret.id}: ${grantsBefore.map((g) => g.short_name || g.app_id).join(', ') || '(none)'}`);

  // Verify the new active bundle has the fields.
  const verify = await secretsService.readSecretMaterial(newSecret.id);
  const ok = CODES.every((c) => verify[`refresh_token_${c.toLowerCase()}`]);
  console.log('verify new bundle fields:', Object.keys(verify).sort().join(', '));
  console.log(ok ? 'OK: NL/PL tokens present in new vault bundle.' : 'WARNING: expected fields missing after write.');
}

main()
  .then(() => db.close(() => process.exit(0)))
  .catch((err) => { console.error('[add-marketplace-tokens] FAILED:', err.message); db.close(() => process.exit(1)); });
