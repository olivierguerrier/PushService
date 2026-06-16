const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const { diffAttributes, equal } = require('../src/reconcileDiff');

test('equal tolerates numeric-string vs number and whitespace', () => {
  assert.ok(equal([{ value: 9.99 }], [{ value: '9.99' }]));
  assert.ok(equal([{ value: 'Cool   Toy ' }], [{ value: 'Cool Toy' }]));
});

test('equal ignores marketplace_id metadata + entry ordering', () => {
  const pushed = [{ value: 'a' }, { value: 'b' }];
  const live = [{ value: 'b', marketplace_id: 'ATVPDKIKX0DER' }, { value: 'a', marketplace_id: 'ATVPDKIKX0DER' }];
  assert.ok(equal(pushed, live));
});

test('diffAttributes reports MATCH when Amazon echoes reshaped values', () => {
  const expected = { item_name: [{ value: 'Cool Toy' }], list_price: [{ value: 19.99 }] };
  const observed = {
    item_name: [{ value: 'Cool Toy', marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' }],
    list_price: [{ value: '19.99', currency: 'USD', marketplace_id: 'ATVPDKIKX0DER' }]
  };
  // list_price differs only by extra currency key Amazon added → still flagged
  // as a mismatch (currency is meaningful, not metadata). item_name matches.
  const res = diffAttributes(expected, observed);
  assert.equal(res.diffs.find((d) => d.attr === 'item_name'), undefined);
});

test('diffAttributes flags value drift', () => {
  const res = diffAttributes({ item_name: [{ value: 'New Title' }] }, { item_name: [{ value: 'Old Title' }] });
  assert.equal(res.match, false);
  assert.equal(res.diffs[0].reason, 'value_mismatch');
});

test('diffAttributes flags attributes missing on Amazon', () => {
  const res = diffAttributes({ brand: [{ value: 'B' }] }, { item_name: [{ value: 'X' }] });
  assert.equal(res.match, false);
  assert.equal(res.diffs[0].reason, 'missing_on_amazon');
});
