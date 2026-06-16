// Audit query + export + chain verification. Admin-guarded (the audit trail
// can contain operational detail about every push).
//
//   GET /audit?submissionUuid=&jobUuid=&event=&since=&limit=   query events
//   GET /audit/verify                                          verify hash chain
//   GET /audit/export?format=jsonl|csv                         full export
const express = require('express');
const { adminAuth } = require('../middleware/auth');
const audit = require('../src/audit/auditEvents');

const router = express.Router();

router.get('/', adminAuth, (req, res) => {
  const rows = audit.query({
    submissionUuid: req.query.submissionUuid || null,
    jobUuid: req.query.jobUuid || null,
    event: req.query.event || null,
    sinceIso: req.query.since || null,
    limit: req.query.limit || 200
  });
  res.json({ count: rows.length, events: rows });
});

router.get('/verify', adminAuth, (req, res) => {
  res.json(audit.verifyChain());
});

router.get('/export', adminAuth, (req, res) => {
  const format = String(req.query.format || 'jsonl').toLowerCase();
  const rows = audit.query({
    submissionUuid: req.query.submissionUuid || null,
    jobUuid: req.query.jobUuid || null,
    event: req.query.event || null,
    sinceIso: req.query.since || null,
    limit: req.query.limit || 1000
  });
  if (format === 'csv') {
    const cols = ['id', 'at', 'event', 'actor', 'submission_uuid', 'job_uuid', 'hash'];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="audit-export.csv"');
    return res.send(lines.join('\n'));
  }
  res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="audit-export.jsonl"');
  res.send(rows.map((r) => JSON.stringify(r)).join('\n'));
});

module.exports = router;
