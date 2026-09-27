# REPORT-C — Slice C: interop / identity artifacts (pass 2, 2026-08-18)

Scope: RFC 0152 (A2A 1.0), RFC 0153 (MCP 2026-07-28), RFC 0154 (workload identity /
delegation / telemetry / provenance), proposed RFC 0161, proposed RFC 0163; app-side ADR 0552 /
0553 / 0556 as their reference-host implementations.

Baselines read: spec `/Users/david/dev/openwop` main `54f29548` (2026-08-17 17:08 -0400); app
`/Users/david/dev/openwop-app` main `9b2af4839` (#3325, 2026-08-17 19:23 -0400 — i.e. AFTER the
spec tip); roadmap `c60ee3645`; live wire `https://app.openwop.dev/api/.well-known/openwop` read
2026-08-18 (readiness `build.commit` = `fb6cbbcba`, so **#3324/#3325 are NOT deployed**).
Method: read RFC text, registers, spec prose, conformance scenario source, host source + tests,
git log; network reads of npm/PyPI package metadata + three tarballs/wheels unpacked under the
scratchpad. No suites run, no repo modified.

Evidence-level vocabulary is the roadmap's: schema / server-free / test-seam / local-live /
deployed-live / official-peer / independent-host / external-audit.

---

## RFC 0152 — A2A 1.0 Versioned Composition

### 1. Identity
- Path: `RFCS/0152-a2a-1-0-versioned-composition.md`, 107 lines.
- `Status:` line verbatim (`:7`): `| **Status** | \`Accepted\` |`
- Last substantive edit: `9eb52572 2026-08-16 feat(conformance): RFC 0148 acceptance closed out — … six 0152/0153 invariants registered (1.123.0) (#1029)`.
- Sections: Summary, Motivation, Proposal §A–§E, Compatibility, Conformance, Alternatives (4), Unresolved questions (4; UQ1 date + UQ3 + UQ4 resolved, UQ2 open), Implementation notes, Acceptance criteria (5 boxes, 0 ticked, every box annotated), References. No phases (RFC); no "Verification record"/"Claim record" in the roadmap Part V sense.
- Registers: `RFCS/registers/0152-*.gaps.md` (G1–G7; last edit `046576d5`), `.risks.md` (R1–R5; `bbeacebe`).

### 2. What it decides
- §A: `a2a.protocolVersions[]` + `preferredVersion` + `profiles[]` (`a2a-1.0`, `a2a-0.3-legacy`); bare `supported:true` deprecated and cannot substantiate a "current A2A" claim (`:38`).
- §B: `A2A-Version: 1.0` mandatory on 1.0 requests; upstream version error projected through the OpenWOP interop envelope; no silent downgrade; policy-forbidden downgrade fails closed + content-free audit event (`:42`).
- §C: 1.0 Agent Card + `supportedInterfaces` derived from the same source as runtime routing (`:46`).
- §D: field-by-field translation table (D.1–D.7 landed in `spec/v1/a2a-integration.md`), unknown upstream fields opaque, RFC 0100 persistence/replay/push-SSRF retained (`:50`).
- §E: peer identity ≠ authorization; three invariants `a2a-version-no-silent-downgrade`, `a2a-card-runtime-consistent`, `a2a-peer-no-authority-escalation` (`:54-56`).
- Compatibility: additive; 0.3 legacy window 12 months → **2027-03-12** (UQ1); removal is v2 or a safety fix (`:60`).
- Conformance (`:64-74`): seven named scenarios; "Shape tests use official A2A 1.0 fixtures"; behavioural acceptance requires "at least one real upstream A2A 1.0 peer in addition to the fake peer".
- Rejected: prose-only bump; immediate replacement; content-negotiation inference; do nothing (`:78-81`).

### 3. Artifact quality
- **Internal contradiction (stale vs its own later line):** `:97` "openwop-app's live origin passes the §A leg and has NOT wired the seam, so its §B legs are `blocked`" vs `:100` "each on a leg driven non-vacuously against the first 1.0 host (openwop-app ADR 0552 P2 at main `24b9e6c9b`, strict, fake peer)". The seam WAS wired at `24b9e6c9b` (app `test/a2a-invoke-seam.test.ts`; `INTEROP-MATRIX.md:293` records `a2a-1-0-task-roundtrip 1/1`, `a2a-peer-authority 1/1`, `a2a-version-negotiation 4/4` executed). `:10` ("Updated") carries the same stale "passes §A only — no invoke seam" clause. Made stale by app `24b9e6c9b` (2026-08-16 08:23) and spec `INTEROP-MATRIX` `9a7f2cba` (deployed-origin witness).
- `:74` "Shape tests use official A2A 1.0 fixtures" — **not met as phrased**: `conformance/fixtures/` holds no upstream A2A fixture; the peer is hand-written from `a2a.proto@v1.0.0` (`conformance/src/lib/a2a-fake-peer.ts:18,37`). Either strike "official fixtures" or vendor them.
- `:66-72` names `a2a-1.0-version-header`, `a2a-1.0-stream-push`, `a2a-version-downgrade` files; none exist under those names — header/downgrade live inside `a2a-version-negotiation.test.ts`; stream-push does not exist at all (`a2a-integration.md:503` G6 "Open: `a2a-1.0-stream-push`"). Not a defect, but the Conformance list should map names → files.
- Spec prose staleness the RFC depends on: `spec/v1/a2a-integration.md:504` (G3) "the fake peer is 0.3-shaped" contradicts `:503` (G6) "dual-era peer landed" in the SAME table; `:362` says `a2a-card-runtime-consistent` is "*named, not yet registered*" — registered `9eb52572` (`SECURITY/invariants.yaml:3191`).
- Acceptance box `:98` "Real upstream A2A 1.0 peer passes in CI. (Carried, and externally gated…)" — **the "externally gated" premise is FALSE today**: `@a2a-js/sdk@1.0.1` published 2026-07-28 (`npm view … time`), ships client + Express/gRPC servers + `compat/v0_3` (unpacked: `dist/server/express/index.js`, `dist/client/index.js`, both carrying `"SendMessage"`/`"GetTask"`/`"CancelTask"`/`"SubscribeToTask"` and `A2A-Version`). Nothing external blocks a pinned run; UQ2 (`:86`) is a corpus decision.
- Missing vs Part V template: no verification record (commands/limits), no claim record (profiles advertised vs not, evidence expiry). Partly substituted by `INTEROP-MATRIX.md:285-297`.
- Correction notes present and good (UQ1/UQ3/UQ4 struck with dates; acceptance boxes annotated with "(Formerly: …)"). No correction note yet for the `:97` over-correction.

### 4. Implementation reality on current main
Corpus (spec `54f29548`):
- §A schema + `versioned-composition-profiles.test.ts` — LANDED (schema level; `capabilities.schema.json` a2a family).
- §C/§D/§E prose D.1–D.7 — LANDED `d77d259b` (#1010) in `a2a-integration.md` §"A2A 1.0 versioned composition".
- Dual-era `A2AFakePeer` + 5 scenario files (`a2a-1-0-agent-card`, `a2a-1-0-task-roundtrip`, `a2a-card-runtime-consistency`, `a2a-peer-authority`, `a2a-version-negotiation`) — LANDED `00e3b44a` (#1016), `5e2aefe8` (S23), `046576d5` (S17/S18).
- Invariants: 3/3 registered (`invariants.yaml:1505,3191,3208`).
- Host-as-server legs present: SendMessage/GetTask/not-found (`a2a-1-0-task-roundtrip.test.ts:75-107`) and card/runtime (`a2a-card-runtime-consistency.test.ts:80-165`). ABSENT: artifacts, CancelTask, cross-tenant lookup, streaming, push (host-as-server); no `OPENWOP_A2A_REAL_PEER_URL` reader among the 1.0 legs (only legacy `a2a-task-roundtrip.test.ts:64` and `cross-host-traceparent-propagation.test.ts` reference it).
- Evidence level reached: **deployed-live** for §A + §C (`INTEROP-MATRIX.md:289` — `a2a-card-runtime-consistency` 5/5 on `app.openwop.dev` deploy `1b2dd6fbb`); **local-live** for §B/§D/§E legs (`:293`); **official-peer: none** (no `@a2a-js/sdk` in either repo — `backend/typescript/package.json` and `conformance/package.json` grep clean).

App (ADR 0552, `docs/adr/0552-a2a-1-adapter-and-versioned-interop.md`, `Status:` `:3-12`; last edit `a847daa50` H44):
- P0/P1/P2 + P2-correction/H19/H24/H25/H26/H41/H27 — LANDED (provenance table `:118-127`, witness files `test/a2a-*.test.ts` — 12 files present).
- P3 (streaming/push durability) — OPEN, `host-evidence`. Live wire: `a2a.streaming:false, pushNotifications:true, durableTasks:true, protocolVersions:["1.0","0.3"], profiles:[a2a-1.0,a2a-0.3-legacy]`. Under `OPENWOP_A2A_STREAMING=true` the 1.0 codec answers `SendStreamingMessage`/`SubscribeToTask` with ONE JSON `{task}` and demands `params.id` even for SendStreamingMessage (`src/host/a2aServer10.ts:216-233`) — no SSE, no create-via-stream. Push = single best-effort POST, no retry/outbox (`src/host/a2aTaskStore.ts:379-405`).
- P4 (retire legacy) — OPEN, date-bound 2027-03-12; no adopter inventory (RFC 0152 G1).
- Between `fa968b428` and `9b2af4839`: **no A2A change** (`git diff --stat` on `host/a2a*`, `routes/discovery.ts`, ADR 0552 = empty). ADR 0552's provenance table lacks the H47 row (the `core.a2a.invoke` legacy alias deletion is recorded only in ADR 0553 `:1053-1110`).

### 5. Roadmap bullet-by-bullet (`OPENWOP-A-PLUS-ROADMAP.md:247-261`)
| Bullet | Verdict | Evidence |
|---|---|---|
| Run the profile against an official or pinned upstream A2A 1.0 peer | OPEN — **actionable now** | `@a2a-js/sdk@1.0.1` (npm, 2026-07-28); no dep anywhere; RFC 0152 UQ2 `:86` open |
| Test Agent Card/runtime consistency | DONE (deployed-live) | `a2a-card-runtime-consistency.test.ts`; `INTEROP-MATRIX.md:289,293` |
| Test task creation, status, artifacts, errors, cancellation, authentication, tenant isolation, authority preservation | PARTIAL | creation/status/not-found/errors: `a2a-1-0-task-roundtrip.test.ts`; authority: `a2a-peer-authority.test.ts`; auth: bearer in roundtrip; **absent at suite:** artifacts, Cancel, cross-tenant (app-only `test/a2a-tenant-binding.test.ts`) |
| Add streaming and push-notification qualification | OPEN | no `a2a-1.0-stream-push`; peer doesn't stream; host returns single JSON under the flag (`a2aServer10.ts:233`) |
| Specify and test restart-safe subscription and task correlation | FALSE-PREMISE (specify) / OPEN (test) | RFC 0100 §2/§3 already specify durable Task + `tasks/resubscribe`; host persists via `DurableCollection` (`a2aTaskStore.ts:17-27`); no restart leg in `test/a2a-durable-tasks.test.ts` (memory://, single process) |
| Publish the legacy 0.3 adopter inventory | OPEN | G1 "Measured — one dual-era advertiser (openwop-app)"; telemetry cannot distinguish 0.3 vs 1.0 (`metricSeams.ts:422` labels `{protocol, disposition}` only) |
| Enforce the deprecation date in claims and release tooling | OPEN | `A2A_LEGACY_PROFILE_SUNSET` exists as a constant (ADR 0552 `:88`); no date-aware lint in corpus `scripts/` or app gate |
| Include official-peer evidence in certification bundles | OPEN (needs schema) | `schemas/certification-bundle-v2.schema.json` properties = bundleVersion/suite/host/discovery/claimedProfiles/aliases/results/scenarioManifestSha256/targetConfigurationSha256 — no peer field |

### 6. Cross-artifact
- Depends on RFC 0100 (durable tasks/push — the "restart-safe push" bar is ABOVE RFC 0100 §4 `:99-105`, which requires fire-on-transition + SSRF only); RFC 0154 for identity (G5 closed); RFC 0148 for `blocked` semantics; RFC 0156 §F claims gate.
- Ownership overlap with proposed RFC 0163: peer qualification/pinning (0152 UQ2 + G3 + R5 already own "which peer / pinned / no flake").
- RFC 0147 §A.1: 0152 is workstream 5 — exempt from the freeze (`docs/RFC-0147-SELF-AUDIT.md:29-31`); a bundle-v2 peer field is a corpus artifact, not host wire.
- Part III row "Current A2A interoperability | RFC 0152, RFC 0163 | ADR 0552 | official-peer CI evidence" — correct owner; the RFC 0163 half is unnecessary for the run itself.

### 7. Defects & gates-that-cannot-fail
- **G-C1 (gate cannot fail):** `a2a-card-runtime-consistency.test.ts:153-165` compares `card.capabilities.streaming/pushNotifications` to `capabilities.a2a.*` — both derived from the SAME env flags (`a2aCard.ts:78-79`, `discovery.ts:1370-1372`). Flipping `OPENWOP_A2A_STREAMING=true` keeps the leg green while the endpoint returns a single JSON body. Needs a behavioural stream leg (SSE content-type + ≥1 event) — the RFC's own missing `a2a-1.0-stream-push`.
- **Claims gate blind:** `scripts/generate-assurance-status.mjs:142` `current-A2A compatible` has `tokens: []` — no wording can trip it; `permitted:false` is hard-coded, not derived from a peer result. Small; owner RFC 0156 §F.
- Telemetry cannot support P4/G1: `openwop.protocol.version{protocol,disposition}` (`metricSeams.ts:422`) has no profile label. Small; owner ADR 0552/0553 (shared).
- Doc drift: `a2a-integration.md:362,504`; RFC 0152 `:10,:97`.

### 8. Verdict
Roadmap treatment is **partially stale**: card/runtime is done at deployed-live; "specify restart-safe" is owned by RFC 0100; the official-peer run is the cheapest external-evidence win in the whole program and is **not** externally gated. Artifact needs an amendment pass: strike the `:10/:97` "no seam" clause, map the seven scenario names to real files, delete "official fixtures" or vendor them, resolve UQ2 by naming `@a2a-js/sdk@1.0.x` (pinned) as the CI peer, add artifacts/Cancel/cross-tenant/stream legs. **P1** — evidence-level jump for near-zero spec work.

---

## RFC 0153 — MCP 2026-07-28 Versioned Composition

### 1. Identity
- Path: `RFCS/0153-mcp-2026-07-28-versioned-composition.md`, 109 lines. `Status:` `:7` `| **Status** | \`Accepted\` |`. Last edit `9eb52572` (#1029).
- Sections: Summary, Motivation, §A–§E, Compatibility, Conformance (8 named scenarios), Alternatives (4), UQ (5; UQ1 date/UQ3/UQ4/UQ5 resolved, UQ2 open), Impl notes, Acceptance (5 boxes, 0 ticked, annotated), References. Registers G1–G5 / R1–R5 (`bbeacebe`).

### 2. What it decides
- §A exact date-form `protocolVersions`, `preferredVersion`, `profiles`, closed `features` (`server-discover|mrtr|cacheable-lists|extensions`) (`:28-38`).
- §B stateless core: no `initialize`/session; `server/discover`; `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` header↔body agreement fails closed (`:42`).
- §C MRTR replaces legacy `sampling/createMessage`/`elicitation/create` for the current profile; durable request identity, timeout, cancel, retry, interrupt composition, replay-recorded outcomes; no silent legacy fallback (`:46`).
- §D ordered lists preserve upstream order + validators; cache keys include tenant/principal scope + authorization-relevant discovery context; extensions opaque, no authority via `_meta` (`:50`).
- §E every request re-authorized at OpenWOP; anonymous principal MUST NOT be production default; MCP content never advances approval gates; five invariants (`:54-56`).
- Legacy `mcp-2025-06-18-legacy` window → **2027-08-12** (UQ1); removal v2 or safety fix (`:60`).
- Rejected: mutate RFC 0020; keep sessions as extension; MRTR-over-callbacks advertised as current; do nothing (`:79-82`).

### 3. Artifact quality
- **Stale/contradictory:** `:99` "openwop-app's live origin passes the §A legs and has NOT wired the seam, so its §B legs are `blocked`" vs `:102` "driven non-vacuously against the first 2026-07-28 host (openwop-app ADR 0553 P2 branch `3c2cd839a`)" and `INTEROP-MATRIX.md:294` "**DEPLOYED-WIRE for §B/§D since 2026-08-17** … `mcp-2026-07-28-discover` 10/10 · `mcp-stateless-request` 2/2 · … `mcp-current-auth-boundary` ✓ 1/1 on deploy #3". Made stale by app `df03c3476` (2026-08-16 09:24) and spec `d8f9be75`/`1bcbcd41` (2026-08-17). `:10` "Updated" carries the same clause.
- `:100` "Pinned real MCP current peer passes in CI. (Carried, and externally gated…)" and G3 "Carried, externally gated — no real current peer selected". **The upstream half of that gate is FALSE for the Python SDK**: PyPI `mcp==2.0.0` released **2026-07-28T13:45Z** with `mcp-types==2.0.0`; unpacked wheel: `mcp_types/version.py` `KNOWN_PROTOCOL_VERSIONS = (…, "2025-11-25", "2026-07-28")`, `mcp_types/methods.py:122` `("server/discover", "2026-07-28")`, `mcp/server/lowlevel/server.py:448` `("server/discover", …, self._handle_discover)`, `mcp/server/request_state.py`, `mcp/shared/message.py:27` per-message `MCP-Protocol-Version`/`Mcp-Method` headers. The **TypeScript** SDK is NOT there: `@modelcontextprotocol/sdk@1.30.0` (2026-07-27, `latest`) has `LATEST_PROTOCOL_VERSION = '2025-11-25'`, `SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']` and zero hits for `server/discover`/`Mcp-Method`/`requestState` (`dist/esm/types.js:2-4`). So: official-peer for RFC 0153 = pin `mcp==2.0.0` (Python) as the reference server/client; UQ2 `:87` is a corpus decision, not an external wait.
- `:66-73` names `mcp-routing-headers.test.ts` and `mcp-version-downgrade.test.ts` — neither exists (headers → `mcp-stateless-request` + `mcp-2026-07-28-discover:75`; downgrade → `mcp-version-negotiation`). Map names → files.
- Spec prose staleness: `spec/v1/mcp-integration.md:300,301,308` still say `mcp-cache-tenant-scoped` / `mcp-extension-no-authority` / `mcp-peer-no-authority-escalation` are "named — not yet registered"; all three registered `9eb52572` (`invariants.yaml:3225,3242,3258`).
- Note for G1 (adopter inventory): the corpus's legacy profile is 2025-06-18, but upstream's most-deployed TS revision is **2025-11-25**, which the corpus never names (app `docs/adr/0553:302` "2025-11-25 is NOT a profile: `selectMcpCodec` refuses it -32022"). Real TS-SDK clients negotiate down through `initialize` to 2025-06-18, so no break — but the inventory question should name 2025-11-25.

### 4. Implementation reality on current main
Corpus: §A schema (incl. S27 `mcp.serverUrls`, `821921ce`); §B–§E prose `65ebd53a` (#1012); dual-era `McpFakeServer` + 7 files (`07e5f276` #1017, `da84d535`, `fbb82fa8` S25, `d8f9be75` S30); invariants 5/5 registered (`invariants.yaml:1524,3225,3242,3258,3274`). MRTR legs cover identity/requestState/retry/forged-state (`mcp-mrtr-roundtrip.test.ts:53,94`); **ABSENT: timeout, cancellation, replay legs; scope-change staleness leg** (only one leg in `mcp-cache-tenant-scope.test.ts:48`). Evidence level: **deployed-live** for §B/§D/§E-auth-boundary (`INTEROP-MATRIX.md:294`, deploys `756a9938d`/`3318d7062`), local-live for MRTR server half; **official-peer: none**.

App (ADR 0553, 1110 lines; `Status:` `:3`): P0/P1/P1§A/P2/H43/H21/H27/H47 LANDED (provenance table `:119-135`); **P3 LANDED at `9b2af4839` (#3325, H53)** — the change between the audit baselines: downgrade floor both directions (`mcpProfile.ts`, `mcpClient.ts`), `discoveryRevision` cache component (`mcpClientCache.ts:67`), `mcpServer.audience` gate at `wireCall`, run-abort → `notifications/cancelled` (`runLifecycle.ts`, `executor.ts`), stateless reconnect proof, `mcpAudit.ts`, second tenant-scoped conformance key (`conformance/run.ts:477,995`); 7 new test files (`test/mcp-{downgrade-floor,token-audience,cancel-reconnect,cache-confusion,audit-record,cache-cross-caller}.test.ts`, `test/run-abort-signal.test.ts`). **NOT deployed** (live `build.commit fb6cbbcba`; live `mcp.features = [server-discover, mrtr, cacheable-lists]`, no `extensions` — honest). P4 (claims) OPEN. The H44 provenance table `:119-135` has no P3/H47 rows (stale by #3325 itself).

### 5. Roadmap bullet-by-bullet (`:263-277`)
| Bullet | Verdict | Evidence |
|---|---|---|
| Run against an official current MCP SDK or reference peer | OPEN — **actionable with Python `mcp==2.0.0`**; TS SDK not yet | see §3 |
| Prove stateless discovery and per-request metadata behavior | DONE (deployed-live) | `mcp-2026-07-28-discover`, `mcp-stateless-request:65`; `INTEROP-MATRIX.md:294` |
| Prove header/body version and method consistency | DONE (deployed-live) | `mcp-stateless-request:49`, `mcp-2026-07-28-discover:75,192`; invariant `:3274` |
| Prove MRTR request identity, retry, timeout, cancellation, replay | PARTIAL | identity/retry/requestState: `mcp-mrtr-roundtrip.test.ts`; timeout/cancel/replay: no suite leg (ADR 0553 `:1030-1040` "installed suite … has zero coverage of cancellation, stream reconnect, or MCP token audience"); host-only `test/mcp-cancel-reconnect.test.ts` |
| Prove cache tenant scoping and invalidation after authorization changes | OPEN — **worse than listed** | key `scopeFingerprint = sha256([tenantId, orgId, actingUserId, serverId])` (`mcpClient.ts:899`) carries NO authorization material; `invalidateMcpCacheForPrincipal` (`mcpClientCache.ts:155`) has zero production callers (only `test/mcp-client-current.test.ts:383`); `mcpClientCache.ts:22-27` docblock ("a revoked scope cannot hit a warm entry at all") and ADR 0553 `:290` ("A scope change is a MISS") are false by construction; H53 added `discoveryRevision`, not scope. Natural hook points exist and are unwired: `features/connections/connectionsService.ts:203 revokeConnection`, `host/accessControlService.ts:617 updateMember` |
| Prove extensions cannot expand authority | DONE (deployed-live) | `mcp-extension-opacity` 2/2 on the wire; invariant `:3242` |
| Specify durable callbacks or subscriptions wherever a host advertises them | N/A-HONEST | app advertises no `subscriptions`; ADR 0553 `:457` `subscriptions/listen` not implemented, `listChanged:false` |
| Publish a complete 2025-06-18 migration runbook and adopter inventory | OPEN | RFC `:101` "Carried: the migration runbook beyond §A's paragraph, and the adopter inventory (G1)" |
| Enforce the legacy-profile retirement date | OPEN | `MCP_LEGACY_PROFILE_SUNSET = 2027-08-12` constant (ADR 0553 `:717`); no date-aware lint |

### 6. Cross-artifact
- Depends on RFC 0150 (MRTR identity as one logical invocation), RFC 0051/0094 (interrupt/cancel), RFC 0154 (authorization), RFC 0020 (legacy), RFC 0148 (`blocked`).
- Overlap with proposed 0163 as for 0152 (UQ2/G3/R5 own peer selection + pinning).
- Freeze: workstream 5, exempt; H53 items are host-local ("No wire change" `:1042`).
- Part III row correct; "official-peer CI evidence" needs a peer choice, not a new RFC.

### 7. Defects & gates-that-cannot-fail
- **D-C1 (P1, small, owner ADR 0553):** cache scope fingerprint has no authz material + invalidator unwired (above). Fix: fold the resolved connection/credential identity+revision (and for user-scoped connectors the resolved scope set) into `scopeFingerprint`; call `invalidateMcpCacheForPrincipal` from `revokeConnection`/re-auth; correct the two false doc claims; falsifying test = grant→cached→revoke→MUST miss (goes red today).
- **G-C2 (gate cannot fail, corpus):** `mcp-cache-tenant-scope.test.ts:48-71` — the registered invariant `mcp-cache-tenant-scoped` rides a leg whose cross-caller half (a) returns silently without `softSkip` when `OPENWOP_TEST_SECONDARY_API_KEY` is unset (`:56-61` — file still records `executed-pass` with 1 assertion because the `cacheScope` presence assert already ran), (b) `if (theirs.status !== 200) return;` (`:63` — a non-authenticating second key = silent pass), (c) `if (!same) {…}` (`:65` — identical lists = zero property assertions). Under `OPENWOP_REQUIRE_BEHAVIOR=true` none of these fail. `INTEROP-MATRIX.md:294` records "(1, two credentials)" = one assertion = the property was NOT exercised on that witness. Fix: `softSkip('blocked', …)` on (a), `expect(theirs.status).toBe(200)` on (b), and on (c) assert `private` for a host that advertises per-caller derivation or require the two callers to differ. App-side `test/mcp-cache-cross-caller.test.ts:86-132` already asserts (a)/(b) locally.
- **Claims gate blind:** `generate-assurance-status.mjs:143` `current-MCP compatible` `tokens: []`.
- ADR 0553 provenance table `:119-135` missing P3 (`9b2af4839`) and H47 rows.
- Doc drift: `mcp-integration.md:300,301,308`; RFC 0153 `:10,:99`.

### 8. Verdict
Roadmap treatment **partially stale** (3 of 9 bullets done at deployed-live; the cache-invalidation bullet under-states a real defect; the peer bullet is not upstream-blocked once the Python SDK is admitted). Artifact needs: strike `:10/:99` seam clause; map scenario names → files; resolve UQ2 as "`mcp==2.0.0` (Python) pinned; TS SDK follows when it ships 2026-07-28"; add MRTR timeout/cancel/replay + scope-change legs; harden `mcp-cache-tenant-scope`. **P1** (D-C1 is a live confused-cache hazard; the suite/witness gaps are hours each).

---

## RFC 0154 — Workload Identity, Delegation, Telemetry, and Provenance Assurance

### 1. Identity
- Path: `RFCS/0154-workload-identity-delegation-telemetry-and-provenance.md`, 149 lines. `Status:` `:7` `| **Status** | \`Accepted\` |`. Last edit `f082abd1 2026-08-16 chore(0154): verify-published-provenance.sh — suite + SDK SLSA attestations verify from a clean directory (#1043)`.
- Sections: Summary, Motivation, §A–§F, Compatibility, Conformance (8 named scenarios), Alternatives (5), UQ (5; UQ4/UQ5 resolved; UQ1 proof format, UQ2 DPoP-at-Active, UQ3 in-toto/SLSA predicate OPEN), Impl notes, Acceptance (6 boxes, 0 ticked, annotated), References. Registers G1–G5 / R1–R5 (`bbeacebe`).

### 2. What it decides
- §A `auth.workloadIdentity {supported, schemes[spiffe|mtls-san|cloud-subject|oauth-client], senderConstraint[mtls|dpop]}`; identity object `{scheme, subject, issuer?, audience?, keyBinding?}` with NO raw credential material; verify→bind→resolve→fail-closed (`:28-41`).
- §B delegation chain = provenance not authorization; every hop verified; no self-asserted `onBehalfOf`; bound length; reject cycles/expiry/audience mismatch/unknown issuer/scope amplification (`:45-62`).
- §C sender constraint SHOULD (mTLS/DPoP); token exchange must not exceed upstream; bearer fallback MUST be advertised + policy-controlled and cannot inherit sender-constrained assurance (`:66`).
- §D content-free audit facts; `openwop.*` canonical; versioned optional OTel GenAI projection (v0, experimental — UQ4); W3C trace context never authorization evidence (`:70-72`).
- §E provenance attestations for spec releases, suite, SDKs, official packs; bundle v2 MAY be wrapped; verify fails closed on digest/signature mismatch (`:76`).
- §F seven invariants (`:82-88`); external audit scope named (`:90`).
- Rejected: SPIFFE-only; `onBehalfOf` as role; require experimental OTel; signatures without build provenance; do nothing (`:113-117`).

### 3. Artifact quality
- `:134` "Measured on openwop-app main `2d2f78793` (local boot): 0/4 — the host maps every chain refusal to `identity_unverified` … host follow-up. … Carried: a host that advertises `auth.workloadIdentity` and wires the seam" — **stale twice**: openwop-app advertised + wired the §20 seam at `8fbed15d4` (2026-08-16 07:55, ADR 0556 P3), and H28 `3653cd90d` (16:39) took chain-bounds 0/4 → 4/4 (`INTEROP-MATRIX.md:295`). RFC text `04f59e91` (13:37) predates H28. Register G1 "no advertiser" (`bbeacebe` 04:12) likewise stale.
- `spec/v1/auth.md:203` "No host advertises the profile as of this writing … `delegation-chain-bounded` (the narrower name; acyclicity is not yet witnessed). Named … and **not** registered: … `delegation-no-scope-amplification`, `delegation-chain-bounded-acyclic` …" — stale by `04f59e91` (`invariants.yaml:1666,1681`) and by `8fbed15d4`.
- `docs/RFC-0147-SELF-AUDIT.md:224,241` still lists `delegation-no-scope-amplification` as unregistered ("the three RFC 0154 rows") — stale by `04f59e91`; and its "twelve remained named-but-unregistered" table `:229-243` lists only 3 of the 5 RFC 0154 invariants that were unregistered on 08-13 (`workload-identity-cryptographically-bound` and `sender-constraint-no-bearer-downgrade` are absent from the table entirely).
- Acceptance/Conformance mismatch: `:100-107` names `workload-identity-proof-bound`, `delegation-chain-validation`, `delegation-tenant-audience`, `sender-constraint-downgrade`, `otel-semconv-mapping`, `artifact-provenance-verification` — the first, fourth, fifth, sixth do not exist as scenarios (`otel-semconv-mapping`: no test references `genai_mapping_version` — only `observability.md`; provenance verification is a shell script `scripts/verify-published-provenance.sh`, not a suite scenario). `:109` "require a synthetic issuer/workload harness" — none exists; §20 is a projection seam that by design cannot carry credential material (ADR 0556 `:643-655`), so `workload-identity-cryptographically-bound` and `workload-identity-proof-bound` are **structurally un-witnessable through the only seam that exists**. This is an RFC design gap, not a host gap.
- UQ1/UQ3 open means "everything signed" (bundle v2 wrapping, pack attestations) has no decided envelope; UQ2 (DPoP at Active) is moot — the RFC is Accepted with DPoP advertised optional; strike or answer.
- No Part V verification/claim record; INTEROP `:295` substitutes.

### 4. Implementation reality on current main
Corpus: §A schema `workload-identity.schema.json` + `auth.workloadIdentity` — LANDED (`8de95a14`/`b7c52f75`); §A–§D prose `31de3bbb` (#1013): `auth.md:162-203`, `observability.md` §"Identity and delegation attributes", `SECURITY/threat-model-workload-identity.md`; §B negative legs `04f59e91` (`workload-identity-chain-bounds.test.ts:86-129`); behaviour legs (`workload-identity-behavior.test.ts:86-175`: resolve, audience, expiry, closed reasons, no credential material); §E suite+SDK SLSA v1 provenance via npm OIDC + `scripts/verify-published-provenance.sh` (`f082abd1`). Invariants: 3 registered by RFC name (`delegation-tenant-audience-bound:1628`, `delegation-no-scope-amplification:1681`) + `delegation-chain-bounded:1644` ∧ `delegation-chain-acyclic:1666` = `delegation-chain-bounded-acyclic`; **unregistered (4): `workload-identity-cryptographically-bound`, `delegation-provenance-not-authorization`, `sender-constraint-no-bearer-downgrade`, `provenance-attestation-digest-bound`** (grep of `invariants.yaml` empty for all four). Absent legs: unknown-issuer, tenant neutralization, sender-downgrade, proof-bound, OTel mapping.
- Pack provenance (§E "official packs"): `openwop-registry` verifies Ed25519 per version (`registry/scripts/verify-signatures.mjs`), no SLSA/in-toto attestation, and see D-C2 below. Corpus release = git tag, no attested artifact (RFC `:136`).
- Evidence level: **local-live** (openwop-app boot with trust roots — `INTEROP-MATRIX.md:295`, `workload-identity-behavior` 6/6, `-profile` 11/11, `-chain-bounds` 4/4); **deployed-live: none** (live wire `auth.workloadIdentity` absent — env-gated OFF, confirmed 2026-08-18); §E: server-free verifier for suite+SDK only.

App (ADR 0556, 1162 lines, `Status:` `:3`; last edit `2fb186f02` #3318): P0/P1/P2/P3§A§B/H28 LANDED (provenance `:137-152`); §C sender constraint: `senderConstraint: []` (bearer-fallback advert, `discovery.ts:117-125,145`); constraint enforcement exists (`workloadIdentity.ts:774-777`) but `keyBinding` is never populated on the credential path (`verifyWorkloadCredential` `:686-695` builds identity without it) — so `OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS=dpop` would advertise DPoP while refusing every real credential (fail-closed, but an advert the host cannot honour); credentials are HS256 JWS under a host-resolved shared key (`:640-683`) — "cryptographically verified" narrowly, symmetric. P4 OPEN. Nothing in this lane changed between `fa968b428` and `9b2af4839`.

### 5. Roadmap bullet-by-bullet (`:279-295`)
| Bullet | Verdict | Evidence |
|---|---|---|
| Register and witness every remaining security invariant | OPEN (4/7 unregistered) | `invariants.yaml` grep; §3 above |
| Define proof-format negotiation | OPEN (UQ1/G1) | `:121`, register G1 |
| Complete issuer, audience, tenant, expiry, chain-bound, cycle, scope-amplification tests | PARTIAL | audience/expiry/chain-bound/cycle/amplification: suite legs exist; issuer-unknown + tenant-neutralization: host-only (`workloadIdentity.ts:665,782-786`), no suite leg |
| Standardize sender constraint through mTLS, DPoP, or profiled equivalent | DONE as spec (SHOULD) / OPEN as host | `auth.md:189-191`; app `[]` honest; no DPoP/mTLS impl (ADR 0556 `:757-760`) |
| Add SPIFFE/SVID guidance without making SPIFFE mandatory | DONE | `auth.md:173` scheme `spiffe`; RFC alt 1 rejected SPIFFE-only |
| Add provenance for packs and corpus releases, not just npm packages | OPEN | RFC `:136` carried; registry has Ed25519 only; corpus release unattested |
| Bind audit and telemetry facts to verified workload identity | DONE (spec) / local-live (host) | `auth.md` §D; app `recordAuthorizationDecision` in `middleware/workloadIdentity.ts:96-125` |
| Prove raw credentials and subject identifiers cannot enter evidence | PARTIAL | `workload-identity-behavior.test.ts:175` (seam response only); no OTel/redaction canary for identity attributes |
| Obtain external review | EXTERNAL | `:138`; `SECURITY/external-audit-findings.json` pre-completion |

### 6. Cross-artifact
- Supplies identity to 0151–0153 (`:129`); §E is the owner of signing questions the roadmap's proposed RFC 0160 would re-decide (0148 G4 defers to 0154 §E). ADR 0556 P4 (attestation carrying SLO evidence) rides ADR 0550.
- Part III rows: "Workload identity and delegation … live sender-constrained identity tests" — **over-reads the RFC**: §C is SHOULD and bearer fallback is conformant when advertised (`:66`); Phase 4 hard gate "Workload identity is sender constrained" (`:892`) is a bar above RFC 0154. Either amend 0154 to MUST for a named profile, or re-word the gate to "sender constraint advertised honestly + witnessed where advertised". "Pack provenance | RFC 0154, RFC 0160 | ADR 0550, ADR 0555" — 0154 §E owns; the registry repo is the missing app-side owner (neither ADR 0550 nor 0555 owns `openwop-registry`).
- Freeze: workstream 6, exempt; every field optional/capability-gated (`:94`).

### 7. Defects & gates-that-cannot-fail
- **D-C2 (P1, small–medium, owner openwop-registry + RFC 0154 §E + app `packs/registryInstaller.ts`): pack signatures do not cover the artifact.** 158 of 160 published pack versions use `signing.method: "manual"` where the Ed25519 signature is over `pack.json` bytes ONLY (`openwop-registry/registry/scripts/verify-signatures.mjs:149-168`; e.g. `core.openwop.agents.structured-extractor/-/1.0.0` tarball contains `prompts/structured-extractor.md`, `schemas/*.json` — unsigned; `pack.json` has no per-file digest map). The tarball digest lives only in the UNSIGNED version manifest (`1.0.0.json` `integrity: sha256-…`). The app installer mirrors this: SRI check against that unsigned manifest (`registryInstaller.ts:128-136`) then Ed25519 over `pack.json` only (`:151-162`). A registry-host/MITM compromise can swap an agent's prompt while signature verification stays green. RFC 0154 alt 4 (`:116`) rejects exactly this posture. Fix: sign the tarball bytes (method `ed25519`) or embed file digests in `pack.json`; installer verifies accordingly; RFC 0154 §E should MUST "signature covers the full artifact digest".
- **G-C3:** `sender_constraint_missing` path is only reachable via the test seam projection (no credential path sets `keyBinding`), so `sender-constraint-no-bearer-downgrade` cannot be witnessed non-vacuously on this host — and cannot go red on a downgrade because no key-bound credential exists to downgrade from.
- Self-audit/`auth.md`/register staleness (§3).

### 8. Verdict
Roadmap treatment **partially stale** (SPIFFE + sender-constraint + audit-binding exist as spec; the sender-constraint GATE over-reads the RFC). Artifact needs an in-place amendment: resolve UQ1 + UQ3 (DSSE + SLSA v1 is the obvious pick and is what 0160 would re-litigate), strike UQ2, add a MUST that pack/bundle signatures bind the full artifact digest, add issuer/tenant/downgrade legs and a credential-bearing harness (or record that `cryptographically-bound` is host-witnessed only), refresh `:134` and `auth.md:203`. **P1** for D-C2 (supply-chain integrity) and the UQ decisions; P2 for the rest.

---

## Proposed RFC 0161 — Closed Capability Namespaces and Protocol-v2 Discovery

1. **Premise check** — "v1 intentionally permits unknown root properties; closing in place would break forward-compatible v1 documents": TRUE. `capabilities.schema.json` root `additionalProperties: true`; of 90 root families 66 are closed, 24 open (11 with non-false AP + 13 with no AP key — measured with node over the schema). RFC 0149 alt 2 (`:108`) explicitly rejected closing v1.
2. **Existing owners** — closure at v2 is ALREADY decided: RFC 0073 `:10` ("the schema's `additionalProperties` tolerance retire[s] … at v2.0, when `capabilities.schema.json` tightens"), `capabilities.md:93` (same), RFC 0149 alt 2. Namespaces `x-host-*` / `vendor.<org>.*` / `private.<host>.*` + opacity + registration: `spec/v1/host-extensions.md:21-45,157-160`, RFC 0043 §A/§C, RFC 0144 §A rule (`:53`), RFC 0149 §E `discovery-canonical-family-no-shadow` (shadow rule, landed). Typo lint: RFC 0149 §B UQ2 (`:115,127`, landed 2026-08-16). "SDKs preserve unknown extensions": RFC 0155 `:117` measured that no SDK carries capability helpers at all — nothing to preserve yet.
3. **Genuinely new** — v1↔v2 negotiation/migration (no RFC decides how a v2 host serves v1 clients or how `protocolVersion` major bumps are discovered); "misspelled canonical families invalid" is a corollary of closure. That is all.
4. **Wire/freeze/compat** — breaking, v2 target; RFC 0147 §A.1 freezes v1 optional growth, and R14 ("pause optional RFC growth") makes a v2 major RFC premature; nothing on the v1 A+ path depends on it.
5. **Recommendation** — **DON'T (now)**; when v2 opens, AUTHOR a v2 RFC titled "Protocol v2 discovery closure and negotiation" that CITES 0073/0043/0144/0149 rather than re-deciding them. Acceptance tests that can go red: (a) `capabilities.schema.json` v2 root `additionalProperties:false` and a fixture with a typo'd family FAILS validation; (b) a fixture with `x-host-acme.*` PASSES; (c) a v1 client against a v2 host receives a documented negotiation outcome (a leg that fails if the host silently serves v2 shape to a v1 client). Keep it out of Phase 5's v1 gate.

## Proposed RFC 0163 — Official-Peer Interoperability Evidence

1. **Premise check** — the roadmap gives no "why new" paragraph; the implied premise (nothing defines/prohibits fakes as independent evidence) is FALSE: RFC 0147 `:131` "Both child RFCs MUST use real upstream peers in addition to fake servers, publish the tested upstream version"; RFC 0152 `:74`; RFC 0153 `:75`; `GOVERNANCE.md:60-75` evidence tiers already forbid calling steward-built artefacts "independent". Cadence: RFC 0156 §G `:72` "quarterly standards-version review".
2. **Existing owners** — peer selection/pinning: 0152 UQ2/G3/R5, 0153 UQ2/G3/R5 (open, but owned); operation matrices: 0152 §D D.1–D.7 + 0153 §B–§D (the matrices ARE the translation tables); adversarial identity/tenant tests: 0152 §E / 0153 §E + registered invariants; how results enter bundles: RFC 0148 (bundle v2 owner) — currently NO peer field; review cadence: 0156 §G.
3. **Genuinely new** — (a) a bundle-v2 field recording upstream peer identity + pinned version + result (schema `certification-bundle-v2.schema.json` has none); (b) an explicit "evidence level ≠ assurance tier" statement (official-peer is a LEVEL; Tier-3 is an ORG tier — the roadmap's Phase 3 must not satisfy Phase 6); (c) an upgrade/freshness policy for the pin (RFC 0147 R10 "refresh SLA unwritten"). None of these need a new number.
4. **Wire/freeze/compat** — process + a corpus bundle field (not host wire); freeze-neutral.
5. **Recommendation** — **AMEND-0152/0153 (resolve UQ2 in each: `@a2a-js/sdk@1.0.x`; `mcp==2.0.0` Python) + AMEND-0148 (one bundle-v2 `peers[]` entry: `{protocol, package, version, role: client|server, result}`) + AMEND-0156 §F (derive `current-A2A/MCP compatible` permitted-ness from that entry and give the rows real tokens)**. Falsifiable tests: (a) a bundle claiming `a2a-1.0`/`mcp-2026-07-28` with an empty `peers[]` is not `certified` for a "current-*" claim (red today: no such rule); (b) `generate-assurance-status --check` fails on a README containing "current A2A" while `permitted:false` (red today: `tokens: []`); (c) the suite's official-peer job pins the version and FAILS (not skips) when the peer is unreachable (H25 lesson — a soft-skip here would be another silent opt-out). Only if maintainers insist on separability does a ~2-page process RFC make sense — P2 for the process text, P1 for the actual A2A run.

---

## Cross-slice notes for the orchestrator
- Nothing in RFC 0152/0154 or ADR 0552/0556 changed between `fa968b428` and `9b2af4839`; the only Slice-C delta is #3325 (ADR 0553 P3) — merged, **not deployed** (live `fb6cbbcba`).
- Live wire (2026-08-18): `a2a {streaming:false, pushNotifications:true, durableTasks:true, protocolVersions:[1.0,0.3], profiles:[a2a-1.0, a2a-0.3-legacy]}`; `mcp {serverUrls:[/v1/host/openwop-app/mcp], protocolVersions:[2026-07-28,2025-06-18], features:[server-discover,mrtr,cacheable-lists], serverMount:{samplingBridge:true, elicitationBridge:true}}`; `auth.workloadIdentity` absent; `contractProvenance.suiteVersion 1.135.2`; `compensation.supported:true`. Note `agentCardUrl` points at the `*.run.app` origin, not `app.openwop.dev` (`OPENWOP_A2A_PUBLIC_BASE_URL` unset; by design per `test/a2a-agentcardurl-origin.test.ts`).
- Ownership: pack-provenance defect D-C2 has NO app ADR owner (registry repo) — Part III's "ADR 0550, ADR 0555" row should name `openwop-registry` explicitly.

## Corrections to prior audit (PRIOR-AUDIT.txt)
1. **RFC 0153 official peer "probably upstream-gated … unverifiable"** (`:59`, `:291`) — WRONG for the Python SDK: `mcp==2.0.0` / `mcp-types==2.0.0` (PyPI, 2026-07-28) implement revision 2026-07-28 incl. `server/discover`, `Mcp-Method`, `requestState` (verified in the unpacked wheel). Right for the TS SDK (`1.30.0` tops out at 2025-11-25 — verified in `dist/esm/types.js:2-4`). The gate is a corpus selection, not an external wait.
2. **"H53 STILL unmerged / stranded, no PR"** (`:93`, `:407`) — STALE: merged as #3325 = `9b2af4839` (7 test files, `mcpAudit.ts`, `conformance/run.ts` secondary key). Its "cross-caller leg tests caller separation, not same-caller scope CHANGE" and the fingerprint/invalidator findings remain TRUE on `9b2af4839` (`mcpClient.ts:899`, `mcpClientCache.ts:155`, zero callers).
3. **"@a2a-js/sdk@1.0.1 exists NOW"** — CONFIRMED (npm `time`: `1.0.1` 2026-07-28T10:41Z; `1.0.0` 2026-07-22), and stronger than stated: the package ships BOTH an Express/gRPC server and a client plus `compat/v0_3`, so both directions can be driven from one pin.
4. **`mcp-cache-tenant-scope` "1/1, two credentials"** — the prior audit did not notice this witness is vacuous on the property (one assertion = the shape check; three silent-pass paths in the leg). New finding G-C2.
5. **Pack provenance "Ed25519 pack sigs, no build attestation"** — TRUE but under-states: for 158/160 versions the signature binds `pack.json` only, not the tarball (new finding D-C2).
6. **RFC 0154 "3/7 invariants"** — CONFIRMED (3 by RFC name + the bounded∧acyclic pair); the SELF-AUDIT and `auth.md:203` are staler than the prior audit said (they miss `04f59e91` and list only 3 of the 5 rows unregistered on 08-13).
7. **ADR 0552 "restart-safe push over-reads RFC 0100 §4"** — CONFIRMED (`RFCS/0100:99-105`: fire-on-transition + SSRF; no delivery durability), with the caveat that a crash between transition and the best-effort POST means the host never "fired" — RFC 0100 does not say whether that is a violation; an amendment should decide it before ADR 0552 P3 builds anything.
8. **Prior audit's RFC 0152 "Task legs … absent against host-as-server: artifacts, Cancel, cross-tenant"** — CONFIRMED by reading the leg bodies (`a2a-1-0-task-roundtrip.test.ts:75-107`).
9. **Prior audit's "no date-aware sunset lint"** — CONFIRMED for both (constants only: ADR 0552 `:88`, ADR 0553 `:717`).
