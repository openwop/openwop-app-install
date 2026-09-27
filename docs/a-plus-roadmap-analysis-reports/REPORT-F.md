# REPORT-F — interop / isolation / security ADRs (pass 2, 2026-08-18)

Slice F: ADR 0552 (A2A 1.0), ADR 0553 (MCP 2026-07-28), ADR 0555 (untrusted-pack isolation),
proposed ADR 0581 (deps + document ingestion), proposed ADR 0585 (external audit program).

Verified against: app `main` = `9b2af4839` (includes #3325 = ADR 0553 P3 "H53"), spec `main` =
`54f29548`, roadmap `c60ee3645`. Live wire read 2026-08-18 via `https://app.openwop.dev/api/.well-known/openwop`
and `/api/readiness` — **live commit is `fb6cbbcba` (deploy #4)**, i.e. H53 (#3325) is merged but NOT
deployed. Everything below that says "deployed-live" is therefore pre-H53.

Read-only: no repo writes, no suites/builds run. `npm audit --omit=dev --json` and `npm view` were the
only network/registry reads (both read-only). Raw audit JSON saved beside this report
(`audit-backend.json`, `audit-frontend.json`, `wk.json`).

Roadmap sections consulted: `OPENWOP-A-PLUS-ROADMAP.md:562-573` (0552), `:575-585` (0553), `:607-619`
(0555), `:679-703` (0581), `:766-783` (0585), Part III `:785-810`, Part IV `:830-928`, Part V `:930-969`,
Part VI `:971-1012`.

---

## ADR 0552 — A2A 1.0 adapter and versioned interoperability

### 1. Identity
- Path: `docs/adr/0552-a2a-1-adapter-and-versioned-interop.md`, 599 lines.
- `Status:` (verbatim, `:3-12`): "Accepted — P0 implemented 2026-08-12 (`483862a95`); P1 §B (downgrade
  refusal) implemented 2026-08-13; P1 §A (exact-version discovery) implemented 2026-08-15 (`6e7b9ed55`,
  #3253, at the 1.106.0 conformance bump); **P2 (the A2A 1.0 codec, card projection, auth and task
  binding) implemented 2026-08-16** (`24b9e6c9b`, #3280) — … **P2 CORRECTION + H19/H24/H25/H26
  2026-08-16** (`5a902f30c`, #3286 …). P3–P4 open, and their reason CHANGED: not a corpus gap any more
  but host evidence for the streaming/push half plus a dated legacy retirement."
- Last substantive edit: `a847daa50 2026-08-17 docs(adr): implementation records 0548–0556 reconciled
  to the merged tree (H44) (#3314)`; last code phase `5a902f30c` (#3286, 2026-08-16).
- Sections: Context / Decision (6 numbered) / Boundaries audit / Feature matrix / Phases P0–P4 (`:82-92`)
  / RFC-gate note / Implementation record with H44 provenance table (`:114-131`), P0, P1, P2 (spec→host
  map, eight decisions, two host decisions + correction, codec boundary, sibling-suite witness, sabotage
  table, honesty flip, "What P2 does NOT do" `:547-561`), "P3–P4 — blocked, and not partially attempted"
  `:563-590` (twice-corrected, historical), Alternatives `:592-599`.

### 2. What it decides
- ONE A2A route + ONE durable task/run projection; version adapter (`a2aService` version-neutral,
  `a2aServer10`/`a2aCodec10` for 1.0, existing 0.3 codec kept as `a2a-0.3-legacy`) — `:38-54`.
- Negotiate only by the upstream mechanism (`A2A-Version` header, RFC 0152 §B); unsupported ⇒ typed
  refusal, never silent downgrade (`:47-48`, `a2a-version-refusal.test.ts`).
- Every task bound to tenant + remote principal + version + run + trace; resume/push re-authorize
  against the binding (`:49-51`; `a2a-tenant-binding.test.ts`).
- Discovery names exact versions; `supported:true` without a version forbidden (`:52-53`; advert
  DERIVED from `A2A_SUPPORTED_VERSIONS`, `host/a2aProfile.ts`).
- Header-less card GET = 0.3 shape while legacy advertised (P2 CORRECTION, `:15-20`; `a2aCard.ts:121`
  `LEGACY_A2A_PROTOCOL_VERSION`) — matches the live card I read: `protocolVersion:"0.3"`, 103 skills.
- Wire impact: `capabilities.a2a.profiles/protocolVersions/preferredVersion` (RFC 0152 §A) — live wire
  today: `protocolVersions ["1.0","0.3"]`, `preferredVersion "1.0"`, `profiles [a2a-1.0, a2a-0.3-legacy]`,
  `streaming:false`, `pushNotifications:true`, `durableTasks:true`.
- Rejected: replace 0.3 in place; mount `/a2a-v1`; translate inside the executor (`:592-599`).
- Legacy sunset date fixed: `A2A_LEGACY_PROFILE_SUNSET = 2027-03-12` (`:91`).

### 3. Artifact quality
- Internally consistent; the twice-corrected P3–P4 paragraph (`:563-590`) is explicitly historical.
- Phase-table P3 row (`:90`) is honest: "what P3 still owes is the streaming/push half".
- Provenance table (`:114-131`) current as of H44; nothing landed for 0552 after H44 (verified `git log`).
- Missing vs Part V template: no "Claim record" section as such — the claim facts are scattered
  (honesty flip `:536-545`, "What P2 does NOT do" `:547-561`); no "Verification record → evidence level"
  line; no explicit "public statements prohibited" list. Not a defect, a template gap.
- One over-read in the roadmap, not the ADR: see §5 bullet 2.

### 4. Implementation reality on `9b2af4839`
| Phase | State | Witness | Evidence level |
|---|---|---|---|
| P0 version-neutral service | LANDED `483862a95` | `a2a-profile.test.ts` | test-seam |
| P1 §B downgrade refusal | LANDED `96b3f6be1` #3196 | `a2a-version-refusal.test.ts` | test-seam; §A advert deployed-live (wire read above) |
| P1 §A exact-version discovery | LANDED `6e7b9ed55` #3253 | advert derived from `A2A_SUPPORTED_VERSIONS` | deployed-live |
| P2 codec/card/auth/task binding | LANDED `24b9e6c9b` #3280 + `5a902f30c` #3286 | `a2a-1-0-server`, `a2a-codec-1-0`, `a2a-durable-route`, `a2a-invoke-seam`, `a2a-tenant-binding` (8 files/74 tests at H44 `:129`) | local-live (sibling suite) + **deployed-live for the credential-free legs** (`../openwop/INTEROP-MATRIX.md:289` — `a2a-card-runtime-consistency 5/5`, `a2a-1-0-agent-card 10/10` against `app.openwop.dev` at `1b2dd6fbb`) |
| P3 dual-version durability + push | OPEN (`host-evidence`) | task store durable: `a2aTaskStore.ts:213` `DurableCollection`; `a2a-durable-tasks.test.ts:98,140,163`; push = ONE best-effort POST, failure swallowed `a2aTaskStore.ts:401-406`; streaming methods return `{task}` JSON, not a stream `a2aServer10.ts:216-232` | test-seam (same-process "disconnect", no real restart) |
| P4 retire legacy | OPEN — date-bound 2027-03-12 + RFC 0152 G1 (corpus) | — | — |
- Nothing changed for 0552 between `fa968b428` and `9b2af4839` (#3325 touched no A2A file).
- Cross-tenant probes landed with P2 (`a2a-tenant-binding.test.ts:67-118`).
- Peer-authority: MEASURED with a vacuity guard (`a2aPeerAuthorityProbe.ts:1-31`), local-boot leg
  `a2a-peer-authority 1/1` (INTEROP-MATRIX:293); host-as-client legs are local-only (no peer reachable
  from Cloud Run).
- Official peer: no `@a2a-js/sdk` in `backend/typescript/package.json` (grep empty); RFC 0152 G3
  "Carried, externally gated" (`RFCS/registers/0152-…gaps.md:10`).

### 5. Roadmap bullet-by-bullet (`:566-573`)
1. "Add official A2A SDK or peer tests to CI" — **EXTERNAL/OPEN** (corpus G3; no SDK dep). Not app-closable
   alone; app side would be a pinned `@a2a-js/sdk` client leg once the corpus selects one.
2. "Implement restart-safe streaming and push if those features are advertised" — **FALSE-PREMISE /
   UNMEETABLE-AS-PHRASED**. Streaming is NOT advertised (`streaming:false` live; `OPENWOP_A2A_STREAMING`
   unset in Cloud Run env, read via `gcloud run services describe`). Push IS advertised, and RFC 0100 §4
   (`RFCS/0100-async-durable-a2a-tasks.md:101-107`) requires SSRF-guarded fire-on-transition and NO
   delivery durability; the host does exactly that (`a2aTaskStore.ts:401-406`, `a2a-durable-tasks.test.ts:163,184`).
   "Restart-safe push" is a bar above the RFC → needs an RFC 0100/0152 amendment first, then the ADR 0551
   outbox (never a second delivery queue). Trap confirmed: `OPENWOP_A2A_STREAMING=true` flips the advert
   while `SubscribeToTask` returns one JSON `{task}` (`a2aServer10.ts:221-232`) — setting it is a false claim.
3. "Persist task and subscription correlation" — **DONE** for tasks + push-config (`a2aTaskStore.ts:213,
   409-419`); subscriptions N/A (no stream state exists). Evidence: test-seam; a real process-restart
   witness does not exist (the durability test re-reads in the same process).
4. "Verify peer authority cannot expand across the adapter" — **DONE** (`a2aPeerAuthorityProbe.ts`, invariant
   `a2a-peer-no-authority-escalation` registered `INTEROP-MATRIX.md:297`).
5. "Test Agent Card/runtime parity against deployed discovery" — **PARTIAL**: witnessed ONCE on the deployed
   origin by the steward (`INTEROP-MATRIX.md:289`, 2026-08-16); the certify lane boots LOCALLY
   (`scripts/deploy.sh:219-220` `npm run test:conformance -- --certify`) and `scripts/verify-deploy.sh` has
   no card probe (grep `agent-card` empty). Not continuous. Small item: one curl+jq leg in verify-deploy.sh.
6. "Gather legacy-profile usage evidence and execute retirement" — **OPEN/EXTERNAL + a host gap**: the only
   version telemetry is `openwop.protocol.version{protocol,disposition}` (`observability/metrics.ts:257-262`)
   — the SERVED profile is not a label, so 0.3 vs 1.0 usage cannot be measured from this host's metrics at
   all. (The comment's "requested version is unbounded" is right; the served profile is a closed 2-set from
   `A2A_PROFILES` and is safe to label.) Corpus G1 inventory carried.

### 6. Cross-artifact
- Depends on RFC 0152 (Accepted, §C/§D/§E prose landed `d77d259b`), RFC 0100 (push/durable tasks), RFC
  0093 (SSRF), ADR 0551 (any durable-push outbox), ADR 0550 (claims).
- RFC 0147 §A.1: no new wire; the profile vocabulary is 0152's. A durable-push guarantee WOULD be new
  optional wire semantics → RFC first.
- Part III row "Current A2A interoperability | RFC 0152, RFC 0163 | ADR 0552 | official-peer CI evidence"
  — correct owner; the evidence cell is externally gated (G3).
- Overlap: streaming/push durability rides 0551's outbox — roadmap does not say so; rule-6 risk if 0552 P3
  builds its own retry queue.

### 7. Defects & gates-that-cannot-fail
- `observability/metrics.ts:257-262` — no served-profile label ⇒ P4's "usage evidence" cannot be produced
  from telemetry (size: small; owner 0552).
- `scripts/verify-deploy.sh` — no deployed card/advert parity probe; the certify witness is a local boot
  (`scripts/deploy.sh:219-220`). Small.
- `../openwop/INTEROP-MATRIX.md:293` "Not yet: `durableTasks` / `pushNotifications` not advertised" is
  STALE — both are `true` on the live wire today (and were on `fb6cbbcba`). Corpus doc drift.
- Restart-safety of the task store is witnessed same-process only (`a2a-durable-tasks.test.ts:98`);
  a green there cannot go red on a lost `DurableCollection` backing (it uses the same in-memory/sqlite
  handle). Owner: 0551's two-process harness.

### 8. Verdict
Roadmap treatment is **partially stale and one bullet over-reads the RFC** (2/6 done, 1 partial, 1
false-premise, 2 external). The ADR itself is accurate and honest; it needs (a) a Part V "Claim record"
block, (b) a served-profile metric label + a verify-deploy card probe (small host items), (c) nothing else
until an RFC 0100 amendment exists for durable push. **P2** — the advert is honest today, nothing
advertised is un-honoured.

---

## ADR 0553 — MCP 2026-07-28 secure, versioned adapter

### 1. Identity
- Path: `docs/adr/0553-mcp-2026-secure-versioned-adapter.md`, 1110 lines (+353 in #3325).
- `Status:` (`:3`, verbatim head): "Accepted — P0 implemented 2026-08-12 (`0f126b7e0`); P1 version seam
  implemented 2026-08-13; P1 §A … 2026-08-15 (`6e7b9ed55`, #3253); **P2 implemented 2026-08-16** (…
  `df03c3476` #3279); **H43 implemented 2026-08-17** (`5bd850706`, #3303 …); **H21 implemented 2026-08-17**
  (`fb6cbbcba`, #3311 …); **H47 implemented 2026-08-17** (pin `^1.136.0` …); **P3 implemented 2026-08-17**
  (H53 — the downgrade floor both directions, the cache's fourth key component, manifest-declared token
  audience, run cancellation of an in-flight call, the stateless-reconnect proof and the closed-key audit
  record; 22 sabotages … see § "P3"); P4 open. Merge provenance reconciled 2026-08-17 (H44). …"
- Last substantive edit: `9b2af4839 2026-08-17 feat(mcp): ADR 0553 P3 — … (#3325)` (the P3 record, 353
  lines, `:705-1051`).
- Sections: Context / Decision (auth-first, versioned codecs) / Boundaries / Matrix / Phases (`:87-115`,
  P3 row now "SHIPPED 2026-08-17 (H53)") / Implementation record: H44 provenance table `:119-135`, H43,
  P0, P1, P2 (spec→host map `:278-293`, seven decisions, corrections, sibling witness, sabotage table,
  "What P2 does NOT do" `:451-478`, H26, re-drive), H21 `:541-704`, **P3 `:705-1051`** (Gaps 1–9, 26-row
  sabotage table `:889-931`, code-review findings `:932-960`, wire `:1022`, corpus-coverage absence
  `:1029-1051`), H47 `:1053-1110`.

### 2. What it decides
- Auth first: no anonymous wildcard; typed 401 before JSON-RPC dispatch; scope + tenant membership;
  per-principal rate limit; audit method/target/principal/outcome — never args/content/tokens (`:31-42`).
- Two codecs over one version-neutral semantic service; `legacy-2025-06-18` + `mcp-2026-07-28`; fail-closed
  version selection; no silent downgrade (`:44-53`).
- Outbound: manifest declares exact profile + audience; client validates peer self-description; **cache
  entries keyed by server, version, authenticated principal scope and advertised revision** (`:53-56`).
- Legacy `sampling`/`elicitation` bridges legacy-only; current profile uses MRTR (`:57-59`).
- P3 (H53) decisions: header-less inbound derives from the served set (Gap 1); `mcpServer.profile` is a
  FLOOR, pin outranks a remembered negotiation, `serverStatus` second door closed, unknown profile = hard
  failure (Gap 2); `discoveryRevision` = digest of `server/discover` in the KEY, discovery itself never
  cached (Gap 3 + CORRECTION); `mcpServer.audience` verified at `wireCall`, unreadable ⇒ refuse (Gap 4);
  `armRunAbort` on `notifyRunTerminal`, `mcp_cancelled` typed, courtesy `notifications/cancelled` (Gap 5);
  reconnect = stateless proof (Gap 6); `mcpAudit.ts` closed key set (Gap 7); `finalizeRun` terminal guard
  (Gap 8, explicitly NOT a CAS); tenant-scoped second conformance key (Gap 9).
- Wire: no change in P3 (`:1022-1027`). Live: `profiles [mcp-2026-07-28, mcp-2025-06-18-legacy]`,
  `features [server-discover, mrtr, cacheable-lists]`, no `subscriptions`, `serverMount` on.
- Legacy sunset `MCP_LEGACY_PROFILE_SUNSET = 2027-08-12`.

### 3. Artifact quality
- **Contradiction (claim vs code) — the ADR's §D row `:290`: "Key = tenant/workspace/principal/origin/
  revision/scope-fingerprint. A scope change is a MISS, not a stale hit."** and decision 4 `:321-322`
  "a scope change is stale regardless of `ttlMs`". Code: `host/mcpClient.ts:899`
  `scopeFingerprint: sha256([deps.tenantId, deps.orgId ?? '', deps.actingUserId ?? '', serverId])` —
  NO authorization material (no scopes, roles, connection/credential identity). A grant/revoke changes
  none of those four inputs, so the key is unchanged and a warm `private` entry is served. The docblock
  `host/mcpClientCache.ts:23-27` ("a revoked scope cannot hit a warm entry at all") and `:150-153`
  ("Called on an authorization-scope change") are false as built.
- **Stale after H53:** `host/mcpClient.ts:160-165` still says the run signal "is currently dormant — wiring
  it is the tracked remaining gap" — H53 wired it (`executor/runLifecycle.ts:96`, `executor.ts:876,1632`).
- **Provenance table `:124-133` was NOT extended** for P3/H53 (`9b2af4839` #3325) or H47 — the status
  line and phase table were, the table was not (a Part V "phase-to-commit mapping" gap).
- P3 residue is not summarised as a list the way P2's is (`:451-478`); the honest absences are inside
  `:1029-1051` (corpus coverage) and Gap 8's "NOT claimed as atomic". The G4 scope-change gap is not
  named anywhere in the ADR — it is presented as closed (`:290`).
- Cancellation (Gap 5) is process-local: `armRunAbort`/`aborters` is a module `Map`
  (`runLifecycle.ts:76`); a cancel served by another Cloud Run instance never aborts the draining
  instance's in-flight call. Not recorded as a limit (the ADR records `negotiated` as process-global,
  `:742-746`, but not this). Owner overlaps 0551.
- Correction notes: present and good (two in Gap 3, one in Gap 5, S18/S19 re-aim `:918-923`, the
  `git checkout --` process failure `:947-955`).

### 4. Implementation reality on `9b2af4839`
| Phase | State | Witness | Evidence level |
|---|---|---|---|
| P0 | LANDED `0f126b7e0` | `mcp-profile.test.ts` | test-seam |
| P1 seam + §A | LANDED `96b3f6be1`, `6e7b9ed55` | `mcp-profile.test.ts`; advert derived | deployed-live (advert) |
| P2 codec both directions | LANDED `df03c3476` #3279 | `mcp-current-codec`, `mcp-client-current`, `mcp-request-state`, … (10 files/116 tests at H44 `:134`) | **deployed-live for §B/§D** (`INTEROP-MATRIX.md:294`: authenticated strict pass at `756a9938d`/`00646-2zb`, `mcp-2026-07-28-discover 10/10`, `mcp-stateless-request 2/2`, `mcp-cache-tenant-scope 1/1`; auth boundary 1/1 on deploy #3) |
| H43 anonymous refusal | LANDED `5bd850706` #3303 | `mcp-mount-anonymous-principal.test.ts` | deployed-live (401 verified on prod, register `:306-308`) |
| H21 operator outbound server | LANDED `fb6cbbcba` #3311 | `mcp-operator-server.test.ts` (15) | local-live; `OPENWOP_MCP_SERVER_URL` NOT set in prod env |
| H47 pin ^1.136.0 | LANDED | `conformance-mcp-invoke-node`, `conformance-a2a-invoke-node` | test-seam |
| **P3 (H53)** | **LANDED `9b2af4839` #3325 (2026-08-17 19:23 -0400)** — files: `mcpClient.ts` (+480), `mcpClientCache.ts` (+23), `mcpProfile.ts`, `mcpAudit.ts` (new), `routes/mcp.ts`, `providerRegistry.ts`, `executor.ts`, `runLifecycle.ts`, `conformance/run.ts` | `mcp-downgrade-floor` (15), `mcp-token-audience` (14), `mcp-cancel-reconnect` (11), `mcp-cache-confusion` (8), `mcp-audit-record` (8), `run-abort-signal` (9), `mcp-cache-cross-caller` (3) — all present in the merge stat | test-seam / local-live; **NOT deployed** (live = `fb6cbbcba`) |
| P4 claims | ongoing — advert honest for the three `features[]`; deployed-wire witnesses exist for §B/§D | — | deployed-live |
- **Changed between `fa968b428` and `9b2af4839`:** everything in the P3 row above. The prior audit's
  "H53 stranded / no PR" is now stale — merged as #3325.
- **NOT changed by H53:** `scopeFingerprint` inputs (still tenant/org/user/serverId, `mcpClient.ts:899`);
  `invalidateMcpCacheForPrincipal` still has **zero production callers** — the only reference outside its
  definition is `test/mcp-client-current.test.ts:35,383` (grep of `src`+`test`). H53 added
  `discoveryRevision` (peer-side change) — orthogonal to G4's caller-side scope change.
- Candidate scope-mutation seams that do NOT call the invalidator: `host/accessControlService.ts:617
  updateMember`, `:657 deleteMember` (grep `invalidateMcpCacheForPrincipal` in `src` = 1 hit, its own
  definition). Material available for the fingerprint: `scopesForRoles()` `accessControlService.ts:278`;
  the resolved connection identity `cred.provenance` (`mcpClient.ts:600-613`) — a Connection swap/rotation
  for the same user is ALSO not in the key today.

### 5. Roadmap bullet-by-bullet (`:579-585`)
1. "Add official MCP SDK or reference-peer tests to CI" — **EXTERNAL/OPEN** (RFC 0153 G3 "Carried,
   externally gated" `registers/0153-…gaps.md:10`; no `@modelcontextprotocol/sdk` in package.json).
2. "Persist MRTR requests that must survive instance restart" — **FALSE-PREMISE (mostly done)**:
   `requestState` is HMAC-bound and stateless-verifiable, the interrupt is durable run state (`:453-457`;
   `host/mcpRequestState.ts`; `mcp-current-codec.test.ts:324` single-use replay refusal); only the
   per-invocation round COUNT is not persisted, by design.
3. "Add durable subscriptions where advertised" — **N/A, honest**: not advertised (`features[]` has no
   `subscriptions`; `listChanged:false`; `:458-460`).
4. "Harden cache invalidation after authorization changes" — **OPEN + DEFECT** (see §3/§7). The roadmap
   under-states it: the ADR CLAIMS it done. Prior audit confirmed; H53 did not fix it.
5. "Complete extension routing and authority tests" — **DONE**: `mcp-extension-opacity 2/2` deployed-wire,
   `mcp-peer-no-authority-escalation` + `mcp-extension-no-authority` registered (`INTEROP-MATRIX.md:297`);
   `extensions` feature deliberately NOT claimed (`:298-300`).
6. "Prove replay and fork cannot reissue callbacks" — **PARTIAL/structural**: every outbound call rides
   `webhookEgressDispatcher()` (`mcpClient.ts:716,763`) whose `assertEffectAllowed('network-egress')`
   (`webhookEgressGuard.ts:178`) refuses under replay; `mcp-cancel-reconnect.test.ts` proves one delivery on
   re-issue; there is NO MCP-specific "replayed run does not re-POST `tools/call`" test (grep `replay` in
   `test/mcp-*` = requestState single-use + a comment). Small (≈20 lines).
7. "Remove the legacy profile after the protocol deadline" — **EXTERNAL/time** (2027-08-12).

### 6. Cross-artifact
- RFC 0153 (§B/§C/§D/§E in `spec/v1/mcp-integration.md`), RFC 0154 (inbound audience via
  `middleware/workloadIdentity.ts`, `:815-822`), RFC 0148 ledger (Gap 9), ADR 0554 P2 (Gap 8 `finalizeRun`
  seam, cross-referenced in `0554…md` +31), ADR 0551 (process-local abort; storage CAS for the terminal
  write), ADR 0550 (claims).
- RFC 0147 §A.1: no new wire in P3 (`:1022`). G4's fix is host-local (key material) — no wire.
- Part III row "Current MCP interoperability | RFC 0153, RFC 0163 | ADR 0553 | official-peer CI evidence" —
  correct; externally gated (G3).
- Corpus follow-up candidate named by the ADR (`:1029-1051`): the suite has zero coverage of cancellation,
  reconnect, token audience.

### 7. Defects & gates-that-cannot-fail
- **P1 (security, small):** `host/mcpClient.ts:899` fingerprint carries no authz material;
  `host/mcpClientCache.ts:155` `invalidateMcpCacheForPrincipal` unwired; ADR `:290`, docblocks
  `mcpClientCache.ts:23-27,150-153` false. The test `mcp-client-current.test.ts:378-386` calls the
  invalidator DIRECTLY, so it is green while nothing in production ever calls it — a wiring gate that
  cannot fail. Fix: fold `sha256(scopesForRoles(principal.roles) + connectionId/rotation)` into the
  fingerprint AND/OR call the invalidator from `updateMember`/`deleteMember`; falsifying test = grant →
  cached private list → revoke via the REAL seam → next `listTools` MUST hit the wire (fails today).
  RFC 0153 G4 is "Closed" in the corpus on prose (`registers/0153-…gaps.md:11`) — this host does not honour
  it while advertising `cacheable-lists`.
- Stale docblock `mcpClient.ts:160-165` (post-H53). Trivial.
- Provenance table `:124-133` missing P3 + H47 rows. Trivial.
- Process-local cancellation (`runLifecycle.ts:76`): the W6 witness ("cancelled mid-flight ⇒
  `mcp_cancelled`") holds single-instance only; unrecorded. Medium; owner 0551 (row re-read / cross-instance
  signal), record in 0553.
- `finalizeRun` guard is not a CAS (recorded `:985-994`) — honest, but the residue is a `Storage.updateRun`
  status-conditional write, owner 0551.

### 8. Verdict
Roadmap treatment **partially stale** (2/7 done, 1 N/A, 1 mostly-done, 1 partial-structural, 2 external)
and **wrong in the one place that matters**: it lists cache-invalidation hardening as ordinary open work,
while the ADR records it as done and the code does not do it — a security claim in an accepted ADR that
is false by construction. H53 (P3) is merged (#3325) but NOT deployed. The ADR needs a CORRECTION note at
`:290` + the fingerprint/invalidator fix + a Part V claim/verification block + provenance rows. **P1** —
because `mcp-2026-07-28`/`cacheable-lists` is advertised on the live wire and RFC 0153 §D/G4 is a MUST.

---

## ADR 0555 — Untrusted-pack trust tier and isolated execution

### 1. Identity
- Path: `docs/adr/0555-untrusted-pack-trust-tier-and-isolated-execution.md`, 893 lines.
- `Status:` (`:3`, verbatim): "Accepted — P0 implemented 2026-08-12 (`be62a115e`, #3179; preceded by
  CORRECTION 1, `b920beddf`, #3172); P1 implemented 2026-08-16 (`f16489a16`, #3288); P2 (first production
  isolation adapter) implemented 2026-08-17 — see the P2 implementation record, which records network
  egress as the one gate item this platform cannot meet; P3 (broker hardening) open; P4 (the
  `sandbox.supported` claim) blocked on RFC 0035 ADOPTION, not on host work. Merge provenance reconciled
  2026-08-17 (H44)"
- Last substantive edit: `1f422e383 2026-08-17 14:05 feat(packs): the first production isolation adapter …
  (ADR 0555 P2) (#3317)` (AFTER H44 `a847daa50` 12:22 and BEFORE the roadmap baseline `10f8ba3c`).
- Sections: Context / Decision (trust tiers + CORRECTION 3, isolated worker contract `:199-212`) /
  Boundaries / Matrix / Phases `:240-248` / P1 grounding survey / Alternatives / Implementation record:
  H44 provenance `:309-345`, P0 `:347-392`, P1 `:394-582`, **P2 `:584-893`** (enforced-vs-attested table
  `:604-652`, defaults, cancellation, worker entry, 17-row sabotage `:727-746`, 6 corrections `:748-800`,
  operator notes `:802-821`, addendum: deployability + memory budget `:823-893`).

### 2. What it decides
- Trust tier is an EXECUTION decision; fail-closed: unsigned/unpinned executable packs cannot dispatch
  unless the operator sets the break-glass `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED` (`packTrust.ts:53-58,197`).
- Version-neutral isolated-worker contract; closed request envelope; effects only via the host-call broker
  under the capability firewall; per-dispatch capability binding (not a signed envelope — P1 correction
  `:244`); clean isolate per invocation; cancellation kills the isolate (`:199-212`).
- P2: forked Node process per dispatch under `--permission` (`isolation/childProcessAdapter.ts`);
  guarantee record is a TOTAL `Record<Guarantee,'enforced'|'not-enforced'>` (`isolationGuarantees.ts`);
  a tier whose requirement the adapter cannot meet is REFUSED, never downgraded; `network-denied:
  'not-enforced'` recorded and pinned POSITIVELY by `pack-isolation-escape.test.ts:234`; isolation default
  `untrusted` (`packIsolationPolicy.ts:116`), adapter default `child`; no warm pool; 2×96 MB budget for
  512 Mi.
- Wire: NOTHING advertised (`sandbox.supported` absent; `agrade-wire-blocked-residue.test.ts:277-288`);
  the `OPENWOP_TEST_SANDBOX_MVP` conformance seam (`routes/discovery.ts:1437-1446`) is not set in prod.

### 3. Artifact quality
- **Internal contradiction:** status line `:3` "P4 … blocked on RFC 0035 ADOPTION, not on host work" vs
  P2 record `:631` "Network is the one gate item P2 does not meet, and it is not closable here" and `:820`
  "the network gap above is exactly the kind of thing that claim would have to be honest about", and the
  P4 gate itself `:248` "Wait for RFC 0035 Accepted AND non-vacuous live isolation evidence". RFC 0035 is
  `Active` (Parked) with a tripwire about a NON-steward host (`../openwop/RFCS/0035-…md:7,10`); it does not
  forbid a steward host advertising. Under CLAUDE.md's three-part test the blocker for THIS host is part 3
  (host honours the behaviour): `SECURITY/invariants.yaml:1069-1081` `node-pack-sandbox-network-gated`
  (tier protocol, severity critical) is exactly the guarantee the adapter reports `not-enforced`. So the P4
  reason is mis-classified: `host-evidence` (network) not `adoption`. The register row
  (`docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md:95`) and the tripwire's `why: 'adoption'`
  (`agrade-wire-blocked-residue.test.ts:206`) repeat the mis-classification.
- **Stale:** register `:95` says "P2 (the first REAL adapter) and P3 (broker hardening) open" — P2 shipped
  `1f422e383` (#3317) 1h43m after H44 reconciled the register; the register was not touched by #3317.
- CORRECTION 5 (`:11-19`) already says "read RFC 0035, not its rung" — the status line then does the thing
  CORRECTION 5 warns against.
- P3 phrasing `:247` "Effect attempts cannot bypass policy; replay guard survives process boundary" — the
  second half is ALREADY witnessed (`pack-isolation-guards.test.ts:132-230`, `pack-isolation-child-adapter.test.ts:194-260`
  LIVE fires / REPLAY refused across the real boundary; `:579-582` says so). What P3 still owns is a
  host-call POLICY surface + sabotage. The phase row should be narrowed.
- Correction notes: exemplary (CORRECTIONS 1–5 pre-P1, 6 in P2, the "two tests passed while sabotaged"
  admission `:748-761`).
- Part V gaps: no consolidated Claim record; the "evidence level" is stated in prose only.

### 4. Implementation reality on `9b2af4839`
| Phase | State | Witness | Evidence level |
|---|---|---|---|
| P0 trust tier + fail-closed | LANDED `be62a115e` #3179 | `pack-trust-tier`, `pack-trust-enforcement`, `pack-trust-config` | test-seam; prod posture: no `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED` in Cloud Run env ⇒ untrusted REFUSED |
| P1 contract + fake adapter + broker | LANDED `f16489a16` #3288 | `pack-isolation-guards`, `pack-isolation-eligibility`, `pack-isolation-executor` | test-seam |
| P2 child-process adapter | LANDED `1f422e383` #3317 | `pack-isolation-escape` (25 legs `:71-460`: fs read/write, env, network attenuated + `node:net` STILL connects `:234`, subprocess/worker/addon/eval/`process.binding`/`process.send`, CPU/idle/memory ceiling/bomb, cross-pack read/sibling tmp/scratch removal, forged dispatch credential `:457`), `pack-isolation-child-adapter` (17), `pack-isolation-build-wiring` (5), `pack-isolation-deployability` | test-seam + local-live; **prod isolates an EMPTY population** (no `OPENWOP_PACK_ISOLATION*` env; default `untrusted`; untrusted packs are refused before isolation is reached) |
| P3 broker hardening (policy surface) | OPEN (small) — guard propagation + authority + confused-deputy already witnessed | — | — |
| P4 `sandbox.supported` | BLOCKED — `host-evidence` (network) mis-labelled `adoption` | tripwire `agrade-wire-blocked-residue.test.ts:277` | — |
- Guarantees per `childProcessAdapter.ts:108-133`: separate-process, scrubbed-env, memory-cap,
  cpu-wall-clock-kill, no-dynamic-code unconditional; fs-allowlist / no-subprocess / no-worker /
  no-native-addons / cross-dispatch = permission model; `network-denied` = `not-enforced` always.
- Nothing changed for 0555 between `fa968b428` and `9b2af4839`.
- Note the prior audit's `brokeredEgress.ts` is NOT the pack broker — that is `host/packHostCallBroker.ts:208-259`
  (`dispatch_unknown`, `host_capability_denied` for a call outside the grant, `runWithEffectContext`+
  `runWithAuthority` at `:22,55-56`). `brokeredEgress.ts` is the Connections adapters' egress spine.

### 5. Roadmap bullet-by-bullet (`:611-619`)
1. "Enforce filesystem, environment, network, process, CPU, memory, and wall-time isolation" — **DONE
   except network** (`childProcessAdapter.ts:108-133`; escape suite legs cited above).
2. "Replace `network-denied: not-enforced` with an enforceable policy" — **OPEN, needs a runtime decision**:
   Node 22 permission model has no network dimension; Cloud Run gen2 offers no seccomp/netns
   (`:631-651`); the ESM resolve hook costs `no-worker-threads`. Options are Deno/WASM worker or a
   brokered-only egress (route `node:net` through `packHostCallBroker` = deny by construction). This is a
   decision the ADR must record; not a bullet a coder closes.
3. "Implement the host-call broker" — **DONE** (`packHostCallBroker.ts`; P1 `:394-582`).
4. "Authenticate worker calls and bind them to dispatch identity" — **DONE** (per-dispatch hashed token,
   `packDispatchRegistry.ts`; forged-credential leg `pack-isolation-escape.test.ts:457`).
5. "Preserve interrupts and canonical error codes across the boundary" — **DONE**
   (`pack-isolation-child-adapter.test.ts:119-160`, executor both placements `pack-isolation-executor.test.ts:210-260`).
6. "Carry replay effect restrictions into the worker" — **DONE** (`pack-isolation-guards.test.ts:132-230`,
   `pack-isolation-child-adapter.test.ts:235`).
7. "Deny unknown broker operations" — **DONE** (`packHostCallBroker.ts:208,220`).
8. "Add cross-pack, process escape, worker-reuse, and confused-deputy tests" — **DONE except
   worker-reuse**: there is no pool by design (`:810-811`), so "worker-reuse" is a non-property; the honest
   guard is a "no pool exists" pin (grep `pool` in `test/pack-isolation-*` = 0 hits, so today nothing would
   go red if someone added one). Small.
9. "Advertise sandbox capability only after live isolation evidence" — **OPEN/BLOCKED (network)**; the
   negative is pinned (`agrade-wire-blocked-residue.test.ts:277-288`).
- Roadmap Phase 4 hard gate `:918-919` "isolated across process, filesystem, environment, **network**, CPU,
  memory, and time" — cannot close without the network decision. Correct as a gate.

### 6. Cross-artifact
- RFC 0035 (contract + §B invariants; Parked, tripwire non-steward), `SECURITY/invariants.yaml`
  `node-pack-sandbox-*` (7 protocol-tier), ADR 0367 (signatures), ADR 0397 (firewall), ADR 0531 (effect
  guard), ADR 0556 P3 (authority across the boundary, `pack-isolation-guards.test.ts:232-287`), ADR 0550
  (pack provenance / signing at release — deferred `:113-118`), proposed 0581 (reuse the child adapter for
  document extraction — see below).
- RFC 0147 §A.1: no wire today; a future `sandbox.supported` advert is RFC 0035's existing vocabulary, not
  new wire.
- Part III rows: "Untrusted pack isolation | Existing sandbox RFCs and invariants | ADR 0555 |
  process/network/filesystem escape suite" — correct; "Pack provenance | RFC 0154, RFC 0160 | ADR 0550,
  ADR 0555" — 0555 only inherits (`packSignature.ts`), signing-at-release is 0550's.
- Overlap risk: 0584's "multi-process harness" and 0555 P4's "live isolation evidence" — evidence for
  0555 comes from its own escape suite in the deployed image (a `childAdapterGuarantees()` deploy-smoke
  probe), not from a chaos harness.

### 7. Defects & gates-that-cannot-fail
- Status-line/register/tripwire mis-classification (`:3`, register `:95`, test `:206`) — doc; small.
- Register `:95` stale (P2 open) — doc; trivial.
- `routes/discovery.ts:1424-1425` comment "production deployments use wasmtime/nsjail for real isolation"
  — false (ADR 0555 P2 `:594-600`: nsjail/Firecracker unavailable on Cloud Run gen2; the production adapter
  is a forked Node). Trivial doc defect, but it is the comment beside the sandbox advert seam.
- No deploy-smoke assertion of `childAdapterGuarantees()` from the LIVE image: the permission-model
  guarantees are conditional on `process.allowedNodeEnvironmentFlags` (`childProcessAdapter.ts:109-112`);
  a Node minor that renamed the flag would silently flip five guarantees to `not-enforced` in prod with every
  local gate green (`pack-isolation-deployability.test.ts` pins the Dockerfile text, not the runtime flag
  set). Small; owner 0555 P3/P4.
- No metric of "dispatches actually isolated" is asserted anywhere; `openwop.pack.isolation.dispatch` exists
  (`:716`) but prod's population is empty, so the sandbox's first real use will be its first measurement.
- "Cancellation kills the isolate" is a parent-timer/finally kill; the ADR admits Cloud Run CPU throttling
  makes the timer best-effort after flush (`:815-817`) — recorded, fine.

### 8. Verdict
Roadmap treatment **mostly stale** (7/9 bullets done before its own baseline). The ADR is high quality but
carries one self-contradiction that mislabels its only real blocker (network = host runtime decision, not
RFC 0035 adoption). Needs: a CORRECTION 6 fixing the P4 reason (status line + register `:95` + tripwire
`why`), a recorded runtime decision for network denial (or an explicit "not on Node/Cloud Run" verdict), a
narrowed P3 row, a no-pool pin, and a live-image guarantees probe. **P2** — fail-closed today, nothing
advertised, prod population empty.

---

## Proposed ADR 0581 — Dependency and Untrusted Document-Ingestion Security

### 1. Premise check
Roadmap `:681-682`: "the audit found High-severity production dependency chains in backend document
parsing and frontend rendering." **TRUE, measured 2026-08-18** (`npm audit --omit=dev --json`):
- backend: 4 high / 0 critical — `officeparser@7.2.1` (direct) → `pdfjs-dist@5.6.205` GHSA-hq66-cqwq-w95j
  ("Arbitrary JavaScript execution upon opening a malicious PDF", CWE-79, range `>=5.6.83 <6.2.108`);
  `pptxgenjs@4.0.1` (direct) → `image-size@1.2.1` GHSA-w3rx-r6r6-pgpr + GHSA-5p2g-fcmc-qvqq (ICNS/JXL/HEIF
  infinite-loop DoS, range `<=2.0.2`).
- frontend: 2 high — `react-router-dom@7.18.1`→`react-router@7.18.1` GHSA-qwww-vcr4-c8h2 (RSC-mode CSRF);
  2 moderate — `mermaid@11.15.0` (5 advisories incl. prototype pollution GHSA-c4c3-pg64-4m4v,
  GHSA-3rrr-jr9j-h3q3; all fixed `<11.16.1`), `dompurify<=3.4.12` GHSA-55q2-fjhq-7xh7 (transitive via mermaid).
- **All 4 highs are ALREADY waived** in `scripts/audit-exceptions.json` (NOT `backend/typescript/…` as the
  brief said) with reachability + `revisitAfter` (2026-09-06 / 2026-09-08 / 2026-10-31); the blocking gate
  `scripts/check-audit.mjs` runs in `scripts/ci.sh:659-668`; moderates are advisory-only unless
  `OPENWOP_CI_AUDIT_STRICT=1` (`ci.sh:669-672`).
- **Audit-invisible exposure (confirmed):** `unpdf@1.6.2` (the KB's PDF path, `kbService.ts:1338-1341`)
  bundles pdf.js **5.6.205** in `node_modules/unpdf/dist/pdfjs.mjs` (`apiVersion:"5.6.205"`, three hits) and
  declares NO npm dependency on `pdfjs-dist` (`dependencies: null`) — inside GHSA-hq66-cqwq-w95j's range and
  invisible to `npm audit`. **No upstream fix exists yet:** `unpdf@1.8.1` (latest) bundles `~6.1.200`
  (`unpkg …/unpdf@1.8.1/package.json` devDependencies), and `officeparser@7.6.2` (latest) pins
  `pdfjs-dist 6.1.200` — both still `<6.2.108`. `image-size` latest is `2.0.2` = inside `<=2.0.2` — no fixed
  release exists.
- `officeparser.parseOffice(buffer)` with no ext runs `fileTypeFromBuffer` (`node_modules/officeparser/dist/OfficeParser.js:165-172`)
  and routes `%PDF` to its `PdfParser` → `pdfjs.getDocument({data, verbosity:0})` (`parsers/PdfParser.js:309-312`)
  with NO `isEvalSupported:false` — so a PDF body uploaded under a pptx/xlsx/odt/rtf MIME reaches
  officeparser's pdf.js; the exception entries' "PowerPoint, Excel, OpenDocument, RTF" reachability note is
  incomplete (they DO say "NOT ASSESSED: the specific defect", which is honest).
- Extraction is IN-PROCESS on the API instance (`kbService.ts:1318-1360`), the only limit being the 32 MiB
  decoded cap (`:1278,1471-1473`); no page/object/decompression/CPU/time bound.
- Frontend: `MermaidDiagram.tsx:83-85` runs `mermaid.initialize({securityLevel:'strict'})` +
  `mermaid.render()` in the PARENT document and puts only the SVG into an `<iframe sandbox="">` with a
  no-script CSP (`:23,102-104`). The iframe protects against OUTPUT (CSS injection, script in SVG); the
  prototype-pollution advisories act at render time in the parent. Fix is the in-range bump.
- No SBOM anywhere (grep `sbom|cyclonedx|spdx` across scripts, Dockerfile, package.json, .github = 0 hits).

### 2. Existing owners
- Audit gate + expiring exceptions: `scripts/check-audit.mjs` + `scripts/audit-exceptions.json` (landed with
  the CORS fixes #3029/#3044 era, `git log`), wired `scripts/ci.sh:659-672`. Fields today: advisory /
  package / workspace / severity / why / reachability / revisitAfter / removeWhen — no `owner`, no
  `mitigation`, no `affected path` field (paths live in `why` prose).
- Isolation boundary to reuse: ADR 0555 P2 child adapter (`--disallow-code-generation-from-strings`,
  `--permission`, memory cap, SIGKILL wall clock — `childProcessAdapter.ts:108-133`) — a pdf.js `new
  Function` path is structurally impossible inside it.
- Claims/evidence: ADR 0550 (attestation), RFC 0156 §E claims gate; SBOM/attestation binding belongs to
  0550 P4/deploy provenance (ADR 0518/0530), not a new ADR.
- Frontend mermaid sandbox: ADR 0129 (`MermaidDiagram.tsx:2-8`).
- Upload caps: `kbService.ts:1278-1282`.

### 3. Genuinely new residue
- Moving untrusted document extraction (PDF/OFFICE/DOCX) out of the API process into a bounded worker (the
  0555 adapter, or a dedicated `child_process.fork` with the same spawn options), with byte/page/object/
  time/memory limits and `isEvalSupported:false` for both pdf.js copies — no artifact decides this today.
- Malicious-fixture suite (PDF with JS/OpenAction, zip-bomb pptx, ICNS/JXL image bomb, mermaid `%%{init}%%`
  prototype-pollution source) as tests — none exist.
- A "vendored-copy" tripwire: a text test pinning unpdf's embedded pdf.js version so the audit-invisible
  copy is at least VISIBLE (today nothing would go red if unpdf shipped a vulnerable bundle).
- Exception schema hardening (owner + mitigation + affected path fields; validation) — small, could be
  folded into 0550 or done inline.

### 4. Wire/freeze/compat
Host-local + safety-fix. No wire. RFC 0147 §A.1 irrelevant except that RFC 0156 §E's claims gate would
withdraw "secure" claims on an open High.

### 5. Recommendation
**AUTHOR, NARROWED** to "Untrusted document-ingestion isolation and limits" (compose on ADR 0555's
adapter; do NOT restate the audit gate, which exists). Fold SBOM + exception-field hardening into ADR 0550
(deploy provenance) rather than here. Hours-sized pre-work needs no ADR: `npm update mermaid dompurify`
(in-range, under `npx -y npm@10.9.8`), `isEvalSupported:false` on both `getDocument` call sites the app
controls (unpdf's `getDocumentProxy(data, options)` passes options through), amend the two officeparser/
pdfjs exception entries with the magic-byte + unpdf facts.
Falsifiable acceptance tests (what turns them red):
- `test/kb-ingest-isolation.test.ts`: a PDF fixture whose font program / OpenAction attempts
  `globalThis.__pwned = 1` — extraction must succeed or fail typed with `__pwned` undefined in the API
  process (red if extraction runs in-process without `--disallow-code-generation-from-strings`).
- A 32 MiB deck that decompresses to >1 GiB is refused `validation_error`/413-class within N s (red if no
  decompression bound).
- An ICNS/JXL bomb through the pptx export path terminates within the wall clock (red today: in-process
  infinite loop).
- A text test that reads `node_modules/unpdf/dist/pdfjs.mjs` `apiVersion` and asserts it is either
  `>=6.2.108` or listed in `audit-exceptions.json` with `package:"unpdf-vendored-pdfjs"` (red today —
  which is the point).
- `check-audit.mjs` schema arm: an entry missing `revisitAfter`/`owner` fails (red today: see below).
- Roadmap Phase 1 gate `:840` "No unwaived Critical/High production dependency advisory" is **met TODAY by
  the exception file** — vacuous as phrased. Rephrase to "no High older than N days without an upstream
  issue link AND ingestion isolated" or "zero High reachable from unauthenticated/tenant input in-process".

### Extra defects found in the existing gate (owner: 0550 or inline; small)
- `scripts/check-audit.mjs:93` matches an exception by **package name OR advisory** — a NEW, different
  advisory on an already-excepted package (e.g. a second pdfjs-dist RCE, or any future react-router high) is
  auto-waived and marked `seen`, so neither UNEXPECTED nor STALE fires. Sabotage: add a fake high `via` for
  `officeparser` with a new GHSA id → gate stays green.
- `scripts/check-audit.mjs:41` `e.revisitAfter < today` with a missing `revisitAfter` is `false` forever —
  a malformed entry never expires; no schema validation of required fields.

---

## Proposed ADR 0585 — External Security Audit and Remediation Program

### 1. Premise check
The roadmap section (`:766-783`) has **no "why a new ADR is required" paragraph at all** — decisions and
acceptance criteria only. Every decision bullet is already normative in the corpus:
- scope → `SECURITY/external-audit-engagement.md` §2.1 (`:24-97`) — pinned to spec docs, threat models,
  reference hosts under `examples/hosts/`, SDKs; **openwop-app appears 0 times** in that file (grep);
- freeze claims on open Critical/High → RFC 0156 §C (`:36`) + §E (`:60`); the app-side projection is ADR
  0550 P4 (`54229aa61` #3309, claims derived from the RFC 0148 ledger);
- track remediation + retest → RFC 0156 §C status vocabulary
  `not-started|contracted|in-progress|remediation|retest|complete` (`:38`), the machine findings bundle
  `SECURITY/external-audit-findings.json` (`findings: []`, schema beside it), engagement §8 tracker (all
  TBD after "outreach drafts ready 2026-05-11");
- publish redacted report + machine findings → §C "public summary MUST state scope, dates, methodology,
  severity counts, excluded surfaces, retest status" + §F assurance manifest (`docs/ASSURANCE-STATUS.md:17-19`
  today: "Engagement: **unscheduled**; 0 finding(s)");
- annual follow-up → RFC 0156 acceptance list "recurring review cadence … Carried" (`:120`).
So the premise is FALSE for the corpus and only true for the app in one narrow sense: openwop-app is not in
the engagement scope and has no `SECURITY.md` (`ls SECURITY.md backend/typescript/SECURITY.md` → none).

### 2. Existing owners
RFC 0156 §C/§E/§F/§G (`../openwop/RFCS/0156-governance-independent-assurance-and-claims.md:34-72`);
`SECURITY/external-audit-engagement.md` (271 lines, status DRAFT scope-pinned 2026-05-15, §8 tracker);
`external-audit-findings.{json,schema.json}`; RFC 0147 R15 (`ASSURANCE-STATUS.md:85` "no vendor, no start
date"); ADR 0550 P4 (app claims); RFC 0148/0155 (evidence bundle).

### 3. Genuinely new residue
Nothing decisional. Actionable residue: (a) add openwop-app (deployed `app.openwop.dev` + the Cloud Run
image) to engagement §2.1 as an in-scope host, with the isolation adapter, MCP/A2A mounts, KB ingestion and
compensation runtime named; (b) an app `SECURITY.md` pointing at the corpus SLA (`SECURITY/response-sla.json`)
and disclosure path; (c) a findings→regression-test intake rule (each remediated finding gets a named test)
— which the roadmap lists as an acceptance criterion and which belongs in ADR 0550/0548 as an invariant.

### 4. Wire/freeze/compat
None. Human/external (vendor, budget, contract) — Part VI already says "Commission and complete the
external security audit" cannot be closed by a document.

### 5. Recommendation
**DON'T author.** An accepted 0585 with a `Status:` line is the "document that looks like progress" the
roadmap's own Part VI warns against; RFC 0156 `:38` already forbids representing the empty findings file
as a clean audit — one tripwire is enough. Do instead: AMEND `SECURITY/external-audit-engagement.md`
§2.1 (+ openwop-app), add `SECURITY.md` to the app, and add the "remediated finding ⇒ regression test"
invariant to ADR 0548/0550. Falsifiable checks: `generate-assurance-status.mjs --check` already fails on
drift; add a test that the app repo has a `SECURITY.md` naming the corpus SLA (red today); the honest
Part III owner cell for "External security assurance" is `SECURITY/external-audit-engagement.md §8`, not a
new ADR. Priority: P0 as HUMAN work (vendor + budget), P3 as documents.

---

## Corrections to prior audit (PRIOR-AUDIT.txt)

1. **H53 is no longer stranded** — merged as #3325 = `9b2af4839` (2026-08-17 19:23 -0400) with all eight
   test files named in the ADR (`git show --stat`). Still NOT deployed (live `fb6cbbcba`).
2. **Line refs moved:** `scopeFingerprint` is at `host/mcpClient.ts:899` (was :625); the invalidator at
   `host/mcpClientCache.ts:155` (was :132). Substance CONFIRMED: no authz material, zero production
   callers, docblock false; H53 added `discoveryRevision` only.
3. **`image-size` "overrides: >=2.0.3"** (prior :453) is UNMEETABLE today — latest published is `2.0.2`
   and the advisory range is `<=2.0.2` (`npm view image-size version`; audit `range`). Upstream-gated.
4. **"move [unpdf] to a release bundling ≥6.2.108"** (prior :453) — no such release: `unpdf@1.8.1` bundles
   `~6.1.200`. And `officeparser@7.6.2` pins `pdfjs-dist 6.1.200`. Both still vulnerable; the only
   in-app mitigations are `isEvalSupported:false` + isolation (+ the vendored-version tripwire).
5. **"card parity runs against LOCAL boot only"** (prior 0552 row) — true of the CI/certify lane
   (`deploy.sh:219-220`), but a deployed-origin steward witness EXISTS (`INTEROP-MATRIX.md:289`,
   `a2a-card-runtime-consistency 5/5` at `1b2dd6fbb`). Not continuous, not absent.
6. **`brokeredEgress.ts` "is the policy surface"** for network denial (prior 0555 Open) — it is the
   Connections adapters' egress spine; the pack broker is `host/packHostCallBroker.ts`. The network policy
   would live in the worker channel/broker, not there.
7. `audit-exceptions.json` lives at `scripts/audit-exceptions.json` (repo root) — the brief's
   `backend/typescript/audit-exceptions.json` does not exist (team-lead slip, noted for accuracy).
8. Prior audit CONFIRMED on: 0555 7/9 stale + network true blocker + P4 mis-stated; 0552 push = one
   best-effort POST above no RFC requirement; RFC 0100 §4 has no durability MUST; prod isolates an empty
   population; 0553 MRTR restart claim mostly stale; mermaid.render in the parent doc; officeparser
   magic-byte routing; no SBOM; 0585 duplicate.

## New findings this pass (not in the prior audit)
- `scripts/check-audit.mjs:93` package-name match auto-waives NEW advisories on excepted packages; `:41`
  missing `revisitAfter` never expires. Two gates that cannot fail; small fix.
- Roadmap Phase 1 gate (`:840`) is met today by the exception file — vacuous as phrased.
- ADR 0553 cancellation is process-local (`runLifecycle.ts:76`); unrecorded cross-instance limit.
- ADR 0553 provenance table lacks P3/H47 rows; `mcpClient.ts:160-165` docblock stale post-H53.
- ADR 0555 status line contradicts its own P2 record (`:3` vs `:631,:820,:248`); register `:95` stale
  (P2 open); `routes/discovery.ts:1424-1425` "wasmtime/nsjail in production" false.
- 0552: no served-profile metric label (`metrics.ts:257-262`) ⇒ P4 usage evidence unobtainable;
  `INTEROP-MATRIX.md:293` "push/durableTasks not advertised" stale vs live wire.
- No live-image `childAdapterGuarantees()` probe — the permission-model guarantees are runtime-flag
  conditional (`childProcessAdapter.ts:109-112`).
