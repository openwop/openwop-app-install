# ADR 0647 — the SPA adopts `@openwop/openwop@2`, and the agent-management surface stops calling a seam address that production 404s

Status: Accepted (implemented; see § Implementation record)

## Context

ADR 0642 counted the SPA's reliance on major 1 as 630 `/v1/` call sites and
zero `OpenWOP-Version` headers. **That count was inflated roughly 2× by
comments and test expectations** — see § Correction below; the corrected
pre-migration figure is 14 protocol + 328 host-extension call sites in CODE. Sizing the migration on 2026-09-10 — the day
`@openwop/openwop@2.0.0` went GA — measured three things that reshape it:

1. **The migratable set is much smaller than "87 protocol call sites".** Only
   the operations `schemas/v2/path-manifest.json` names have a major-2 home.
   Of what the SPA calls, `GET /v1/runs` (list), `DELETE /v1/runs/{id}`,
   `GET /v1/runs/{id}/debug-bundle`, `GET /v1/runs/{id}/events/token`,
   `GET /v1/packs/…` and the workflow register/list surfaces are **not**
   manifest operations — they are host surfaces that happen to sit under
   `/v1/`. They are in the same bucket as the 543 `/v1/host/openwop-app/*`
   sites: no v2 address exists, and the proprietary-path ruling upstream is
   *undecided, not permissive*.
2. **The v2 wire differs from v1 in exactly two ways the SPA can feel**, both
   applied at the negotiator (`middleware/protocolVersion.ts installV2ResponseHygiene`):
   run ids are projected to the tenant-bound `<tenantId>/<opaque>` form
   (`identity.md` §5, ADR 0629), and unregistered error codes travel as
   `openwop-app.<code>`. Success bodies are otherwise byte-identical;
   `toV2Envelope` rewrites only error envelopes. The SPA branches on 14 bare
   codes and matches one vendor event type by literal
   (`openwop-app.conversation.recall-used`) — the vendored `event-codemap.json`
   has no `openwop-app.*` rows, so vendor event names are identical across
   vocabularies and that match is safe.
3. **The 1.x SDK the SPA pinned (`^1.7.0`) hard-codes `/v1/` in 15 files and
   sends no version header; 2.0.0 is v2-only** and removes `runs.debugBundle`,
   `userAgents.*` and `RegistryClient` — the SPA uses the first two.

And one thing that had nothing to do with v2 and was found only because the
sizing walked every SDK call:

4. **Agent management has answered 404 in production since 2026-06-14.** The
   1.x SDK's `userAgents.*` methods target `/v1/host/sample/agents` and
   `/v1/host/sample/registry/agent-packs` — the conformance SAMPLE namespace.
   This host rewrites `sample` onto its product surface only under
   `OPENWOP_TEST_SEAM_ENABLED` (`routes/testSeam.ts`, "never production"), and
   production sets it `false`. The backend renamed the real routes on 2026-06-14
   (#260, the whitelabel purge); the SPA kept the SDK's address. Measured live:
   `/api/v1/host/sample/agents` → **404**, `/api/v1/host/openwop-app/agents` →
   200. Five UI surfaces ride it — create agent (new page + wizard), delete
   agent, list packs, install pack — and two fail **silently**: the SDK maps
   404 to `false` (delete "succeeds") and `null` (an empty install catalogue).
   22 of the 24 test files around these clients `vi.mock` the client module,
   so nothing was red; 14 days of request logs show no organic traffic, so no
   user is known to have hit it. It was broken by construction, not by report.

## Decision

1. **Two SDK clients during the overlap, one seam.** `@openwop/openwop@2.0.0`
   is the protocol client; `@openwop/openwop-v1` (an npm alias of 1.9.0) is
   kept for exactly two reads with no major-2 home: `discovery.capabilities()`
   — 14 modules read the v1 document's shape (`caps.auth.profiles`,
   `caps.feedback.supported`, …) and the v2 root is a different, closed
   document — and `runs.debugBundle()`. Both are constructed from one shared
   options object and one shared fetch wrapper (`runsClient.ts sdkFetch`).
2. **The SPA keeps BARE run ids in its own state; `v2Wire.ts` is the one place
   the wire's shape is applied in BOTH directions.** Inbound, every v2 result
   passes through `unbindRunIds` (deep, keyed by a predicate that covers
   singular and plural `*RunId(s)` keys, pinned by a parity test that walks the
   vendored schemas the same way the backend derives its projected-key set).
   Outbound, every `{runId}` path parameter is **tenant-bound and
   percent-encoded** (`bindRunId` → `<tenant>/<opaque>`, which the SDK sends as
   `tenant%2Fopaque`). The tenant is remembered from any bound id the wire
   returned, from `switchWorkspace`, or resolved once from
   `GET /v1/host/openwop-app/me/workspaces` `.active`; it is reset on auth
   change. `normalizeErrorCode` strips this host's vendor prefix at the SPA's
   single error-code choke (`errorEnvelope.readErrorCode`).

   **CORRECTED before merge (corpus steward, crosstalk `2b5a`).** The first
   draft of this decision sent BARE ids on major-2 requests because this host's
   inbound check gates on `includes('/')` and lets a bare id through, and called
   that "host-verified, not spec-guaranteed". It is **non-conformant**:
   `api/v2/openapi.yaml` (`parameters.RunId`, line 3049) types the `runId` path
   parameter as `ids.schema.json#/$defs/runId` — the tenant-bound grammar, whose
   description says the `/` is part of the value and MUST be percent-encoded —
   and `identity.md` §5 says the grammar "has no legacy branch, and it MUST NOT
   acquire one". `versioning.md` §5 gives the reason: a bare id has no tenant
   segment, so the mandatory `403 id_tenant_mismatch` check is structurally
   inapplicable to it. The fix is encode, not un-bind. A property this host
   happens to have is not a property the wire grants; I had promoted the first
   to the second.

   **CORRECTED AGAIN, same day (corpus steward, crosstalk `3b5f`).** The
   steward wrote the "refuse bare ids under major 2" leg into `v2-id-grammar`,
   applied it to the reference host, and the suite went red in six places:
   `v2-dual-stack-negotiation` reads a `/v1`-created run by its BARE id under
   `OpenWOP-Version: 2.0` and requires 200 — the corpus's own witness of
   `versioning.md` §5 — and five scenarios expect a bare unknown id to be
   `404 not_found`. `identity.md` §5 (2.0.10) now states the rule: the bound
   form MUST be accepted; **through the overlap the bare form is admitted** on
   a major-2 path parameter, resolved under the caller's tenant (the credential
   supplies the segment the `403` check would have read) with the response
   naming the resource bound; **when `protocolVersions[]` no longer carries a
   `1.x` member, the bare form MUST be refused `400 validation_error`**; and a
   client MAY bind at its request seam — always correct, never required through
   the overlap.

   Consequences here: the binding in this ADR **stays** (a MAY that survives
   retirement). This host's `includes('/')` admit is the conformant overlap
   behaviour, not a defect. A backend refusal I had built against the first
   ruling — with three existing tests re-encoded to expect 400 — was discarded
   unpushed; refusing is the December change, atomic with retirement, and the
   2.0.10 `v2-id-grammar` leg reads live discovery to witness both sides of that
   expiry. Two rulings in one day, both cited here rather than silently
   replaced: a prescribed fix from the steward was itself the regression, and it
   was the instrument that caught it.

3. **One SSE transport.** Both auth modes go through the 2.0 SDK's
   `streamEvents()` driven by a credentialed fetch; the hand-rolled cookie-mode
   generator is deleted. The run-scoped `streamToken` still comes from
   `/v1/runs/{id}/events/token` (a host route, not a manifest operation).
4. **Agent management calls the product surface directly** and never a seam
   address. A failed catalogue read now THROWS instead of rendering empty;
   delete returns `true` on 204, `false` on 404 and throws on anything else.
5. **Wire-level tests.** `v2Clients.test.ts` stubs `fetch` and asserts the
   URL, the version header, the cursor name and the id shape the clients
   actually send and accept — the thing the 22 module-mocking tests cannot see.

## Alternatives

- **Hand-migrate the 87 sites to unversioned paths + a header.** Rejected:
  that re-implements the v2 wire inside the SPA beside the SDK that already
  does it, and would have missed the id projection and the error-code
  namespacing until production.
- **Migrate discovery to the v2 root now.** Rejected for this ADR: 36 distinct
  capability-property reads across 14 modules are written against the v1
  document; that is its own change with its own blast radius.
- **Store tenant-bound ids in the SPA.** Rejected: a bound id contains `/`,
  which is a path separator in `/runs/:runId` and in every host-extension URL
  the SPA still builds. Projecting at the boundary in both directions is
  smaller and reversible — and the request side is a MUST, not a choice.
- **Keep the v1 SDK alias for `userAgents` too.** Rejected: the alias would
  keep calling the seam address that production refuses. The honest address
  was always the product one.

## Correction — the numbers this plan was sized on were inflated

`scripts/check-v1-reliance.mjs` (ADR 0642) counted every occurrence of a
`/v1/` literal under `frontend/react/src` and `backend/typescript/src`,
**including comments and test files**. This PR's own header comments and
wire-level test made it report the migration as a RISE (87 → 91, 543 → 555),
and the numbers were re-baselined over before being read. Attributing line by
line: +11 from one test file's URL expectations, +19 from comments, a net fall
in code. The instrument now reads whole lines, drops comment lines, and never
reads a test file; sabotage-verified (a literal in a comment or a test does not
move the count; one in code does).

Measured with the corrected instrument, at `origin/main` before this change
and on this branch after it:

| metric (code lines only) | before | after |
|---|---|---|
| SPA protocol `/v1/` call sites | 14 | 13 |
| SPA host-extension `/v1/host/openwop-app/` call sites | 328 | 330 |
| backend protocol path refs | 150 | 150 |
| backend host-extension path refs | 780 | 780 |

Two honest readings follow. First, the "630 call sites" and "87 protocol
sites" cited by ADR 0642 and by this ADR's first draft overstate the SPA's
literal reliance by about 2×; the four structural layers ADR 0642 names are
unaffected by the count. Second, **this migration is nearly invisible to the
literal-count metric by construction**: the ~16 operations it moved to major 2
(runs create/get/cancel/fork/poll, annotations, agents, workflows, interrupts,
audit, SSE) were SDK-backed, so their paths lived in `node_modules`, never in
the SPA's source. The metric that sees the change is `spaOpenWopVersionHeaders`
(0 → 2), which now counts code-level v2 client signals (`major: 2`,
`protocolVersion:`). A literal-count ratchet measures the RAW-FETCH surface;
it does not measure which major the SDK speaks. Both are worth knowing, and
they are different numbers.

## Consequences

- The ratchet baseline is re-cut on the corrected instrument in this PR. What
  remains under `/v1/` in the SPA is host-surface, not protocol — a
  classification the ratchet should learn next (split "migratable" from
  "no v2 home").
- The two v1 reads are the December work for this SPA; both are named here.

## Implementation record

| what | where |
|---|---|
| package: `@openwop/openwop` 2.0.0 + `@openwop/openwop-v1` → 1.9.0 | `frontend/react/package.json` |
| the seam: id un-binding, error-code normalization | `src/client/v2Wire.ts` (+ schema-parity test) |
| two clients, shared fetch; unbinding; `afterSequence` | `src/client/runsClient.ts` |
| one SSE transport, credentialed fetch | `src/client/streamsClient.ts` |
| agent management on the product surface | `src/client/agentsClient.ts` |
| error-code choke | `src/client/errorEnvelope.ts` |
| wire-level assertions | `src/client/__tests__/v2Clients.test.ts` |

Sabotage-verified: reverting the cursor rename reddens the poll leg; removing
the unbind reddens the create leg; pointing agents back at the seam address
reddens two legs. The schema-parity test caught a real gap before any of that:
the first predicate matched only singular `*RunId` keys and would have left
`sourceRunIds` / `contributingRunIds` tenant-bound.

## Correction — the seam translated ids and paths, not vocabulary (2026-09-10)

**The adoption above shipped a live defect.** Moving the poll and SSE
transports to major 2 changed a third thing besides the path space and the id
grammar: **the event-type vocabulary.** A major-2 read carries the v2
spellings of `schemas/v2/event-codemap.json` (36 renamed rows —
`agent.toolCalled → agent.tool-called`, `agent.reasoning.delta →
agent.reasoning-delta`, `core.workflowChain.event → workflow-chain.event`, …),
and the SPA's consumers branch on the v1 spellings: 12 literal sites in six
files (`runs/RunAgentTrace.tsx`, `runs/RunHandoffMap.tsx`,
`runs/RunProvenancePanel.tsx`, `chat/conversationTransport.ts`,
`chat/EnvelopeInspector.tsx`, plus the intent ledger). From the day this ADR
deployed, the agent trace, the handoff map, the provenance panel and the chat
transport were silently blind to every renamed event on every era-3 run.

**Why the wire-level tests did not see it:** `v2Clients.test.ts` proved paths,
headers and ids, and its poll and stream fixtures used `node.completed` — an
UNRENAMED type, so the vocabulary axis was never exercised. A witness that
picks an identity row is a witness of nothing for the rename class. It was
found by the 2026-09-10 v2-readiness measurement (crosstalk `8f27`), not by a
test.

**Decision.** The SPA keeps the v1 event dialect, exactly as the backend keeps
its in-process dialect and translates at the storage boundary
(`storage/eventEra.ts`). Translation happens ONCE, at the client seam, from the
SAME vendored codemap — `src/client/eventVocabulary.ts` reads the 36 renamed
pairs from `eventCodemap.generated.ts`, produced by
`scripts/gen-event-codemap.mjs` from `schemas/v2/event-codemap.json` (a direct
import of the 118-row file cost 3.5 kB gzip in the entry chunk and failed
`check-bundle-budget` at 131.7/131 kB; the pairs cost 0.7 kB). The generator
runs from `scripts/sync-schemas.sh` after every re-vendor, `npm run build`
runs it in `--check` mode, and the test below pins the pairs to the file and
the `CORPUS_TAG` stamp — on both inbound paths: `runsClient.pollEvents` and `streamsClient`'s `unbindEvents`. The
inverse (`toWireEventType`) exists for the December move of the SPA's own
dialect and is unused on any path today. Renaming the 12 literals instead was
rejected: it fixes one lane, leaves the concept ungated, and the debug-bundle
read (still v1) would then be the mismatched one.

**Guard.** `eventVocabulary.test.ts` pins the seam to the codemap (count
parity, both-direction round-trip) and adds the check that would have caught
this: every event-type literal in `src/` is a v1 spelling the codemap knows,
and NO v2 spelling is referenced anywhere (a v2 literal means a consumer
bypassed the seam). The poll and SSE legs in `v2Clients.test.ts` now carry a
RENAMED type. Sabotage-verified: an identity `toClientEventType` reddens the
new legs and the round-trip.

**Lesson for the next transport change:** a major bump is three contracts —
address, identity, vocabulary — and a test per contract, each on a row the
change actually renames.
