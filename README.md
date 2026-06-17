# amazon-push-service

A standalone, **fully segregated** service that is the only system allowed to
write Battat product data to Amazon via the Selling Partner API (SP-API). It
reads the source of truth (ListingApp / PIM + pricing), builds the SP-API
payloads itself, pushes them to Amazon, and keeps a complete, tamper-evident
audit trail.

It shares **no code, no database, and no process** with FlyApp. Any reusable
logic from FlyApp has been *copied* (ported), never imported.

## Why it exists

Writing to Amazon is the highest-blast-radius thing the toolchain does. This
service isolates that capability behind its own process, port, database,
credentials, and kill switch so it can be locked down, audited, and operated
independently of the rest of FlyApp.

## Architecture

```
ListingApp (PIM/pricing bridge)            Amazon SP-API
        │                                        ▲
        ▼                                        │
  sotClient ─► translator ─► jobs/submissions ─► forwarder
                                  │   ▲              │
                                  ▼   │              ▼
                              audit trail      ControlTower vault
                          (SQLite + JSONL)     (SP-API + LA creds)
                                  ▲
                            REST API + UI
```

- **sotClient** (`src/sot/`) reads PIM + seasonal pricing from ListingApp's
  `/api/flyapp-bridge/*` endpoints and listing copy through a pluggable
  `contentSource` adapter, then assembles a normalized snapshot + content hash.
- **translator** (`src/translator/`) turns the snapshot into schema-filtered
  Amazon attributes and JSON-Patch / feed payloads.
- **spapi** (`src/spapi/`) is the ported SP-API client (LWA token lifecycle,
  Listings Items, Feeds, Catalog, Product Type schemas).
- **orchestration** (`src/jobs.js`, `src/submissions.js`, `src/forwarder.js`,
  `src/idempotency.js`, `src/approvalPolicy.js`, `src/poller.js`) manages the
  push lifecycle: idempotent submission, per-scope approval, live forwarding,
  async feed polling, and boot-time recovery.
- **package ingestion** (`src/packageValidator.js`) validates caller-built
  Amazon payloads against the Product Type schema for the thin `/push/package`
  path (FlyApp builds the JSON; this service reviews, approves, and pushes it).
- **reconciliation** (`src/reconciliation.js`, `src/reconcileDiff.js`,
  `src/reconciler.js`) schedules and runs over-time SP-API read-backs to verify
  pushed data is still reflected live on Amazon.
- **audit trail** (`src/audit/`) is two-layer: an append-only, hash-chained
  `audit_events` table (UPDATE/DELETE blocked by triggers) **and** a
  synchronous JSONL mirror for crash durability.

## Segregation & safety

- Separate repo / process / port / SQLite DB (`push.db`) / `.env` / vault scope.
- **Writes off by default**: `SPAPI_WRITES_ENABLED=false` → every write returns
  503. Flip it on only when you mean it.
- Bearer service tokens for machine callers; admin JWT / token for the UI.
- `Idempotency-Key` dedup, per-scope rate limits, helmet + CORS allow-list,
  secret scrubbing on every error/log/audit path.
- Per-scope approval policy (`auto` vs email): content/images/revert auto;
  pricing/VC-fix require an emailed human approval click.

## Getting started

```bash
npm install
cp .env.example data/.env   # then edit data/.env
npm run init-db
npm run smoke               # verifies the LWA credential chain (read-only)
npm start                   # or: pm2 start ecosystem.config.js
```

Open the operator console at `http://<host>:<PORT>/` and connect with the
`ADMIN_TOKEN`.

## REST API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/push/preview` | bearer | Build payload + optional Amazon dry-run. No write. |
| `POST` | `/push` | bearer + writes-on | **Fat path:** build from SoT + push; fans out to submissions. Returns `{ jobId }`. |
| `POST` | `/push/package` | bearer + writes-on | **Thin path:** accept a caller-built Amazon JSON package, schema-validate, approve + push. |
| `GET` | `/push/jobs/:jobUuid` | bearer | Parent job status + child submissions. |
| `GET` | `/push/submissions/:uuid` | bearer | One submission + audit timeline + reconciliation checks. |
| `POST` | `/push/revert/:uuid` | bearer + writes-on | Inverse patch from captured prior state. |
| `GET` | `/admin/reconciliation` | admin | Recent over-time reconciliation checks (for the console). |
| `GET` | `/audit` | admin | Query audit events. |
| `GET` | `/audit/verify` | admin | Verify the hash chain. |
| `GET` | `/audit/export` | admin | Export JSONL / CSV. |
| `GET` | `/healthz` | public | Liveness + writes-enabled + version. |
| `GET` | `/approve/:token` | token | Email approval landing page. |

### Push request shape

The caller supplies each target's listing **coordinates** (the ASIN↔SKU↔vendor
topology lives in FlyApp, not the PIM); everything that goes *into* the payload
is built here from the source of truth.

`asin` is the **default identifier**: it is required on every target, and the
service tracks each push at the ASIN level (jobs, submissions, audit, console,
and approval emails all lead with the ASIN). `sku` remains required at forward
time only because Amazon's Listings Items API addresses listings by
`{sellerId}/{sku}` — it is the technical execution key, not the identifier the
system is organised around.

`parentSku` (optional) is the **vendor SKU fallback**. Some listings are
registered under a parent vendor code's SKU even though the target vendor code's
documented SKU (from SP-API / the vendor xlsx) is different — often equal to the
ASIN. When Amazon rejects the documented SKU with error `101168` ("You can't
change Vendor SKU from its original value '<sku>'" on `vendor_sku`), the
forwarder automatically retries the **same vendor code** using this caller-
supplied `parentSku`. The parent SKU is sourced from the caller (FlyApp), never
inferred from Amazon's response. The SKU that actually succeeded is recorded as
`effectiveSku` and is what reconciliation read-backs and reverts target.

```json
{
  "scope": "PRICING",
  "fieldNames": ["list_price", "cost_price"],
  "targets": [
    {
      "asin": "B0XXXXXXX",
      "sellerId": "VENDORCODE",
      "sku": "VENDOR-SKU",
      "itemNumber": "BX1234",
      "productId": 98765,
      "marketplaceCode": "US",
      "productType": "TOYS_AND_GAMES"
    }
  ]
}
```

### Pre-built package shape (`POST /push/package`)

For callers (e.g. FlyApp) that build the Amazon payload themselves. The package
is **not** assembled from the SoT here — instead it is validated against the
live Product Type schema (unknown attributes are rejected, or dropped + warned
when `allowUnknownAttributes` is true), stored verbatim (`raw_package_json`),
run through the same approval policy, and forwarded by the same forwarder. The
changed attribute names are derived from the package so revert and over-time
reconciliation still work.

```json
{
  "scope": "CONTENT_MATCH",
  "operation": "patchItem",
  "allowUnknownAttributes": false,
  "targets": [
    {
      "asin": "B0XXXXXXX",
      "sellerId": "VENDORCODE",
      "sku": "VENDOR-SKU",
      "parentSku": "PARENT-VENDOR-SKU",
      "marketplaceCode": "US",
      "productType": "TOYS_AND_GAMES",
      "package": {
        "productType": "TOYS_AND_GAMES",
        "patches": [
          { "op": "replace", "path": "/attributes/item_name", "value": [{ "value": "New title", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" }] }
        ]
      }
    }
  ]
}
```

For `operation: "submitJsonListingsFeed"` the package carries `{ messages: [...] }`
(JSON_LISTINGS_FEED) instead of `patches`. Both paths keep FlyApp segregated:
it talks to this service over HTTP only — never its database.

### Forward-time resilience (patchItem)

The forwarder hardens live `patchItem` writes against two well-known Amazon
failure modes:

- **Transient internal error (`4000000`)** — Amazon's generic "an internal
  error has occurred, try again". The same patch is re-submitted up to
  `SPAPI_INTERNAL_RETRY_MAX` times (default 2) with the
  `SPAPI_INTERNAL_RETRY_BACKOFF_MS` backoff before settling `FAILED`.
- **Vendor SKU rejection (`101168`)** — "you can't change Vendor SKU from its
  original value". The forwarder retries the **same vendor code** through tiered
  fallbacks, recording the winning `effectiveSku`:
  1. the caller-supplied `parentSku` (see above — authoritative);
  2. if that is absent or *also* rejected with `101168`, the canonical SKU
     Amazon names in the rejection message, parsed out as a last resort
     (EN/DE locales). Each candidate is tried once, so it never loops.
- **Already-listed no-op (`101161` / `101165`)** — once addressed by the correct
  SKU, Amazon may reject a content match because the SKU↔ASIN association already
  exists ("matches another product … SKUs cannot be duplicated" / "identifiers
  aren't unique"). The desired state already holds, so the forwarder settles the
  submission as **`APPLIED` (a successful no-op)** rather than `FAILED`, keeping
  the issues on the row for audit and emitting a `noop_already_listed` event.

These are scoped narrowly (only their specific issue codes) so genuine
validation errors are never silently retried, and they compose: a `4000000`
on either the documented-SKU or parent-SKU attempt is retried in place.

To re-settle historical rows that failed before this logic existed, run
`npm run repush-101168` (dry-run) then `npm run repush-101168 -- --apply`. It
re-pushes each `FAILED` `101168` patch through the forwarder so the tiered
fallback (and the no-op resolution) applies. Honours the kill switch.

## Over-time reconciliation

After a write reaches `APPLIED`, the service schedules SP-API read-backs at the
`RECON_OFFSETS` (default +1h, +24h, +7d). The reconciler cron GETs the live
listing, compares the pushed attribute values against what Amazon reports, and
settles each check to `MATCH` / `DRIFT` / `MISSING` / `ERROR`. Outcomes are
recorded on the submission's hash-chained audit timeline (`reconciled_ok`,
`drift_detected`) and shown in the operator console's **Reconciliation** tab.

The comparator (`src/reconcileDiff.js`) is intentionally tolerant — it checks
that each value we pushed is still **contained** in Amazon's (often enriched)
response, rather than requiring byte-equality. Run with `RECON_ALERT_ENABLED=false`
first so drift is recorded but not emailed while the rules are calibrated
against real responses, then enable alerts to `RECON_ALERT_EMAIL`.

## Content source (v1 decision)

Amazon listing copy (title/bullets/description) is **not** part of ListingApp's
PIM — in FlyApp it lives in `ref_content_sot`. This service reads it through a
pluggable adapter selected by `CONTENT_SOURCE`:

- `none` (default) — push only PIM/pricing-derived attributes; content is out
  of scope for v1.
- `http` — read `{ title, description, bullets[] }` from `CONTENT_SOURCE_URL`
  (a read-only endpoint exposed by ListingApp or FlyApp).

Switching adapters does not change the rest of the architecture.

## Open items to confirm

- Content source for v1 (`none` vs an `http` endpoint).
- Whether to provision a dedicated SP-API LWA app (strongest segregation) or
  reuse the existing refresh token under a distinct vault provider.
- PIM field-name mapping in `src/sot/sotClient.js#mapPimRow` should be tuned
  against live `/api/flyapp-bridge/pim-data` rows.

## Tests

```bash
npm test   # translator, audit, idempotency, kill switch, package ingestion, reconciliation
```

Tests require Node 24 (matching `engines` and the compiled `better-sqlite3`).
If `node -v` on your PATH is older, run them with the v24 binary explicitly,
e.g. `& "C:\Program Files\nodejs\node.exe" --test`.
