// Marketplace reference (ported from FlyApp config/marketplaces.js).
// `code` is the Battat marketplace code; `amazonMarketplaceId` is the value
// SP-API expects in the marketplaceIds query param; `region` (NA/EU/FE)
// drives endpoint selection; `currency` is the ISO-4217 code used to build
// list_price / cost_price envelopes; `units` ('imperial'|'metric') is the
// measurement system Amazon expects for dimension/weight attributes in that
// marketplace. Battat PIM stores inches/pounds, so metric marketplaces require
// converting the values (see src/units.js), not just relabeling the unit.
// Only the shared NA catalog (US/CA) takes imperial; everywhere else — incl.
// Mexico, EU/MENA, and the Far East — expects metric.
const MARKETPLACES = [
  { code: 'US', label: 'United States',        amazonMarketplaceId: 'ATVPDKIKX0DER', currency: 'USD', region: 'NA', units: 'imperial', storeDomain: 'amazon.com' },
  { code: 'CA', label: 'Canada',               amazonMarketplaceId: 'A2EUQ1WTGCTBG2', currency: 'CAD', region: 'NA', units: 'imperial', storeDomain: 'amazon.ca' },
  { code: 'MX', label: 'Mexico',               amazonMarketplaceId: 'A1AM78C64UM0Y8', currency: 'MXN', region: 'NA', units: 'metric',   storeDomain: 'amazon.com.mx' },
  { code: 'GB', label: 'United Kingdom',       amazonMarketplaceId: 'A1F83G8C2ARO7P', currency: 'GBP', region: 'EU', units: 'metric',   storeDomain: 'amazon.co.uk' },
  { code: 'DE', label: 'Germany',              amazonMarketplaceId: 'A1PA6795UKMFR9', currency: 'EUR', region: 'EU', units: 'metric',   storeDomain: 'amazon.de' },
  { code: 'FR', label: 'France',               amazonMarketplaceId: 'A13V1IB3VIYZZH', currency: 'EUR', region: 'EU', units: 'metric',   storeDomain: 'amazon.fr' },
  { code: 'IT', label: 'Italy',                amazonMarketplaceId: 'APJ6JRA9NG5V4',  currency: 'EUR', region: 'EU', units: 'metric',   storeDomain: 'amazon.it' },
  { code: 'ES', label: 'Spain',                amazonMarketplaceId: 'A1RKKUPIHCS9HS', currency: 'EUR', region: 'EU', units: 'metric',   storeDomain: 'amazon.es' },
  { code: 'AE', label: 'United Arab Emirates', amazonMarketplaceId: 'A2VIGQ35RCS4UG', currency: 'AED', region: 'EU', units: 'metric',   storeDomain: 'amazon.ae' },
  { code: 'SA', label: 'Saudi Arabia',         amazonMarketplaceId: 'A17E79C6D8DWNP', currency: 'SAR', region: 'EU', units: 'metric',   storeDomain: 'amazon.sa' },
  { code: 'AU', label: 'Australia',            amazonMarketplaceId: 'A39IBJ37TRP1C6', currency: 'AUD', region: 'FE', units: 'metric',   storeDomain: 'amazon.com.au' },
  { code: 'JP', label: 'Japan',                amazonMarketplaceId: 'A1VC38T7YXB528', currency: 'JPY', region: 'FE', units: 'metric',   storeDomain: 'amazon.co.jp' },
  { code: 'SG', label: 'Singapore',            amazonMarketplaceId: 'A19VAU5U5O7RUS', currency: 'SGD', region: 'FE', units: 'metric',   storeDomain: 'amazon.sg' },
  { code: 'SE', label: 'Sweden',               amazonMarketplaceId: 'A2NODRKZP88ZB9', currency: 'SEK', region: 'EU', units: 'metric',   storeDomain: 'amazon.se' }
];

const byCode = new Map(MARKETPLACES.map((m) => [m.code, m]));
const byAmazonId = new Map(MARKETPLACES.filter((m) => m.amazonMarketplaceId).map((m) => [m.amazonMarketplaceId, m]));

function resolveByCode(code) { return byCode.get(String(code || '').toUpperCase()); }

module.exports = {
  MARKETPLACES,
  resolveByCode,
  resolveByAmazonId: (id) => byAmazonId.get(id),
  // Measurement system for a marketplace; defaults to metric (the safer default
  // for the wider catalog) when the code is unknown.
  unitsFor: (code) => {
    const mp = resolveByCode(code);
    return mp && mp.units ? mp.units : 'metric';
  }
};
