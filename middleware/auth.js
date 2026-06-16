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
const userCache = new Map(); // id -> { row, expiresAt }

async function findActiveUserByIdCached(id) {
  const now = Date.now();
  const hit = userCache.get(id);
  if (hit && hit.expiresAt > now) return hit.row;
  const row = await listingAppClient.getUser(id);
  userCache.set(id, { row, expiresAt: now + USER_CACHE_TTL_MS });
  if (userCache.size > 500) {
    const firstKey = userCache.keys().next().value;
    userCache.delete(firstKey);
  }
  return row;
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
      let current;
      try {
        current = await findActiveUserByIdCached(payload.id);
      } catch (dbErr) {
        console.warn('[AUTH] user lookup failed:', dbErr.message);
        return res.status(503).json({ error: 'auth_lookup_failed' });
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

module.exports = {
  bearerAuth,
  adminAuth,
  serviceTokens,
  signAdminJwt,
  verifyCredentials,
  requireRole,
  findActiveUserByIdCached,
  TOKEN_TTL_SECONDS
};
