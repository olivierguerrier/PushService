// Zod schemas for the write/preview request bodies. Centralised so the
// routes stay thin and the error messages are consistent.
const { z } = require('zod');

const targetSchema = z.object({
  // ASIN is the canonical/default identifier: the caller (FlyApp) addresses
  // every target at the ASIN level and we track it as such throughout the
  // service. SKU is retained only as the technical key the Amazon Listings
  // Items API requires in its path; it is not the identifier the system is
  // organised around.
  // It is accepted as optional here so a missing ASIN does not 400 the whole
  // batch; the push routes enforce it per target and record a visible FAILED
  // submission for any target that arrives without one (see handleTarget /
  // handlePackageTarget).
  asin: z.string().min(1).optional().nullable(),
  sellerId: z.string().min(1).optional().nullable(),
  vendorCode: z.string().min(1).optional().nullable(),
  sku: z.string().min(1).optional().nullable(),
  // Parent vendor code's SKU, supplied by the caller (FlyApp). Some listings
  // are registered under a parent vendor code's SKU even though the target
  // vendor code's documented SKU (from SP-API / the vendor xlsx) is different
  // (often equal to the ASIN). When Amazon rejects the documented SKU with the
  // "can't change Vendor SKU from its original value" error (101168), the
  // forwarder retries the SAME vendor code using this parent SKU.
  parentSku: z.string().min(1).optional().nullable(),
  parentVendorSku: z.string().min(1).optional().nullable(),
  itemNumber: z.string().min(1).optional().nullable(),
  productId: z.union([z.string(), z.number()]).optional().nullable(),
  marketplaceCode: z.string().min(2),
  productType: z.string().min(1),
  packageLevel: z.enum(['unit', 'case', 'pallet']).optional().nullable(),
  fieldNames: z.array(z.string()).optional().nullable(),
  idempotencyKey: z.string().min(1).optional().nullable(),
  // Free-form caller metadata. Strictly descriptive — surfaced in the
  // operator console + audit so reviewers see context (customer, season,
  // lifecycle status, etc.) without it ever influencing payload-building,
  // approval policy, or anything sent to Amazon.
  meta: z.record(z.any()).optional().nullable()
}).transform((t) => ({
  ...t,
  sellerId: t.sellerId || t.vendorCode || null,
  parentSku: t.parentSku || t.parentVendorSku || null
}));

const previewSchema = targetSchema;

const pushSchema = z.object({
  scope: z.string().min(1).default('VCFIX'),
  fieldNames: z.array(z.string()).optional().nullable(),
  label: z.string().optional().nullable(),
  // One free-text note from the requester for the human approver. Descriptive
  // only — surfaced in the approval email, approval page, console, and audit;
  // never influences payload-building, approval policy, or anything sent to
  // Amazon. Applies to every submission the push creates.
  comment: z.string().trim().max(2000).optional().nullable(),
  operation: z.enum(['patchItem', 'submitJsonListingsFeed']).default('patchItem'),
  targets: z.array(targetSchema).min(1)
});

// ── Pre-built package ingestion (the "thin" path) ────────────────────────────
// FlyApp (or another caller) builds the Amazon payload itself and submits it
// for review + push. We accept it loosely here (z.any() for the package body)
// and do the real validation in packageValidator against the live productType
// schema — Zod only enforces the envelope/coordinates.
const patchOpSchema = z.object({
  op: z.enum(['add', 'replace', 'delete']),
  path: z.string().min(1),
  value: z.any().optional()
});

const feedMessageSchema = z.object({
  messageId: z.union([z.string(), z.number()]).optional(),
  sku: z.string().min(1),
  operationType: z.string().optional(),
  productType: z.string().optional(),
  attributes: z.record(z.any())
});

// A package is either a patchItem package or a feed package; the route picks
// the validator by `operation`.
const packageSchema = z.union([
  z.object({ productType: z.string().min(1).optional(), patches: z.array(patchOpSchema).min(1) }).passthrough(),
  z.object({ header: z.any().optional(), messages: z.array(feedMessageSchema).min(1) }).passthrough()
]);

const packageTargetSchema = targetSchema.and(z.object({ package: packageSchema }));

const pushPackageSchema = z.object({
  scope: z.string().min(1).default('VCFIX'),
  label: z.string().optional().nullable(),
  // See pushSchema.comment — requester note for the approver, descriptive only.
  comment: z.string().trim().max(2000).optional().nullable(),
  operation: z.enum(['patchItem', 'submitJsonListingsFeed']).default('patchItem'),
  allowUnknownAttributes: z.boolean().optional().default(false),
  targets: z.array(packageTargetSchema).min(1)
});

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const err = new Error('validation_error');
    err.status = 400;
    err.details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw err;
  }
  return result.data;
}

module.exports = { targetSchema, previewSchema, pushSchema, packageSchema, packageTargetSchema, pushPackageSchema, parse };
