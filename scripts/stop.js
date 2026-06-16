#!/usr/bin/env node
// Stops the service. If it is managed by PM2 (the normal deployment), PM2 owns
// the lifecycle and would instantly respawn a killed process — so we ask PM2 to
// stop it. Otherwise (local `node server.js`) we just free the configured port.
// Always exits 0 so it can be chained with `&&` even when nothing is running.
'use strict';

const { resolvePort, findPm2App, freePort, execSync } = require('./_lifecycle');

const app = findPm2App();
if (app) {
  console.log(`[stop] pm2 stop ${app.name} (id ${app.pm_id})`);
  try { execSync(`pm2 stop ${app.pm_id}`, { stdio: 'inherit' }); }
  catch (err) { console.warn('[stop] pm2 stop failed:', err.message); }
  process.exit(0);
}

freePort(resolvePort());
process.exit(0);
