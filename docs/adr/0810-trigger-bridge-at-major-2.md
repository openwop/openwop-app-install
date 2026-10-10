# ADR 0810 — the trigger bridge is advertised at major 2

Status: Accepted (2026-10-03; implemented in the PR that adds this file — see § Implementation record)

- **Supersedes ADR 0793 for one line:** "v2 discovery carries no `triggerBridge`
  family on this host … Advertising the family on v2 is separate." This is that
  separate decision. The rest of ADR 0793 (the signed, credential-less ingest)
  stands.
- **Wire:** none new. The family, its six facets and the v2 page schema are
  already in the corpus (`spec/v2/declaration.json` families[`triggerBridge`];
  `schemas/v2/capabilities.schema.json#triggerBridge`; RFC 0232). The v2
  scenarios that witness it ship in suite 2.45.11.
- **Decided with the user** (2026-10-03): the full sequence (advert, gate,
  deploy, re-cut major 2). In the spec session the maintainer chose this path,
  option (b), over loosening certification, option (a).

## Context

RFC 0230 and RFC 0232 can reach `Accepted` only from a **certified** production
bundle that carries their rows. The 062381a5 cut (ADR 0805) measured why neither
bundle qualified:

- **Major 1** carries every trigger row: 20 pass and 2 are inapplicable for
  stated reasons. But it never certifies on a production host. "A bundle with
  blocked > 0 does not certify" (RFC 0168 §E.1) is bundle-wide, and about 350
  seam-only rows are always blocked there.
- **Major 2** certifies (0 blocked), but carried no trigger rows. This host did
  not advertise the family at v2, and the scenarios ran only at v1.

The spec half (2.45.11) ports the scenarios to v2. This ADR is the host half.

## Decision

1. **One source for both majors.** `triggerBridgeFacets()` in
   `routes/discovery.ts` returns `subscriptionStates`, `dedup`, `retryPolicy`,
   `deadLetter`, `sources` and `ingestion` (with `inboundSigning` under its flag),
   every gate the same predicate its route checks.
   - v1 is `{supported: true, ...facets}`.
   - v2 is `{status: 'experimental', since, until, witness: 'witnessable-gated', ...facets}`.
   - `status` and `witness` are the declaration's values.
   - A test asserts the two facet sets are equal, and that turning the signing
     flag off drops `inboundSigning` from both.
2. **No handler changes.** The v2 surface was already reachable:
   - the v2 mount rewrites `/trigger-subscriptions/…` onto the v1 handlers;
   - `v2Identity` accepts both bound-id spellings (`~2F` and `%2F`);
   - `projectV2RunIds` binds every schema-typed `subscriptionId` in a response,
     including the dead-letter record's nested `attempt.subscriptionId` and
     `stateChange.subscriptionId`.
   - The test validates a live v2 page against the **closed** v2 page schema,
     which fails on any unbound id.
3. **Foreign tenant at major 2 is `403 id_tenant_mismatch`, by `identity.md` §5.**
   - A v2 bound id names its tenant. §5 says a host MUST reject a segment that is
     not the caller's with `403 id_tenant_mismatch`, and the identity middleware
     does so before any handler runs.
   - RFC 0232 §B.2's "same 404 as an unknown id" holds at v1 (bare ids). At v2 it
     holds for the caller's own tenant wrapped around another tenant's opaque id:
     that resolves under the caller and finds nothing.
   - The test pins all three answers. The conflict was raised with the spec owner
     before 2.45.11 shipped (see Open questions).

## Alternatives weighed

- **Advertise at v2 without the corpus port.** That claims a family no v2 scenario
  witnesses, and leaves the certified bundle with nothing to carry. Rejected; this
  ADR waits for 2.45.11.
- **A separate v2 facet builder.** It is two sources for one claim, and they
  would drift. The other v2 families here were folded onto their v1 source for
  the same reason (ADR 0730 C.3a).

## Open questions

- [x] The 2.45.11 v2 tenant-bound leg — **decided 2026-10-03 (openwop #1872):**
  tenant B's key on tenant A's bound id is `403 id_tenant_mismatch` with no
  record in the body; the caller's own bound id with a never-minted opaque is
  `404`. RFC 0232 §B.2 and the v2 OpenAPI now say 403 at major 2; v1 keeps
  foreign = unknown = `404` (bare ids). The suite does not assert the rebound
  case (it cannot know tenant B's segment); this host's test still pins it.

## Implementation record

| Phase | What | Where |
|---|---|---|
| 1 | `triggerBridgeFacets()`; v1 record uses it; v2 `triggerBridge` record | `backend/typescript/src/routes/discovery.ts` |
| 1 | Both majors one claim; flag drops `inboundSigning` from both | `test/adr0793-signed-trigger-ingest.test.ts` |
| 1 | v2 register → refuse → dead-letter page, closed-schema valid, bound ids, both segment spellings, 403 / 404 | `test/adr0810-trigger-bridge-major-2.test.ts` |
| 2 | Suite pin to 2.45.11 (the v2 trigger scenarios) | `backend/typescript/package.json` |
| 3 | Deploy, re-cut major 2 | evidence under the deployed commit |
