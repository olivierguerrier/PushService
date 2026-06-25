// Shared error-distillation + export helpers. The operator console's
// Submissions queue, the Errors tab, and the Excel export all need the same
// view of "what went wrong" so the logic lives here once.
const submissions = require('./submissions');
const errorTranslation = require('./errorTranslation');

// Excel rejects cell text longer than 32,767 chars; keep a small margin.
const CELL_MAX = 32000;

function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// Distil the persisted error envelope (issues_json / amazon_response_json) into
// a compact list of diagnostics: { code, message, severity, attributeNames }.
// Returns [] when there is nothing useful to show.
function summarizeErrorDetails({ issues_json, amazon_response_json }) {
  const out = [];
  const issues = parseJson(issues_json);
  if (Array.isArray(issues)) {
    for (const i of issues) {
      if (!i) continue;
      out.push({
        code: i.code || null,
        message: i.message || (typeof i === 'string' ? i : null),
        severity: i.severity || null,
        attributeNames: Array.isArray(i.attributeNames) ? i.attributeNames : (i.attributeName ? [i.attributeName] : [])
      });
    }
  }
  if (!out.length && amazon_response_json) {
    const amazon = parseJson(amazon_response_json);
    if (amazon && typeof amazon === 'object' && amazon.error) {
      const msg = typeof amazon.error === 'string' ? amazon.error : JSON.stringify(amazon.error);
      out.push({ code: null, message: String(msg).slice(0, 2000), severity: 'ERROR', attributeNames: [] });
    }
  }
  return out;
}

// ── Error "Type" classification ─────────────────────────────────────────────
// Bucket each failed submission into one operational category so the console
// and the Excel export can triage at a glance. The category is driven by how
// many distinct *required* attributes Amazon says are absent:
//   • full_data_missing — 5+ required fields missing. The product was, in
//     effect, submitted without its data set; it needs a full re-feed.
//   • master_data       — 1–4 specific required fields missing. Targeted
//     PIM / master-data gaps to fill in.
//   • rule_issue        — no required field is actually absent; a field that
//     WAS submitted is rejected by a validation / business rule (invalid
//     value, duplicate identifier, title-word rule, etc.).
//   • unknown           — no diagnostics to classify on.
const FULL_DATA_MISSING_THRESHOLD = 5;

// Codes Amazon uses specifically for "a required attribute is absent".
const MISSING_FIELD_CODES = new Set(['90220', '18027', '8560']);

const ERROR_TYPE_LABELS = {
  full_data_missing: 'Full data missing',
  master_data: 'Master data',
  rule_issue: 'Rule issue',
  unknown: 'Unknown'
};

// "required but missing" is unambiguous and wins over any value-rule wording.
const REQUIRED_MISSING_RE = /required but (missing|not\b|isn'?t|is not)/i;
// Value / business-rule rejections on a field that was actually submitted.
const VALUE_RULE_RE = /(not a valid value|is not valid|invalid value|valid value|already (listed|assigned|exists)|not unique|match(?:es)? (?:multiple|another|existing)|more than (?:twice|two)|duplicat|conflict)/i;
// Generic "this field is required / please provide it" wording (multi-lingual
// so non-English markets without a recognised code still classify sensibly).
const MISSING_FIELD_RE = /(missing required|is required\b|required attribute|please provide a value(?! that)|attribute is required|debe proporcionar un valor|obligatori|obligatoir|erforderlich|requerido|requis)/i;

function leadingCode(message) {
  const m = String(message || '').match(/^\s*(\d{3,8})\s*:/);
  return m ? m[1] : null;
}

// Decide whether a single distilled diagnostic represents an *absent required
// field* (vs. a value/rule rejection on a field that was submitted).
function detailIsMissingField(detail, englishText) {
  const text = `${(detail && detail.message) || ''} ${englishText || ''}`;
  if (REQUIRED_MISSING_RE.test(text)) return true;
  if (VALUE_RULE_RE.test(text)) return false;
  const code = String((detail && detail.code) || '').trim();
  if (MISSING_FIELD_CODES.has(code)) return true;
  return MISSING_FIELD_RE.test(text);
}

// Classify a (distilled) error record into a Type bucket. Uses the structured
// issue list when present, otherwise the single error_message. errorDetailsEn /
// error_message_en (added by enrichRecords) are consulted when available, but
// the language-independent error codes are the primary signal.
function classifyErrorType(record) {
  const details = Array.isArray(record.errorDetails) ? record.errorDetails : [];
  const detailsEn = Array.isArray(record.errorDetailsEn) ? record.errorDetailsEn : [];

  let units;
  if (details.length) {
    units = details.map((d, i) => ({ detail: d, en: detailsEn[i] || '' }));
  } else if (record.error_message || record.error_message_en) {
    const msg = record.error_message || '';
    const code = leadingCode(msg) || leadingCode(record.error_message_en);
    units = [{ detail: { code, message: msg, attributeNames: [] }, en: record.error_message_en || '' }];
  } else {
    return { type: 'unknown', label: ERROR_TYPE_LABELS.unknown, missingFieldCount: 0 };
  }

  // Count distinct attributes flagged as missing; missing diagnostics that name
  // no attribute each count as one field.
  const missingFields = new Set();
  let missingWithoutAttr = 0;
  for (const u of units) {
    if (!detailIsMissingField(u.detail, u.en)) continue;
    const attrs = Array.isArray(u.detail.attributeNames) ? u.detail.attributeNames.filter(Boolean) : [];
    if (attrs.length) attrs.forEach((a) => missingFields.add(String(a)));
    else missingWithoutAttr += 1;
  }

  const missingFieldCount = missingFields.size + missingWithoutAttr;
  let type;
  if (missingFieldCount >= FULL_DATA_MISSING_THRESHOLD) type = 'full_data_missing';
  else if (missingFieldCount >= 1) type = 'master_data';
  else type = 'rule_issue';
  return { type, label: ERROR_TYPE_LABELS[type], missingFieldCount };
}

// Stamp the classification onto a record in place (so the Errors tab, the
// export, and the API all read the same fields).
function attachErrorType(record) {
  const c = classifyErrorType(record);
  record.errorType = c.type;
  record.errorTypeLabel = c.label;
  record.missingFieldCount = c.missingFieldCount;
  return record;
}

function listErrorSubmissions({ limit } = {}) {
  return submissions.listErrors({ limit });
}

// Per-submission view for the Errors tab: submission context + distilled issues
// + the raw Amazon envelope (as a string) for the expandable detail panel.
function toRecord(row) {
  const details = summarizeErrorDetails(row);
  return attachErrorType({
    submission_uuid: row.submission_uuid,
    job_uuid: row.job_uuid,
    status: row.status,
    caller: row.caller,
    vendor_code: row.vendor_code,
    sku: row.sku,
    effective_sku: row.effective_sku,
    asin: row.asin,
    item_number: row.item_number,
    marketplace_code: row.marketplace_code,
    product_type: row.product_type,
    operation: row.operation,
    scope: row.scope,
    approved_by: row.approved_by,
    feed_id: row.feed_id,
    error_message: row.error_message || null,
    archived: !!row.archived_at,
    archived_at: row.archived_at || null,
    archived_by: row.archived_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    errorDetails: details,
    rawResponse: row.amazon_response_json || null,
    rawIssues: row.issues_json || null
  });
}

// Flatten a submission into >=1 spreadsheet rows — one per Amazon issue so each
// error code lands on its own line. Submissions with no distilled issue still
// emit a single row carrying the error_message so nothing is dropped.
function toExportRows(record) {
  const details = record.errorDetails || [];
  const detailsEn = record.errorDetailsEn || [];
  const raw = record.rawResponse ? String(record.rawResponse).slice(0, CELL_MAX) : '';
  const base = {
    created_at: record.created_at || '',
    updated_at: record.updated_at || '',
    submission_uuid: record.submission_uuid || '',
    job_uuid: record.job_uuid || '',
    status: record.status || '',
    caller: record.caller || '',
    vendor_code: record.vendor_code || '',
    sku: record.sku || '',
    effective_sku: record.effective_sku || '',
    asin: record.asin || '',
    item_number: record.item_number || '',
    marketplace_code: record.marketplace_code || '',
    product_type: record.product_type || '',
    operation: record.operation || '',
    scope: record.scope || '',
    approved_by: record.approved_by || '',
    feed_id: record.feed_id || '',
    error_type: record.errorTypeLabel || '',
    missing_field_count: record.missingFieldCount != null ? record.missingFieldCount : '',
    error_message: record.error_message || '',
    error_message_en: record.error_message_en || ''
  };
  if (!details.length) {
    return [Object.assign({}, base, {
      severity: '',
      code: '',
      issue_message: record.error_message || '',
      issue_message_en: record.error_message_en || '',
      attribute_names: '',
      raw_response: raw
    })];
  }
  // Attach the raw envelope only to the first issue row to avoid repeating a
  // large blob on every line of the same submission.
  return details.map((d, idx) => Object.assign({}, base, {
    severity: d.severity || '',
    code: d.code || '',
    issue_message: d.message || '',
    issue_message_en: detailsEn[idx] || errorTranslation.formatErrorDetail(d),
    attribute_names: (d.attributeNames || []).join(', '),
    raw_response: idx === 0 ? raw : ''
  }));
}

// Column layout for the Excel workbook (header + key + width).
const EXPORT_COLUMNS = [
  { header: 'Created', key: 'created_at', width: 20 },
  { header: 'Updated', key: 'updated_at', width: 20 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Type', key: 'error_type', width: 18 },
  { header: 'Missing fields', key: 'missing_field_count', width: 13 },
  { header: 'Issue severity', key: 'severity', width: 14 },
  { header: 'Issue code', key: 'code', width: 18 },
  { header: 'Issue message', key: 'issue_message', width: 60 },
  { header: 'Issue message (English)', key: 'issue_message_en', width: 60 },
  { header: 'Attributes', key: 'attribute_names', width: 24 },
  { header: 'Error summary', key: 'error_message', width: 40 },
  { header: 'Error summary (English)', key: 'error_message_en', width: 40 },
  { header: 'ASIN', key: 'asin', width: 14 },
  { header: 'SKU', key: 'sku', width: 18 },
  { header: 'Effective SKU', key: 'effective_sku', width: 18 },
  { header: 'Vendor', key: 'vendor_code', width: 10 },
  { header: 'Item #', key: 'item_number', width: 14 },
  { header: 'Marketplace', key: 'marketplace_code', width: 12 },
  { header: 'Product type', key: 'product_type', width: 16 },
  { header: 'Operation', key: 'operation', width: 12 },
  { header: 'Scope', key: 'scope', width: 12 },
  { header: 'Caller', key: 'caller', width: 16 },
  { header: 'Approved by', key: 'approved_by', width: 16 },
  { header: 'Feed ID', key: 'feed_id', width: 18 },
  { header: 'Submission UUID', key: 'submission_uuid', width: 38 },
  { header: 'Job UUID', key: 'job_uuid', width: 38 },
  { header: 'Raw Amazon response (JSON)', key: 'raw_response', width: 80 }
];

// Convert a 1-based column index to its Excel column letters (1 -> A, 27 -> AA)
// so the auto-filter range stays valid past 26 columns.
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Build an ExcelJS workbook from the persisted error submissions.
async function buildWorkbook({ limit } = {}) {
  const ExcelJS = require('exceljs');
  const rows = listErrorSubmissions({ limit });
  const records = rows.map(toRecord);
  await errorTranslation.enrichRecords(records);
  // Re-classify now that English copies are attached (refines value-vs-missing
  // detection for non-English markets).
  records.forEach(attachErrorType);
  const exportRows = [];
  for (const r of records) exportRows.push(...toExportRows(r));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amazon Push Service';
  wb.created = new Date();
  const ws = wb.addWorksheet('Amazon errors', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  for (const r of exportRows) ws.addRow(r);
  ws.autoFilter = `A1:${columnLetter(EXPORT_COLUMNS.length)}1`;
  return { workbook: wb, submissionCount: rows.length, rowCount: exportRows.length };
}

module.exports = {
  summarizeErrorDetails,
  classifyErrorType,
  attachErrorType,
  ERROR_TYPE_LABELS,
  listErrorSubmissions,
  toRecord,
  toExportRows,
  buildWorkbook,
  EXPORT_COLUMNS
};
