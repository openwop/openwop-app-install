# ADR 0811 — RFC 0233: the connection-provider registry reads (host side)

Status: Accepted (implemented; advertised once deployed with the fixture flag)

Related: RFC 0233 (`../openwop/RFCS/0233-connection-provider-registry-read.md`,
Active, suite 2.45.12), ADR 0809 (provider identity at major 2),
`docs/steward/V2-COMPLETION-PLAN.md`.

## Context

ADR 0809 declared `connections` at major 2. The corpus's only witness for
`connection-packs.md` §Provider identity was the RFC 0095 install seam, which
production does not mount. So the production v2 cut recorded three `blocked`
rows (`v2-provider-conflict`), and the v2 bundle certified nothing. The steward
ruled that this was a corpus defect: `conformance.md` §Witness class says a
seam-only MUST must mint a normative observation path. RFC 0233 mints it. This
ADR is the host half.

## Decision

1. **Two major-2-only reads**, mounted on the `/v1` key with a major-2 guard
   (v1 resolves collisions by version precedence and defines no such
   operation), under `manifest:read`. An unauthenticated caller is refused `401`
   by the auth layer.
   - `GET /connection-providers`: `{ providers[], refusals[] }`, host-global and
     content-free (an id, a source and a pack name; a refusal adds a code and a
     holder).
   - `GET /connection-providers/{providerId}[?pack=]`: one row, or
     `404 connection_provider_unresolved`. The qualified form resolves only to
     the named pack (the ADR 0809 owner map).
2. **Refusals are recorded where they are already built.** Both install paths
   (boot `loadConnectionPacks`, seam `installConnectionPackManifest`) call
   `noteRefusal` in the catch that builds the error row, so the read cannot
   disagree with the log. The record lives in `providerRegistry.ts`, in memory
   and per process (§B.7 allows recomputing at every start), deduplicated. Every
   conflict names its holder: the v2 refusal carries it, and the v1 precedence
   refusal reads it from the owner map, with `builtin` when no pack owns the id.
3. **The §D fixture pair** is installed at boot, through the normal install
   function, before the server listens, ONLY when the operator sets
   `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES=true`. The fixtures are v2-engined on
   disk (the steward changed them so that no special case is needed), so ADR
   0809's v2 rule refuses the rival.
4. **Advert:** `connections.providerRead: true` at major 2. `manifest:read`
   joins `ENFORCED_PROTOCOL_SCOPES`, so `scopes_supported` now lists it, because
   a route now refuses for it.
5. **Pin 2.45.12:** schemas, fixtures, `CORPUS_TAG`, the generated CORS header
   list and codemap, and two Hosting rewrites (`/connection-providers`,
   `/connection-providers/**`; `check-hosting-wire-rewrites` requires them for
   the new v2 manifest root).

## Implementation record

| What | Where |
|---|---|
| refusal record + owner-aware holder | `features/connections/providerRegistry.ts`, `connectionPackLoader.ts` (`noteRefusal`) |
| read model + fixture install | `features/connections/providerRegistryRead.ts` |
| routes | `features/connections/routes.ts` |
| boot hook | `index.ts` |
| advert, scope | `routes/discovery.ts`, `host/protocolAuthorization.ts` |
| pin + vendoring + rewrites | `backend/typescript/package{,-lock}.json`, `schemas/`, `conformance-fixtures/`, `firebase.json`, generated files |
| tests: registry page (uniqueness, holder, content-free), major-1 404, 401, resolve (qualified / rival / bare / unknown), the fixture pair at boot plus its no-flag control | `test/rfc0233-provider-registry-read.test.ts`, `test/rfc0233-fixture-pair-at-boot.test.ts` |
| suite at major 2, in-process, flag on: `v2-provider-conflict` 3/3 (fail-closed, qualified-form, `0233.provider-registry.unique`) | `npm run test:conformance -- --filter "provider\|registry"` |

## Operator step

Production must set `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES=true` (a merge-style
`--update-env-vars` in the deploying revision). Otherwise the fixture rows are
absent, and the corpus records `0177.*` as `inapplicable` rather than passing.
