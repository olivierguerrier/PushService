// Region resolver for the Selling Partner API. Maps a marketplace code to
// its regional cluster (NA/EU/FE) and to the matching endpoint host. The
// same LWA refresh token works across all three regions.
const env = require('../../config/env');
const { resolveByCode } = require('../../config/marketplaces');

const REGION_BY_CODE = {
  US: 'NA', CA: 'NA', MX: 'NA',
  GB: 'EU', DE: 'EU', FR: 'EU', IT: 'EU', ES: 'EU',
  NL: 'EU', PL: 'EU', AE: 'EU', SA: 'EU', SE: 'EU',
  AU: 'FE', JP: 'FE', SG: 'FE'
};

function regionFor(marketplaceCode) {
  const code = String(marketplaceCode || '').toUpperCase();
  const region = REGION_BY_CODE[code];
  if (!region) throw new Error(`Unknown SP-API region for marketplace code: ${marketplaceCode}`);
  return region;
}

function endpointFor(region) {
  const r = String(region || '').toUpperCase();
  if (r === 'NA') return env.SP_API_ENDPOINT_NA;
  if (r === 'EU') return env.SP_API_ENDPOINT_EU;
  if (r === 'FE') return env.SP_API_ENDPOINT_FE;
  throw new Error(`Unknown SP-API region: ${region}`);
}

function endpointForMarketplace(marketplaceCode) {
  return endpointFor(regionFor(marketplaceCode));
}

function amazonMarketplaceId(marketplaceCode) {
  const mp = resolveByCode(marketplaceCode);
  if (!mp || !mp.amazonMarketplaceId) {
    throw new Error(`No amazonMarketplaceId configured for marketplace code: ${marketplaceCode}`);
  }
  return mp.amazonMarketplaceId;
}

module.exports = {
  regionFor,
  endpointFor,
  endpointForMarketplace,
  amazonMarketplaceId,
  REGION_BY_CODE
};
