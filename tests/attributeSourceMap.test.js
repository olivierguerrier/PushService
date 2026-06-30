const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').isolate();

const asm = require('../src/sot/attributeSourceMap');

function sampleSources() {
  return {
    snapshot: {
      identity: { brand: 'B. toys', manufacturer: null, item_number: 'BX1749Z', upc: null },
      pricing: { list_price: 9.99, cost_price: null, currency: 'GBP' },
      dimensions: { item: { length: 5, width: 3, height: 2 }, package: { length: 8, width: 4, height: 3 } },
      weights: { item: { value: 0.4 }, package: { value: 0.6 } },
      compliance: { country_of_origin: 'CN' },
      content: {}
    },
    pim: { material_composition: 'Wood', target_gender: 'unisex' },
    pricing: { retail_price: 9.99, sell_price: 4.2 },
    product: { brand: 'B. toys', product_number: 'BX1749Z' },
    content: null,
    live: null
  };
}

test('buildGroundedPackage grounds only attributes with a real source value', () => {
  const sources = sampleSources();
  const out = asm.buildGroundedPackage({
    attrNames: ['brand', 'manufacturer', 'item_dimensions', 'item_weight', 'list_price', 'cost_price', 'material', 'country_of_origin'],
    operation: 'patchItem',
    sources,
    marketplaceCode: 'GB'
  });

  const byPath = Object.fromEntries(out.package.patches.map((p) => [p.path, p.value]));
  // Grounded from real values.
  assert.equal(byPath['/attributes/brand'][0].value, 'B. toys');
  assert.equal(byPath['/attributes/brand'][0].marketplace_id, 'A1F83G8C2ARO7P');
  assert.equal(byPath['/attributes/material'][0].value, 'Wood');
  assert.equal(byPath['/attributes/country_of_origin'][0].value, 'CN');
  // GB is a metric marketplace. item_weight mirrors the single package weight
  // (0.6 lb -> 0.272 kg), NOT the item-only 0.4 lb, since PIM has one weight.
  assert.equal(byPath['/attributes/item_weight'][0].value, 0.272);
  assert.equal(byPath['/attributes/item_weight'][0].unit, 'kilograms');
  assert.equal(out.valueSources.item_weight, 'snapshot.weights.package');
  assert.equal(byPath['/attributes/list_price'][0].value, 9.99);
  assert.equal(byPath['/attributes/list_price'][0].currency, 'GBP');
  assert.equal(byPath['/attributes/cost_price'][0].value, 4.2, 'cost_price falls back to pricing.sell_price');
  // item_dimensions reuses the single (consumer) package dimensions, converted to cm.
  assert.equal(byPath['/attributes/item_dimensions'][0].length.value, 20.32);
  assert.equal(byPath['/attributes/item_dimensions'][0].length.unit, 'centimeters');

  // Provenance is recorded for every grounded attribute.
  assert.equal(out.valueSources.brand, 'snapshot.identity.brand');
  assert.equal(out.valueSources.material, 'pim.material_composition');

  // manufacturer has NO source value anywhere -> omitted, not invented.
  assert.ok(!('/attributes/manufacturer' in byPath), 'manufacturer is omitted');
  assert.ok(out.unresolved.some((u) => u.field === 'manufacturer'));
});

test('buildGroundedPackage never invents: unmapped attributes go to unresolved', () => {
  const out = asm.buildGroundedPackage({
    attrNames: ['accepted_voltage_frequency', 'eu_toys_safety_directive_warning', 'warranty_description'],
    operation: 'patchItem',
    sources: sampleSources(),
    marketplaceCode: 'GB'
  });
  assert.equal(out.package, null, 'nothing grounded -> no package');
  assert.equal(out.resolved.length, 0);
  assert.equal(out.unresolved.length, 3);
  for (const u of out.unresolved) assert.match(u.reason, /no source-field mapping defined/);
});

test('buildGroundedPackage emits a feed message for submitJsonListingsFeed', () => {
  const out = asm.buildGroundedPackage({
    attrNames: ['brand'],
    operation: 'submitJsonListingsFeed',
    sources: sampleSources(),
    marketplaceCode: 'GB',
    sku: 'SKU-9'
  });
  assert.ok(Array.isArray(out.package.messages));
  assert.equal(out.package.messages[0].sku, 'SKU-9');
  assert.equal(out.package.messages[0].attributes.brand[0].value, 'B. toys');
});

test('buildGroundedPackage reports unknown marketplace as unresolved', () => {
  const out = asm.buildGroundedPackage({ attrNames: ['brand'], operation: 'patchItem', sources: sampleSources(), marketplaceCode: 'ZZ' });
  assert.equal(out.package, null);
  assert.match(out.unresolved[0].reason, /unknown marketplace/);
});

test('grounds from raw PIM/product columns using CTF verified aliases (no snapshot)', () => {
  const sources = {
    snapshot: null,
    pim: {
      material_type: 'Wood',
      age_grade: '18 months and up',
      coo: 'CN',
      package_length: 10,
      package_width: 6,
      single_unit_package_height: 4,
      package_weight: 1.2,
      product_taxonomy_subcategory: 'Building Sets',
      bullets: 'Fun to build | Develops motor skills | Ages 18m+',
    },
    product: { manufacturer: 'Branford LTD', brand: 'B. toys' },
    pricing: { retail_price: 14.99, sell_price: 6.25 },
    content: null,
    live: null,
  };

  const out = asm.buildGroundedPackage({
    attrNames: [
      'manufacturer', 'brand', 'material', 'age_range_description', 'country_of_origin',
      'item_package_dimensions', 'item_package_weight', 'item_type_keyword', 'bullet_point', 'list_price', 'cost_price',
    ],
    operation: 'patchItem',
    sources,
    marketplaceCode: 'GB',
  });

  const byPath = Object.fromEntries(out.package.patches.map((p) => [p.path, p.value]));
  assert.equal(byPath['/attributes/manufacturer'][0].value, 'Branford LTD');
  assert.equal(out.valueSources.manufacturer, 'product.manufacturer');
  assert.equal(byPath['/attributes/material'][0].value, 'Wood');
  assert.equal(byPath['/attributes/age_range_description'][0].value, '18 months and up');
  assert.equal(byPath['/attributes/country_of_origin'][0].value, 'CN');
  // GB metric: 10 in -> 25.4 cm, 4 in -> 10.16 cm, 1.2 lb -> 0.544 kg.
  assert.equal(byPath['/attributes/item_package_dimensions'][0].length.value, 25.4);
  assert.equal(byPath['/attributes/item_package_dimensions'][0].length.unit, 'centimeters');
  assert.equal(byPath['/attributes/item_package_dimensions'][0].height.value, 10.16, 'assembled from single_unit_package_height alias');
  assert.equal(byPath['/attributes/item_package_weight'][0].value, 0.544);
  assert.equal(byPath['/attributes/item_package_weight'][0].unit, 'kilograms');
  assert.equal(byPath['/attributes/item_type_keyword'][0].value, 'Building Sets');
  assert.equal(byPath['/attributes/bullet_point'].length, 3, 'pipe-delimited bullets fan out');
  assert.equal(byPath['/attributes/list_price'][0].value, 14.99);
  assert.equal(byPath['/attributes/cost_price'][0].value, 6.25);
});

test('grounds rtip_safety_warning and rtip_items_per_inner_pack from raw PIM columns', () => {
  const sources = {
    snapshot: null,
    pim: { safety_warning_text: 'WARNING: Choking hazard - small parts.', inner_pack_qty: '6' },
    product: null,
    pricing: null,
  };
  const out = asm.buildGroundedPackage({
    attrNames: ['rtip_safety_warning', 'rtip_items_per_inner_pack'],
    operation: 'patchItem',
    sources,
    marketplaceCode: 'US',
  });
  const byPath = Object.fromEntries(out.package.patches.map((p) => [p.path, p.value]));
  assert.equal(byPath['/attributes/rtip_safety_warning'][0].value, 'WARNING: Choking hazard - small parts.');
  assert.equal(out.valueSources.rtip_safety_warning, 'pim.safety_warning_text');
  assert.equal(byPath['/attributes/rtip_items_per_inner_pack'][0].value, 6);
});

test('parses a single "L x W x H" package dimension string into three axes', () => {
  const sources = { snapshot: null, pim: { package_dimensions: '5.5 x 3 x 2 in' }, product: null, pricing: null };
  const out = asm.buildGroundedPackage({ attrNames: ['item_dimensions'], operation: 'patchItem', sources, marketplaceCode: 'US' });
  const dim = out.package.patches[0].value[0];
  assert.equal(dim.length.value, 5.5);
  assert.equal(dim.width.value, 3);
  assert.equal(dim.height.value, 2);
});

test('dimensions and weight follow the marketplace unit system (imperial vs metric)', () => {
  const sources = { snapshot: null, pim: { package_length: 10, package_width: 5, package_height: 2, package_weight: 3 }, product: null, pricing: null };

  const us = asm.buildGroundedPackage({ attrNames: ['item_package_dimensions', 'item_weight', 'item_package_weight'], operation: 'patchItem', sources, marketplaceCode: 'US' });
  const usByPath = Object.fromEntries(us.package.patches.map((p) => [p.path, p.value]));
  assert.equal(usByPath['/attributes/item_package_dimensions'][0].length.value, 10);
  assert.equal(usByPath['/attributes/item_package_dimensions'][0].length.unit, 'inches');
  assert.equal(usByPath['/attributes/item_package_weight'][0].value, 3);
  assert.equal(usByPath['/attributes/item_package_weight'][0].unit, 'pounds');
  // item_weight mirrors the single package weight (same value and unit).
  assert.equal(usByPath['/attributes/item_weight'][0].value, 3);
  assert.equal(usByPath['/attributes/item_weight'][0].unit, 'pounds');
  assert.equal(usByPath['/attributes/item_weight'][0].value, usByPath['/attributes/item_package_weight'][0].value);

  const de = asm.buildGroundedPackage({ attrNames: ['item_package_dimensions', 'item_weight', 'item_package_weight'], operation: 'patchItem', sources, marketplaceCode: 'DE' });
  const deByPath = Object.fromEntries(de.package.patches.map((p) => [p.path, p.value]));
  assert.equal(deByPath['/attributes/item_package_dimensions'][0].length.value, 25.4);
  assert.equal(deByPath['/attributes/item_package_dimensions'][0].length.unit, 'centimeters');
  assert.equal(deByPath['/attributes/item_package_weight'][0].value, 1.361, '3 lb -> kg');
  assert.equal(deByPath['/attributes/item_package_weight'][0].unit, 'kilograms');
  assert.equal(deByPath['/attributes/item_weight'][0].value, 1.361, '3 lb -> kg');
  assert.equal(deByPath['/attributes/item_weight'][0].unit, 'kilograms');
  assert.equal(deByPath['/attributes/item_weight'][0].value, deByPath['/attributes/item_package_weight'][0].value);
});

test('item_weight is grounded from the PIM package weight, not a sibling value', () => {
  const sources = {
    snapshot: null,
    pim: { package_weight: 4.92 },
    product: null,
    pricing: null,
    siblings: {
      candidates: {
        item_weight: [{ value: 6.98, unit: 'pounds', marketplace_id: 'ATVPDKIKX0DER' }]
      },
      provenance: { item_weight: 'sibling:some-uuid vendor W68TD (US)' }
    }
  };
  const out = asm.buildGroundedPackage({ attrNames: ['item_weight', 'item_package_weight'], operation: 'patchItem', sources, marketplaceCode: 'US' });
  const byPath = Object.fromEntries(out.package.patches.map((p) => [p.path, p.value]));
  // PIM grounding wins over the sibling candidate, and both weights match.
  assert.equal(byPath['/attributes/item_weight'][0].value, 4.92);
  assert.equal(byPath['/attributes/item_package_weight'][0].value, 4.92);
  assert.equal(out.valueSources.item_weight, 'pim.package_weight');
  assert.equal(out.valueSources.item_package_weight, 'pim.package_weight');
});

test('collectTargetAttrNames unions Amazon issue attrs, model changed names, and proposed patch paths', () => {
  const names = asm.collectTargetAttrNames({
    details: [{ code: '90220', attributeNames: ['brand', 'material'] }],
    output: {
      changed_attr_names: ['material', 'country_of_origin'],
      proposed_package: { patches: [{ op: 'replace', path: '/attributes/item_weight', value: [] }] }
    }
  });
  assert.deepEqual(names.sort(), ['brand', 'country_of_origin', 'item_weight', 'material']);
});
