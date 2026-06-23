// Measurement-unit conversion for Amazon dimension/weight attributes.
//
// Battat PIM stores linear dimensions in INCHES and weights in POUNDS. Amazon
// expects values in the unit system of the target marketplace: imperial
// (inches / pounds) for the shared NA catalog (US, CA) and metric
// (centimeters / kilograms) everywhere else. Metric marketplaces therefore need
// the numeric value CONVERTED, not just the unit label changed.
'use strict';

const IN_TO_CM = 2.54;
const LB_TO_KG = 0.45359237;

function round(n, places = 3) {
  const f = 10 ** places;
  return Math.round(Number(n) * f) / f;
}

function isMetric(units) {
  return String(units || '').toLowerCase() === 'metric';
}

// Amazon enum value for the length unit in this system.
function lengthUnit(units) {
  return isMetric(units) ? 'centimeters' : 'inches';
}

// Amazon enum value for the weight unit in this system.
function weightUnit(units) {
  return isMetric(units) ? 'kilograms' : 'pounds';
}

// Convert a length given in inches to the marketplace's unit.
function convertLength(inches, units) {
  if (inches == null || inches === '') return null;
  const n = Number(inches);
  if (!Number.isFinite(n)) return null;
  return round(isMetric(units) ? n * IN_TO_CM : n);
}

// Convert a weight given in pounds to the marketplace's unit.
function convertWeight(pounds, units) {
  if (pounds == null || pounds === '') return null;
  const n = Number(pounds);
  if (!Number.isFinite(n)) return null;
  return round(isMetric(units) ? n * LB_TO_KG : n);
}

module.exports = {
  IN_TO_CM,
  LB_TO_KG,
  isMetric,
  lengthUnit,
  weightUnit,
  convertLength,
  convertWeight
};
