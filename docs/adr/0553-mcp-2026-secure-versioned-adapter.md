# ADR 0553 — MCP 2026-07-28 secure, versioned adapter

Status: Accepted — P0 implemented 2026-08-12 (`0f126b7e0`); P1 version seam implemented 2026-08-13; P1 §A (exact-version discovery) implemented 2026-08-15 (`6e7b9ed55`, #3253); **P2 implemented 2026-08-16** (the `mcp-2026-07-28` codec both directions, the P1-deferred fail-closed path, and the advert — see § "P2 — implemented 2026-08-16", merged `df03c3476` #3279); **H43 implemented 2026-08-17** (`5bd850706`, #3303 — the mount refuses anonymous principals unless `anonymousActor` is advertised, RFC 0153 §E; found on the prod wire, not in the gate, and re-verified there after deploy #3); **H21 implemented 2026-08-17** (`fb6cbbcba`, #3311 — operator-configured outbound MCP server; the
`mcp-tool-roundtrip` host-mediated leg now EXECUTES, 2 skipped → 2 executed; see § "H21"); **H47 implemented 2026-08-17** (pin `^1.136.0`; H21's loader rewrite and the A2A legacy alias DELETED, openwop#1060 — see § "H47"); **P3 implemented 2026-08-17** (H53 — the downgrade floor both directions, the cache's fourth key component, manifest-declared token audience, run cancellation of an in-flight call, the stateless-reconnect proof and the closed-key audit record; 22 sabotages, three of them corrections to my own first design — see § "P3"); P4 open. Merge provenance reconciled 2026-08-17 (H44). The P2 block was `spec-prose` and it EXPIRED: RFC 0153 §C/§D/§E landed in `spec/v1/mcp-integration.md` (`65ebd53a`, openwop#1012). Witnessed non-vacuously by the sibling suite (1.120.0, strict) — 13/16 `mcp-*` files, 36/39 tests, driven by `openwop-1`; see § "Sibling-suite witness".

Date: 2026-08-11

Composes: ADR 0030 outbound MCP, ADR 0087 inbound authorization-scoped tools,
ADR 0397 capability firewall, `host/mcpClient.ts`, `host/mcpServerRouter.ts`,
`routes/mcp.ts`. Protocol gate: RFC 0153 (`Accepted` — verified 2026-08-13 on
`../openwop` `origin/main`; this line read `Draft` until then).

## Context

The inbound router explicitly implements MCP 2025-06-18 and legacy
`initialize` (`host/mcpServerRouter.ts:1-12,84-138`). The outbound client probes
with 2024-11-05 and sends the older JSON-RPC/HTTP header set
(`host/mcpClient.ts:242-259,296-303`). It lacks the 2026-07-28 stateless
self-description, `server/discover`, method/name headers, MRTR mapping and
extension/auth hardening.

The server route is off by default, but when enabled it can synthesize
`mcp-anonymous` with tenant wildcard if middleware did not populate a principal
(`routes/mcp.ts:67-77`). A warning is not an authorization boundary. This must
never be production-reachable.

## Decision

Build one bidirectional MCP adapter with explicit legacy and current profiles.

### Authentication first

- Delete the anonymous wildcard fallback from the production route. Missing
  principal returns a typed unauthenticated response before JSON-RPC dispatch.
- Require the existing protocol scope plus tenant membership for every request;
  method-level tool/resource authorization remains in the registry/firewall.
- Test seams use an explicit harness principal injected only when the test-seam
  boot flag is on; production boot fails if that bypass is configured.
- Rate-limit every method by principal and additionally apply cost/concurrency
  budgets to effectful methods.
- Audit method, server/tool/resource identifier, principal, outcome, duration
  and trace id; never arguments, content or bearer tokens by default.

### Versioned codecs

Extract a version-neutral MCP semantic service for list/read/call/prompt and
host bridges. Keep the current 2025-06-18 codec as `legacy-2025-06-18`. Add the
2026-07-28 stateless codec, `server/discover`, required headers, ordered/cacheable
lists, extension negotiation, MRTR semantics and current auth behavior exactly
as accepted in RFC 0153. Unsupported versions fail closed; no silent downgrade.

For outbound calls, provider manifests declare the exact MCP profile and auth
audience. The client sends version/method/name headers and validates the peer's
self-description before exposing tools to a run. Cache entries are keyed by
server, version, authenticated principal scope and advertised revision.

Legacy `sampling/createMessage` and `elicitation/create` bridges are exposed
only in the legacy profile. The current profile uses the upstream MRTR mapping;
the semantic service converts both to the existing governed AI/HITL owners.

## Boundaries audit

| Concept | Owner |
|---|---|
| Inbound route | existing `routes/mcp.ts` only |
| Method semantics | extracted from existing `mcpServerRouter`; no duplicate registry |
| Outbound resolution/auth | existing provider manifest + Connections broker |
| Tool authorization | existing registry + capability firewall |
| Egress/SSRF | existing brokered webhook egress dispatcher |
| AI and elicitation | existing `ctx.callAI` and `ctx.suspend` bridges |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core protocol adapter; no feature package. |
| 2 | Toggle | Deployment enablement stays default-off; versions are explicit profiles, not experiments. |
| 3 | Workflow surface | MCP calls launch/bridge existing workflows only. |
| 4 | Node pack | Reuse `core.openwop.mcp`; update only after accepted contract. |
| 5 | Envelopes | MCP input/output remains untrusted and uses existing fencing. |
| 6 | Agent pack | None. |
| 7 | Public surface | Existing host-extension route; exact MCP version advertised. |
| 8 | RBAC | Authenticated principal, protocol scope, tenant membership and tool ACL all required. |
| 9 | Replay/fork | Peer version, tool contract digest and recorded outcome are replay facts. |
| 10 | Frontend | Connections/Operations show server version and health; no new page. |

## Phases and verification

| Phase | Scope | Gate |
|---|---|---|
| P0 | Remove anonymous wildcard; explicit test principal | Unauthenticated, wildcard and tenant-confusion adversarial tests. |
| P1 | Extract semantic service and pin legacy behavior | Existing MCP tests unchanged; no second route/registry. **Version seam shipped** (`mcpProfile.ts`, `mcp-profile.test.ts`, sabotage-proven); §A discovery blocked on pinned conformance 1.73.0, tripwired. |
| P2 | Current inbound/outbound codec | **SHIPPED 2026-08-16.** Two codecs over one version-neutral semantic service; fail-closed version selection; MRTR both halves; §23 seam; advert flipped in the same commit. 17 sabotages, four run down to a masking fence. |
| P3 | MRTR, caching, extensions and auth audience | **SHIPPED 2026-08-17 (H53).** "Largely absorbed into P2" was optimistic: reading the code turned up SIX open items, four of them live defects (a header-less request served legacy by coincidence; an outbound downgrade with no floor and a second door through `serverStatus`; a cache key missing the ADR's own fourth component; a cancellation seam wired to nothing). 22 sabotages, all RED on the intended assertion. |
| P4 | Claims | Advertise only profiles whose live behavior witnesses pass. |

> **RFC GATE SATISFIED — verified 2026-08-13 against `../openwop` `origin/main`.**
> All four RFCs of the 0147 program read `Accepted`:
>
> | RFC | status on `origin/main` |
> |---|---|
> | 0151 compensation-and-partial-failure-profile | `Accepted` |
> | 0152 a2a-1-0-versioned-composition | `Accepted` |
> | 0153 mcp-2026-07-28-versioned-composition | `Accepted` |
> | 0154 workload-identity-delegation-telemetry | `Accepted` |
>
> **HOW this was nearly recorded backwards.** Reading the files from the local
> `../openwop` WORKING TREE returned `Draft` for all four — that checkout was
> **56 commits behind** `origin/main`. Same branch-vs-`main` error I had
> corrected the steward on two hours earlier, with the roles reversed, and I was
> more confident because I had just taught the lesson.
>
> The reliable read is `git show origin/main:RFCS/<file>` after a `git fetch`,
> never a path in a sibling worktree. Knowing the failure mode did not prevent
> it; checking the ref's freshness is what would have.

## Implementation record

### Merged-tree provenance — reconciled 2026-08-17 (H44)

Phase → PR → **merge commit on `origin/main`**, each verified with
`git show <sha> --stat`:

| Phase | PR | Merge commit | Merged | Witness tests |
|---|---|---|---|---|
| P0 — the anonymous wildcard principal removed | — | `0f126b7e0` | 2026-08-12 | `mcp-profile.test.ts` |
| P1 — version seam | [#3196](https://github.com/openwop/openwop-app/pull/3196) | `96b3f6be1` | 2026-08-13 | `mcp-profile.test.ts` |
| P1 §A — exact-version discovery | [#3253](https://github.com/openwop/openwop-app/pull/3253) | `6e7b9ed55` | 2026-08-15 | advert DERIVED from `MCP_SUPPORTED_VERSIONS` |
| P2 — the `mcp-2026-07-28` stateless codec, both directions, and the advert | [#3279](https://github.com/openwop/openwop-app/pull/3279) | `df03c3476` | 2026-08-16 | `mcp-current-codec.test.ts`, `mcp-client-current.test.ts`, `mcp-request-state.test.ts`, `mcp-invoke-seam.test.ts`, `mcp-mount-sample-registered.test.ts`, `outbound-mcp.test.ts` |
| **H43 — the mount refuses anonymous principals (RFC 0153 §E)** | [#3303](https://github.com/openwop/openwop-app/pull/3303) | `5bd850706` | 2026-08-17 | `mcp-mount-anonymous-principal.test.ts` |
| H21 — operator-configured outbound MCP server; the roundtrip leg EXECUTES | [#3311](https://github.com/openwop/openwop-app/pull/3311) | `fb6cbbcba` | 2026-08-17 | `mcp-operator-server.test.ts` (15), `conformance-mcp-invoke-node.test.ts`, `conformance-fixture-advert-gating.test.ts`, `features/connections/__tests__/builtinMcpServer.test.ts` |
| H27 — the MCP invoke seam's error body converged on the flat envelope | [#3300](https://github.com/openwop/openwop-app/pull/3300) | `9b342b3be` | 2026-08-17 | `mcp-invoke-seam.test.ts`, `flat-error-envelope{,-ratchet}.test.ts` |

| H47 — conformance pin `^1.136.0`; the legacy `core.a2a.invoke` alias deleted | [#3315](https://github.com/openwop/openwop-app/pull/3315) | `4dbc7e325` | 2026-08-17 | `conformance-mcp-invoke-node`, `conformance-a2a-invoke-node` |
| **P3 (H53) — downgrade floor both ways, `discoveryRevision` in the cache key, manifest token audience, run cancellation, stateless-reconnect proof, closed-key audit** | [#3325](https://github.com/openwop/openwop-app/pull/3325) | `9b2af4839` | 2026-08-17 | `mcp-downgrade-floor` (15), `mcp-token-audience` (14), `mcp-cancel-reconnect` (11), `mcp-cache-confusion` (8), `mcp-audit-record` (8), `run-abort-signal` (9), `mcp-cache-cross-caller` (3) |

**Rows added 2026-08-18.** H47 and P3 were merged without extending this table —
#3325 updated the status line and the phase row but not the provenance record it
sits above, which is the drift this table exists to prevent.

**Re-measured at `fb6cbbcba` (H44):** the ten MCP witness files are **10 files /
116 tests green**.

### H43 — the mount admitted ANONYMOUS principals in the cookie posture (implemented 2026-08-17)

This was not recorded in this ADR until the H44 reconciliation, and it is the
most important entry in the table above, because **it is a defect P0 was
supposed to have closed and the gate could not see.**

P0 removed the synthesized `{ principalId: 'mcp-anonymous', tenants: ['*'] }`
wildcard, and `principalFromReq` returning `null` was taken as the boundary. In
the **cookie posture** — which is production's — the auth middleware MINTS a
principal for a credential-less caller (`anon:<sid>`, ADR 0015) and marks it
`req.anonymousPrincipal`, which `auth.ts` says consumers MUST NOT treat as
authenticated. So `principalFromReq` answered "yes, there is a principal" and an
unauthenticated POST to `/v1/host/openwop-app/mcp` got a live 2026-07-28 session
while `anonymousActor` was not advertised. RFC 0153 §E: *"an anonymous MCP
principal MUST NOT be the production default for an advertised current profile —
refuse (401/403) or advertise `anonymousActor`."*

**Why the conformance lane was green.** The driver's unauthenticated request
carries no cookie, so no anon session is minted in the lane. The leg
(`mcp-current-auth-boundary`) could not reproduce the production posture, and a
leg that cannot reproduce the posture is not evidence about it. It was found on
the **prod wire** during the authenticated pass at `756a9938d` (rev `00646-2zb`,
suite 1.135.2): `expected [401, 403] to include 200`, alongside
`mcp-2026-07-28-discover` 10/10, `mcp-stateless-request` 2/2 and
`mcp-version-negotiation` 4/4 all green.

**Fix.** After `principalFromReq`, refuse `req.anonymousPrincipal === true` with
401 `unauthenticated` (`details.reason: anonymous_principal_refused`, flat
envelope through the shared `sendError`) unless `anonymousActorAdvertised()`
(RFC 0132 — advert and behaviour agree) or the documented non-production
test-seam posture is on. The boundary is **anonymity, not cookies**: a signed-in
cookie principal is still admitted, which the test asserts as its own leg so the
guard cannot pass by refusing too much.

**Sabotage:** guard disabled → `expected 200 to be 401`. All 10 MCP test files
93/93 at the time.

**Verified on the prod wire after deploy #3** (rev `00648-pwz`):
`mcp-current-auth-boundary` **1/1**, and a bare POST to the mount → **401**. That
is the check that closes it — the local suite is the same lane that missed it.

### P0 — shipped 2026-08-12

`routes/mcp.ts` no longer synthesizes `{ principalId: 'mcp-anonymous',
tenants: ['*'] }`. `principalFromReq` returns `null` when nothing attached a
principal, and the route 401s **before parsing the body**, so an unauthenticated
prober learns nothing about the tool surface. The conformance seam becomes an
explicit, named, SINGLE-TENANT principal (`mcp-test-seam`, `tenants:
['default']`) behind `OPENWOP_TEST_SEAM_ENABLED` — the flag the rest of the host
already uses. Tests: `test/mcp-anonymous-wildcard.test.ts` (5).

**Correction to this ADR's Context, from measuring the reachability.** The
Context implies the wildcard was broadly reachable. It was not: this route is
NOT in `middleware/auth.ts`'s exempt list, so a plain unauthenticated request is
401'd by the global middleware before `routes/mcp.ts` runs. The fallback needed
a posture where the middleware RUNS but attaches no principal — auth-bypass, or
a future exempt path. Narrower than stated, and still wrong, because the
fallback's own comment said it existed for precisely such a posture, and because
`isAnonymousPrincipal` (ADR 0087) only denies *gated* tools — a tool that never
opted into gating stayed reachable behind it.

**That measurement also caught a vacuous test of mine.** The first version of
the suite booted an unauthenticated host and asserted 401 on the endpoint. It
passed — and would have passed with the wildcard fully restored, because it was
measuring the global middleware, not this change. Rewritten to exercise
`principalFromReq` directly, which is the only way to test a guard sitting
behind another guard.

### P1 — version seam shipped 2026-08-13

`host/mcpProfile.ts` (new) is the single owner of the served MCP version, mirroring
`host/a2aProfile.ts`. Tests: `test/mcp-profile.test.ts` (9).

**The version was a literal in places that DISAGREED.** `mcpServerRouter.ts`
answered `initialize` with `2025-06-18`; `mcpClient.ts` probed peers with
`2024-11-05`. The same host advertised two different MCP versions depending on
which direction you asked from. Nothing compared them, because **no test asserted
what `initialize` returns and none asserted what the client sends** — the entire
version surface was untested. `a2a-profile.test.ts` has carried exactly this
source-level assertion since ADR 0552 P0; pointed at these two files it would
have failed the whole time.

**`initialize` could not see the peer's request.** `params` was bound in
`dispatch` and never passed on — `initializeResult()` took no arguments. The
requested version was structurally unreachable, so the host could not have agreed
or disagreed with it. It is read now, and a mismatch is logged.

**Deliberately NOT fail-closed, which departs from this ADR's own decision text
("Unsupported versions fail closed; no silent downgrade").** That sentence is
scoped to RFC 0153 §B, which governs the CURRENT `2026-07-28` profile and its
header-based stateless negotiation. This host serves only the legacy
`2025-06-18` profile, and upstream's rule there is the opposite: the server
answers with a version it supports and the CLIENT decides whether to proceed.
Failing closed on the legacy profile would break every standard MCP client that
opens with an older version — including this host's own outbound probe, which
did exactly that until this commit. The fail-closed path lands with the codec it
belongs to (P2). Recorded here rather than left as a silent divergence.

The outbound half also stopped discarding the peer's reply: `serverStatus` read
`serverInfo` and dropped `protocolVersion`, so a peer speaking something
unparseable still reported `available: true` with nothing recorded. The field was
missing from the result TYPE too, which is why nothing ever flagged the drop.

A regex guard now fails if either file re-pins a date literal in executable code
(comments may cite versions — that is the reasoning trail). Sabotage-proven both
ways: re-pinning the literal fails the drift leg; echoing the peer's version back
fails the mismatch leg.

> **CORRECTION 2026-08-16.** History now: the pin moved to **1.106.0**
> (`6e7b9ed55`, #3253), the tripwire fired, §A SHIPPED (`routes/discovery.ts`
> derives `mcp.protocolVersions` / `preferredVersion` from
> `MCP_SUPPORTED_VERSIONS`), and the tripwire became a positive obligation.
> That commit did not update this ADR. P2–P4's live block is RFC 0153 §C
> (MRTR / callback replacement — gap G2 unauthored), §D and §E existing only as
> RFC prose with `spec/v1/mcp-integration.md` carrying zero 0153 content;
> delegated 2026-08-16 (crosstalk `agrade`, task A-4). The P1-deferred
> fail-closed path still lands WITH the codec.

**§A (exact-version discovery) is NOT shipped, and not for the RFC's sake.** RFC
0153 is `Accepted` and `protocolVersions`/`preferredVersion`/`profiles`/`features`
exist upstream. The pinned `@openwop/openwop-conformance` **1.73.0** predates them
and marks the `mcp` slot `additionalProperties: false` — measured, an advert
carrying them is rejected. Tripwired in
`test/agrade-wire-blocked-residue.test.ts`, which goes red when the pinned schema
grows the fields.

### P2 — implemented 2026-08-16

The current-profile codec, both directions, the fail-closed path P1 deferred,
and the advert — in one commit, because the entry and the behaviour are one
claim (ADR 0548 invariant 3).

**The block that lifted.** P2 was parked as `spec-prose`, not on RFC 0153's
status: §C's MRTR mapping was gap **G2 "unauthored"** and `mcp-integration.md`
carried zero 0153 content, so a host building the codec would have been
guessing at the task↔run mapping. That expired on 2026-08-16 when `65ebd53a`
(openwop#1012) landed § "MCP 2026-07-28 versioned composition" — G2 closed by
§C.1/§C.2, **G4** (authorization-aware cache validators) by §D, **G5** decided
as "none first-class", **G6** (dual-era fake server + six scenarios) by suite
1.113.0. This phase implements that text; it does not anticipate it.

#### Spec § → host mapping

| Spec | Host | Note |
|---|---|---|
| §A discovery + closed `features[]` | `routes/discovery.ts`, derived from `host/mcpProfile.ts` | `profiles` + `features` join `protocolVersions`/`preferredVersion`. Every value DERIVED — `selectMcpCodec` and `server/discover` read the same constants. |
| §B stateless routing, `_meta`, 3 headers | `host/mcpCurrentCodec.ts` | Header/body agreement checked BEFORE dispatch, so a disagreeing request never reaches a registry lookup or a run. |
| §B `server/discover` | `mcpCurrentCodec.ts` | `supportedVersions` is `MCP_SUPPORTED_VERSIONS` — the same array the discovery document renders. Two documents, one fact, one source. |
| §B version selection / no silent downgrade | `host/mcpProfile.ts` `selectMcpCodec` (inbound), `host/mcpClient.ts` `negotiatedCall` (outbound) | **The P1-deferred fail-closed path.** |
| §B boundary projection | `routes/mcpInvokeSeam.ts`, `McpError.details` | `interop_version_unsupported`, `retriable:false`, `details.protocol:"mcp"`. |
| §C.1 MRTR client half | `mcpClient.ts` `invokeTool` + `executor.ts` `elicitationResolver` | `input_required` → a `clarification` interrupt on the calling node → retry with `inputResponses` + `requestState` echoed byte-exact. |
| §C.2 MRTR server half | `mcpCurrentCodec.ts` + `host/mcpRequestState.ts` + `mcpSemantics.resumeInterrupt` | HMAC-bound state; resolution goes through `resolveAndResume`, so the RFC 0051 eligibility gate applies to a peer exactly as to a human. |
| §D cacheable lists | `mcpCurrentCodec.ts` | `ttlMs` + `cacheScope` on every list/read; `private` always, because our lists derive from `listToolsForPrincipal`. |
| §D client cache keys + G4 | `host/mcpClientCache.ts` | Key = tenant/workspace/principal/origin/revision/scope-fingerprint. A scope change is a MISS, not a stale hit. |
| §D extension opacity | `mcpCurrentCodec.ts` (reads only named `_meta` keys) + `mcpClient.ts` closed return shape | A peer's `_meta` has no field to arrive in. |
| §E auth boundary | `routes/mcp.ts` (ADR 0553 P0, unchanged) | Production default is **401 before the body is parsed**. |
| §23 seam | `routes/mcpInvokeSeam.ts` | Drives the REAL client; only the peer URL is injected. |

#### The seven decisions this phase was held to

1. **The pre-existing body IS `mcp-2025-06-18-legacy`.** `mcpServerRouter.ts` is
   now named as that codec and behaves identically — no peer can tell the
   extraction happened. `MCP_LEGACY_PROFILE_SUNSET = '2027-08-12'` records the
   window rather than enforcing it (a host that silently stopped answering
   `initialize` on the date would break every peer that had not moved).
   `2025-11-25` is NOT a profile: `selectMcpCodec` refuses it `-32022` rather
   than serving it as legacy, which is the most tempting silent downgrade
   because the request would otherwise "work".
2. **`features[]` MUSTs.** `server-discover`, `mrtr`, `cacheable-lists` are
   claimed. `extensions` is deliberately NOT — it means "advertises and honours
   `capabilities.extensions`", and this host honours none.
3. **MRTR both directions.** Client: initial + retries are ONE logical
   invocation — the resolver is `ctx.suspend`, so the initial call and the retry
   sit inside one node body, `beginNodeActivity` rewinds the ordinal on resume,
   and the RFC 0150 §B identity is unchanged. `sampling/createMessage` and
   `roots/list` are never declared, so a peer sending one is a typed failure,
   never a live callback. The node owns the timeout; a cancelled run issues no
   retry (checked before AND after the gather — the gather is exactly the window
   a cancel arrives in). Server: a run reaching `waiting-input` answers the
   in-flight `tools/call` with `input_required`; the resolving principal is
   authorized through `resolveAndResume`. Legacy bridges stay legacy-only with
   no silent fallback.
4. **`cacheScope` follows the tenant boundary** — `private` for every list this
   host serves, `public` only for `server/discover` (byte-identical for every
   caller). Client keys are scope-scoped; a scope change is stale regardless of
   `ttlMs`.
5. **No extension gets a first-class mapping.** OTel `_meta` keys and
   `logLevel` only; `io.modelcontextprotocol/tasks` deliberately unmapped.
6. **The anonymous MCP principal is NOT the production default.** Verified
   against the P0 posture: `routes/mcp.ts` returns 401 before parsing the body
   when nothing attached a principal. The named `mcp-test-seam` principal exists
   only behind `OPENWOP_TEST_SEAM_ENABLED` and is single-tenant, never `['*']`.
7. **Seam §23** is wired at both spellings, guarded on the route.

#### Two things the implementation corrected

> **CORRECTION 1 — the seam's guard was inherited on one spelling and not the
> other.** `testSeam.ts` mounts `app.use('/v1/host/sample', guardSeam)` and
> `app.use('/v1/host/openwop-app/test', guardSeam)`. The invoke seam lives at
> `/v1/host/openwop-app/mcp/invoke`, which matches NEITHER prefix — so the
> `sample` alias would have been guarded and the product spelling would not,
> on an endpoint whose whole purpose is to make the host issue an outbound
> request to a caller-supplied URL. A door guarded under one of its two names is
> not guarded. `requireNonAnonymousPrincipal` is now applied on the route itself,
> to both.

> **CORRECTION 2 — `advertisedMcpProtocolVersion()` and the legacy handshake's
> answer now DIFFER, and conflating them would have been a version lie.** P1
> had one served version, so `initialize` could report it. With two, reporting
> the PREFERRED (current) revision from a handshake that only exists in the
> legacy profile would tell a peer it had negotiated a stateless wire and then
> answer it with sessions. `initializeVersionOutcome` therefore reports
> `MCP_LEGACY_VERSION` explicitly, and a test pins that it is not the current one.

#### Sibling-suite witness (the exit criterion)

Driven by the spec worker **`openwop-1`** against this branch at `3c2cd839a`,
booted on port 18098, using **main's corpus at suite 1.120.0** in STRICT mode
(`OPENWOP_REQUIRE_BEHAVIOR=true`) with `OPENWOP_MCP_FAKE_SERVER=true` and
`OPENWOP_TEST_SECONDARY_API_KEY` set for the cross-caller cache leg. Recorded
here attributed, because a host must not be the only witness to its own claim.

**RE-DRIVE (authoritative): 14 of 16 `mcp-*` files, 37/39 tests**, at
`3c2cd839a` against **suite 1.122.0** — the corpus with BOTH fixes in
(openwop#1027's agreement-before-selection vector, openwop#1028's fixture-edge
correction). `mcp-mrtr-roundtrip` is **fully green, 11 assertions**:
`input_required` + `elicitation/create` + a bound `requestState` → the retry
resolves → a forged `requestState` is refused. `mcp-2026-07-28-discover` →
48 executed-pass on the post-#1027 vector.

**Everything RFC 0153 §B/§C/§D/§E names is witnessed non-vacuously on this
host.** The two remaining non-passes are neither P2 nor regressions:
`mcp-tool-roundtrip`'s legacy host-mediated leg (H21, pre-existing — no
configuration path for an operator-configured MCP server URL) and
`mcp-toolcall-redaction`, inapplicable because this host advertises no
`mcpClient` surface.

**FIRST DRIVE (kept — it is what produced the fixes): 13/16 files, 36/39
tests**, at the same commit against suite **1.120.0**. This was the first
non-vacuous RFC 0153 §B/§D/§E host witness in the program; every one of these
legs was `blocked` against every host until this branch. Witnessed assertion
counts, so "passed" cannot mean "asserted nothing":

| Scenario | Assertions |
|---|---|
| `mcp-2026-07-28-discover` | 45 |
| `mcp-discoverability` | 10 |
| `mcp-version-negotiation` | 9 |
| `mcp-stateless-request` | 7 |
| `mcp-extension-opacity` | 6 |
| `mcp-server-tool-roundtrip` | 6 |
| `mcp-server-untrusted-args` | 5 |
| `mcp-server-elicitation-bridge` | 4 |
| `mcp-server-resource-roundtrip` | 4 |
| `mcp-server-prompt-roundtrip` | 4 |
| `mcp-server-sampling-bridge` | 3 |
| `mcp-current-auth-boundary` | 2 |
| `mcp-cache-tenant-scope` | 1 |
| `mcp-toolcall-redaction` | inapplicable |

Note what the legacy rows prove: `mcp-server-*` and `mcp-discoverability` still
pass, so extracting the semantic service did not change the legacy wire.

**The three failures, classified.**

| # | Leg | Verdict |
|---|---|---|
| (a) | `mcp-2026-07-28-discover` header/body mismatch vector | **CORPUS-SIDE, and now also a host change.** The vector sent header `2026-07-28` + body `2025-11-25` — simultaneously a disagreement AND an unsupported revision — and this host answered `-32022` (support-first). Fixed upstream in openwop#1027 (suite 1.121.0), which states **agreement before selection** and re-points the vector at a supported body revision; re-driven 10/10. No host change was REQUIRED, but the corpus order is the better one and this host now follows it (`mcpCurrentCodec.ts`, sabotage S18). |
| (b) | `mcp-mrtr-roundtrip` server half | **RETRACTED by the reporter; not a host gap.** Independently falsified here by measurement BEFORE any change was made, then withdrawn by `openwop-1` once the fixture bug was fixed (openwop#1028) and the re-drive came back fully green (11 assertions).** Reported as `-32602 "tool 'mrtr_…' not exposed"` and read as "the mount does not expose sample-registered suspending workflows when the seam is on". Driven over the SAME path the suite uses — register at `/v1/host/sample/workflows`, call at `/v1/host/sample/mcp`, authenticated — the tool appears in `tools/list` and `tools/call` answers `input_required`, and the retry resolves. The suite's registration `400`s because its fixture posts `edges: [{ from, to }]` (RFC 0013 workflow-CHAIN vocabulary) to the workflow-DEFINITION endpoint, so the workflow never registers and `-32602` is the CORRECT answer for a tool that does not exist. Pinned both ways in `mcp-mount-sample-registered.test.ts` (sabotage S19). **No exposure change was made, because there was nothing to fix** — shipping one would have been a fix for a defect that does not exist. |
| (c) | `mcp-tool-roundtrip` legacy host-mediated leg | **Pre-existing, out of P2 scope.** No configuration path for an operator-configured outbound MCP server URL (`ctx.mcp.*` resolves only host-curated Connections manifests, ADR 0030). Tracked as a host follow-up (H21). **CLOSED 2026-08-17** — see § "H21"; the missing config path was one of THREE causes, and the other two (the runner never starting the suite's server; the fixture's node resolving to a prompt-library node) are why this leg was skipping rather than failing on the committed lane. |

**Why (b) is recorded this way.** The instruction was to fix it by exposing
sample-registered workflows. Following that would have produced a change with a
green test and no defect behind it, and left the real cause — a fixture bug in
the corpus — unfixed and rediscoverable. A signal that pattern-matches to a
known failure can have a different cause, and the only way to tell is to drive
the exact path and look.

#### Sabotage table

Every new guard was broken and watched go red. **Four came back GREEN**, and
each was run down to its cause rather than to a bigger hammer — that is the part
worth keeping, since a green sabotage is the only evidence that a test proves
less than its name.

| # | Sabotage | Result |
|---|---|---|
| S1 | Accept a header/body mismatch | RED |
| S2 | Serve an unserved revision as legacy (silent downgrade) | RED |
| S3 | Leak the peer's `_meta` out of the client | RED |
| S4 | Skip `requestState` verification | **GREEN** — masked by the interrupt-lookup fence, which answers the same uniform `-32602`. Re-aimed: S4b disables the principal binding the verifier owns → RED |
| S5 | Drop the single-use CAS | **GREEN** — masked by the `resolvedAt` fence. S5b removes that fence → RED. S5c (CAS + a concurrency leg) stayed GREEN: two `fetch`es to one origin ride a keep-alive connection and are served in order, so the leg cannot interleave. Recorded, not papered over — the CAS's concurrent path is witnessed at the storage layer by `eng1-approval-gate-atomicity.test.ts` |
| S6 | Drop the principal from the cache key | **GREEN** — two-fence: the principal is also inside `scopeFingerprint`. S6b removes both → RED |
| S7 | Advertise the profile with an empty `features[]` | RED |
| S8 | Re-pin a date literal in the codec | RED |
| S9 | Fall back to the legacy live callback on `input_required` | RED |
| S10 | Make `server/discover` disagree with the advert | RED (both the codec and the residue obligation) |
| S11 | Seam hand-writes the version | **GREEN** — against a current-revision peer the reported and wire values coincide. Added a LEGACY-ONLY peer leg where they must differ; S11b → RED |
| S12 | Remove the MRTR round bound | RED |
| S13 | Cache an interim MRTR result | **GREEN** — structurally uncacheable (`invokeTool` has no cache path). S13b ADDS one → RED |
| S14 | `requestState` skips the principal binding | RED |
| S15 | `requestState` never expires | RED |
| S16 | Claim the `extensions` feature | RED |
| S18 | Revert to support-first ordering (the corpus-fixed defect) | RED |
| S19 | Make the mount stop exposing a sample-registered tool | RED |
| S17 | Hard-code `extensionAuthority.scopesWidened: false` | **GREEN** — the true value is `false`, so the assertion cannot tell measured from hard-coded. S17b makes the host actually leak → the report flips to `true` → RED |

#### Tests

`mcp-current-codec.test.ts` (22), `mcp-client-current.test.ts` (18),
`mcp-invoke-seam.test.ts` (6), `mcp-request-state.test.ts` (8),
`mcp-mount-sample-registered.test.ts` (2), `mcp-profile.test.ts` (21, rewritten
for P2), plus the converted obligations in `agrade-wire-blocked-residue.test.ts`.

#### What P2 does NOT do (P3/P4 residue)

- **Durable MRTR round state.** `requestState` is stateless-verifiable and the
  interrupt is durable, so a round survives a restart; what is NOT tracked is a
  per-invocation round COUNT across processes. The server-side bound is
  per-retry-chain, and the host does not trust a peer-supplied counter.
- **`subscriptions/listen`** change notifications are not implemented; this host
  emits no server-to-client change stream, and `listChanged` is advertised
  `false` on the legacy profile as before.
- **The `extensions` feature** — see decision 2. Claiming it needs a named
  mapping to honour, and RFC 0153 G5 decided there are none.
- **A pinned real current-revision peer in CI** (RFC 0153 **G3**) stays
  externally gated; the witnesses are the suite's dual-era fake server and this
  host's own fixtures.
- ~~**An operator-configured outbound MCP server URL** (finding (c), H21). `ctx.mcp.*`
  resolves only host-curated Connections manifests (ADR 0030), so the legacy
  `mcp-tool-roundtrip` host-mediated leg has no configuration path to point the
  host at an arbitrary server. Pre-existing and out of P2's scope; the §23 seam
  covers the current-profile client half by a different route.~~ **CLOSED
  2026-08-17** — `OPENWOP_MCP_SERVER_URL` synthesizes a curated `reach:'mcp'`
  provider, so the resolution path is still the ONE in ADR 0030. See
  § "H21 — operator-configured outbound MCP server"; note the correction there
  about the other two things this bullet did not name.
- **`authorization.decided { action: "mcp:negotiate" }`** on a policy-forbidden
  downgrade (**G7**) — the corpus has no dedicated negotiation event and this
  host does not advertise `capabilities.authorization`; the refusal is logged
  content-free (`mcp_version_refused`) instead.

#### Follow-up: the sample-workflow seam's edge field diverges from the canonical schema (H26)

Catalogued by `openwop-1` as `host-sample-test-seams.md` §24 while diagnosing
the fixture bug below. This host's `/v1/host/{openwop-app,sample}/workflows`
seam validates edges as `{ edgeId, sourceNodeId, targetNodeId }`, while the
canonical `workflow-definition.schema.json` spells the first field **`id`**. A
conformance fixture written to the published schema is therefore refused by the
reference host, which is the wrong way round for a REFERENCE host — it makes the
seam's contract discoverable only by reading this host's validator.

Not fixed here: it is a pre-existing divergence on a non-wire host-extension
route, changing it touches every existing caller (the builder autosaves through
it), and doing it inside the MCP codec phase would bury it. Tracked as a host
follow-up.

#### A suite fixture bug found while building to it

`mcp-mrtr-roundtrip.test.ts`'s server half registers its fixture with
`edges: [{ from: 'expose', to: 'ask' }]` against `/v1/host/sample/workflows` —
the RFC 0013 workflow-CHAIN edge vocabulary posted to the workflow-DEFINITION
endpoint, which takes `{ edgeId, sourceNodeId, targetNodeId }` (the wire schema
spells it `{ id, sourceNodeId, targetNodeId }`; neither is `from`/`to`). This
host answers that `400 validation_error`, and the scenario only treats 404/403
as `seamAbsent`, so the leg fails rather than recording `blocked`. **That is a
suite fixture bug, not a host gap** — the same fixture with host-shaped edges
drives the full MRTR server half green (`mcp-current-codec.test.ts`). Reported
upstream and **fixed in openwop#1028 (suite 1.122.0)**; the re-drive against
the corrected fixture passes the server half in full. The host-side leg is
covered locally by `mcp-mount-sample-registered.test.ts` regardless.

#### Re-drive against the published suite, at main `df03c3476` (2026-08-16)

Driven by the spec worker against **main**, not a branch — so this measures the
merged P2, not the PR that produced it. Suite `1.123.0`, strict mode,
`OPENWOP_MCP_FAKE_SERVER=true`, a second credential, port 18098.

**15/16 files, 39/40 tests.** RFC 0148 ledger rows:

| Leg | Rows |
|---|---|
| `discover` | 48 |
| `stateless-request` | 11 |
| `mrtr-roundtrip` | 19 |
| `extension-opacity` | 6 |
| `cache-tenant-scope` | 1 |
| `current-auth-boundary` | 2 |
| `version-negotiation` | 9 |
| `discoverability` | 10 |
| `server-tool-roundtrip` | 6 |
| `server-untrusted-args` | 5 |
| `server-elicitation-bridge` | 4 |
| `server-sampling-bridge` | 3 |
| `server-resource-roundtrip` | 4 |
| `server-prompt-roundtrip` | 4 |

`toolcall-redaction` records **inapplicable** (this host advertises no
`mcpClient`), which is an honest absence rather than a pass. The one non-green
file is `mcp-tool-roundtrip`'s `executed-fail` (12) — the legacy host-mediated
leg, pre-existing and tracked as **H21**; it is not a P2 regression and the
fixture bug above is a separate, already-fixed item.
**CLOSED 2026-08-17 — see § "H21 — operator-configured outbound MCP server".**

### H21 — operator-configured outbound MCP server (implemented 2026-08-17)

Closes finding (c) above and the corresponding "Known gaps" bullet: *"an
operator-configured outbound MCP server URL … the legacy `mcp-tool-roundtrip`
host-mediated leg has no configuration path to point the host at an arbitrary
server."*

**Correction to how that gap was framed.** The gap statement said the leg had no
config path, and that was true but incomplete — it named ONE of three missing
pieces, and closing only that one would have left the leg exactly as unmeasured
as before. Reading the suite turned up the other two:

1. **`conformance/run.ts` never set `OPENWOP_MCP_FAKE_SERVER`.** The suite starts
   its synthetic server only under that flag (`setup.ts:160`), so
   `getMcpFakeServer()` was `null` and BOTH legs of the file returned early —
   the direct wire-shape probe as well as the host-mediated one. Measured on this
   branch by reverting just that line: the file "passes" in **2 ms** with
   `[mcp-tool-roundtrip] no MCP endpoint configured` and `[mcp-tool-roundtrip]
   fake server not started; skipping host-mediated test`. The P2 record's
   `executed-fail (12)` reflects a drive where the flag WAS set by hand; the
   committed lane never set it. A leg that returns early is not a leg that fails,
   and it is not a leg that passes either.
2. **The fixture's node does not resolve to anything MCP-aware on this host.**
   `conformance-mcp-tool-roundtrip` declares one node spelled
   `core.ai.callPrompt` carrying `config.mcp = { tool, arguments }`. On this host
   that typeId is `packs/vendor.myndhyve.ai`'s prompt-library node: it requires
   `config.promptId`, ignores `config.mcp`, and fails `prompt_not_found`. So the
   fixture was ADVERTISED and unrunnable — the advertise-and-spuriously-fail
   dishonesty `listLoadedConformanceFixtures` exists to prevent, missed because
   its predicate keys on the `core.conformance.` prefix.

**Decision 1 — the operator server is a synthesized PROVIDER, not a second
config lane.** `host/mcpOperatorServer.ts` reads `OPENWOP_MCP_SERVER_URL`
(+ `_ID` / `_LABEL` / `_TOKEN_REF`) and `registerProvider`s a curated
`reach:'mcp'` manifest carrying `mcpServer.url` — the same hook a Marketplace
install uses. From that point it is an ordinary provider: `getProvider`
resolution, the ADR 0028 governance gate, the RFC 0093 egress dispatcher, the
RFC 0079 `connectionUse[]` stamp and the ADR 0027 `untrustedContent` marking are
all the existing code paths, unbranched. The rejected alternative was the
obvious one — read the env inside `mcpClient` when `serverId` is absent — which
forks `resolveTarget`, the single function holding the three fail-closed gates,
and leaves every later reader asking which lane a call took.

**Decision 2 — one new credential branch, keyed on a marker set in exactly one
place.** `resolveConnectionCredential` requires a per-user Connection row, which
a host-global operator server has none of by construction; seeding a synthetic
Connection to fit would put a placeholder secret on the wire. So the synthesized
manifest carries `operatorManaged: true` (a host-side field, not wire) and
`resolveTarget` branches on that marker alone. Token ref configured ⇒ resolved
through the BYOK secret resolver, and **unresolvable ⇒ `mcp_not_connected`**,
never a silent downgrade to an unauthenticated call. No token ref ⇒ the operator
declared the endpoint auth-less and the secret is `''`, which `wireCall` already
renders as NO `Authorization` header. The token ref resolves HOST-GLOBAL
(scopeless), so `OPENWOP_BYOK_EPHEMERAL=false` is required for it to load — same
constraint as `billing:stripe-key`, and it fails closed rather than calling out
bare. Every other provider takes the unchanged ADR 0024 path.

**Decision 3 — a bridge node, and a narrow load-time mapping to reach it.**
`bootstrap/conformanceMcpInvokeNode.ts` registers `core.conformance.mcp-invoke`
(modelled on H25's `conformanceA2aInvokeNode`, self-gated on
`conformanceNodesEnabled()`), calling `ctx.mcp.invokeTool` — the same client, so
the run genuinely exercises the pipeline rather than returning canned content.
It fails TYPED (`mcp_server_not_configured` / `mcp_tool_not_configured` /
`mcp_client_unavailable`) rather than succeeding empty.

The fixture spells its node `core.ai.callPrompt`, which must not be hijacked
globally, so the fixture LOADER (`host/index.ts`) rewrites that one node onto the
reserved id under the bridge's OWN config predicate (`declaresMcpToolCall`,
shared rather than restated). The fixture's description sanctions host-side
substitution — *"Hosts that don't wire MCP-aware nodes can stub this fixture as
`core.noop`"* — and a real bridge is strictly more honest than that stub, which
would make the leg pass without a byte reaching a server. The rewrite is applied
**unconditionally**, not behind `conformanceNodesEnabled()`, because it is what
makes `fixtureNeedsConformanceNodes` see the fixture and therefore what stops the
advert promising it on a deploy that cannot run it.

**Corpus follow-up — RAISED AND LANDED.** The ask was the A2A treatment
(openwop#1028): rename the fixture's node to the conformance-reserved
`core.conformance.mcp-invoke` and state the mapping rule with it —
`core.ai.callPrompt` is a vendor pack-tier id no host is obliged to ship, and the
fixture's `config.mcp` shape appeared nowhere in `spec/v1/mcp-integration.md`
(§"Concrete example" uses `config.mcpServers: ["web-search"]`). Upstream landed
it as **openwop#1060 (suite 1.136.0, S33)**: the node is renamed, `config.mcp
{ tool, arguments }` is documented, and the MUST-map / MUST-NOT-advertise rule is
stated in `node-packs.md`, `fixtures.md` and `mcp-integration.md` §Conformance.

This host pins **1.135.2**, so the loader rewrite is still load-bearing and stays
— it is a **no-op at ≥ 1.136.0**. Delete it when the pin moves past 1.136.0, not
before: deleting early re-breaks the leg at the current pin, which is exactly the
trap `CONFORMANCE_A2A_INVOKE_LEGACY_TYPE_ID` was written to document. The bridge
node itself is unaffected by the pin either way — the renamed fixture resolves to
it directly.

> **EXIT CONDITION MET — the rewrite is DELETED (H47, 2026-08-17, openwop#1060).**
> The pin moved `^1.135.2 → ^1.136.0` and the rewrite, `declaresMcpToolCall`, and
> the advert-gating restatement's second clause are gone. The A2A twin
> `CONFORMANCE_A2A_INVOKE_LEGACY_TYPE_ID` went with it on the same lifecycle.
>
> **CORRECTION to the exit condition as written above.** It named ONE input — "the
> pin moves past 1.136.0" — and that is not sufficient. The host loads fixtures
> from the vendored `conformance-fixtures/` dir, which `scripts/sync-fixtures.sh`
> syncs from the corpus, **not** from `node_modules`. The npm pin and the vendored
> copy are independent, and at the moment of the bump the vendored
> `conformance-mcp-tool-roundtrip.json` still spelled its node `core.ai.callPrompt`
> (and the A2A one still spelled `core.a2a.invoke`). Deleting on the pin alone
> would have re-broken exactly the leg this condition exists to protect, while
> every version string read 1.136.0 — the failure the condition was written to
> prevent, reached through the door it left open. Both fixtures were re-vendored
> from the corpus at 1.136.0 (byte-identical to the installed package copies)
> **before** the deletion. The correct condition is: *the pin has moved AND the
> vendored copy the host actually loads carries the reserved id.* That second half
> is now a test (`conformance-mcp-invoke-node.test.ts` — "the vendored roundtrip
> fixtures are byte-identical to the PINNED suite package"), so it cannot be
> assumed again.

**Egress posture unchanged.** Nothing here relaxes a default: `resolveTarget`
still requires `https://` unless `webhookPrivateEgressAllowed()`, and the RFC
0093 dispatcher still refuses private ranges without it. The conformance boot's
loopback server is reachable only because that boot already sets
`OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` for the compat mock.

**Result.** `conformance/run.ts` now pins the port (`pinnedPort(…) ||
reservePort`, for the same both-sides-need-the-number-first reason H25
documents), sets `OPENWOP_MCP_FAKE_SERVER` + `_PORT` (suite side) and
`OPENWOP_MCP_SERVER_URL` (host side). `mcp-tool-roundtrip` goes from
**2 tests skipped in 2 ms** to **2 tests executed-pass in 288 ms**, with the
host-mediated leg's `tools/call` assertion satisfied by a real invocation
recorded on the suite's server.

| Sabotage | Change | Result |
|---|---|---|
| S1 | `conformance/run.ts` sets `OPENWOP_MCP_FAKE_SERVER='false'` | file back to 2 skips in 2 ms with both `skipping` warnings — the pre-H21 baseline, reproduced |
| S2 | drop the host-side `OPENWOP_MCP_SERVER_URL`, keep the server started | `mcp-tool-roundtrip` **RED**: `host MUST invoke tools/call on the configured MCP server during the fixture run: expected 0 to be greater than 0` |
| S3 | loader keeps `n.typeId` (no rewrite) | `conformance-mcp-invoke-node` RED (`expected ['core.ai.callPrompt'] to include 'core.conformance.mcp-invoke'`) **and** `conformance-fixture-advert-gating` RED (`advertised but references core.conformance.* nodes this host has not registered: expected ['conformance-mcp-tool-roundtrip'] to deeply equal []`) |
| S4 | unresolvable token ref returns `''` instead of `null` | `mcp-operator-server` RED ×2 (`expected '' to be null`; `promise resolved instead of rejecting`) |
| S5 | credential branch keyed on `reach === 'mcp'` instead of `operatorManaged` | `mcp-operator-server` RED (per-user bearer never reaches the wire) **and** `outbound-mcp` RED ×7 |
| S6 | exempt an operator provider from the https rule | `mcp-operator-server` RED (`promise resolved instead of rejecting` — a plaintext operator URL must be refused outside the private-egress posture) |
| S7 | widen the loader predicate to every `core.ai.callPrompt` | `conformance-mcp-invoke-node` RED: `conformance-stream-text must keep its core.ai.callPrompt node: expected ['core.conformance.mcp-invoke'] to include 'core.ai.callPrompt'` — a real prompt-library fixture, so the narrowness loop has a live subject rather than an empty one |
| S8 | let an operator provider skip `isProviderAllowed` | `mcp-operator-server` RED — operator config buys an ENDPOINT, not an exemption from ADR 0028 |

S5 is worth recording for a reason beyond the row: the first cut of the
non-operator test passed under the wrong condition, because the operator lane
ALSO refuses an id it did not configure. The no-connection half was a gate that
could not fail; the discriminating assertion is a CONNECTED non-operator
provider still putting its own bearer on the wire.

| Piece | File |
|---|---|
| Operator config → synthesized provider | `src/host/mcpOperatorServer.ts` |
| Credential branch + header doc | `src/host/mcpClient.ts` |
| `operatorManaged` marker | `src/features/connections/providerRegistry.ts` |
| Boot registration | `src/index.ts` |
| Invoke bridge | `src/bootstrap/conformanceMcpInvokeNode.ts`, `src/bootstrap/nodes.ts` |
| Fixture load-time mapping | `src/host/index.ts` — **deleted at H47**; the fixture now declares the reserved id itself |
| Conformance boot wiring | `conformance/run.ts` |
| Operator env inventory | `backend/typescript/.env.example`, README |
| Tests | `test/mcp-operator-server.test.ts` (15), `test/conformance-mcp-invoke-node.test.ts` (6), `test/conformance-fixture-advert-gating.test.ts` + `src/features/connections/__tests__/builtinMcpServer.test.ts` (extended) |

- Turn MCP off permanently: safe but does not satisfy the interoperability goal.
- Patch headers into the legacy router: rejected; lifecycle and callback
  semantics changed, so headers alone would create false compatibility.
- Add a second `/mcp-2026` route: rejected; duplicates auth and method owners.


### P3 — MRTR, caching, extensions and auth audience (implemented 2026-08-17, H53)

P3 was recorded as "largely absorbed into P2", with the remainder listed under
"What P2 does NOT do". Reading the code rather than that list turned up **six**
open items, four of which were live defects rather than unbuilt features. Each
is recorded below with what was actually measured, because in three cases the
first design was wrong and the tests are what said so.

#### Gap 1 — the inbound header-less request was `legacy` by coincidence

`selectMcpCodec` returned `{ kind: 'legacy' }` for a request with no
`MCP-Protocol-Version`, unconditionally. §B: *"a host whose `protocolVersions`
does not include a pre-header revision **MUST** reject it."* The branch was
correct only because this host happens to serve `2025-06-18` — and the legacy
sunset (`MCP_LEGACY_PROFILE_SUNSET = 2027-08-12`) exists to reach a state where
it is not. Deleting one array entry would have turned a correct branch into a
silent downgrade with nothing to notice it.

It now derives from the served set. **`selectMcpCodec` takes `served` as a
defaulted PARAMETER** — not for flexibility, but because a claim that can only
ever be evaluated against one value is a guard that cannot fail. Every
production call site is unchanged.

#### Gap 2 — the outbound downgrade had no floor, and the pin has two doors

The Decision text says *"provider manifests declare the exact MCP profile and
auth audience"*; neither existed. `negotiatedCall` would select ANY revision in
`MCP_SUPPORTED_VERSIONS ∩ peer.supported`.

`mcpServer.profile` is now a **FLOOR**, and the distinction it draws is between
EXPLICIT and SANCTIONED. P2's downgrade is honest — the peer's `-32022` is the
only thing that lowers a revision and the lowered revision is carried on every
later call, so `mcp-version-no-silent-downgrade` holds. But an operator who
pinned `mcp-2026-07-28` declared that this peer speaks MRTR and stateless
routing, and a peer that answers `-32022` naming only the legacy revision is not
that peer, however honestly the host reaches that conclusion one step at a time.

**Three things this needed that a single-site fix would have missed:**

1. **The pin overrides a REMEMBERED negotiation, not just the default.**
   `negotiated` is process-global and keyed by ORIGIN, so a downgrade agreed for
   an UNPINNED connector pointing at the same host would otherwise become the
   pinned connector's opening revision. Two manifests, one origin, one map.
   Pinned as its own leg.
2. **`serverStatus`'s legacy `initialize` fallback is a second door.** It goes
   through `callAtRevision`, which never consults `negotiatedCall` at all, so
   pinning the negotiation path alone would have left a probe that downgrades to
   the legacy handshake on any `server/discover` failure. Guarded there too.
3. **An unknown profile name is a hard failure.** Silently ignoring a typo'd or
   newer profile leaves the call running at the preferred revision while the
   manifest says otherwise — a silent downgrade authored in configuration rather
   than in code.

#### Gap 3 — the cache key was missing the ADR's fourth component

The Decision names four: *"server, version, authenticated principal scope and
advertised revision."* P2 shipped three. `revision` is the revision the CALL was
made under, which does not move when a peer adds a tool, drops a capability,
changes its instructions, or is redeployed as a different server at the same
origin — and within `ttlMs` every one of those was served warm.

The key now carries a **digest of the peer's `server/discover` answer**. Because
it is part of the KEY rather than a validator consulted after a hit, a changed
peer's old entry is not stale — it is unreachable.

> **CORRECTION — the first cut of this cached the discovery answer, and that
> defeated the whole mechanism.** Caching it under the peer's own `ttlMs` (the
> suite's fake server offers an hour) is defensible protocol behaviour: the peer
> is the authority on how long its self-description holds. It is also exactly
> the hole this component exists to close — with a cached description, a peer
> that redeployed inside the window was still keyed by its OLD description and
> the stale tools list was served straight back. The guarantee degraded from "a
> changed peer cannot be served the old list" to "…for however long the peer
> said", which is a TTL wearing a key's clothes, the substitution §D forbids in
> as many words. **`mcp-cache-confusion.test.ts` went red on three legs and is
> what caught it**; the reasoning that produced the bug was perfectly sound and
> would have shipped. The client no longer caches `server/discover` at all. The
> cost is one discovery round trip per `listTools` — you cannot key by a fact you
> refuse to re-read — and the `tools/list` round trip is still saved.

> **CORRECTION 2 — validating the peer's self-description started as a blanket
> refusal, which was a live regression.** §B does say a current-profile server
> MUST implement `server/discover`, so the first cut refused any peer that did
> not answer it. Measured: that reddened three pre-existing `outbound-mcp` legs,
> and in production it would have broken `ctx.mcp.listTools` against every real
> peer that has not shipped the method yet (Google Calendar, Slack), for a
> guarantee no operator asked for. Calibrated: **PINNED ⇒ refuse** (the operator
> declared this peer meets the profile in full, and a peer that will not say so
> is not that peer); **UNPINNED ⇒ do not refuse, but do not CACHE either** —
> without a self-description there is no way to notice a change, so serving
> uncached is the honest answer and caching under a placeholder would keep the
> guarantee's shape while losing its substance.

#### Gap 4 — no audience anywhere

`mcpServer.audience`, verified at `wireCall` — **the single choke where a bearer
is attached**, rather than beside the three resolve sites, so a method added
later cannot be added around it. The threat is the confused deputy:
`resolveTarget` binds a credential and a URL by the same `serverId`, which stops
the obvious cross-wiring but cannot see what the credential the broker returned
was MINTED for. Only the token knows that.

**Fail-closed includes the unreadable case**, and that is the decision worth
stating: a declaring manifest plus a token whose audience cannot be read is a
REFUSAL. Letting opaque bearers through would have made the guard unable to fail
on the commonest credential shape there is — indistinguishable from no guard.
Declaring `audience` is opt-in precisely so this can be strict without breaking
connectors carrying opaque tokens today, and the unpinned legs assert that they
still work. The refusal names **neither the token nor the audience it was
actually minted for**: an `aud` claim names a real host, and joined to a refusal
it tells a prober which OTHER peer the credential is good for.

**Inbound is asserted, not rebuilt.** RFC 0154 workload credentials already
reach the mount through the globally-mounted `middleware/workloadIdentity.ts`,
which refuses `audience_mismatch` before `routes/mcp.ts` runs. What was
unproven — and what stops being true the day someone adds an exempt path — is
that the mount is BEHIND it, so that is asserted over HTTP against the real
mount rather than restated at the resolver.

#### Gap 5 — cancellation was fully dormant

`McpClientDeps.signal` has existed since ADR 0030 Phase 2b, is consumed in six
places, and **nothing ever supplied one**. Measured: the executor has no
cancellation mechanism at all — no `AbortController` anywhere in `executor/`,
and a drain loop that checks the RFC 0058 deadline only BETWEEN nodes and never
re-reads the run row. So a cancelled run's in-flight MCP call ran to the 15 s
request timeout and then reported `mcp_timeout` — a misattribution, not just a
delay.

`armRunAbort` rides **the existing `notifyRunTerminal` seam** in
`executor/runLifecycle.ts`, which already calls itself the single owner of "a
run reached terminal". A sibling "run abort registry" would have been a second
answer to "is this run still going", and the two would drift the first time a
terminal path was added to one and not the other.

**Two windows, two behaviours, and conflating them is the easy mistake.** A
request IN FLIGHT is aborted (§B: streams are per-request and a broken stream
loses the request, so the abort IS the transport-level cancellation), surfaces
the typed `mcp_cancelled`, and the peer is told with a best-effort
`notifications/cancelled`. The MRTR GATHER window sends the server **nothing**,
per §C.1 — there is no request in flight, and a notification naming a request the
peer already completed would be a lie about which round trip was abandoned.

> **The notification is a courtesy and can never affect the outcome.** It is
> fired on a fresh timeout-only signal (the run's signal is already aborted, so
> reusing it would abort the cancel), hard-bounded at 2 s, and every failure
> swallowed — including a peer answering `-32601`, which the tests drive by
> default. A cancel that could hang on the telling of it would be worse than a
> cancel that says nothing. **Whether upstream retained `notifications/cancelled`
> in 2026-07-28 could not be verified from here** — the corpus has zero
> occurrences of it and §B does not list it among the removals — so the decision
> was made on blast radius: if upstream dropped it the peer answers `-32601` and
> nothing depends on it; if this host omitted it and upstream kept it, a
> cancelled peer-side job runs on. Nothing is advertised either way.

> **A defect the tests found in my own implementation.** The first cut sent
> `notifications/cancelled` even when the run was ALREADY cancelled before the
> request left — telling a peer to abandon a request it had never received. The
> §C.1 leg caught it; `preAborted` is the fix.

#### Gap 6 — reconnect, and why there is nothing to implement

§B: *"The current revision removed SSE resumability (`Last-Event-ID`) and the
standalone GET stream; a broken response stream loses the in-flight request and
the client **MUST** re-issue it with a new JSON-RPC id."* So the deliverable is
to PROVE the stateless behaviour, which is now pinned: no `Last-Event-ID` on any
request this host makes, no `Mcp-Session-Id`, a broken stream is a typed failure
with exactly ONE attempt reaching the peer, a re-issue mints a fresh id, and the
caller is delivered the result once. Duplicate delivery is the failure mode
resumability would have introduced, and for an effectful `tools/call` it is a
duplicate side effect rather than a nicety.

#### Gap 7 — the audit record

`host/mcpAudit.ts` writes through the **existing** `appendAudit` hash chain (no
second sink); it owns only the SHAPE. The payload key set is CLOSED and pinned
by `toEqual` on a sorted key list — a `toMatchObject` is precisely the assertion
that cannot notice a NEW field, which is the only direction this guards. The
`outcome` and `reason` vocabularies are closed unions, so an out-of-vocabulary
value is a compile error at the call site; `reason` is a CODE, never a message,
because a free-text reason is how a bearer token or a peer's error prose reaches
a durable, append-only record. `target` is bounded, so a peer cannot inflate a
row by choosing a long tool name.

#### Sabotage table — 26 sabotages, 26 RED, each on the intended assertion

Every one asserted its own `git diff --stat` BEFORE any test result was trusted,
and the failing assertion was read rather than the exit code. Residual `src`
diff after the run: **empty**.

| # | Sabotage | Result |
|---|---|---|
| S1 | header-less request returns `legacy` unconditionally | RED — `expected {kind:'legacy'} to deeply equal {kind:'unsupported'}` |
| S2 | explicit legacy header accepted regardless of the served set | RED |
| S3 | `negotiatedCall` ignores the pin | RED — `promise resolved instead of rejecting` |
| S4 | a remembered negotiation outranks the pin | RED — the two-manifests-one-origin leg |
| S5 | `callAtRevision` drops the pin guard | RED — `serverStatus` reaches `initialize` on a pinned server |
| S6 | an unknown profile name is ignored | RED |
| S7 | `assertAudience` returns early always | RED — confused deputy |
| S8 | an unreadable audience is allowed through | RED — the opaque-bearer leg |
| S9 | `audienceMatches` returns true for any non-empty pair | RED |
| S10 | cache key drops `discoveryRevision` | RED — `expected [{name:'echo'}] to deeply equal [{name:'after-bump'}]` |
| S11 | re-introduce discovery caching (the CORRECTION above, as a sabotage) | RED on three legs |
| S12 | cache an unvalidatable peer under a placeholder key | RED — `an unvalidatable peer is read every time` |
| S13 | `transportError` stops distinguishing cancel from timeout | RED — the code becomes `AbortError`, not `mcp_cancelled` |
| S14 | never send `notifications/cancelled` | RED ×2 (client leg + the e2e leg) |
| S15 | send the notification even when pre-aborted | RED — the §C.1 leg |
| S16 | the notification hand-writes its headers | RED — `expected undefined to be '2026-07-28'` |
| S17 | `armRunAbort` registers a listener that never aborts | RED |
| S18 | the executor stops passing `signal` into `ctx.mcp` | RED — `the in-flight call must observe the run cancellation` |
| S19 | the executor stops arming the signal | RED — same assertion |
| S20 | add a `token` field to the audit payload | RED — closed key set |
| S21 | `mcpAuditTarget` drops the length bound | RED — `expected 10009 to be less than 300` |
| S22 | the mount stops refusing anonymous principals (H43 regression probe) | RED |
| S23 | `method` reaches the audit row unbounded (the review finding below) | RED — `expected 9000 to be less than 200` |
| S24 | `finalizeRun`'s terminal guard disabled | RED — `expected 'completed' to be 'cancelled'` |
| S25 | the guard reads the STALE in-memory `run.status` instead of the row | RED — same assertion; this is the one that proves the FRESH read is load-bearing |
| S26 | drop the tenant-scoped second key from `OPENWOP_API_KEYS` | RED — `the tenant-scoped second key must ALSO reach the mount: expected 401 to be 200` |

> **S18/S19 were re-aimed, and the first result would have been a false
> positive.** Both went RED on the first pass — on an unrelated `TypeError` deep
> in `executeRunBody`, because with the wiring removed the tool call simply
> succeeded late and the run took a different terminal path. A red on a crash is
> not evidence that the test detects the defect. The leg now asserts the NODE's
> outcome, captured inside the node where no later executor behaviour can mask
> it, and both re-runs fail on `expected undefined to be 'mcp_cancelled'`.

#### What the `code-review` pass found — two defects in this phase's own work

Both in the audit path, both fixed before the gate, and both the kind of thing 60
green tests do not notice because the tests assert what the code was *for*.

1. **The unauthenticated 401 wrote a durable audit-chain row.** That branch is
   reachable by any anonymous caller, and `appendAudit` takes a per-tenant lock
   and a seq CAS — so auditing it hands an unauthenticated prober an unbounded
   durable-write lever, into a tenant bucket that had to be INVENTED (`'unknown'`)
   because there is no caller identity to file it under. Removed: the refusal is
   already recorded content-free in the structured log, and the ADR's audit
   requirement is about MCP *decisions*, which presuppose a principal. Every
   remaining audited branch has one.
2. **`method` is peer-supplied and was not bounded** — `routes/mcp.ts` reads it
   straight off the JSON-RPC body, so a peer chose how many bytes an append-only
   row cost. Worse, the field's doc comment asserted the opposite ("host
   vocabulary, never peer-supplied free text"), which is why it read as safe.
   Bounded like `target`, comment corrected in place, and S23 added.

> **A process failure worth recording, because I walked into a hazard this
> repo's own rules name explicitly.** Sabotaging S23 the first time, I restored
> with `git checkout -- src/host/mcpAudit.ts` while that file carried the
> UNCOMMITTED review fix above — and destroyed it, exactly the H49 failure the
> agent rules warn about in as many words. It was caught only because the next
> grep for `boundAuditString` returned `0`. The rule is not "snapshot the file";
> it is **commit before sabotaging**, which makes `git checkout --` restore the
> right thing by construction. S23 was re-run afterwards on a tree verified clean
> both before and after.

#### Gap 8 — `finalizeRun` undid the cancel it had just accepted

> Originally reported as out of scope. **Pulled back IN by the program**, on the
> correct reasoning: the W6 witness ("a run cancelled mid-flight ⇒ node outcome
> `mcp_cancelled`") is exactly the assertion this defect defeats. A run that is
> cancelled, audited, cascaded to its children — and then reports `completed` a
> second later — has not been cancelled, and every other cancellation claim in
> this phase would have been true only until the last node returned.

Every branch of `finalizeRun` wrote `storage.updateRun(..., { status })` from
the in-memory `RunRecord` captured at run START, and none re-read the row. An
RFC 0094 cancel lands on the ROW while the drain loop is still running nodes, so
the write silently reverted it. Same seam H50 named as the **"finalizeRun-bypass
choke"**: the fault is not that any individual write is wrong, it is that
*nothing re-reads the row* between the cancel and the write.

Guarded **once at the top** rather than at each of the named sites, and the
reason is ordering: the event appends happen BEFORE the status writes, so a
per-write guard would still have emitted `run.completed` into a cancelled run's
event log — a worse lie than the status, because the event stream is the durable
record. The test asserts all three surfaces (returned disposition, durable row,
event stream).

> **NOT claimed as atomic, and the distinction is the point.**
> `Storage.updateRun` has no compare-and-swap, so a cancel landing between this
> read and the write still wins the write and loses the status. **A
> legal-transition check is not a CAS** — the same trap as two concurrent
> read-check-writes both firing one refund. What this buys is a window narrowed
> from "the entire duration of the final node" to "between a read and a write";
> closing it needs a status-conditional write on the `Storage` interface, which
> is a lifecycle change and deliberately out of scope (the program's "no
> lifecycle rewrite" bound).

**A pre-existing executor fragility surfaced while building this, NOT fixed:**
`runOneNode`'s final `return { kind: 'suspended', interrupt: outcome.interrupt }`
is a fall-through — a node returning a malformed `NodeOutcome` (no `status`)
lands there and the caller crashes on `out.interrupt.data` with a raw
`TypeError` instead of failing typed. My first test fixtures returned a bare
`{}` and hit exactly this, which is *why* sabotages S18/S19 first went red for
the wrong reason. The fixtures are fixed; the executor's fall-through is
reported, not patched.

#### Gap 9 — the §D cross-caller cache leg had never executed

`mcp-cache-tenant-scope`'s cross-caller half has recorded `blocked` on every run
of this host, because `conformance/run.ts` never set
`OPENWOP_TEST_SECONDARY_API_KEY`. It now mints a second key as a second entry in
the SAME `OPENWOP_API_KEYS` CSV (the H38 precedent — never a second auth
mechanism).

**Scoped to its own tenant, not a second `:*`, and that is the substance rather
than caution.** The leg asks whether a `tools/list` that DIFFERS between two
callers is marked `private`. Two wildcard operator keys are the *same*
authorization context, would be served the same list, and the `if (!same)`
assertion would never fire — a leg that executes and cannot fail, which is
precisely the vacuous green the RFC 0148 ledger exists to expose. Note also that
the corpus leg bails on `theirs.status !== 200` **without failing**, so a
secondary key that does not authenticate produces a silent pass; that is the
failure mode `mcp-cache-cross-caller.test.ts` asserts against locally, so a
mis-wiring surfaces here rather than in the lane.

#### Wire

**No wire change.** Everything here is RFC 0153-accepted behaviour (§B
downgrade + streams, §D cache keys, §E audience) or host-side manifest fields
(`mcpServer.profile`, `mcpServer.audience`) that never reach a capability
document. Nothing new is advertised.

#### Corpus coverage — an honest absence

The installed suite (**1.136.0**, 16 `mcp-*` files / 38 tests) has **zero**
coverage of cancellation, stream reconnect, or MCP token audience:
`notifications/cancelled` appears nowhere in `src/`, `Last-Event-ID` is
OpenWOP-run-SSE only, and every `audience` hit belongs to RFC 0079/0154. Its
`McpFakeServer` answers every method synchronously, so there is no in-flight
window a cancellation could even be witnessed in. These three deliverables are
therefore host-witnessed only — recorded as an absence rather than papered over,
and a candidate for a corpus follow-up.

| Piece | File |
|---|---|
| Inbound served-set derivation + profile→version map | `src/host/mcpProfile.ts` |
| Manifest `profile` + `audience` | `src/features/connections/providerRegistry.ts` |
| Downgrade floor, audience gate, discovery validation, cancel notification | `src/host/mcpClient.ts` |
| `discoveryRevision` key component | `src/host/mcpClientCache.ts` |
| Audit record (closed key set) | `src/host/mcpAudit.ts` |
| Inbound refusal audits | `src/routes/mcp.ts` |
| Run cancellation signal | `src/executor/runLifecycle.ts`, `src/executor/executor.ts` |
| Terminal-status guard | `src/executor/executor.ts` (`finalizeRun`) |
| Second conformance caller | `backend/typescript/conformance/run.ts` |
| Tests | `test/mcp-downgrade-floor.test.ts` (15), `test/mcp-token-audience.test.ts` (14), `test/mcp-cancel-reconnect.test.ts` (11), `test/mcp-cache-confusion.test.ts` (8), `test/mcp-audit-record.test.ts` (8), `test/run-abort-signal.test.ts` (9), `test/mcp-cache-cross-caller.test.ts` (3) |

### H47 — pin `^1.136.0`; the H21 loader rewrite and the A2A legacy alias DELETED (2026-08-17)

H21 shipped a load-time rewrite in `host/index.ts` that mapped the roundtrip
fixture's `core.ai.callPrompt` + `config.mcp` node onto
`core.conformance.mcp-invoke`, and recorded its own exit condition: *delete it
when the pin moves past 1.136.0, not before.* openwop#1060 (suite **1.136.0**,
S33) renamed the fixture's node to that conformance-RESERVED id and stated the
MUST-map / MUST-NOT-advertise rule with it in `node-packs.md`, `fixtures.md` and
`mcp-integration.md` §Conformance. **The rewrite is deleted at pin `^1.136.0`
(openwop#1060).**

The A2A twin `CONFORMANCE_A2A_INVOKE_LEGACY_TYPE_ID` (`core.a2a.invoke`, H25 /
#3286) was written on the same lifecycle — "this constant is what a later pin
bump deletes" — and **is deleted here too**, on the same measured condition, not
by analogy: `grep -l 'core\.a2a\.invoke' node_modules/@openwop/openwop-conformance/fixtures/*.json`
at 1.136.0 returns nothing.

**Why "the pin moved" was not the whole condition.** The host loads fixtures from
the vendored `conformance-fixtures/` dir. `scripts/sync-fixtures.sh` syncs that
dir from the **corpus**, never from `node_modules`, so the npm pin and the
vendored copy are two independent inputs — and at the moment of the bump the
vendored copies of BOTH roundtrip fixtures still carried the legacy spellings.
Deleting on the pin alone would have restored the exact
advertise-and-spuriously-fail breakage the exit condition exists to prevent,
with every version string reading 1.136.0. Both fixtures were re-vendored from
`../openwop` `origin/main` at 1.136.0 (verified byte-identical to the installed
package copies) before anything was deleted, and the two-input condition is now
a test rather than a comment.

Vendoring the two changed fixtures alongside the pin bump — rather than a
whole-dir `sync-fixtures.sh` run — follows the established practice here
(`7e0e1b1ac` "pin ^1.72.2 + vendor B2 fixture", `e923885c6` "pin ^1.70.2 + sync
rebuilt handoff fixture"). **Residue:** the vendored set is otherwise stale
against 1.136.0 — it lacks `conformance-agent-memory-injection-budget.json`,
`conformance-context-budget-multiturn.json`, `connection-packs/`,
`trigger-events/` and `pack-manifests/workflow-chain-sample.pack.json`, and
carries two host-authored extras (`conformance-replay-effect*.json`). That drift
is unguarded outside the two fixtures pinned by the new test, and is its own
item.

**Lockfile:** `npx -y npm@10.9.8 install --package-lock-only`, `added: 0,
removed: 0` — the diff is 4 lines, the dependency range plus the resolved
version / URL / integrity of the one package. `test/kms-backend-preflight.test.ts`
green (the npm ≥ 11.5 `optionalDependency`-pruning tripwire).

| Sabotage | Change | Result |
|---|---|---|
| S9 | revert the vendored `conformance-mcp-tool-roundtrip.json` to the `core.ai.callPrompt` spelling, keep the rewrite deleted | `conformance-mcp-invoke-node` RED ×2 (`expected [ 'core.ai.callPrompt' ] to include 'core.conformance.mcp-invoke'`; and the vendored-vs-pinned byte comparison) **and** `conformance-fixture-advert-gating` RED (`advertised but references core.conformance.* nodes this host has not registered`) — i.e. the exit-condition-not-met state is caught, not silently shipped |
| S10 | revert the vendored `conformance-a2a-task-roundtrip.json` to `core.a2a.invoke` | `conformance-mcp-invoke-node` RED ×2 (reserved id absent; vendored ≠ pinned) **and** `conformance-fixture-advert-gating` RED — the A2A half of the deletion is guarded independently of the MCP half |
| S11 | re-register the deleted `core.a2a.invoke` alias | `conformance-a2a-invoke-node` RED (`the legacy alias is deleted: expected NodeModule to be null`) — the absence assertion is the load-bearing half; without it a quiet re-registration would be untestable |

| Piece | File |
|---|---|
| Pin + lockfile | `backend/typescript/package.json`, `backend/typescript/package-lock.json` |
| Loader rewrite deleted (`mapMcpInvokeTypeId`, `declaresMcpToolCall`, the extra advert-membership clause) | `src/host/index.ts`, `src/bootstrap/conformanceMcpInvokeNode.ts` |
| A2A legacy alias deleted | `src/bootstrap/conformanceA2aInvokeNode.ts` |
| Fixtures re-vendored at 1.136.0 | `conformance-fixtures/conformance-mcp-tool-roundtrip.json`, `conformance-fixtures/conformance-a2a-task-roundtrip.json` |
| Tests | `test/conformance-mcp-invoke-node.test.ts` (rewrite tests → vendored-fixture + pin-parity guards), `test/conformance-a2a-invoke-node.test.ts` (alias-absence), `test/conformance-fixture-advert-gating.test.ts` (restatement back to the bare prefix, + the A2A fixture as a second subject) |
