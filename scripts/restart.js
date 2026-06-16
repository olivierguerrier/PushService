#!/usr/bin/env node
// Restarts the service WITHOUT PM2:
//   1. If PM2 is currently managing this app, delete it from PM2 so it stops
//      owning the lifecycle (otherwise PM2 instantly respawns the process we
//      kill, and a manual `node server.js` loses the port race -> EADDRINUSE).
//   2. Kill whatever is holding the port (existing instances).
//   3. Start a fresh `node server.js` detached in the background, with output
//      going to the same log files the PM2 config used, so the terminal returns
//      and the service keeps running after this command exits.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  PROJECT_ROOT,
  resolvePort,
  findPm2App,
  freePort,
  execSync,
} = require('./_lifecycle');

// 1. Stop PM2 from managing (and respawning) this app.
const app = findPm2App();
if (app) {
  console.log(`[restart] removing ${app.name} (id ${app.pm_id}) from PM2`);
  try { execSync(`pm2 delete ${app.pm_id}`, { stdio: 'inherit' }); }
  catch (err) { console.warn('[restart] pm2 delete failed:', err.message); }
}

// 2. Kill any existing instance holding the port.
const port = resolvePort();
if (!freePort(port)) {
  console.error('[restart] could not free the port — aborting to avoid EADDRINUSE');
  process.exit(1);
}

// 3. Start a fresh server, detached, logging to data/server.log(.err).
//
// Interpreter pinning (mirrors ecosystem.config.js): this service requires
// Node 24 (NODE_MODULE_VERSION 137) for the better-sqlite3 native binding. On
// hosts where another Node version is ahead on PATH (e.g. the IDE-bundled Node
// 22), `process.execPath` would launch the server under the wrong interpreter
// and break that binding — so pin to the known Node 24 install when present.
const NODE_24_WIN = 'C:\\Program Files\\nodejs\\node.exe';
const interpreter = fs.existsSync(NODE_24_WIN) ? NODE_24_WIN : process.execPath;

const outPath = path.join(PROJECT_ROOT, 'data', 'server.log');
const errPath = path.join(PROJECT_ROOT, 'data', 'server.err.log');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const out = fs.openSync(outPath, 'a');
const err = fs.openSync(errPath, 'a');

console.log(`[restart] starting server.js (interpreter: ${interpreter})`);
const child = spawn(interpreter, [path.join(PROJECT_ROOT, 'server.js')], {
  cwd: PROJECT_ROOT,
  detached: true,
  stdio: ['ignore', out, err],
});
child.unref();

console.log(`[restart] server.js started (pid ${child.pid}) on port ${port}`);
console.log(`[restart] logs: ${outPath}`);
process.exit(0);
