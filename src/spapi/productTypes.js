// Amazon Product Type Definitions — fetcher + on-disk cache. Every Listings
// Items / feed submission must declare a productType and only attributes
// valid for it; this fetches the JSON Schema so the translator can drop
// fields the productType doesn't accept. Ported from FlyApp.
const fs = require('fs');
const path = require('path');
const { SCHEMA_CACHE_DIR } = require('../../config/paths');
const { regionFor, amazonMarketplaceId } = require('./regions');
const client = require('./client');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const memo = new Map();

function cachePathFor(productType, marketplaceId) {
  const slug = String(productType).replace(/[^A-Z0-9_]+/gi, '_');
  return path.join(SCHEMA_CACHE_DIR, `${slug}__${marketplaceId}.json`);
}

function readCache(productType, marketplaceId) {
  const file = cachePathFor(productType, marketplaceId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeCache(productType, marketplaceId, payload) {
  fs.writeFileSync(cachePathFor(productType, marketplaceId), JSON.stringify(payload), 'utf8');
}

async function fetchFreshSchema(productType, marketplaceCode) {
  const region = regionFor(marketplaceCode);
  const marketplaceId = amazonMarketplaceId(marketplaceCode);
  const meta = await client.request(
    'GET',
    region,
    `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`,
    { query: { marketplaceIds: marketplaceId, requirements: 'LISTING', locale: 'DEFAULT' }, marketplaceCode }
  );
  if (!meta || !meta.schema || !meta.schema.link || !meta.schema.link.resource) {
    throw new Error(`SP-API productType meta returned no schema link for ${productType}/${marketplaceCode}`);
  }
  const schemaRes = await fetch(meta.schema.link.resource);
  if (!schemaRes.ok) {
    throw new Error(`SP-API productType schema fetch failed (${schemaRes.status}) for ${productType}/${marketplaceCode}`);
  }
  const schema = await schemaRes.json();
  const ptv = meta.productTypeVersion;
  const productTypeVersion = (ptv && typeof ptv === 'object' && ptv.version)
    ? ptv.version
    : (typeof ptv === 'string' ? ptv : null);
  return {
    productType: meta.productType || productType,
    marketplaceId,
    marketplaceCode: String(marketplaceCode || '').toUpperCase(),
    productTypeVersion,
    schemaVersion: (meta.schema && meta.schema.checksum) || null,
    fetchedAt: new Date().toISOString(),
    schema
  };
}

async function getSchema({ productType, marketplaceCode, force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!productType) throw new Error('productType is required');
  if (!marketplaceCode) throw new Error('marketplaceCode is required');
  const code = String(marketplaceCode).toUpperCase();
  const marketplaceId = amazonMarketplaceId(code);
  const memoKey = `${productType}|${marketplaceId}`;

  if (!force) {
    if (memo.has(memoKey)) return memo.get(memoKey);
    const cached = readCache(productType, marketplaceId);
    if (cached && cached.fetchedAt) {
      const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
      if (ageMs < ttlMs) { memo.set(memoKey, cached); return cached; }
    }
  }
  const fresh = await fetchFreshSchema(productType, code);
  writeCache(productType, marketplaceId, fresh);
  memo.set(memoKey, fresh);
  return fresh;
}

function listAttributeNames(schemaPayload) {
  if (!schemaPayload || !schemaPayload.schema) return [];
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties && typeof node.properties === 'object') {
      for (const key of Object.keys(node.properties)) names.add(key);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(node[key])) for (const child of node[key]) walk(child);
    }
    if (node.items) walk(node.items);
  };
  walk(schemaPayload.schema);
  return Array.from(names).sort();
}

function hasAttribute(schemaPayload, attributeName) {
  return listAttributeNames(schemaPayload).includes(String(attributeName));
}

function invalidate({ productType, marketplaceCode }) {
  const code = String(marketplaceCode || '').toUpperCase();
  const marketplaceId = amazonMarketplaceId(code);
  memo.delete(`${productType}|${marketplaceId}`);
  const file = cachePathFor(productType, marketplaceId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { getSchema, listAttributeNames, hasAttribute, invalidate };
