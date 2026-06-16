// Master kill switch for write paths. When SPAPI_WRITES_ENABLED is false
// (the default), every write endpoint returns 503 before any Amazon call is
// even contemplated. Dry-run / preview / read endpoints do NOT use this gate.
const env = require('../config/env');

function writeGate(req, res, next) {
  if (!env.SPAPI_WRITES_ENABLED) {
    return res.status(503).json({
      error: 'writes_disabled',
      message: 'SPAPI_WRITES_ENABLED is false. Live writes to Amazon are turned off (kill switch).'
    });
  }
  next();
}

module.exports = { writeGate };
