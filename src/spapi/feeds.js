// Feeds API wrapper — JSON_LISTINGS_FEED 3-step flow (createDocument ->
// PUT to S3 -> createFeed) plus poll/result helpers. Ported from FlyApp.
const { regionFor, amazonMarketplaceId } = require('./regions');
const client = require('./client');

const FEEDS_BASE = '/feeds/2021-06-30/feeds';
const DOCS_BASE = '/feeds/2021-06-30/documents';

async function createFeedDocument({ marketplaceCode, contentType = 'application/json' }) {
  const region = regionFor(marketplaceCode);
  return client.request('POST', region, DOCS_BASE, { body: { contentType }, contentType: 'application/json', marketplaceCode });
}

async function uploadFeedDocument({ url, body, contentType }) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Feed document upload failed (${res.status}): ${text.slice(0, 400)}`);
    err.status = res.status;
    err.responseText = text;
    throw err;
  }
  return { uploaded: true, status: res.status };
}

async function createFeed({ marketplaceCode, feedType = 'JSON_LISTINGS_FEED', feedDocumentId, options = null }) {
  const region = regionFor(marketplaceCode);
  const marketplaceId = amazonMarketplaceId(marketplaceCode);
  const body = { feedType, marketplaceIds: [marketplaceId], inputFeedDocumentId: feedDocumentId };
  if (options) body.feedOptions = options;
  return client.request('POST', region, FEEDS_BASE, { body, contentType: 'application/json', marketplaceCode });
}

async function getFeed({ feedId, marketplaceCode }) {
  const region = regionFor(marketplaceCode);
  return client.request('GET', region, `${FEEDS_BASE}/${encodeURIComponent(feedId)}`, { marketplaceCode });
}

async function getFeedDocument({ feedDocumentId, marketplaceCode }) {
  const region = regionFor(marketplaceCode);
  return client.request('GET', region, `${DOCS_BASE}/${encodeURIComponent(feedDocumentId)}`, { marketplaceCode });
}

async function downloadFeedResult({ feedDocumentId, marketplaceCode }) {
  const meta = await getFeedDocument({ feedDocumentId, marketplaceCode });
  if (!meta || !meta.url) throw new Error('Feed result document had no download URL');
  const res = await fetch(meta.url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Feed result download failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let buf = Buffer.from(await res.arrayBuffer());
  if (meta.compressionAlgorithm === 'GZIP') {
    const zlib = require('zlib');
    buf = zlib.gunzipSync(buf);
  }
  const text = buf.toString('utf8');
  try { return JSON.parse(text); }
  catch { return { rawText: text }; }
}

// One-shot: createDocument -> upload -> createFeed.
async function submitJsonListingsFeed({ marketplaceCode, payload }) {
  const doc = await createFeedDocument({ marketplaceCode, contentType: 'application/json' });
  if (!doc || !doc.feedDocumentId || !doc.url) {
    throw new Error(`createFeedDocument returned unexpected envelope: ${JSON.stringify(doc).slice(0, 240)}`);
  }
  await uploadFeedDocument({ url: doc.url, body: payload, contentType: 'application/json' });
  const created = await createFeed({ marketplaceCode, feedType: 'JSON_LISTINGS_FEED', feedDocumentId: doc.feedDocumentId });
  if (!created || !created.feedId) {
    throw new Error(`createFeed returned unexpected envelope: ${JSON.stringify(created).slice(0, 240)}`);
  }
  return { feedId: created.feedId, feedDocumentId: doc.feedDocumentId, feedType: 'JSON_LISTINGS_FEED', marketplaceCode };
}

module.exports = {
  createFeedDocument,
  uploadFeedDocument,
  createFeed,
  getFeed,
  getFeedDocument,
  downloadFeedResult,
  submitJsonListingsFeed
};
