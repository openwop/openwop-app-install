# 0303 — Honor pack-delivered `provider.vendor` (RFC 0123 graduation)

Status: implemented

## Context

RFC **0123** (connection-pack provider `vendor`) is **Active** on the OpenWOP wire: an
additive OPTIONAL free-form string on the RFC 0095 provider manifest naming the commercial
vendor/ecosystem ("Microsoft 365", "Google", "Workday") so a host/registry groups the
connector catalog by the vendors a customer uses. Presentational ONLY — it is NOT the
RFC 0047 resolution key, gates no capability, and a manifest without it stays valid.

This host **already** groups its connector catalog by vendor for the **built-in**
providers (ADR 0185, `providerRegistry.BUILTIN_VENDOR` → `ProviderManifest.vendor`). But
**pack-delivered** connectors did not get grouped: `connectionPackLoader.toProviderManifest`
deliberately dropped `vendor` because the vendored RFC 0095 provider schema is
`additionalProperties:false`, so a pack could not even *declare* `provider.vendor` without a
spec amendment. The loader carried the explicit note:

> `vendor` (catalog grouping) is NOT read from the pack manifest — the normative RFC 0095
> provider schema is `additionalProperties:false` … (ADR 0185, follow-on).

RFC 0123 is exactly that follow-on. Its Active→Accepted work is (a) the spec/schema
amendment adding `provider.vendor` + conformance (openwop steward's lane), and (b) the host
honoring it (this ADR).

## Decision

Honor the pack-delivered `provider.vendor` so a pack-delivered connector groups under its
declared vendor via the **same** ADR 0185 catalog the built-ins use. Host work only — rides
Active RFC 0123, **no new RFC** (the wire shape is the steward's amendment; graduating it is
the bootstrap-waiver implementation).

1. **Vendored schema** — add the additive OPTIONAL `vendor` (`string`, `minLength:1`,
   free-form/no enum) to the provider object in the app's vendored
   `schemas/connection-pack-manifest.schema.json`, matching the RFC 0123 shape. Kept in
   lockstep with the steward's normative amendment + the pinned `@openwop/openwop-conformance`
   schema (repin when it bumps).
2. **Loader honor** — `connectionPackLoader.toProviderManifest` reads `p.vendor` →
   `ProviderManifest.vendor` (`...(p.vendor ? { vendor: p.vendor } : {})`); the manifest TS
   type gains `provider.vendor?: string`. Absent ⇒ own-label group (unchanged).
3. **No new grouping surface** — the catalog already reads `ProviderManifest.vendor`
   (ADR 0185); this only populates it for pack-delivered providers. Presentational, gates
   nothing, not the RFC 0047 resolution key.

### Why no new RFC

`provider.vendor` is the steward's RFC 0095 schema amendment (RFC 0123). The host merely
reads an OPTIONAL presentational field — it advertises no capability and changes no wire it
owns. Per CLAUDE.md, riding an accepted/Active-graduating RFC's shape is host work; the spec
surface lives in `../openwop`.

## Alternatives weighed

- **Wait for the conformance-package schema bump before touching the app schema.** Rejected:
  the app validates against its OWN vendored schema copy; adding the field there now (matched
  to the RFC 0123 shape, coordinated with the steward) is forward-compatible and unblocks the
  host witness. The vendored copy repins to the published schema when it lands.
- **Read `vendor` but keep the schema `additionalProperties:false` rejecting it.** Impossible
  — the pack would fail validation before the loader ever saw it. The schema field is required.
- **A new pack-vendor grouping map (like `BUILTIN_VENDOR`).** Rejected — that shadows the
  ADR 0185 catalog. The pack DECLARES its own vendor; the host honors it directly.

## Witness

`backend/typescript/src/features/connections/__tests__/connectionPackVendor.test.ts` (3
tests): a pack declaring `provider.vendor` **validates** (schema accepts it) + resolves with
that vendor on its `ProviderManifest` (→ ADR 0185 grouping); a pack **without** it stays
valid + falls back to own-label; an arbitrary free-form vendor string is honored (no enum).

## Implementation

| What | File |
|---|---|
| Vendored schema — OPTIONAL `provider.vendor` | `schemas/connection-pack-manifest.schema.json` |
| Loader honor + manifest type + note | `backend/typescript/src/features/connections/connectionPackLoader.ts` |
| Witness | `.../connections/__tests__/connectionPackVendor.test.ts` |

## Cross-refs

- RFC 0123 (connection-pack provider `vendor`), RFC 0095 (connection packs), RFC 0047
  (provider resolution — vendor is explicitly NOT this key)
- ADR 0185 (connector-catalog vendor grouping — the built-in grouping this extends)
- ADR 0024/0037 (Connections / connector framework)
