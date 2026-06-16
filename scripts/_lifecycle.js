// Shared helpers for the stop/restart lifecycle scripts.
//
// The service is normally run under PM2 (which respawns it on exit), but during
// local development it may be a plain `node server.js`. These helpers let the
// npm scripts do the right thing in either case:
//   - PM2-managed  -> delegate to `pm2 stop/restart` (PM2 owns the lifecycle)
//   - standalone   -> kill whatever holds the port, then start
'use strict';

const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

let APP_NAME = 'amazon-push-service';
try { APP_NAME = require(path.join(PROJECT_ROOT, 'package.json')).name || APP_NAME; }
catch { /* fall back to default */ }

// Resolve the port the same way config/env.js does, without booting the app.
function resolvePort() {
  try {
    const dotenv = require('dotenv');
    const dataDir = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');
    dotenv.config({ path: path.join(dataDir, '.env') });
    dotenv.config();
  } catch { /* dotenv optional here — env injection still works */ }
  const n = parseInt(process.env.PORT, 10);
  return Number.isFinite(n) ? n : 7791;
}

// Returns the PM2 entry managing this project, or null. Matches on working
// directory (authoritative across machines) and falls back to app name.
function findPm2App() {
  let raw;
  try { raw = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; } // pm2 not installed or daemon not running
  let list;
  try { list = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const sameCwd = (a, b) => path.resolve(a || '').toLowerCase() === path.resolve(b || '').toLowerCase();
  return list.find((p) => {
    const cwd = p && p.pm2_env && p.pm2_env.pm_cwd;
    return sameCwd(cwd, PROJECT_ROOT) || (p && p.name === APP_NAME);
  }) || null;
}

function pidsOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === port) pids.add(m[2]);
      }
    } else {
      const out = execSync(`lsof -t -i tcp:${port} -s tcp:LISTEN`, { encoding: 'utf8' });
      for (const pid of out.split(/\s+/)) if (pid) pids.add(pid);
    }
  } catch { /* no listener — nothing to kill */ }
  return [...pids];
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Synchronous sleep (blocks the event loop — fine for a sequential CLI step).
function sleep(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// taskkill/kill return before the OS releases the listening socket, so poll
// until the port is actually free; otherwise a chained start races teardown.
function waitForPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsOnPort(port).length === 0) return true;
    sleep(150);
  }
  return pidsOnPort(port).length === 0;
}

// Kill any process holding the port and confirm it is released.
function freePort(port) {
  const pids = pidsOnPort(port);
  if (pids.length === 0) {
    console.log(`[stop] nothing listening on port ${port}`);
    return true;
  }
  for (const pid of pids) {
    if (killPid(pid)) console.log(`[stop] killed pid ${pid} on port ${port}`);
    else console.warn(`[stop] could not kill pid ${pid} (already gone?)`);
  }
  const free = waitForPortFree(port);
  console.log(free ? `[stop] port ${port} is free` : `[stop] port ${port} still in use after kill`);
  return free;
}

module.exports = {
  PROJECT_ROOT,
  APP_NAME,
  resolvePort,
  findPm2App,
  freePort,
  execSync,
};
