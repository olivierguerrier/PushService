const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const translator = require('../src/translator');

test('buildAttributes maps content + pricing + identity to Amazon envelopes', () => {
  const snapshot = {
    content: { title: 'Cool Toy', description: 'A cool toy', bullets: ['fun', 'safe'] },
    pricing: { list_price: 19.99, cost_price: 9.5, currency: 'USD' },
    identity: { brand: 'B. toys', item_number: 'BX1234', upc: '062243000001' }
  };
  const attrs = translator.buildAttributes(snapshot, { marketplaceCode: 'US' });
  assert.equal(attrs.item_name[0].value, 'Cool Toy');
  assert.equal(attrs.item_name[0].language_tag, 'en_US');
  assert.equal(attrs.item_name[0].marketplace_id, 'ATVPDKIKX0DER');
  assert.equal(attrs.bullet_point.length, 2);
  assert.equal(attrs.list_price[0].currency, 'USD');
  assert.equal(attrs.list_price[0].value, 19.99);
  assert.equal(attrs.cost_price[0].value, 9.5);
  assert.ok(attrs.cost_price[0].marketplace_id === undefined, 'cost_price omits marketplace_id');
  assert.equal(attrs.brand[0].value, 'B. toys');
  assert.equal(attrs.model_number[0].value, 'BX1234');
});

test('buildAttributes drops zero / empty values', () => {
  const attrs = translator.buildAttributes({ content: { title: '   ' }, pricing: { list_price: 0, currency: 'USD' } }, { marketplaceCode: 'US' });
  assert.ok(!attrs.item_name, 'blank title dropped');
  assert.ok(!attrs.list_price, 'zero price dropped');
});

test('fieldNames restricts the build', () => {
  const snapshot = { content: { title: 'X' }, pricing: { list_price: 5, currency: 'USD' } };
  const attrs = translator.buildAttributes(snapshot, { marketplaceCode: 'US', fieldNames: ['list_price'] });
  assert.ok(!attrs.item_name);
  assert.ok(attrs.list_price);
});

test('buildPatchOps + buildRevertPatchOps', () => {
  const attrs = translator.buildAttributes({ content: { title: 'X' } }, { marketplaceCode: 'US' });
  const ops = translator.buildPatchOps(attrs);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'replace');
  assert.equal(ops[0].path, '/attributes/item_name');

  // Revert: prior had item_name -> replace; missing -> delete.
  const revert = translator.buildRevertPatchOps({ item_name: [{ value: 'Old' }] }, ['item_name', 'brand']);
  assert.deepEqual(revert[0], { op: 'replace', path: '/attributes/item_name', value: [{ value: 'Old' }] });
  assert.deepEqual(revert[1], { op: 'delete', path: '/attributes/brand' });
});

test('filterBySchema keeps only allowed attribute names', () => {
  const schemaPayload = { schema: { properties: { item_name: {}, list_price: {} } } };
  const attrs = { item_name: [{ value: 'X' }], brand: [{ value: 'B' }] };
  const { kept, dropped } = translator.filterBySchema(attrs, schemaPayload);
  assert.ok(kept.item_name);
  assert.ok(!kept.brand);
  assert.deepEqual(dropped, ['brand']);
});
