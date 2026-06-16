// Pluggable content adapter for Amazon listing copy (title / description /
// bullets). ListingApp does NOT own this content (in FlyApp it lives in
// ref_content_sot), so the push service reads it through a configurable
// adapter selected by CONTENT_SOURCE:
//
//   none  — content is out of scope; the service pushes only PIM/pricing
//           derived attributes. getContent() returns null.
//   http  — GET a JSON endpoint returning { title, description, bullets[] }.
//           CONTENT_SOURCE_URL may contain {asin} / {marketplace} tokens.
//
// Returns null when no content is available so the translator simply omits
// the content fields rather than pushing blanks.
const env = require('../../config/env');

function configured() {
  if (env.CONTENT_SOURCE === 'http') return !!env.CONTENT_SOURCE_URL;
  return env.CONTENT_SOURCE === 'none';
}

function describe() {
  return { mode: env.CONTENT_SOURCE, configured: configured(), url: env.CONTENT_SOURCE === 'http' ? env.CONTENT_SOURCE_URL : null };
}

async function getContent({ asin, marketplaceCode, itemNumber }) {
  if (env.CONTENT_SOURCE !== 'http') return null;
  if (!env.CONTENT_SOURCE_URL) return null;

  const url = env.CONTENT_SOURCE_URL
    .replace('{asin}', encodeURIComponent(asin || ''))
    .replace('{marketplace}', encodeURIComponent(marketplaceCode || ''))
    .replace('{itemNumber}', encodeURIComponent(itemNumber || ''));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(env.CONTENT_SOURCE_TOKEN ? { Authorization: `Bearer ${env.CONTENT_SOURCE_TOKEN}` } : {})
      },
      signal: controller.signal
    });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`content source HTTP ${res.status}`);
    }
    const body = await res.json();
    if (!body) return null;
    return {
      title: body.title ?? null,
      description: body.description ?? null,
      bullets: Array.isArray(body.bullets) ? body.bullets : []
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { configured, describe, getContent };
