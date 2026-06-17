// Curated reference of the Amazon SP-API Listings / Feeds error codes this
// service sees most often, with a plain-English meaning and the typical fix.
//
// This is deliberately a small, hand-maintained knowledge base (NOT scraped
// docs) that we feed into the AI resolver's prompt so the model grounds its
// diagnosis in how Amazon actually behaves, instead of guessing from the raw
// message alone. The live Product Type schema (productTypes.getSchema) is the
// authority on valid attribute shapes; this table is the authority on what a
// given error code means and how it is usually resolved.
//
// Keep entries terse. `fix` should describe the corrective action a corrected
// package would take; `data_needed` flags codes that usually require a real
// source value (which the model must pull from the snapshot, not invent).

const ERROR_CODES = {
  '90220': {
    title: 'Required attribute missing',
    meaning: "A required attribute for the product type is absent from the listing (message names the attribute, e.g. \"'Item Package Dimensions' is required but missing\").",
    fix: 'Add the named attribute with a value sourced from PIM/snapshot, shaped exactly as the product type schema requires (units, marketplace_id, etc.).',
    data_needed: true
  },
  '8560': {
    title: 'Missing/invalid required attribute (data quality)',
    meaning: 'Amazon data-quality rejection: a required field is missing or malformed for the targeted attribute.',
    fix: 'Provide the missing/required value in the schema-correct shape, or correct the malformed value.',
    data_needed: true
  },
  '8541': {
    title: 'Invalid attribute value',
    meaning: 'A supplied attribute value is not accepted (wrong enum, out-of-range number, bad format).',
    fix: 'Replace with a value valid per the product type schema (matching enum/format/units).',
    data_needed: false
  },
  '4000001': {
    title: 'Invalid value / validation error',
    meaning: 'Generic Listings validation failure on a submitted value or structure.',
    fix: 'Correct the value/shape to match the product type schema; remove attributes the schema does not define.',
    data_needed: false
  },
  '4000000': {
    title: 'Transient internal error',
    meaning: 'Amazon-side generic internal error ("there was a problem, try again"). Not caused by the payload.',
    fix: 'No payload change needed — this is retried automatically by the forwarder. Do NOT fabricate a fix; mark unresolved if this is the only issue.',
    data_needed: false,
    transient: true
  },
  '101161': {
    title: 'Item already listed / identifiers not unique',
    meaning: 'The SKU<->ASIN match already exists; the write is effectively a no-op. The forwarder folds this into APPLIED.',
    fix: 'Usually no fix required. Only act if the operator intends to change attributes on the existing listing.',
    data_needed: false
  },
  '101165': {
    title: 'Identifiers match multiple/existing catalog items',
    meaning: "External ID / ASIN matches existing catalog items because identifiers are not unique. Message: update values so they don't conflict, then resubmit.",
    fix: 'Adjust the conflicting identifier attributes (e.g. external_product_id / vendor_sku) so they resolve to the intended single catalog item, or drop the conflicting identifier.',
    data_needed: true
  },
  '101168': {
    title: "Can't change Vendor SKU from its original value",
    meaning: 'The path SKU used is not the SKU the listing is registered under; Amazon names the canonical SKU in the message.',
    fix: 'Re-target the listing using the correct (parent) vendor SKU. The forwarder already retries known SKU fallbacks; only override the SKU here if those are exhausted.',
    data_needed: true
  },
  '18027': {
    title: 'Missing required attribute for product type',
    meaning: 'Feed/listing rejected because a product-type-required attribute was not supplied.',
    fix: 'Add the required attribute from the snapshot in schema-correct shape.',
    data_needed: true
  }
};

// Build a compact reference object covering only the codes present in a set of
// issues, so the prompt carries just the relevant guidance (plus a short note
// for any code we do not have an entry for).
function referenceForCodes(codes = []) {
  const out = {};
  const seen = new Set();
  for (const raw of codes) {
    const code = String(raw || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out[code] = ERROR_CODES[code] || {
      title: 'Unknown/unlisted code',
      meaning: 'No curated reference for this code. Rely on the issue message and the product type schema.',
      fix: 'Diagnose from the message + schema; only emit attributes the schema defines.',
      data_needed: false
    };
  }
  return out;
}

module.exports = { ERROR_CODES, referenceForCodes };
