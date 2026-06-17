// Shared error-distillation + export helpers. The operator console's
// Submissions queue, the Errors tab, and the Excel export all need the same
// view of "what went wrong" so the logic lives here once.
const submissions = require('./submissions');

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

function listErrorSubmissions({ limit } = {}) {
  return submissions.listErrors({ limit });
}

// Per-submission view for the Errors tab: submission context + distilled issues
// + the raw Amazon envelope (as a string) for the expandable detail panel.
function toRecord(row) {
  const details = summarizeErrorDetails(row);
  return {
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    errorDetails: details,
    rawResponse: row.amazon_response_json || null,
    rawIssues: row.issues_json || null
  };
}

// Flatten a submission into >=1 spreadsheet rows — one per Amazon issue so each
// error code lands on its own line. Submissions with no distilled issue still
// emit a single row carrying the error_message so nothing is dropped.
function toExportRows(row) {
  const details = summarizeErrorDetails(row);
  const raw = row.amazon_response_json ? String(row.amazon_response_json).slice(0, CELL_MAX) : '';
  const base = {
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    submission_uuid: row.submission_uuid || '',
    job_uuid: row.job_uuid || '',
    status: row.status || '',
    caller: row.caller || '',
    vendor_code: row.vendor_code || '',
    sku: row.sku || '',
    effective_sku: row.effective_sku || '',
    asin: row.asin || '',
    item_number: row.item_number || '',
    marketplace_code: row.marketplace_code || '',
    product_type: row.product_type || '',
    operation: row.operation || '',
    scope: row.scope || '',
    approved_by: row.approved_by || '',
    feed_id: row.feed_id || '',
    error_message: row.error_message || ''
  };
  if (!details.length) {
    return [Object.assign({}, base, { severity: '', code: '', issue_message: row.error_message || '', attribute_names: '', raw_response: raw })];
  }
  // Attach the raw envelope only to the first issue row to avoid repeating a
  // large blob on every line of the same submission.
  return details.map((d, idx) => Object.assign({}, base, {
    severity: d.severity || '',
    code: d.code || '',
    issue_message: d.message || '',
    attribute_names: (d.attributeNames || []).join(', '),
    raw_response: idx === 0 ? raw : ''
  }));
}

// Column layout for the Excel workbook (header + key + width).
const EXPORT_COLUMNS = [
  { header: 'Created', key: 'created_at', width: 20 },
  { header: 'Updated', key: 'updated_at', width: 20 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Issue severity', key: 'severity', width: 14 },
  { header: 'Issue code', key: 'code', width: 18 },
  { header: 'Issue message', key: 'issue_message', width: 60 },
  { header: 'Attributes', key: 'attribute_names', width: 24 },
  { header: 'Error summary', key: 'error_message', width: 40 },
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

// Build an ExcelJS workbook from the persisted error submissions.
async function buildWorkbook({ limit } = {}) {
  const ExcelJS = require('exceljs');
  const rows = listErrorSubmissions({ limit });
  const exportRows = [];
  for (const r of rows) exportRows.push(...toExportRows(r));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amazon Push Service';
  wb.created = new Date();
  const ws = wb.addWorksheet('Amazon errors', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  for (const r of exportRows) ws.addRow(r);
  const lastCol = String.fromCharCode(64 + EXPORT_COLUMNS.length);
  ws.autoFilter = `A1:${lastCol}1`;
  return { workbook: wb, submissionCount: rows.length, rowCount: exportRows.length };
}

module.exports = {
  summarizeErrorDetails,
  listErrorSubmissions,
  toRecord,
  toExportRows,
  buildWorkbook,
  EXPORT_COLUMNS
};
