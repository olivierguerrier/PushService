// Resolve the OpenAI API key from inline env or the ControlTower vault (HTTPS).
// Prefer process.env.OPENAI_API_KEY when hydrated at boot; otherwise fetch the
// `openai` provider bundle on demand so translation/resolver work without a
// plaintext key in .env.
'use strict';

const env = require('../config/env');
const { vault } = require('../lib/vault');

const DEFAULT_PROVIDER = 'openai';
const CACHE_MS = 5 * 60 * 1000;

let _cachedKey = '';
let _cachedAt = 0;
let _inflight = null;

function vaultProvider() {
  return String(process.env.CT_OPENAI_VAULT_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
}

function inlineKey() {
  return env.OPENAI_API_KEY || '';
}

function extractApiKey(bundle) {
  if (!bundle || typeof bundle !== 'object') return '';
  return String(bundle.api_key || bundle.openai_api_key || bundle.OPENAI_API_KEY || '').trim();
}

async function fetchFromVault() {
  if (!vault.isConfigured()) return '';
  const bundle = await vault.get(vaultProvider());
  return extractApiKey(bundle);
}

async function getApiKey({ forceRefresh = false } = {}) {
  const inline = inlineKey();
  if (inline) return inline;

  const now = Date.now();
  if (!forceRefresh && _cachedKey && (now - _cachedAt) < CACHE_MS) return _cachedKey;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const key = await fetchFromVault();
      if (key) {
        _cachedKey = key;
        _cachedAt = Date.now();
        process.env.OPENAI_API_KEY = key;
      }
      return key || _cachedKey || '';
    } catch (_) {
      return _cachedKey || '';
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

function clearCache() {
  _cachedKey = '';
  _cachedAt = 0;
  _inflight = null;
}

module.exports = {
  getApiKey,
  inlineKey,
  clearCache,
  vaultProvider
};
