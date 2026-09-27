# ADR 0270 — CDP-H: Developer platform — self-service scoped API keys & connector certification

**Status:** implemented (scoped API-key store + verify + auth-middleware wiring + connector-cert lint)
**Date:** 2026-07-05
**Depends on:** ADR 0262 (CDP program + rulings), ADR 0022 (marketplace), ADR 0024 (Connections / `oauthClientStore`), ADR 0035 (pack sandbox), ADR 0002/0006 (auth / RBAC), `middleware/auth.ts`, RFC 0095 (connection packs)
**Part of:** CDP program (ADR 0262). CDP-H, Phase 4 (optional — highest-numbered, lowest-coupling).

## Why this exists

A CDP is also a **developer platform**. openwop-app is already strong here — a full `/v1/*` REST+SSE
API with `/.well-known/openwop` capability discovery (headless-proven, ADR 0168), signed durable
outbound webhooks, an external `@openwop/cli`, an outbound MCP client, and an installable/signed RFC
0095 connector framework. Two gaps remain:

1. **No self-service scoped API keys** — auth is an `OPENWOP_API_KEYS` env CSV (`middleware/auth.ts`);
   there is no per-developer issuance, scoping, or rotation.
2. **No connector certification workflow** — `marketplace` projects on-disk packs with signing/SRI
   trust markers, but there is no in-app lint → sandbox-smoke → review gate before publish.

## Decision

Extend auth + marketplace — no new auth scheme, no second registry (ADR 0262 ruling #1/#5 spirit:
extend the existing owner).

### 1. Self-service scoped API keys / PATs (Phase 4)

A developer-credentials surface issuing **scoped, rotatable** host bearer tokens, composing
`connections/oauthClientStore.ts` + the BYOK `secretResolver` (tokens hashed at rest). Validation
**extends `middleware/auth.ts`** beyond the env CSV, in the existing bearer/cookie modes. Scopes reuse
the RFC 0049 protocol scopes + `host:` management scopes (`accessControlService`). Host-ext — a
host-issued bearer that validates in existing modes is **not** a new wire auth scheme (advertising a
*new* scheme would need an RFC; this doesn't).

### 2. Connector certification workflow (Phase 4)

Extend `marketplace` (ADR 0022) with a certification pipeline: automated pack lint + an **RFC 0035
sandbox smoke** (load/invoke in the vm pack-sandbox) + a review gate, feeding the existing Ed25519
signing + SRI trust markers and the external static-registry publish flow
(`packs/registryInstaller.ts`). Reuses the sandbox + signing seams; adds only the workflow.

### 3. Optional: ephemeral developer test-tenant

An ephemeral throwaway tenant (tenant-isolation already enforced everywhere) with seeded data +
scoped credentials for extension development. Host-ext.

## Scope / non-goals

- **Multi-language generated SDKs** and **API version-negotiation** are noted CDP-program items;
  generated SDKs are host-ext (from the discovery/OpenAPI surface), but explicit version negotiation
  is a wire contract → RFC. Neither is built here beyond the scoped-key foundation.
- Inbound MCP server graduation (default-off today) is an adjacent enhancement, out of scope.

## Phased plan

1. Scoped API-key store + `middleware/auth.ts` validation extension + issuance/rotation UI.
2. Marketplace certification pipeline (lint + sandbox smoke + review → sign/publish).
3. (Optional) ephemeral dev test-tenant.
4. Verify: scoped-key authz boundary test (a key can't exceed its scopes); cert-pipeline reject test.

## Open questions

- [ ] Key scope granularity — reuse RFC 0049 scopes verbatim (recommended) vs a CDP-specific scope set. Default: reuse.
- [ ] Certification: fully automated vs human-review-required for public listing. Default: human review for public, auto for private.

## Consequences

The platform becomes safely programmable by third parties (scoped keys) and its connector ecosystem
gains a trust gate (certification) — both as extensions of the existing auth + marketplace owners, no
parallel systems. Deliberately last in the program (Phase 4): lowest coupling, depends on nothing
earlier, and least CDP-specific.
