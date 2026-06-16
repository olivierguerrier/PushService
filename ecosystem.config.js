// PM2 process definition. Mirrors the FlyApp deploy pattern: a single
// long-lived Node process with its data on a mounted volume (DATA_DIR).
//
//   pm2 start ecosystem.config.js
//   pm2 logs amazon-push-service
//
// Interpreter pinning: this service requires Node 24 (NODE_MODULE_VERSION 137)
// per package.json "engines". On hosts where multiple Node versions are on
// PATH (e.g. an IDE-bundled Node ahead of the system one), pm2 could otherwise
// capture the wrong interpreter and break the better-sqlite3 native binding.
// Pin to the known Node 24 install when present; fall back to PATH `node`.
const fs = require('fs');
const NODE_24_WIN = 'C:\\Program Files\\nodejs\\node.exe';
const interpreter = fs.existsSync(NODE_24_WIN) ? NODE_24_WIN : 'node';

module.exports = {
  apps: [
    {
      name: 'amazon-push-service',
      script: 'server.js',
      interpreter,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production'
        // DATA_DIR, PORT, and all secrets come from data/.env or the
        // ControlTower vault — never hard-code them here.
      },
      out_file: 'data/server.log',
      error_file: 'data/server.err.log',
      time: true
    }
  ]
};
