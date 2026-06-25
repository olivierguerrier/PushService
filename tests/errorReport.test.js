'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const errorReport = require('../src/errorReport');

function missing(attr, code = '90220') {
  return { code, message: `The attribute '${attr}' is required but missing.`, attributeNames: [attr], severity: 'ERROR' };
}

describe('errorReport.classifyErrorType', () => {
  it('flags 5+ distinct missing required fields as "Full data missing"', () => {
    const rec = { errorDetails: ['item_name', 'brand', 'color', 'material', 'bullet_point'].map((a) => missing(a)) };
    const c = errorReport.classifyErrorType(rec);
    assert.equal(c.type, 'full_data_missing');
    assert.equal(c.label, 'Full data missing');
    assert.equal(c.missingFieldCount, 5);
  });

  it('flags 1–4 specific missing fields as "Master data"', () => {
    const rec = { errorDetails: [missing('item_name'), missing('brand')] };
    const c = errorReport.classifyErrorType(rec);
    assert.equal(c.type, 'master_data');
    assert.equal(c.missingFieldCount, 2);
  });

  it('counts distinct attributes (deduped) for the threshold', () => {
    const rec = { errorDetails: [missing('item_name'), missing('item_name'), missing('brand')] };
    const c = errorReport.classifyErrorType(rec);
    assert.equal(c.type, 'master_data');
    assert.equal(c.missingFieldCount, 2);
  });

  it('treats a rejected submitted value as a "Rule issue" (no field missing)', () => {
    const rec = {
      errorDetails: [{
        code: '100095',
        message: "The value 'F' of the attribute 'Item Name' is not a valid value. Please provide a valid value.",
        attributeNames: ['item_name']
      }]
    };
    const c = errorReport.classifyErrorType(rec);
    assert.equal(c.type, 'rule_issue');
    assert.equal(c.missingFieldCount, 0);
  });

  it('treats duplicate-identifier rejections as a "Rule issue"', () => {
    const rec = {
      errorDetails: [{ code: '101165', message: 'identifiers match multiple catalog items', attributeNames: ['external_product_id'] }]
    };
    assert.equal(errorReport.classifyErrorType(rec).type, 'rule_issue');
  });

  it('classifies from the single error_message when no structured issues exist', () => {
    const missingRec = { errorDetails: [], error_message: "90220: 'Item Package Dimensions' is required but missing." };
    assert.equal(errorReport.classifyErrorType(missingRec).type, 'master_data');

    const ruleRec = { errorDetails: [], error_message: '8541: invalid value submitted' };
    assert.equal(errorReport.classifyErrorType(ruleRec).type, 'rule_issue');
  });

  it('returns "Unknown" when there is nothing to classify on', () => {
    assert.equal(errorReport.classifyErrorType({ errorDetails: [] }).type, 'unknown');
  });

  it('uses a code-only missing signal even without explanatory text', () => {
    const rec = { errorDetails: [{ code: '18027', message: '', attributeNames: ['country_of_origin'] }] };
    assert.equal(errorReport.classifyErrorType(rec).type, 'master_data');
  });
});

describe('errorReport.attachErrorType', () => {
  it('stamps errorType / errorTypeLabel / missingFieldCount onto the record', () => {
    const rec = errorReport.attachErrorType({ errorDetails: [missing('brand')] });
    assert.equal(rec.errorType, 'master_data');
    assert.equal(rec.errorTypeLabel, 'Master data');
    assert.equal(rec.missingFieldCount, 1);
  });
});

describe('errorReport.toExportRows', () => {
  it('carries the Type label and missing-field count into export rows', () => {
    const rec = errorReport.attachErrorType({
      errorDetails: [missing('item_name'), missing('brand')],
      error_message: 'required fields missing',
      created_at: '2026-06-22T00:00:00Z'
    });
    const rows = errorReport.toExportRows(rec);
    assert.equal(rows[0].error_type, 'Master data');
    assert.equal(rows[0].missing_field_count, 2);
  });
});
