#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { DATA_DIR } = require('../config/paths');
const { saveEnvCache } = require('../lib/vaultEnvCache');
const { applyBundle } = require('../lib/vault');

const CT_DIR = process.env.CONTROLTOWER_DIR || 'I:\\ControlTower';
const DB_PATH = process.env.CONTROLTOWER_DB || path.join(CT_DIR, 'data', 'database.db');

dotenv.config({ path: path.join(DATA_DIR, '.env') });

function loadCtSecretsService() {
  require(path.join(CT_DIR, 'node_modules', 'dotenv')).config({ path: path.join(CT_DIR, '.env') });
  const sqlite3 = require(path.join(CT_DIR, 'node_modules', 'sqlite3'));
  const secretsService = require(path.join(CT_DIR, 'services', 'secretsService.js'));
  const db = new sqlite3.Database(DB_PATH);
  secretsService.init(db);
  return { db, secretsService };
}

function providersFromEnv() {
  return String(process.env.CT_VAULT_PROVIDERS || 'amazon_sp_api,openai')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`ControlTower DB not found: ${DB_PATH}`);
    process.exit(1);
  }
  let db;
  try {
    const loaded = loadCtSecretsService();
    db = loaded.db;
    const { secretsService } = loaded;
    for (const provider of providersFromEnv()) {
      const resolved = await secretsService.resolveForCT(provider);
      if (!resolved || !resolved.value) {
        console.warn(`[seed-vault-cache] no secret for provider '${provider}'`);
        continue;
      }
      const n = applyBundle(provider, resolved.value, {});
      console.log(`[seed-vault-cache] ${provider}: ${n} field(s) from CT DB`);
    }
  } catch (err) {
    console.error('[seed-vault-cache] FAILED:', err.message);
    process.exit(1);
  } finally {
    if (db) db.close(() => {});
  }

  if (!process.env.SP_API_LWA_CLIENT_ID || !process.env.SP_API_LWA_CLIENT_SECRET) {
    console.error('[seed-vault-cache] SP-API base credentials still missing after CT DB read');
    process.exit(1);
  }
  if (!saveEnvCache()) {
    console.error('[seed-vault-cache] could not write cache file');
    process.exit(1);
  }
  console.log('[seed-vault-cache] cache ready — run npm run restart');
}

main();
