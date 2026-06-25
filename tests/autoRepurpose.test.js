const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();
process.env.SPAPI_WRITES_ENABLED = 'true';

const submissions = require('../src/submissions');
const autoRepurpose = require('../src/autoRepurpose');
const packageValidator = require('../src/packageValidator');
const forwarder = require('../src/forwarder');

const { eligible, missingAttrNamesFromIssues, chooseDonor, buildPackage } = autoRepurpose._internal;

const US = 'ATVPDKIKX0DER';

function patchBody(attrs) {
  return { productType: 'TOYS_AND_GAMES', patches: Object.entries(attrs).map(([name, value]) => ({ op: 'replace', path: `/attributes/${name}`, value })) };
}
function env(value, mp = US) { return [{ value, marketplace_id: mp }]; }

function insertDonor(uuid, attrs, overrides = {}) {
  return submissions.insert({
    submissionUuid: uuid, caller: 'test', scope: 'listing', operation: 'patchItem', status: 'APPLIED',
    asin: 'B0AUTO1', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES', vendorCode: uuid.toUpperCase(),
    requestBody: patchBody(attrs), ...overrides
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

test('missingAttrNamesFromIssues collects every blamed attribute', () => {
  const names = missingAttrNamesFromIssues([
    { code: '90220', attributeNames: ['item_type_name'] },
    { code: '90220', attributeNames: ['batteries_required'] },
    { code: '90220', attributeName: 'rtip_safety_warning' }
  ]);
  assert.deepEqual(names.sort(), ['batteries_required', 'item_type_name', 'rtip_safety_warning']);
});

test('eligible rejects auto-repurpose submissions (no loops) and non-failures', () => {
  const base = { status: 'FAILED', operation: 'patchItem', asin: 'A', marketplace_code: 'US', product_type: 'T' };
  assert.equal(eligible(base), true);
  assert.equal(eligible({ ...base, payload_origin: 'auto_repurposed' }), false);
  assert.equal(eligible({ ...base, status: 'APPLIED' }), false);
  assert.equal(eligible({ ...base, marketplace_code: null }), false);
});

// ── donor selection ─────────────────────────────────────────────────────────

test('chooseDonor picks the most complete same-marketplace vendor and ignores other marketplaces', () => {
  const failed = { submission_uuid: 'failed-1', asin: 'B0AUTO1', marketplace_code: 'US', product_type: 'TOYS_AND_GAMES' };
  // Same marketplace, partial coverage.
  insertDonor('donor-partial', { item_type_name: env('Toy') });
  // Same marketplace, richest: covers both needed attrs + extra.
  insertDonor('donor-rich', { item_type_name: env('Toy'), batteries_required: env('No'), material: env('Wood') });
  // Different marketplace, full coverage — must be ignored.
  insertDonor('donor-ca', { item_type_name: env('Toy', 'A2EUQ1WTGCTBG2'), batteries_required: env('No', 'A2EUQ1WTGCTBG2') }, { marketplaceCode: 'CA' });

  const donor = chooseDonor(failed, ['item_type_name', 'batteries_required']);
  assert.equal(donor.row.submission_uuid, 'donor-rich');
  assert.equal(donor.coverage, 2);
});

test('chooseDonor returns null when no same-marketplace sibling covers a missing attr', () => {
  const failed = { submission_uuid: 'failed-2', asin: 'B0NONE', marketplace_code: 'US', product_type: 'TOYS_AND_GAMES' };
  insertDonor('donor-irrelevant', { brand: env('B. toys') }, { asin: 'B0NONE' });
  assert.equal(chooseDonor(failed, ['batteries_required']), null);
});

// ── package build ───────────────────────────────────────────────────────────

test('buildPackage merges donor values for missing attrs into the original patches', () => {
  const failed = { operation: 'patchItem', request_body_json: JSON.stringify(patchBody({ item_name: env('My Toy') })), marketplace_code: 'US', sku: 'SKU1' };
  const donor = { row: { submission_uuid: 'd1', vendor_code: 'V1', marketplace_code: 'US' }, attrs: { batteries_required: env('No'), material: env('Wood') } };
  const built = buildPackage(failed, donor, ['batteries_required', 'item_type_name'], { marketplaceId: US, languageTag: 'en_US' });
  const byPath = Object.fromEntries(built.pkg.patches.map((p) => [p.path, p.value]));
  assert.ok('/attributes/item_name' in byPath, 'keeps original attributes');
  assert.equal(byPath['/attributes/batteries_required'][0].value, 'No', 'fills missing attr from donor');
  assert.ok(!('/attributes/item_type_name' in byPath), 'donor lacks item_type_name -> not added');
  assert.match(built.used.batteries_required, /^auto-repurpose: vendor V1 sub d1 \(US\)/);
});

test('buildPackage returns null when donor has none of the missing attrs', () => {
  const failed = { operation: 'patchItem', request_body_json: JSON.stringify(patchBody({})), marketplace_code: 'US' };
  const donor = { row: { submission_uuid: 'd', vendor_code: 'V', marketplace_code: 'US' }, attrs: { brand: env('X') } };
  assert.equal(buildPackage(failed, donor, ['batteries_required'], { marketplaceId: US, languageTag: 'en_US' }), null);
});

// ── end-to-end maybeRepurpose ───────────────────────────────────────────────

test('maybeRepurpose builds + forwards an auto_repurposed re-push from the richest donor', async () => {
  // Donor in the same marketplace carrying the missing values.
  insertDonor('e2e-donor', { item_type_name: env('Toy'), batteries_required: env('No'), rtip_safety_warning: env('Choking hazard') });
  // The failing submission for the SAME ASIN under a different vendor code.
  const failed = submissions.insert({
    submissionUuid: 'e2e-failed', caller: 'fly', scope: 'listing', operation: 'patchItem', status: 'FAILED',
    asin: 'B0AUTO1', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES', vendorCode: 'FAILVENDOR', sku: 'FAIL-SKU',
    requestBody: patchBody({ item_name: env('My Toy') }),
    issuesJson: undefined
  });
  // Stamp the issues (insert() doesn't take issues) so missing attrs are known.
  submissions.update('e2e-failed', { status: 'FAILED', issues_json: [
    { code: '90220', attributeNames: ['item_type_name'] },
    { code: '90220', attributeNames: ['batteries_required'] },
    { code: '90220', attributeNames: ['rtip_safety_warning'] }
  ] });

  // Avoid live SP-API: stub schema validation and the forward call.
  const origValidate = packageValidator.validatePackage;
  const origForward = forwarder.forward;
  let forwarded = null;
  packageValidator.validatePackage = async ({ pkg }) => ({ ok: true, sanitizedPackage: pkg, changedAttrNames: pkg.patches.map((p) => p.path), droppedAttrNames: [], warnings: [] });
  forwarder.forward = async (sub) => { forwarded = sub; return { ...sub, status: 'APPLIED' }; };

  try {
    const failedRow = submissions.getByUuid('e2e-failed');
    const result = await autoRepurpose.maybeRepurpose(failedRow);
    assert.equal(result.ok, true);
    assert.deepEqual(result.filled.sort(), ['batteries_required', 'item_type_name', 'rtip_safety_warning']);

    // A new submission was created under the FAILING vendor code, marked auto_repurposed.
    assert.ok(forwarded, 'forwarder.forward was called');
    assert.equal(forwarded.payload_origin, 'auto_repurposed');
    assert.equal(forwarded.vendor_code, 'FAILVENDOR');
    assert.equal(forwarded.resolves_uuid, 'e2e-failed');
    const body = JSON.parse(forwarded.request_body_json);
    const byPath = Object.fromEntries(body.patches.map((p) => [p.path, p.value]));
    assert.equal(byPath['/attributes/batteries_required'][0].value, 'No');
    assert.equal(byPath['/attributes/item_type_name'][0].value, 'Toy');
    assert.ok('/attributes/item_name' in byPath, 'original attributes retained');
  } finally {
    packageValidator.validatePackage = origValidate;
    forwarder.forward = origForward;
  }
});

test('maybeRepurpose does not recurse on an already-repurposed submission', async () => {
  const row = submissions.insert({
    submissionUuid: 'no-loop', caller: 'system', scope: 'listing', operation: 'patchItem', status: 'FAILED',
    asin: 'B0AUTO1', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES', vendorCode: 'V',
    requestBody: patchBody({}), payloadOrigin: 'auto_repurposed'
  });
  submissions.update('no-loop', { status: 'FAILED', issues_json: [{ code: '90220', attributeNames: ['batteries_required'] }] });
  const result = await autoRepurpose.maybeRepurpose(submissions.getByUuid('no-loop'));
  assert.equal(result, null);
});
