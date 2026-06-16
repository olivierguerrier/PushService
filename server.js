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
const { PORT_FILE } = require('./config/paths');
const { scrubObject } = require('./lib/safeError');

const adminRoutes = require('./routes/admin');
const approvalRoutes = require('./routes/approval');
const pushRoutes = require('./routes/push');
const auditRoutes = require('./routes/audit');

const poller = require('./src/poller');
const reconciler = require('./src/reconciler');
const jobs = require('./src/jobs');
const audit = require('./src/audit/auditEvents');

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

async function main() {
  await env.ready.catch((err) => console.warn('[boot] vault hydration error:', err.message));

  const app = buildApp();
  const { server, port } = await listenFixed(app, env.PORT);
  writePortFile(port);
  console.log(`[boot] amazon-push-service v${env.VERSION} listening on ${port} (writes ${env.SPAPI_WRITES_ENABLED ? 'ENABLED' : 'disabled'})`);

  // Boot-time recovery for jobs left mid-flight by a crash.
  try {
    const recovered = jobs.recoverStuckJobs({ staleAfterMinutes: env.JOB_STALE_MINUTES });
    if (recovered.recovered) console.log(`[boot] recovered ${recovered.recovered}/${recovered.scanned} stuck job(s)`);
  } catch (err) { console.warn('[boot] job recovery failed:', err.message); }

  audit.record({ event: 'service_boot', actor: 'system', details: { version: env.VERSION, port, writesEnabled: env.SPAPI_WRITES_ENABLED } });

  // Async feed-status poller + over-time reconciliation poller.
  poller.start(env.POLLER_CRON);
  reconciler.start(env.RECON_CRON);

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

module.exports = { buildApp };
