const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const submissions = require('../src/submissions');
const sibling = require('../src/sot/siblingAttributeSource');
const catalogItems = require('../src/spapi/catalogItems');
const asm = require('../src/sot/attributeSourceMap');

const { envelopeFromSubmissionRow, reshapeEnvelope } = sibling._internal;

function insertApplied(uuid, overrides = {}) {
  return submissions.insert({
    submissionUuid: uuid,
    caller: 'test',
    scope: 'listing',
    operation: 'patchItem',
    status: 'APPLIED',
    requestBody: {},
    ...overrides
  });
}

// ── envelope extraction ─────────────────────────────────────────────────────

test('envelopeFromSubmissionRow extracts from a patch request body', () => {
  const row = {
    request_body_json: JSON.stringify({
      patches: [{ op: 'replace', path: '/attributes/material', value: [{ value: 'Wood', marketplace_id: 'ATVPDKIKX0DER' }] }]
    })
  };
  const env = envelopeFromSubmissionRow(row, 'material');
  assert.equal(env[0].value, 'Wood');
  assert.equal(envelopeFromSubmissionRow(row, 'brand'), null);
});

test('envelopeFromSubmissionRow extracts from a feed message body', () => {
  const row = {
    request_body_json: JSON.stringify({
      header: { sellerId: 'V1' },
      messages: [{ sku: 'SKU1', attributes: { batteries_required: [{ value: 'No', marketplace_id: 'ATVPDKIKX0DER' }] } }]
    })
  };
  assert.equal(envelopeFromSubmissionRow(row, 'batteries_required')[0].value, 'No');
});

test('envelopeFromSubmissionRow falls back to prior_state attributes', () => {
  const row = {
    request_body_json: JSON.stringify({ patches: [] }),
    prior_state_json: JSON.stringify({ attributes: { material: [{ value: 'Plastic', marketplace_id: 'ATVPDKIKX0DER' }] } })
  };
  assert.equal(envelopeFromSubmissionRow(row, 'material')[0].value, 'Plastic');
});

// ── marketplace re-shaping ──────────────────────────────────────────────────

test('reshapeEnvelope rewrites marketplace_id and language_tag to the target', () => {
  const out = reshapeEnvelope(
    [{ value: 'Wood', marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' }],
    { marketplaceId: 'A1PA6795UKMFR9', languageTag: 'de_DE' }
  );
  assert.equal(out[0].marketplace_id, 'A1PA6795UKMFR9');
  assert.equal(out[0].language_tag, 'de_DE');
  assert.equal(out[0].value, 'Wood');
});

test('reshapeEnvelope wraps a bare object into an array', () => {
  const out = reshapeEnvelope({ value: 'x', marketplace_id: 'ATVPDKIKX0DER' }, { marketplaceId: 'A1F83G8C2ARO7P' });
  assert.ok(Array.isArray(out));
  assert.equal(out[0].marketplace_id, 'A1F83G8C2ARO7P');
});

// ── listAcceptedByAsin ranking + filtering ──────────────────────────────────

test('listAcceptedByAsin returns only APPLIED rows, excludes a uuid, ranks closest first', () => {
  const asin = 'B0RANK01';
  insertApplied('rank-other-mp', { asin, marketplaceCode: 'CA', productType: 'TOYS_AND_GAMES' });
  insertApplied('rank-same-mp-other-pt', { asin, marketplaceCode: 'US', productType: 'BABY_PRODUCT' });
  insertApplied('rank-exact', { asin, marketplaceCode: 'US', productType: 'TOYS_AND_GAMES' });
  // Non-APPLIED row must be ignored.
  submissions.insert({ submissionUuid: 'rank-failed', caller: 'test', scope: 'listing', operation: 'patchItem', status: 'FAILED', requestBody: {}, asin, marketplaceCode: 'US', productType: 'TOYS_AND_GAMES' });
  // The target row itself must be excluded.
  insertApplied('rank-self', { asin, marketplaceCode: 'US', productType: 'TOYS_AND_GAMES' });

  const rows = submissions.listAcceptedByAsin(asin, { excludeUuid: 'rank-self', marketplaceCode: 'US', productType: 'TOYS_AND_GAMES' });
  const uuids = rows.map((r) => r.submission_uuid);
  assert.ok(!uuids.includes('rank-self'), 'excludes target');
  assert.ok(!uuids.includes('rank-failed'), 'excludes non-APPLIED');
  assert.equal(uuids[0], 'rank-exact', 'exact marketplace+product type wins');
  assert.equal(uuids[1], 'rank-same-mp-other-pt', 'same marketplace next');
  assert.equal(uuids[2], 'rank-other-mp', 'different marketplace last');
});

// ── buildSiblingCandidates: DB sibling, then catalog fallback ────────────────

test('buildSiblingCandidates borrows a value from an accepted sibling submission', async () => {
  const asin = 'B0SIB001';
  insertApplied('sib-src', {
    asin, marketplaceCode: 'US', productType: 'TOYS_AND_GAMES', vendorCode: 'VEND9',
    requestBody: { patches: [{ op: 'replace', path: '/attributes/material', value: [{ value: 'Wood', marketplace_id: 'ATVPDKIKX0DER' }] }] }
  });
  const out = await sibling.buildSiblingCandidates({
    attrNames: ['material'], asin, marketplaceCode: 'US', productType: 'TOYS_AND_GAMES', excludeUuid: 'the-failing-one'
  });
  assert.equal(out.candidates.material[0].value, 'Wood');
  assert.match(out.provenance.material, /^sibling:sib-src vendor VEND9/);
  assert.ok(out.warnings.some((w) => /repurposed 1 attribute/.test(w)));
});

test('buildSiblingCandidates re-shapes a sibling value onto a different marketplace', async () => {
  const asin = 'B0SIB002';
  insertApplied('sib-us', {
    asin, marketplaceCode: 'US', productType: 'TOYS_AND_GAMES',
    requestBody: { patches: [{ op: 'replace', path: '/attributes/material', value: [{ value: 'Wood', marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' }] }] }
  });
  const out = await sibling.buildSiblingCandidates({
    attrNames: ['material'], asin, marketplaceCode: 'DE', productType: 'TOYS_AND_GAMES'
  });
  assert.equal(out.candidates.material[0].marketplace_id, 'A1PA6795UKMFR9');
  assert.equal(out.candidates.material[0].language_tag, 'de_DE');
});

test('buildSiblingCandidates falls back to Amazon catalogue when no sibling has the attribute', async () => {
  const asin = 'B0CATALOG1';
  const orig = catalogItems.getCatalogItem;
  catalogItems.getCatalogItem = async ({ includedData }) => {
    assert.ok(includedData.includes('attributes'), 'requests attributes dataset');
    return { attributes: { batteries_required: [{ value: 'No', marketplace_id: 'ATVPDKIKX0DER' }] } };
  };
  try {
    const out = await sibling.buildSiblingCandidates({
      attrNames: ['batteries_required'], asin, marketplaceCode: 'US', productType: 'TOYS_AND_GAMES'
    });
    assert.equal(out.usedCatalog, true);
    assert.equal(out.candidates.batteries_required[0].value, 'No');
    assert.equal(out.provenance.batteries_required, `amazon-catalog:${asin}`);
  } finally {
    catalogItems.getCatalogItem = orig;
  }
});

test('buildSiblingCandidates returns nothing when the feature is disabled', async () => {
  const prev = process.env.SIBLING_REPURPOSE_ENABLED;
  process.env.SIBLING_REPURPOSE_ENABLED = 'false';
  try {
    const out = await sibling.buildSiblingCandidates({ attrNames: ['material'], asin: 'B0SIB001', marketplaceCode: 'US' });
    assert.deepEqual(out.candidates, {});
  } finally {
    if (prev == null) delete process.env.SIBLING_REPURPOSE_ENABLED;
    else process.env.SIBLING_REPURPOSE_ENABLED = prev;
  }
});

// ── buildGroundedPackage integration: PIM wins, sibling fills the gap ────────

test('buildGroundedPackage prefers PIM and uses siblings only for gaps', () => {
  const sources = {
    snapshot: { identity: { brand: 'B. toys' } },
    pim: { material_composition: 'Wood' },
    product: null,
    pricing: null,
    live: null,
    siblings: {
      candidates: {
        // material is also offered by a sibling, but PIM must win.
        material: [{ value: 'Plastic', marketplace_id: 'ATVPDKIKX0DER' }],
        // batteries_required has no PIM mapping -> sibling fills it.
        batteries_required: [{ value: 'No', marketplace_id: 'ATVPDKIKX0DER' }]
      },
      provenance: { material: 'sibling:x', batteries_required: 'amazon-catalog:B0X' }
    }
  };
  const out = asm.buildGroundedPackage({
    attrNames: ['brand', 'material', 'batteries_required', 'manufacturer'],
    operation: 'patchItem',
    sources,
    marketplaceCode: 'US'
  });
  const byPath = Object.fromEntries(out.package.patches.map((p) => [p.path, p.value]));
  assert.equal(byPath['/attributes/material'][0].value, 'Wood', 'PIM wins over sibling');
  assert.equal(out.valueSources.material, 'pim.material_composition');
  assert.equal(byPath['/attributes/batteries_required'][0].value, 'No', 'sibling fills unmapped attr');
  assert.equal(out.valueSources.batteries_required, 'amazon-catalog:B0X');
  // manufacturer has neither PIM nor sibling -> still unresolved, never invented.
  assert.ok(!('/attributes/manufacturer' in byPath));
  assert.ok(out.unresolved.some((u) => u.field === 'manufacturer'));
});

test('buildGroundedPackage records sibling provenance for a mapped attr with no PIM value', () => {
  const sources = {
    snapshot: null, pim: null, product: null, pricing: null, live: null,
    siblings: {
      candidates: { material: [{ value: 'Wood', marketplace_id: 'ATVPDKIKX0DER' }] },
      provenance: { material: 'sibling:abc vendor V1 (US)' }
    }
  };
  const out = asm.buildGroundedPackage({ attrNames: ['material'], operation: 'patchItem', sources, marketplaceCode: 'US' });
  assert.equal(out.package.patches[0].value[0].value, 'Wood');
  assert.equal(out.valueSources.material, 'sibling:abc vendor V1 (US)');
});
