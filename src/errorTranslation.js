// Translate non-English Amazon error messages to English for the Errors tab.
// Original messages are preserved; enrichRecords adds error_message_en and
// errorDetailsEn. Uses an in-memory cache plus optional OpenAI batch calls.
'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const openaiCredentials = require('./openaiCredentials');
const { ERROR_CODES } = require('./spapi/errorCodeReference');

const ENGLISH_MARKETPLACES = new Set(['US', 'CA', 'GB', 'AU']);
const CACHE_MAX = 5000;
const BATCH_SIZE = 40;
const cache = new Map();

function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function isEnglishMarketplace(code) {
  return ENGLISH_MARKETPLACES.has(String(code || '').toUpperCase());
}

function formatErrorDetail(d) {
  if (!d) return '';
  const attrs = (d.attributeNames && d.attributeNames.length) ? ` [${d.attributeNames.join(', ')}]` : '';
  const code = d.code ? `${d.code}: ` : '';
  return `${code}${d.message || ''}${attrs}`.trim();
}

function primaryMessage(record) {
  const details = Array.isArray(record.errorDetails) ? record.errorDetails : [];
  return record.error_message || (details[0] ? formatErrorDetail(details[0]) : '');
}

function needsTranslation(marketplaceCode, text) {
  if (!text || !String(text).trim()) return false;
  return !isEnglishMarketplace(marketplaceCode);
}

function fallbackEnglish(text, details) {
  if (Array.isArray(details) && details.length) {
    const parts = details.map((d) => {
      const code = d.code ? String(d.code) : '';
      const ref = code && ERROR_CODES[code];
      if (ref) {
        const attrs = (d.attributeNames && d.attributeNames.length) ? ` [${d.attributeNames.join(', ')}]` : '';
        return `${code}: ${ref.title} — ${ref.meaning}${attrs}`;
      }
      return formatErrorDetail(d);
    }).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  const match = String(text || '').match(/^(\d{4,8}):\s*/);
  if (match && ERROR_CODES[match[1]]) {
    const ref = ERROR_CODES[match[1]];
    return `${match[1]}: ${ref.title} — ${ref.meaning}`;
  }
  return String(text || '');
}

function canUseLlm(apiKey) {
  return !!apiKey;
}

function loadOpenAI() {
  let OpenAI;
  try { OpenAI = require('openai'); }
  catch (e) { throw new Error('openai SDK not installed. Run `npm install openai`.'); }
  return OpenAI.OpenAI || OpenAI.default || OpenAI;
}

function trimCache() {
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

async function callTranslateBatch(entries, apiKey) {
  if (!entries.length || !apiKey) return {};
  const OpenAI = loadOpenAI();
  const openai = new OpenAI({ apiKey });
  const model = env.OPENAI_MODEL;
  const systemMsg = [
    'You translate Amazon Seller Central / SP-API listing error messages to English.',
    'Preserve error codes, SKU/ASIN values, attribute names, bracketed placeholders like [po], and JSON-like fragments exactly.',
    'Return JSON: { "translations": { "<id>": "<english text>", ... } }',
    'Provide one translation per input id. Do not add commentary.'
  ].join('\n');
  const payload = {
    items: entries.map((e) => ({ id: e.id, marketplace: e.marketplaceCode, text: e.text }))
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (openai.responses && typeof openai.responses.create === 'function') {
        const resp = await openai.responses.create({
          model,
          input: [{ role: 'user', content: [{ type: 'input_text', text: `${systemMsg}\n\nDATA:\n${JSON.stringify(payload)}` }] }],
          text: { format: { type: 'json_object' } }
        });
        const text = resp.output_text
          || (resp.output && resp.output[0] && resp.output[0].content && resp.output[0].content[0] && resp.output[0].content[0].text)
          || '{}';
        return JSON.parse(text);
      }
      const chat = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: `DATA:\n${JSON.stringify(payload)}` }
        ],
        response_format: { type: 'json_object' }
      });
      const txt = chat.choices && chat.choices[0] && chat.choices[0].message && chat.choices[0].message.content;
      return JSON.parse(txt || '{}');
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      if (status && ![408, 409, 425, 429, 500, 502, 503, 504].includes(status)) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1) ** 2));
    }
  }
  throw lastErr || new Error('LLM translation failed');
}

async function resolveTranslations(unique) {
  const resolved = new Map();
  const pending = [];
  const apiKey = await openaiCredentials.getApiKey();

  for (const [hash, entry] of unique) {
    if (cache.has(hash)) {
      resolved.set(hash, cache.get(hash));
      continue;
    }
    pending.push({ id: hash, text: entry.text, marketplaceCode: entry.marketplaceCode });
  }

  if (pending.length && canUseLlm(apiKey)) {
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      try {
        const out = await callTranslateBatch(chunk, apiKey);
        const translations = (out && out.translations) || {};
        for (const [id, english] of Object.entries(translations)) {
          if (english) {
            cache.set(id, String(english));
            resolved.set(id, String(english));
            trimCache();
          }
        }
      } catch (_) { /* fall back per entry below */ }
    }
  }

  for (const [hash, entry] of unique) {
    if (resolved.has(hash)) continue;
    const english = fallbackEnglish(entry.text, entry.details);
    cache.set(hash, english);
    resolved.set(hash, english);
    trimCache();
  }

  return resolved;
}

function englishForMessage(record, text, details, translations) {
  if (!text) return null;
  if (!needsTranslation(record.marketplace_code, text)) return text;
  const hash = hashText(text);
  return translations.get(hash) || fallbackEnglish(text, details);
}

async function enrichRecords(records) {
  const unique = new Map();

  for (const r of records) {
    const primary = primaryMessage(r);
    if (needsTranslation(r.marketplace_code, primary)) {
      const hash = hashText(primary);
      if (!unique.has(hash)) unique.set(hash, { text: primary, marketplaceCode: r.marketplace_code, details: r.errorDetails });
    }
    for (const d of r.errorDetails || []) {
      const line = formatErrorDetail(d);
      if (!needsTranslation(r.marketplace_code, line)) continue;
      const hash = hashText(line);
      if (!unique.has(hash)) unique.set(hash, { text: line, marketplaceCode: r.marketplace_code, details: [d] });
    }
  }

  const translations = await resolveTranslations(unique);

  for (const r of records) {
    const primary = primaryMessage(r);
    r.error_message_en = englishForMessage(r, primary, r.errorDetails, translations);
    r.errorDetailsEn = (r.errorDetails || []).map((d) => {
      const line = formatErrorDetail(d);
      return englishForMessage(r, line, [d], translations);
    });
  }

  return records;
}

function clearCache() {
  cache.clear();
}

module.exports = {
  ENGLISH_MARKETPLACES,
  isEnglishMarketplace,
  formatErrorDetail,
  primaryMessage,
  needsTranslation,
  fallbackEnglish,
  enrichRecords,
  clearCache
};
