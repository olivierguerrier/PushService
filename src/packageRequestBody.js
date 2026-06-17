// Build the persisted `request_body_json` for a validated, pre-built (thin-path)
// package. Shared by the /push/package route and the AI-fix apply endpoint so
// both store the exact same envelope shape the forwarder expects:
//   patchItem            -> { productType, patches[], changedAttrNames[] }
//   submitJsonListingsFeed -> { marketplaceCode, payload, changedAttrNames[], productType }
// `validated` is the result of packageValidator.validatePackage (its
// sanitizedPackage is used so dropped/unknown attributes never reach Amazon).
function buildRequestBody({ operation, marketplaceCode, productType, validated }) {
  if (operation === 'submitJsonListingsFeed') {
    return {
      marketplaceCode,
      payload: validated.sanitizedPackage,
      changedAttrNames: validated.changedAttrNames,
      productType
    };
  }
  return {
    productType,
    patches: validated.sanitizedPackage.patches,
    changedAttrNames: validated.changedAttrNames
  };
}

module.exports = { buildRequestBody };
