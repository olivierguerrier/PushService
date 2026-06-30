'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/paths');

const CACHE_PATH = path.join(DATA_DIR, 'vault-env-cache.json');

const CACHEABLE_PREFIXES = [
  'SP_API_LWA_', 'SP_API_REFRESH_TOKEN',
  'OPENAI_', 'LISTINGAPP_'
];

function isCacheableKey(key) {
  return CACHEABLE_PREFIXES.some((p) => String(key).startsWith(p));
}

function collectCacheableEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isCacheableKey(key) || value == null || value === '') continue;
    env[key] = String(value);
  }
  return env;
}

function saveEnvCache() {
  const env = collectCacheableEnv();
  if (!env.SP_API_LWA_CLIENT_ID || !env.SP_API_LWA_CLIENT_SECRET) return false;
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ savedAt: new Date().toISOString(), env }, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('[vault] could not write env cache:', err.message);
    return false;
  }
}

function loadEnvCache({ onlyMissing = true } = {}) {
  if (!fs.existsSync(CACHE_PATH)) return { applied: 0, savedAt: null };
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch (err) {
    console.warn('[vault] could not read env cache:', err.message);
    return { applied: 0, savedAt: null };
  }
  const env = payload && payload.env;
  if (!env || typeof env !== 'object') return { applied: 0, savedAt: payload.savedAt || null };
  let applied = 0;
  for (const [key, value] of Object.entries(env)) {
    if (!isCacheableKey(key) || value == null || value === '') continue;
    if (onlyMissing && process.env[key]) continue;
    process.env[key] = String(value);
    applied += 1;
  }
  return { applied, savedAt: payload.savedAt || null };
}

module.exports = { CACHE_PATH, saveEnvCache, loadEnvCache, isCacheableKey };
