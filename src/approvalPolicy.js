// Approval policy resolver. Maps a scope to 'auto' or 'email' via the
// env-driven config. The single seam where a future caller-aware policy
// could live without touching the routes.
const env = require('../config/env');

function resolve({ scope, caller }) {
  const policy = env.approvalPolicyFor(scope);
  return { policy, scope: String(scope || '').toUpperCase(), caller };
}

module.exports = { resolve };
