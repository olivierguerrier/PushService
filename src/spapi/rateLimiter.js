'use strict';
// Token-bucket throttle for OUTBOUND SP-API calls — the "balance the load"
// guard that keeps us under Amazon's per-operation rate limits so we stop
// drawing HTTP 429s.
//
// SP-API meters each operation with its own token bucket: a steady refill
// `rate` (requests/second) and a `burst` capacity. We mirror that locally, one
// bucket per (region, operation) key, and pace requests so we never spend
// faster than Amazon refills. Amazon also publishes the live per-operation rate
// as the `x-amzn-RateLimit-Limit` response header, so each bucket self-tunes to
// the account's actual allocation instead of a guessed constant.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// key -> { tokens, capacity, rate, last }
const buckets = new Map();

function bucketFor(key, rate, burst) {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, capacity: burst, rate, last: Date.now() };
    buckets.set(key, b);
  }
  return b;
}

function refill(b) {
  const now = Date.now();
  const elapsedSec = (now - b.last) / 1000;
  if (elapsedSec > 0) {
    b.tokens = Math.min(b.capacity, b.tokens + elapsedSec * b.rate);
    b.last = now;
  }
}

// Reserve one token and return the milliseconds to wait before the call may go
// out. The decrement happens synchronously (even into the negative) BEFORE any
// await, which serializes concurrent callers: each later caller in the same
// tick sees a deeper deficit and waits proportionally longer, so a burst of N
// requests is smoothed out to the refill rate instead of hitting Amazon at once.
function reserve(b) {
  refill(b);
  const deficit = 1 - b.tokens;
  b.tokens -= 1;
  if (deficit <= 0) return 0;
  return Math.ceil((deficit / b.rate) * 1000);
}

// Acquire permission to make one request on `key`, blocking (async) until the
// bucket has paced us in. Safe to call concurrently.
async function acquire(key, { rate, burst } = {}) {
  const b = bucketFor(key, rate, burst);
  const waitMs = reserve(b);
  if (waitMs > 0) await sleep(waitMs);
}

// Tune a bucket's refill rate from Amazon's `x-amzn-RateLimit-Limit` header so
// pacing tracks the account's real allocation. Ignored if the header is absent
// or unparseable.
function noteLimit(key, headerValue) {
  const rate = Number.parseFloat(headerValue);
  if (!Number.isFinite(rate) || rate <= 0) return;
  const b = buckets.get(key);
  if (!b) return;
  refill(b);
  b.rate = rate;
  if (b.capacity < rate) b.capacity = rate;
}

// A 429 means we've already overspent this bucket: drop it to empty so the next
// call waits a full refill interval before trying again.
function penalize(key) {
  const b = buckets.get(key);
  if (!b) return;
  refill(b);
  if (b.tokens > 0) b.tokens = 0;
}

function reset() {
  buckets.clear();
}

function snapshot() {
  const out = {};
  for (const [key, b] of buckets) {
    out[key] = { tokens: b.tokens, rate: b.rate, capacity: b.capacity };
  }
  return out;
}

module.exports = { acquire, noteLimit, penalize, reset, snapshot };
