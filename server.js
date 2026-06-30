// amazon-push-service entry point.
//
// Boot order matters: config/env hydrates secrets (incl. the ControlTower
// vault) — we await env.ready before binding the port so the first request
// never races an unhydrated credential.
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const { vault } = require('./lib/vault');
const { PORT_FILE, PUSH_DB_PATH } = require('./config/paths');
const { scrubObject } = require('./lib/safeError');
const { getDb } = require('./src/db');

const adminRoutes = require('./routes/admin');
const approvalRoutes = require('./routes/approval');
const pushRoutes = require('./routes/push');
const auditRoutes = require('./routes/audit');

const poller = require('./src/poller');
const reconciler = require('./src/reconciler');
const jobs = require('./src/jobs');
const jobRecovery = require('./src/jobRecovery');
const jobFanOutResume = require('./src/jobFanOutResume');
const audit = require('./src/audit/auditEvents');
const { loadEnvCache } = require('./lib/vaultEnvCache');

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));

  const allow = env.CORS_ORIGINS;
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin / curl
      if (!allow.length) return cb(null, false);
      return cb(null, allow.includes(origin));
    },
    credentials: true
  }));

  app.use(express.json({ limit: '10mb' }));

  // Global rate limit (generous) + a stricter limiter for write submission.
  app.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });

  app.use((req, res, next) => {
    if (!req.path.startsWith('/admin/')) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (req.path === '/admin/metrics' || ms > 1000) {
        console.log(`[admin] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
      }
    });
    next();
  });

  // Public + operator endpoints.
  app.use('/', adminRoutes);
  app.use('/approve', approvalRoutes);

  // Authenticated surfaces.
  app.use('/push', writeLimiter, pushRoutes);
  app.use('/audit', auditRoutes);

  // Static UI (operator console).
  app.use(express.static(path.join(__dirname, 'public')));

  // 404 + error handler (scrubbed).
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err.message);
    res.status(status).json(scrubObject({ error: err.message || 'internal_error', details: err.details || undefined }));
  });

  return app;
}

function writePortFile(port) {
  try { fs.writeFileSync(PORT_FILE, String(port), 'utf8'); }
  catch (err) { console.warn('[boot] could not write .port:', err.message); }
}

// Bind only to the configured port. Never fall back to another port — if it is
// taken we fail loudly so the operator can free it rather than silently moving.
async function listenFixed(app, port) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use — refusing to start on any other port`));
      else reject(e);
    });
    server.listen(port, () => resolve());
  });
  return { server, port };
}

// True when the ControlTower vault is the configured source of secrets:
// providers are listed AND the SDK has its CT credentials. In that posture the
// base SP-API LWA app is expected to arrive from the vault, not from inline env.
function vaultIsCredentialSource() {
  const providers = String(process.env.CT_VAULT_PROVIDERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return providers.length > 0 && vault.isConfigured();
}

// Guard against unit-test fixtures (caller='test') leaking into a real DB. Their
// presence means a test or script ran against the live push.db, which can leave
// permanently stuck rows (e.g. a feed submission polled forever). Refuse to
// start so the contamination is noticed and cleaned rather than served. Bypass
// with ALLOW_TEST_ROWS=true; always skipped under NODE_ENV=test.
function assertNoTestData() {
  if (process.env.NODE_ENV === 'test' || env.ALLOW_TEST_ROWS) return;
  let row;
  try {
    row = getDb().prepare("SELECT COUNT(*) AS n FROM push_submissions WHERE caller = 'test'").get();
  } catch (err) {
    console.warn('[boot] could not check for test data:', err.message);
    return;
  }
  const n = row ? row.n : 0;
  if (n > 0) {
    const samples = getDb()
      .prepare("SELECT submission_uuid FROM push_submissions WHERE caller = 'test' ORDER BY id ASC LIMIT 5")
      .all().map((r) => r.submission_uuid);
    console.error(`[boot] fatal: found ${n} caller='test' submission(s) in ${PUSH_DB_PATH} — unit-test fixtures or a script ran against a real database. Samples: ${samples.join(', ')}. Refusing to start. Remove them or set ALLOW_TEST_ROWS=true to override.`);
    try {
      audit.record({ event: 'service_boot_aborted', actor: 'system', details: { reason: 'test_fixtures_in_database', count: n, samples } });
    } catch (_) { /* audit best-effort */ }
    process.exit(1);
  }
}

// Recomputing thousands of parent job rollups at boot blocks HTTP for minutes.
const OPEN_JOB_RECOMPUTE_BOOT_MAX = 200;

async function runBootRecovery() {
  try {
    const resumed = await jobRecovery.resumeInterruptedForwardsAsync({ batchSize: 10 });
    if (resumed.resumed) console.log(`[boot] resumed ${resumed.resumed}/${resumed.scanned} interrupted submission(s)`);
  } catch (err) { console.warn('[boot] submission resume failed:', err.message); }
  try {
    const fanout = await jobFanOutResume.resumeIncompleteFanOuts();
    if (fanout.resumed) console.log(`[boot] resumed fan-out on ${fanout.resumed} job(s), ${fanout.processedTargets} target(s)`);
  } catch (err) { console.warn('[boot] fan-out resume failed:', err.message); }
  try {
    const stuckCount = getDb().prepare(`
      SELECT COUNT(*) AS n FROM push_jobs
      WHERE status IN ('pending', 'running')
        AND COALESCE(started_at, created_at) < datetime('now', '-' || ? || ' minutes')
    `).get(env.JOB_STALE_MINUTES).n;
    if (stuckCount > OPEN_JOB_RECOMPUTE_BOOT_MAX) {
      console.warn(`[boot] deferring stuck-job recovery for ${stuckCount} job(s) (> ${OPEN_JOB_RECOMPUTE_BOOT_MAX})`);
      void jobs.recoverStuckJobsAsync({ staleAfterMinutes: env.JOB_STALE_MINUTES, batchSize: 10 })
        .then((recovered) => {
          if (recovered.recovered) console.log(`[boot] closed ${recovered.recovered}/${recovered.scanned} legacy incomplete job(s)`);
          if (recovered.leftOpen) console.log(`[boot] left ${recovered.leftOpen} resumable job(s) open`);
          if (recovered.recomputed) console.log(`[boot] recomputed ${recovered.recomputed} open job(s)`);
        })
        .catch((err) => console.warn('[boot] deferred job recovery failed:', err.message));
    } else {
      const recovered = await jobs.recoverStuckJobsAsync({ staleAfterMinutes: env.JOB_STALE_MINUTES, batchSize: 10 });
      if (recovered.recovered) console.log(`[boot] closed ${recovered.recovered}/${recovered.scanned} legacy incomplete job(s)`);
      if (recovered.leftOpen) console.log(`[boot] left ${recovered.leftOpen} resumable job(s) open`);
      if (recovered.recomputed) console.log(`[boot] recomputed ${recovered.recomputed} open job(s)`);
    }
  } catch (err) { console.warn('[boot] job recovery failed:', err.message); }
  try {
    const openCount = getDb().prepare(`SELECT COUNT(*) AS n FROM push_jobs WHERE status IN ('pending', 'running')`).get().n;
    if (openCount > OPEN_JOB_RECOMPUTE_BOOT_MAX) {
      console.warn(`[boot] deferring rollup refresh for ${openCount} open job(s) (> ${OPEN_JOB_RECOMPUTE_BOOT_MAX})`);
      void jobRecovery.recomputeOpenJobsAsync({ batchSize: 10 })
        .then(({ recomputed }) => {
          if (recomputed) console.log(`[boot] refreshed ${recomputed} open job rollup(s)`);
        })
        .catch((err) => console.warn('[boot] deferred job rollup refresh failed:', err.message));
    } else {
      const { recomputed } = await jobRecovery.recomputeOpenJobsAsync({ batchSize: 10 });
      if (recomputed) console.log(`[boot] refreshed ${recomputed} open job rollup(s)`);
    }
  } catch (err) { console.warn('[boot] job rollup refresh failed:', err.message); }
}

async function main() {
  loadEnvCache({ onlyMissing: true });
  await env.ready.catch((err) => console.warn('[boot] vault hydration error:', err.message));

  // Fail loudly rather than serving half-credentialed. When the vault is the
  // configured credential source but the base LWA app didn't hydrate (e.g.
  // ControlTower was unreachable through the whole boot-retry window), every NA
  // marketplace write would fail with "SP_API_LWA_CLIENT_ID_xx not set". Refuse
  // to start with a silent hole — an operator restart once ControlTower recovers
  // hydrates cleanly. lib/vault already retries with backoff before we get here.
  if (vaultIsCredentialSource() && (!env.SP_API_LWA_CLIENT_ID || !env.SP_API_LWA_CLIENT_SECRET)) {
    const fromCache = loadEnvCache({ onlyMissing: false });
    if (fromCache.applied) {
      console.warn(`[boot] loaded ${fromCache.applied} SP-API credential(s) from disk cache after vault hydration failed`);
    }
  }
  if (vaultIsCredentialSource() && (!env.SP_API_LWA_CLIENT_ID || !env.SP_API_LWA_CLIENT_SECRET)) {
    console.error('[boot] fatal: SP-API base LWA credentials (SP_API_LWA_CLIENT_ID/SECRET) were not hydrated from the ControlTower vault. If the vault log shows a 429 rate limit, wait ~15 minutes without restarting (repeated restarts extend the lockout), then run `npm run restart` once. Otherwise verify ControlTower is reachable, or copy the LWA client id/secret into data/.env as a fallback.');
    try {
      audit.record({ event: 'service_boot_aborted', actor: 'system', details: { reason: 'sp_api_base_credentials_unhydrated', version: env.VERSION } });
    } catch (_) { /* audit best-effort */ }
    process.exit(1);
  }

  assertNoTestData();

  const app = buildApp();
  const { server, port } = await listenFixed(app, env.PORT);
  writePortFile(port);
  console.log(`[boot] amazon-push-service v${env.VERSION} listening on ${port} (writes ${env.SPAPI_WRITES_ENABLED ? 'ENABLED' : 'disabled'})`);

  audit.record({ event: 'service_boot', actor: 'system', details: { version: env.VERSION, port, writesEnabled: env.SPAPI_WRITES_ENABLED } });

  // Start schedulers before recovery — replaying a large interrupted backlog must
  // not block feed polling or reconciliation for the rest of the process lifetime.
  poller.start(env.POLLER_CRON);
  reconciler.start(env.RECON_CRON);
  poller.runOnce().catch((err) => console.warn('[boot] initial feed poll failed:', err.message));

  void runBootRecovery();

  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal} — closing`);
    poller.stop();
    reconciler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => { console.error('[boot] fatal:', err); process.exit(1); });
}

module.exports = { buildApp, assertNoTestData };
