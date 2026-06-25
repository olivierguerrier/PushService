// Auth for the push service.
//   - Machine callers (FlyApp, batch jobs) present a bearer token from
//     PUSH_SERVICE_TOKENS (name:token,name:token). req.caller is set to the
//     token's name so the audit trail records WHO pushed each change.
//   - Human operators log in with their ListingApp account (verified over the
//     /api/flyapp-bridge/auth/verify bridge — same model as FlyApp). The push
//     service signs its OWN JWT with JWT_SECRET; ListingApp's own tokens are
//     not accepted, and vice-versa. Every authenticated request re-checks the
//     user is still active in ListingApp (cached 30s) so a deactivate/demote
//     takes effect within seconds instead of waiting for the JWT to expire.
//   - ADMIN_TOKEN remains an optional break-glass bypass for opening the ops
//     UI from a browser link when the LA bridge is unavailable.
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const listingAppClient = require('../src/sot/listingAppClient');

const TOKEN_TTL_SECONDS = 8 * 3600;

let _tokenMap = null;
let _tokenMapRaw = null;

function serviceTokens() {
  const raw = env.PUSH_SERVICE_TOKENS_RAW;
  if (_tokenMap && _tokenMapRaw === raw) return _tokenMap;
  const map = new Map();
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (name && token) map.set(token, name);
  }
  _tokenMap = map;
  _tokenMapRaw = raw;
  return map;
}

function bearerAuth(req, res, next) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  const token = header.slice(7).trim();
  const caller = serviceTokens().get(token);
  if (!caller) return res.status(401).json({ error: 'invalid_bearer_token' });
  req.caller = caller;
  next();
}

// Small in-memory cache of the ListingApp user lookup. Without it every
// authenticated request hits the LA bridge; TTL kept short so a
// demote/deactivate in ListingApp takes effect within seconds.
const USER_CACHE_TTL_MS = 30 * 1000;
const LA_CIRCUIT_MS = 30 * 1000;
const userCache = new Map(); // id -> { row, expiresAt }
const userRefreshInflight = new Map(); // id -> Promise<void>
let laCircuitOpenUntil = 0;

function seedUserCache(user) {
  if (!user || user.id == null) return;
  // The ListingApp bridge's /auth/verify only ever returns accounts that are
  // already active, so its user object omits `is_active`. adminAuth gates every
  // request on `current.is_active`, so seeding the bare verify-row as-is would
  // boot the operator on their very first request (undefined is falsy). A
  // freshly verified user IS active by the bridge's contract — default it so,
  // without clobbering an explicit flag from a richer source (e.g. getUser).
  const row = user.is_active == null ? { ...user, is_active: true } : user;
  userCache.set(user.id, { row, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

function tripLaCircuit() {
  laCircuitOpenUntil = Date.now() + LA_CIRCUIT_MS;
}

function trimUserCache() {
  if (userCache.size <= 500) return;
  const firstKey = userCache.keys().next().value;
  userCache.delete(firstKey);
}

async function refreshUserCache(id) {
  if (Date.now() < laCircuitOpenUntil) {
    const err = new Error('ListingApp unavailable (circuit open)');
    err.code = 'LA_CIRCUIT_OPEN';
    throw err;
  }
  try {
    const row = await listingAppClient.getUser(id);
    userCache.set(id, { row, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    trimUserCache();
    return row;
  } catch (err) {
    tripLaCircuit();
    throw err;
  }
}

function scheduleUserRefresh(id) {
  if (userRefreshInflight.has(id)) return;
  const p = refreshUserCache(id)
    .catch(() => {})
    .finally(() => userRefreshInflight.delete(id));
  userRefreshInflight.set(id, p);
}

function userForRequest(id) {
  const now = Date.now();
  const hit = userCache.get(id);
  if (hit && hit.expiresAt > now) return { known: true, row: hit.row };
  if (hit && hit.row) {
    scheduleUserRefresh(id);
    return { known: true, row: hit.row };
  }
  scheduleUserRefresh(id);
  return { known: false, row: null };
}

async function findActiveUserByIdCached(id) {
  const now = Date.now();
  const hit = userCache.get(id);
  if (hit && hit.expiresAt > now) return hit.row;

  // Stale-while-revalidate: serve last-known-good immediately and refresh in
  // the background. Previously we blocked every request for up to ~10s while
  // getUser timed out on each cache expiry, leaving the console stuck on
  // "Not connected." even though the JWT was still valid.
  if (hit && hit.row) {
    scheduleUserRefresh(id);
    return hit.row;
  }

  try {
    return await refreshUserCache(id);
  } catch (err) {
    if (hit) return hit.row;
    throw err;
  }
}

// Verify ListingApp credentials over the bridge. Returns the user row on
// success, null on bad credentials. Throws when the bridge is unreachable.
async function verifyCredentials(login, password) {
  if (!login || !password) return null;
  const user = await listingAppClient.verifyCredentials({ login, password });
  return user || null;
}

function signAdminJwt(user, ttlSeconds = TOKEN_TTL_SECONDS) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET not configured');
  // Accept either a full ListingApp user row or a bare string (legacy
  // ADMIN_TOKEN path) so existing callers keep working.
  const claims = typeof user === 'string'
    ? { user }
    : { id: user.id, user: user.username, username: user.username, role: user.role, full_name: user.full_name };
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: ttlSeconds });
}

// Admin guard for the UI / operator endpoints. Resolution order:
//   1. ADMIN_TOKEN break-glass (?token= / x-admin-token).
//   2. Signed JWT (Bearer header, aps_jwt cookie, or ?token= for downloads)
//      — re-checked against ListingApp so disabled users are cut off fast.
//   3. Service bearer token (machine callers can also read the ops views).
async function adminAuth(req, res, next) {
  const adminToken = env.ADMIN_TOKEN;
  if (adminToken && (req.query.token === adminToken || req.headers['x-admin-token'] === adminToken)) {
    req.admin = { user: 'admin-token' };
    return next();
  }

  const header = req.headers['authorization'] || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const cookieToken = parseCookies(req).aps_jwt || null;
  // <a href> downloads (audit export) can't set an Authorization header, so a
  // JWT may also arrive as ?token=. We only treat it as a JWT candidate when
  // it isn't the static ADMIN_TOKEN (handled above).
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const jwtToken = bearer || cookieToken || queryToken;

  if (jwtToken && env.JWT_SECRET) {
    let payload;
    try {
      payload = jwt.verify(jwtToken, env.JWT_SECRET);
    } catch { payload = null; }
    if (payload && typeof payload === 'object') {
      // Legacy ADMIN_TOKEN-minted JWTs have no `id` to re-check; accept as-is.
      if (payload.id == null) {
        req.admin = payload;
        return next();
      }
      const { known, row: current } = userForRequest(payload.id);
      if (!known) {
        // Cold server / ListingApp outage: the JWT is already verified and
        // bounded by its expiry, so do not make the operator console wait on
        // the bridge. A background refresh will enforce disables/role changes
        // as soon as ListingApp answers.
        req.admin = payload;
        return next();
      }
      if (!current || !current.is_active) {
        return res.status(401).json({ error: 'user_disabled' });
      }
      // Surface any server-side role/name change from ListingApp.
      payload.role = current.role;
      payload.full_name = current.full_name;
      req.admin = payload;
      return next();
    }
  }

  if (bearer && serviceTokens().has(bearer)) {
    req.caller = serviceTokens().get(bearer);
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

// Role gate for operator endpoints. Use after adminAuth.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'unauthorized' });
    // ADMIN_TOKEN break-glass has no role — treat it as fully privileged.
    if (req.admin.user === 'admin-token') return next();
    if (!allowedRoles.includes(req.admin.role)) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }
    next();
  };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function resetUserCache() {
  userCache.clear();
  userRefreshInflight.clear();
  laCircuitOpenUntil = 0;
}

module.exports = {
  bearerAuth,
  adminAuth,
  serviceTokens,
  signAdminJwt,
  verifyCredentials,
  requireRole,
  findActiveUserByIdCached,
  seedUserCache,
  resetUserCache,
  TOKEN_TTL_SECONDS
};
