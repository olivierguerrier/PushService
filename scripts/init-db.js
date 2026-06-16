// Initialize / migrate push.db. Idempotent — safe to run repeatedly.
//   node scripts/init-db.js
require('../config/env');
const { PUSH_DB_PATH } = require('../config/paths');
const { getDb } = require('../src/db');

const db = getDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
console.log(`push.db ready at ${PUSH_DB_PATH}`);
console.log(`tables: ${tables.join(', ')}`);
process.exit(0);
