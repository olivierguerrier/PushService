// Language <-> marketplace map (ported from FlyApp config/languages.js).
// Used to decide which content language a marketplace publishes in and to
// build the BCP-47 language_tag for Amazon attribute envelopes.
const MP_PRIMARY_LANGUAGE = {
  US: 'EN', CA: 'EN', GB: 'EN', AU: 'EN',
  FR: 'FR', DE: 'DE', IT: 'IT', ES: 'ES', MX: 'ES'
};

const LANGUAGE_GROUPS = {
  EN: ['US', 'CA', 'GB', 'AU'],
  FR: ['FR', 'CA'],
  DE: ['DE'],
  IT: ['IT'],
  ES: ['ES', 'MX']
};

// BCP-47 tag per marketplace for Amazon attribute envelopes.
const LANGUAGE_TAG_BY_MP = {
  US: 'en_US', CA: 'en_CA', MX: 'es_MX', GB: 'en_GB',
  DE: 'de_DE', FR: 'fr_FR', IT: 'it_IT', ES: 'es_ES',
  AE: 'en_AE', SA: 'ar_SA', AU: 'en_AU', JP: 'ja_JP',
  SG: 'en_SG', SE: 'sv_SE'
};

function languageForMarketplace(code) {
  return MP_PRIMARY_LANGUAGE[String(code || '').toUpperCase()] || null;
}
function marketplacesForLanguage(lang) {
  return LANGUAGE_GROUPS[String(lang || '').toUpperCase()] || [];
}
function languageTagFor(code) {
  return LANGUAGE_TAG_BY_MP[String(code || '').toUpperCase()] || 'en_US';
}

module.exports = {
  MP_PRIMARY_LANGUAGE,
  LANGUAGE_GROUPS,
  LANGUAGE_TAG_BY_MP,
  languageForMarketplace,
  marketplacesForLanguage,
  languageTagFor
};
