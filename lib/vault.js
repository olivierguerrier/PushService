// ControlTower vault bootstrap — hydrates process.env from the vault at
// boot and refreshes periodically so credential rotation propagates without
// a restart. Require this BEFORE config/env.js reads any secret.
//
// Segregation note: this service should be granted its OWN vault providers
// (e.g. `amazon_sp_api_push`, `listingapp_push`) holding least-privilege
// credentials distinct from FlyApp's. List them in CT_VAULT_PROVIDERS.
'use strict';

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const vault = require('./controltower-vault');

// Field-name -> env-var mapping. Keyed by the field name a provider bundle
// exposes, so it works regardless of the provider's name (this service uses
// dedicated provider names that still carry the conventional field names).
const FIELD_MAP = {
  lwa_client_id: { env: 'SP_API_LWA_CLIENT_ID' },
  lwa_client_secret: { env: 'SP_API_LWA_CLIENT_SECRET' },
  refresh_token: { env: 'SP_API_REFRESH_TOKEN' },
  lwa_client_id_na: { env: 'SP_API_LWA_CLIENT_ID_NA' },
  lwa_client_secret_na: { env: 'SP_API_LWA_CLIENT_SECRET_NA' },
  refresh_token_na: { env: 'SP_API_REFRESH_TOKEN_NA' },
  lwa_client_id_eu: { env: 'SP_API_LWA_CLIENT_ID_EU' },
  lwa_client_secret_eu: { env: 'SP_API_LWA_CLIENT_SECRET_EU' },
  refresh_token_eu: { env: 'SP_API_REFRESH_TOKEN_EU' },
  lwa_client_id_fe: { env: 'SP_API_LWA_CLIENT_ID_FE' },
  lwa_client_secret_fe: { env: 'SP_API_LWA_CLIENT_SECRET_FE' },
  refresh_token_fe: { env: 'SP_API_REFRESH_TOKEN_FE' },
  service_token: { env: 'LISTINGAPP_SERVICE_TOKEN' },
  api_url: { env: 'LISTINGAPP_API_BASE_URL', preserveExisting: true },
  api_base_url: { env: 'LISTINGAPP_API_BASE_URL', preserveExisting: true }
};

const SP_API_FIELDS = {
  lwa_client_id: 'SP_API_LWA_CLIENT_ID',
  lwa_client_secret: 'SP_API_LWA_CLIENT_SECRET',
  refresh_token: 'SP_API_REFRESH_TOKEN'
};

function parseProviders() {
  return String(process.env.CT_VAULT_PROVIDERS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Optional explicit override: CT_VAULT_MAPPING=provider.field=ENV_NAME,...
function parseUserMapping() {
  const out = {};
  String(process.env.CT_VAULT_MAPPING || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .forEach((pair) => {
      const [lhs, rhs] = pair.split('=').map((s) => s.trim());
      if (lhs && rhs) out[lhs.toLowerCase()] = { env: rhs };
    });
  return out;
}

function regionFromProvider(providerKey) {
  const match = String(providerKey || '').toLowerCase().match(/(?:^|[_-])(na|eu|fe)(?:$|[_-])/);
  return match ? match[1].toUpperCase() : null;
}

function mappingFor(providerKey, field, userMapping) {
  const normalizedField = String(field).toLowerCase();
  const explicit = userMapping[`${providerKey}.${field}`.toLowerCase()];
  if (explicit) return explicit;

  const marketplaceField = normalizedField.match(/^(lwa_client_id|lwa_client_secret|refresh_token)_([a-z]{2})$/);
  if (marketplaceField && SP_API_FIELDS[marketplaceField[1]]) {
    return { env: `${SP_API_FIELDS[marketplaceField[1]]}_${marketplaceField[2].toUpperCase()}` };
  }

  const region = regionFromProvider(providerKey);
  if (region && SP_API_FIELDS[normalizedField]) {
    return { env: `${SP_API_FIELDS[normalizedField]}_${region}` };
  }
  return FIELD_MAP[normalizedField];
}

function applyBundle(providerKey, bundle, userMapping) {
  let applied = 0;
  for (const [field, value] of Object.entries(bundle || {})) {
    if (value == null) continue;
    const m = mappingFor(providerKey, field, userMapping);
    if (!m) continue;
    if (m.preserveExisting && process.env[m.env]) continue;
    process.env[m.env] = String(value);
    applied++;
  }
  return applied;
}

async function hydrate({ silent = false } = {}) {
  const providers = parseProviders();
  if (!providers.length) {
    if (!silent) console.log('[vault] CT_VAULT_PROVIDERS empty — using inline env values');
    return { providers: [], applied: 0 };
  }
  if (!vault.isConfigured()) {
    if (!silent) console.warn('[vault] CT_CLIENT_ID/CT_CLIENT_SECRET not set — keeping existing process.env');
    return { providers, applied: 0, skipped: 'sdk_not_configured' };
  }
  const userMapping = parseUserMapping();
  let total = 0;
  const errors = [];
  for (const p of providers) {
    try {
      const bundle = await vault.get(p);
      const n = applyBundle(p, bundle, userMapping);
      total += n;
      if (!silent) console.log(`[vault] ${p}: ${n} field(s) injected`);
    } catch (err) {
      errors.push({ provider: p, error: err.message });
      if (!silent) console.warn(`[vault] ${p}: FAILED — ${err.message}`);
    }
  }
  return { providers, applied: total, errors };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Boot hydration retries through a transient ControlTower outage so the
// process never comes up half-credentialed. The failure mode this guards
// against: the vault is briefly unreachable at boot, every provider fetch
// throws, hydrate() resolves "successfully" with 0 fields injected, and the
// service then serves with (e.g.) the NA SP-API base creds missing — every
// NA write fails "SP_API_LWA_CLIENT_ID_xx not set". A provider error triggers
// an exponential backoff + retry until all provider fetches succeed or the
// attempt budget is exhausted (after which we return and let the caller decide
// whether to fail loudly). The periodic refresh below is unchanged.
const BOOT_RETRY_ATTEMPTS = Math.max(0, parseInt(process.env.CT_VAULT_BOOT_RETRIES || '6', 10));
const BOOT_RETRY_BASE_MS = Math.max(250, parseInt(process.env.CT_VAULT_BOOT_RETRY_BASE_MS || '2000', 10));
const BOOT_RETRY_MAX_MS = 60_000;

async function hydrateWithRetry(opts = {}) {
  const providers = parseProviders();
  // Nothing to retry when no vault is configured — defer to a single pass.
  if (!providers.length || !vault.isConfigured()) return hydrate(opts);

  let last;
  for (let attempt = 0; attempt <= BOOT_RETRY_ATTEMPTS; attempt++) {
    // Keep the first attempt's logging identical to before; quiet the noisy
    // per-provider FAILED lines on retries (we emit a clearer summary below).
    last = await hydrate({ ...opts, silent: opts.silent || attempt > 0 });
    if (!last.errors || !last.errors.length) return last;
    if (attempt < BOOT_RETRY_ATTEMPTS) {
      const delay = Math.min(BOOT_RETRY_BASE_MS * 2 ** attempt, BOOT_RETRY_MAX_MS);
      const why = last.errors.map((e) => `${e.provider}: ${e.error}`).join('; ');
      console.warn(`[vault] boot hydration failed (attempt ${attempt + 1}/${BOOT_RETRY_ATTEMPTS + 1}); retrying in ${Math.round(delay / 1000)}s — ${why}`);
      await sleep(delay);
    }
  }
  console.error(`[vault] boot hydration STILL failing after ${BOOT_RETRY_ATTEMPTS + 1} attempt(s) — proceeding with whatever is already in process.env (the periodic refresh will keep retrying)`);
  return last;
}

const _ready = hydrateWithRetry({ silent: process.env.CT_VAULT_QUIET === '1' });

const REFRESH_MIN = parseInt(process.env.CT_VAULT_REFRESH_MIN || '5', 10);
if (REFRESH_MIN > 0) {
  setInterval(() => {
    vault.invalidate();
    hydrate({ silent: true }).catch((err) => console.warn('[vault] refresh error:', err.message));
  }, REFRESH_MIN * 60 * 1000).unref();
}

module.exports = { ready: _ready, hydrate, hydrateWithRetry, vault };
