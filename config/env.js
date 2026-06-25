// Central env loader. Order matters:
//   1. Load data/.env (persistent volume) then root .env as fallback.
//   2. Kick off the ControlTower vault bootstrap (hydrates secrets).
//   3. Expose typed getters. Credential getters read process.env LIVE so a
//      vault refresh (rotation) is picked up without a restart.
'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { DATA_DIR } = require('./paths');

// data/.env wins; root .env fills gaps. `override: false` keeps anything
// already in the real environment (container injection) authoritative.
dotenv.config({ path: path.join(DATA_DIR, '.env') });
dotenv.config();

// Start vault hydration (no-op when CT_VAULT_PROVIDERS is empty).
const vaultBootstrap = require('../lib/vault');

function bool(name, def = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function int(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : def;
}
function str(name, def = '') {
  const v = process.env[name];
  return v == null || v === '' ? def : String(v);
}
function list(name) {
  return str(name).split(',').map((s) => s.trim()).filter(Boolean);
}

function spApiCredentialsForRegion(region) {
  const suffix = String(region || '').trim().toUpperCase();
  const fields = [
    ['clientId', 'SP_API_LWA_CLIENT_ID'],
    ['clientSecret', 'SP_API_LWA_CLIENT_SECRET'],
    ['refreshToken', 'SP_API_REFRESH_TOKEN']
  ];
  const regionalNames = fields.map(([, base]) => `${base}_${suffix}`);
  const hasRegionalCredential = regionalNames.some((name) => !!str(name));
  const source = hasRegionalCredential ? suffix : 'default';
  const values = {};
  const missing = [];

  for (let i = 0; i < fields.length; i++) {
    const [key, base] = fields[i];
    const name = hasRegionalCredential ? regionalNames[i] : base;
    const value = str(name);
    values[key] = value;
    if (!value) missing.push(name);
  }

  return { ...values, source, missing };
}

function spApiCredentialsForMarketplace(marketplaceCode, region) {
  const code = String(marketplaceCode || '').trim().toUpperCase();
  if (!code) return spApiCredentialsForRegion(region);

  const regionSuffix = String(region || '').trim().toUpperCase();
  const fields = [
    ['clientId', 'SP_API_LWA_CLIENT_ID'],
    ['clientSecret', 'SP_API_LWA_CLIENT_SECRET'],
    ['refreshToken', 'SP_API_REFRESH_TOKEN']
  ];
  const marketplaceNames = fields.map(([, base]) => `${base}_${code}`);
  const hasMarketplaceCredential = marketplaceNames.some((name) => !!str(name));
  if (!hasMarketplaceCredential) return spApiCredentialsForRegion(regionSuffix);

  const values = {};
  const missing = [];
  for (let i = 0; i < fields.length; i++) {
    const [key, base] = fields[i];
    const marketplaceName = marketplaceNames[i];
    const candidates = [
      marketplaceName,
      regionSuffix ? `${base}_${regionSuffix}` : null,
      base
    ].filter(Boolean);
    const chosen = candidates.find((name) => !!str(name));
    values[key] = chosen ? str(chosen) : '';
    if (!values[key]) missing.push(marketplaceName);
  }

  return { ...values, source: code, missing };
}

// Fail fast on a weak admin JWT secret — a guessable secret defeats the
// whole auth layer. Only enforced when a secret is actually configured so
// the app can still boot in a read-only/no-UI posture.
function assertJwtSecret() {
  const s = process.env.JWT_SECRET || '';
  if (!s) return;
  if (s.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
}
assertJwtSecret();

module.exports = {
  ready: vaultBootstrap.ready,

  // HTTP
  get PORT() { return int('PORT', 7791); },
  get PUBLIC_URL() { return str('PUBLIC_URL', `http://localhost:${int('PORT', 7791)}`).replace(/\/+$/, ''); },
  get CORS_ORIGINS() { return list('CORS_ORIGINS'); },

  // Auth
  get PUSH_SERVICE_TOKENS_RAW() { return str('PUSH_SERVICE_TOKENS'); },
  get JWT_SECRET() { return str('JWT_SECRET'); },
  get ADMIN_TOKEN() { return str('ADMIN_TOKEN'); },
  get LOGIN_RATE_LIMIT_WINDOW_MS() { return int('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000); },
  get LOGIN_RATE_LIMIT_MAX() { return int('LOGIN_RATE_LIMIT_MAX', 20); },

  // Write safety
  get SPAPI_WRITES_ENABLED() { return bool('SPAPI_WRITES_ENABLED', false); },
  get APPROVERS() { return list('APPROVERS'); },
  get APPROVAL_TTL_MIN() { return int('APPROVAL_TTL_MIN', 60 * 24); },

  // Transient SP-API internal-error (code 4000000) retry. Amazon documents this
  // as a generic "internal error — try again" and recommends up to two retries
  // before opening a support ticket. The forwarder re-submits the SAME patch on
  // a 4000000 result, backing off between attempts.
  get SPAPI_INTERNAL_RETRY_MAX() { return Math.max(0, int('SPAPI_INTERNAL_RETRY_MAX', 2)); },
  get SPAPI_INTERNAL_RETRY_BACKOFF_MS() {
    const nums = list('SPAPI_INTERNAL_RETRY_BACKOFF_MS')
      .map((v) => parseInt(v, 10))
      .filter((n) => Number.isFinite(n) && n >= 0);
    return nums.length ? nums : [1000, 3000];
  },

  // Outbound SP-API load balancing. A client-side token bucket (one per
  // region+operation) paces requests so we stay under Amazon's per-operation
  // rate limit instead of bursting into HTTP 429s. RATE = steady requests/sec,
  // BURST = bucket capacity. Each bucket self-tunes to the live allocation
  // Amazon advertises in the `x-amzn-RateLimit-Limit` response header, so these
  // are conservative starting points rather than hard ceilings.
  get SPAPI_RATE_LIMIT_ENABLED() { return bool('SPAPI_RATE_LIMIT_ENABLED', true); },
  get SPAPI_RATE_LIMIT_RATE() {
    const n = Number.parseFloat(process.env.SPAPI_RATE_LIMIT_RATE);
    return Number.isFinite(n) && n > 0 ? n : 5;
  },
  get SPAPI_RATE_LIMIT_BURST() { return Math.max(1, int('SPAPI_RATE_LIMIT_BURST', 10)); },
  // When Amazon still returns 429 (e.g. a shared pool drained by another
  // client), the client waits and retries the SAME request in place, honouring
  // a `Retry-After` header when present and otherwise stepping through this
  // backoff. Set MAX to 0 to disable in-client 429 retries.
  get SPAPI_RATE_LIMIT_429_RETRY_MAX() { return Math.max(0, int('SPAPI_RATE_LIMIT_429_RETRY_MAX', 3)); },
  get SPAPI_RATE_LIMIT_429_BACKOFF_MS() {
    const nums = list('SPAPI_RATE_LIMIT_429_BACKOFF_MS')
      .map((v) => parseInt(v, 10))
      .filter((n) => Number.isFinite(n) && n >= 0);
    return nums.length ? nums : [1000, 2000, 5000];
  },

  // 1P-vendor attributes that are valid on Amazon but absent from the public
  // seller LISTING product-type schema (e.g. `procurement`, which carries
  // replenishment_status). The package validator forwards these to Amazon
  // instead of dropping/rejecting them, letting Amazon be the final authority.
  // Configurable so the allow-list can be scoped or disabled without a deploy.
  get VENDOR_PASSTHROUGH_ATTRS() {
    const v = list('VENDOR_PASSTHROUGH_ATTRS');
    return v.length ? v : ['procurement'];
  },

  // SP-API (LWA) — read live so vault rotation is picked up.
  get SP_API_LWA_CLIENT_ID() { return str('SP_API_LWA_CLIENT_ID'); },
  get SP_API_LWA_CLIENT_SECRET() { return str('SP_API_LWA_CLIENT_SECRET'); },
  get SP_API_REFRESH_TOKEN() { return str('SP_API_REFRESH_TOKEN'); },
  get SP_API_LWA_CLIENT_ID_NA() { return str('SP_API_LWA_CLIENT_ID_NA'); },
  get SP_API_LWA_CLIENT_SECRET_NA() { return str('SP_API_LWA_CLIENT_SECRET_NA'); },
  get SP_API_REFRESH_TOKEN_NA() { return str('SP_API_REFRESH_TOKEN_NA'); },
  get SP_API_LWA_CLIENT_ID_EU() { return str('SP_API_LWA_CLIENT_ID_EU'); },
  get SP_API_LWA_CLIENT_SECRET_EU() { return str('SP_API_LWA_CLIENT_SECRET_EU'); },
  get SP_API_REFRESH_TOKEN_EU() { return str('SP_API_REFRESH_TOKEN_EU'); },
  get SP_API_LWA_CLIENT_ID_FE() { return str('SP_API_LWA_CLIENT_ID_FE'); },
  get SP_API_LWA_CLIENT_SECRET_FE() { return str('SP_API_LWA_CLIENT_SECRET_FE'); },
  get SP_API_REFRESH_TOKEN_FE() { return str('SP_API_REFRESH_TOKEN_FE'); },
  spApiCredentialsForRegion,
  spApiCredentialsForMarketplace,
  get SP_API_ENDPOINT_NA() { return str('SP_API_ENDPOINT_NA', 'https://sellingpartnerapi-na.amazon.com'); },
  get SP_API_ENDPOINT_EU() { return str('SP_API_ENDPOINT_EU', 'https://sellingpartnerapi-eu.amazon.com'); },
  get SP_API_ENDPOINT_FE() { return str('SP_API_ENDPOINT_FE', 'https://sellingpartnerapi-fe.amazon.com'); },
  get SP_API_USER_AGENT() { return str('SP_API_USER_AGENT', 'AmazonPushService/0.1.0 (Language=Node.js)'); },

  // Source of truth (ListingApp bridge)
  get LISTINGAPP_API_BASE_URL() { return str('LISTINGAPP_API_BASE_URL').replace(/\/+$/, ''); },
  get LISTINGAPP_SERVICE_TOKEN() { return str('LISTINGAPP_SERVICE_TOKEN'); },
  get LISTINGAPP_API_TIMEOUT_MS() { return int('LISTINGAPP_API_TIMEOUT_MS', 90000); },
  get EFFECTIVE_PRICING_SEASON_ID() { return int('EFFECTIVE_PRICING_SEASON_ID', 0) || null; },

  // Content source adapter
  get CONTENT_SOURCE() { return str('CONTENT_SOURCE', 'none').toLowerCase(); },
  get CONTENT_SOURCE_URL() { return str('CONTENT_SOURCE_URL'); },
  get CONTENT_SOURCE_TOKEN() { return str('CONTENT_SOURCE_TOKEN'); },

  // ── AI error resolver (OpenAI) ─────────────────────────────────────────────
  // Mirrors FlyApp's OpenAI setup. The resolver reviews FAILED submissions,
  // diagnoses the Amazon error, and drafts a corrected SP-API package for an
  // operator to approve. Read live so a vault rotation is picked up.
  // The feature is OFF unless an API key is present AND OPENAI_RESOLVER_ENABLED
  // is not explicitly turned off.
  get OPENAI_API_KEY() { return str('OPENAI_API_KEY'); },
  get OPENAI_MODEL() { return str('OPENAI_MODEL', 'gpt-5.4-mini'); },
  get OPENAI_RESOLVER_ENABLED() {
    // Default ON whenever a key is available inline or via ControlTower vault.
    if (!bool('OPENAI_RESOLVER_ENABLED', true)) return false;
    if (str('OPENAI_API_KEY')) return true;
    return vaultBootstrap.vault.isConfigured();
  },

  // ── Sibling-ASIN attribute repurposing ─────────────────────────────────────
  // When a push fails on required-but-missing attributes that Battat PIM cannot
  // ground, the resolver may borrow those values from OTHER accepted records of
  // the same ASIN (different vendor code / SKU / marketplace) and surface them —
  // with provenance — in the proposal for operator review (never auto-applied).
  // SIBLING_REPURPOSE_ENABLED gates the whole feature; SIBLING_REPURPOSE_USE_CATALOG
  // additionally allows a live Amazon Catalog Items lookup as a last-resort
  // fallback when no accepted sibling submission carries the attribute.
  get SIBLING_REPURPOSE_ENABLED() { return bool('SIBLING_REPURPOSE_ENABLED', true); },
  get SIBLING_REPURPOSE_USE_CATALOG() { return bool('SIBLING_REPURPOSE_USE_CATALOG', true); },

  // Automatic repurpose on push failure. When a patch/feed FAILS with
  // required-but-missing attributes, the service finds the most complete record
  // of the SAME ASIN in the SAME marketplace under another vendor code, borrows
  // its values for the missing attributes, and re-pushes the listing under the
  // failing vendor code automatically. Same-marketplace sourcing keeps language
  // and units correct. Gated by SIBLING_REPURPOSE_ENABLED and the master write
  // switch (SPAPI_WRITES_ENABLED); set false to keep repurposing review-only.
  get AUTO_REPURPOSE_ON_FAILURE() { return bool('AUTO_REPURPOSE_ON_FAILURE', true); },

  // Poller
  get POLLER_CRON() { return str('POLLER_CRON', '*/2 * * * *'); },
  get JOB_STALE_MINUTES() { return int('JOB_STALE_MINUTES', 15); },
  // A feed submission whose status read (getFeed) keeps failing can never settle
  // and would be re-polled forever. After this many consecutive poll errors the
  // poller abandons it as FAILED rather than looping indefinitely.
  get POLLER_MAX_FEED_ERRORS() { return Math.max(1, int('POLLER_MAX_FEED_ERRORS', 10)); },

  // Boot guard: refuse to start if unit-test fixtures (caller='test') are found
  // in the database, which means tests or a script ran against a real DB. Set
  // true only to deliberately bypass (e.g. a sanctioned fixture environment).
  get ALLOW_TEST_ROWS() { return bool('ALLOW_TEST_ROWS', false); },

  // Over-time reconciliation: after a write APPLIES, schedule SP-API read-backs
  // to confirm the data is still reflected live on Amazon.
  get RECON_ENABLED() { return bool('RECON_ENABLED', true); },
  get RECON_CRON() { return str('RECON_CRON', '*/15 * * * *'); },
  // Offsets after the write APPLIES at which to re-check, as a duration list
  // (e.g. '1h,24h,7d'). Parsed by config-free helper in reconciliation.js.
  get RECON_OFFSETS() { return str('RECON_OFFSETS', '1h,24h,7d'); },
  // When true, drift only records audit + UI state (no alert email). Start
  // here while the normalizing comparator is calibrated against real data.
  get RECON_ALERT_ENABLED() { return bool('RECON_ALERT_ENABLED', false); },
  get RECON_ALERT_EMAIL() { return list('RECON_ALERT_EMAIL'); },
  get RECON_MAX_ATTEMPTS() { return int('RECON_MAX_ATTEMPTS', 3); },

  // Approval policy resolver per scope. One of:
  //   auto   — forward to Amazon immediately, no human gate.
  //   email  — hold as PENDING_APPROVAL and send an approval-link email.
  //   manual — hold as PENDING_APPROVAL for in-app approval in the operator
  //            console (no email). This is the "nothing reaches Amazon until a
  //            human clicks Approve here" mode.
  approvalPolicyFor(scope) {
    const SCOPE_DEFAULTS = {
      CONTENT_MATCH: 'manual', IMAGES: 'manual', REVERT: 'manual',
      PRICING: 'manual', VCFIX: 'manual'
    };
    const norm = String(scope || '').toUpperCase();
    const envVal = process.env[`APPROVAL_${norm}`];
    if (envVal === 'auto' || envVal === 'email' || envVal === 'manual') return envVal;
    if (SCOPE_DEFAULTS[norm]) return SCOPE_DEFAULTS[norm];
    return 'manual';
  },

  VERSION: require('../package.json').version
};
