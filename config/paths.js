// Filesystem layout. Everything that must survive a redeploy lives under
// DATA_DIR (a mounted volume in production, ./data locally). Code and
// node_modules are baked into the image and are ephemeral.
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// In production (container) DATA_DIR is the volume mount (e.g. /app/data).
// Locally it falls back to <project>/data so files sit beside server.js.
const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// The service's own SQLite database — separate failure domain from FlyApp.
const PUSH_DB_PATH = process.env.PUSH_DB_PATH || path.join(DATA_DIR, 'push.db');

// Append-only JSONL audit mirror (defence-in-depth for the DB audit trail).
const AUDIT_DIR = process.env.AUDIT_DIR || path.join(DATA_DIR, 'audit-log');

// On-disk cache of Amazon Product Type Definition schemas.
const SCHEMA_CACHE_DIR = process.env.SPAPI_SCHEMA_DIR || path.join(DATA_DIR, 'spapi-schema');

for (const dir of [AUDIT_DIR, SCHEMA_CACHE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  PUSH_DB_PATH,
  AUDIT_DIR,
  SCHEMA_CACHE_DIR,
  PORT_FILE: path.join(DATA_DIR, '.port'),
  ENV_FILE: path.join(DATA_DIR, '.env')
};
