const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const productTypes = require('../src/spapi/productTypes');
const packageValidator = require('../src/packageValidator');

// Stub the schema fetch so tests are offline + deterministic. The schema shape
// matches what listAttributeNames() walks (schema.properties keys).
function stubSchema(allowedNames) {
  productTypes.getSchema = async () => ({
    productType: 'TOYS_AND_GAMES',
    productTypeVersion: 'LATEST',
    schemaVersion: 'test',
    schema: { properties: Object.fromEntries(allowedNames.map((n) => [n, {}])) }
  });
}

test('attrNameFromPatchPath handles plain + nested + escaped pointers', () => {
  assert.equal(packageValidator.attrNameFromPatchPath('/attributes/item_name'), 'item_name');
  assert.equal(packageValidator.attrNameFromPatchPath('/attributes/item_name/0/value'), 'item_name');
  assert.equal(packageValidator.attrNameFromPatchPath('/summaries/0'), null);
});

test('extractExpected pulls whole-attribute values from patchItem patches', () => {
  const pkg = { patches: [
    { op: 'replace', path: '/attributes/item_name', value: [{ value: 'Toy' }] },
    { op: 'replace', path: '/attributes/list_price/0/value', value: 9.99 }
  ] };
  const { changedAttrNames, expected } = packageValidator.extractExpected({ pkg, operation: 'patchItem' });
  assert.deepEqual(changedAttrNames.sort(), ['item_name', 'list_price']);
  assert.deepEqual(expected.item_name, [{ value: 'Toy' }]);
  assert.ok(!('list_price' in expected), 'nested-path attr has no standalone expected value');
});

test('extractExpected reads feed message attributes', () => {
  const pkg = { messages: [{ sku: 'S1', attributes: { item_name: [{ value: 'X' }], brand: [{ value: 'B' }] } }] };
  const { changedAttrNames, expected } = packageValidator.extractExpected({ pkg, operation: 'submitJsonListingsFeed' });
  assert.deepEqual(changedAttrNames.sort(), ['brand', 'item_name']);
  assert.equal(expected.brand[0].value, 'B');
});

test('validatePackage rejects structurally invalid packages', async () => {
  const res = await packageValidator.validatePackage({ pkg: { patches: [] }, operation: 'patchItem', productType: 'TOYS_AND_GAMES', marketplaceCode: 'US' });
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /non-empty patches/);
});

test('validatePackage strict mode rejects unknown attributes', async () => {
  stubSchema(['item_name']);
  const pkg = { patches: [
    { op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] },
    { op: 'replace', path: '/attributes/not_a_real_attr', value: [{ value: 'Y' }] }
  ] };
  const res = await packageValidator.validatePackage({ pkg, operation: 'patchItem', productType: 'TOYS_AND_GAMES', marketplaceCode: 'US', allowUnknownAttributes: false });
  assert.equal(res.ok, false);
  assert.deepEqual(res.droppedAttrNames, ['not_a_real_attr']);
});

test('validatePackage lenient mode drops unknown attributes + keeps the rest', async () => {
  stubSchema(['item_name']);
  const pkg = { patches: [
    { op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] },
    { op: 'replace', path: '/attributes/not_a_real_attr', value: [{ value: 'Y' }] }
  ] };
  const res = await packageValidator.validatePackage({ pkg, operation: 'patchItem', productType: 'TOYS_AND_GAMES', marketplaceCode: 'US', allowUnknownAttributes: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.changedAttrNames, ['item_name']);
  assert.deepEqual(res.droppedAttrNames, ['not_a_real_attr']);
  assert.equal(res.sanitizedPackage.patches.length, 1, 'unknown patch stripped from sanitized package');
});

test('validatePackage forwards vendor passthrough attrs absent from the schema', async () => {
  // `procurement` is a 1P-vendor attribute the seller LISTING schema never
  // declares; the passthrough allow-list (default ['procurement']) must keep
  // it even in strict mode so it reaches Amazon.
  stubSchema(['item_name', 'package_level']);
  const pkg = { patches: [
    { op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] },
    { op: 'replace', path: '/attributes/procurement', value: [{ marketplace_id: 'ATVPDKIKX0DER', replenishment_status: 'PERMANENTLY_NOT_REPLENISHABLE' }] }
  ] };
  const res = await packageValidator.validatePackage({ pkg, operation: 'patchItem', productType: 'TOY_FIGURE', marketplaceCode: 'US', allowUnknownAttributes: false });
  assert.equal(res.ok, true);
  assert.ok(res.changedAttrNames.includes('procurement'), 'procurement kept as a changed attribute');
  assert.deepEqual(res.droppedAttrNames, [], 'procurement is not dropped');
  assert.equal(res.sanitizedPackage.patches.length, 2, 'procurement patch survives into the forwarded package');
  assert.ok(res.warnings.some((w) => /vendor passthrough/.test(w)), 'a passthrough warning is recorded');
});

test('validatePackage still rejects genuine unknown attrs alongside a passthrough attr', async () => {
  // The passthrough allow-list must not become "allow everything": a real typo
  // is still rejected in strict mode even when a passthrough attr is present.
  stubSchema(['item_name']);
  const pkg = { patches: [
    { op: 'replace', path: '/attributes/procurement', value: [{ marketplace_id: 'ATVPDKIKX0DER', replenishment_status: 'REPLENISHABLE' }] },
    { op: 'replace', path: '/attributes/not_a_real_attr', value: [{ value: 'Y' }] }
  ] };
  const res = await packageValidator.validatePackage({ pkg, operation: 'patchItem', productType: 'TOY_FIGURE', marketplaceCode: 'US', allowUnknownAttributes: false });
  assert.equal(res.ok, false);
  assert.deepEqual(res.droppedAttrNames, ['not_a_real_attr']);
  assert.match(res.problems.join(' '), /not_a_real_attr/);
});
