const { test } = require('node:test');
const assert = require('node:assert');

const units = require('../src/units');
const { unitsFor } = require('../config/marketplaces');

test('marketplace unit systems: US/CA imperial, everything else metric', () => {
  assert.equal(unitsFor('US'), 'imperial');
  assert.equal(unitsFor('CA'), 'imperial');
  assert.equal(unitsFor('MX'), 'metric');
  assert.equal(unitsFor('GB'), 'metric');
  assert.equal(unitsFor('DE'), 'metric');
  assert.equal(unitsFor('JP'), 'metric');
  assert.equal(unitsFor('ZZ'), 'metric', 'unknown marketplace defaults to metric');
});

test('imperial keeps inches/pounds; metric converts to cm/kg', () => {
  assert.equal(units.lengthUnit('imperial'), 'inches');
  assert.equal(units.weightUnit('imperial'), 'pounds');
  assert.equal(units.convertLength(10, 'imperial'), 10);
  assert.equal(units.convertWeight(3, 'imperial'), 3);

  assert.equal(units.lengthUnit('metric'), 'centimeters');
  assert.equal(units.weightUnit('metric'), 'kilograms');
  assert.equal(units.convertLength(10, 'metric'), 25.4);
  assert.equal(units.convertWeight(3, 'metric'), 1.361);
});

test('non-numeric input converts to null', () => {
  assert.equal(units.convertLength('abc', 'metric'), null);
  assert.equal(units.convertWeight(null, 'imperial'), null);
});
