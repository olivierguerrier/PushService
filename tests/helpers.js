// Test bootstrap: isolate every run in its own DATA_DIR (so push.db / audit
// JSONL never touch a real volume) and disable the vault + emails.
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function isolate() {
  const dir = path.join(os.tmpdir(), `aps-test-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.DATA_DIR = dir;
  process.env.CT_VAULT_PROVIDERS = '';
  process.env.CT_VAULT_REFRESH_MIN = '0';
  process.env.SEND_EMAILS = 'false';
  return dir;
}

module.exports = { isolate };
