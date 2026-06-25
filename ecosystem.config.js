// pm2 process definition for the Amazon Push Service.
//
// Standalone SP-API write/audit service (`node server.js`). Segregated from
// FlyApp — shares no code, DB, or process. Currently NOT under supervision;
// bring it under pm2 with the fleet-standard guards.
//
// Mirrors I:\FlyApp\ecosystem.config.js.
//
// Apply from this directory (first start, then persist):
//   pm2 start ecosystem.config.js --update-env && pm2 save
//   # if a stray instance is already running outside pm2, stop it first:
//   #   npm run stop   (uses scripts/stop.js)

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'amazon-push-service',
      script: path.join(__dirname, 'server.js'),
      cwd: __dirname,
      interpreter: 'C:\\Program Files\\nodejs\\node.exe',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '30s',
      max_restarts: 10,
      // restart_delay MUST exceed kill_timeout so a dying fork frees its port
      // and DB handle before the next starts.
      kill_timeout: 8000,
      restart_delay: 12000,
      windowsHide: true
    }
  ]
};
