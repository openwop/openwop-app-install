# REPORT-B — effects / compensation RFCs (pass 2, 2026-08-18)

Slice B: RFC 0150, RFC 0151, RFC 0157 (existing); proposed RFC 0158, RFC 0159, RFC 0162.
Verified against: spec `/Users/david/dev/openwop` main `54f29548`; app `/Users/david/dev/openwop-app` main
`9b2af4839`; `openwop-examples` `434a8e9`; `openwop-sdks` `7a62218`; roadmap `c60ee3645`.
Read-only; no suites run. Every claim carries a path:line or commit. Prior audit (PRIOR-AUDIT.txt) treated as
hypotheses; confirmations and corrections are marked, and collected in the final section.

Line-number convention: `spec:` = /Users/david/dev/openwop, `app:` = /Users/david/dev/openwop-app/backend/typescript
unless a full path is given.

---

## RFC 0150 — Effect Identity, Replay, and Split-Brain Safety

### 1. Identity
- Path: `spec:RFCS/0150-effect-identity-replay-and-split-brain-safety.md`, 152 lines.
- `Status:` verbatim (`:7`): `| **Status** | \`Accepted\` |`.
- Last substantive edit: `0843d0a6 2026-08-16 docs(0150/0155): RFC 0150 §F OTel vocabulary; profile-claim-floor-not-overstated registered (floor half) (#1039)`.
- Sections: §A Layer-1 scope + pending claims (`:26-36`), §B logical effect identity v2 (`:38-48`), §C semantic
  request digest v2 (`:50-66`), §D fenced multi-region ownership (`:68-80`), §E versioning/history (`:82-84`),
  §F security/observability (`:86-96`), Compatibility, Conformance (7 named scenarios `:106-112`), Alternatives,
  5 UQs (`:126-130`, UQ1 resolved), 6 acceptance boxes (`:138-143`, all unchecked). No Part V "Implementation /
  Verification / Claim record" sections; the `Updated` cell (`:10`) is a 1-cell running ledger.

### 2. What it decides
- §A: Layer-1 key MUST be `(authenticatedTenantId, canonicalEndpointId, callerIdempotencyKey)`; records persist
  `requestDigest`, a 4-state machine (`pending|completed|retryable-failure|terminal-failure`), lease owner/expiry;
  atomic reclaim of expired pending MAY; digest mismatch MUST fail with "the canonical mismatch error"; host-generated
  keys MUST NOT share the Layer-1 keyspace (`:28-34`, from #950 `201e1c18`).
- §B: `logicalInvocationId = base64url(sha256("openwop:activity:v2\0"||tenant||run||node||ordinal||providerKey))`;
  `attempt` excluded (`:40-48`).
- §C: JCS-over-v2-object digest, no extra NFC, `providerOptions` namespace, stamp `openwop-semantic-request-v2` (`:52-66`).
- §D: reconciliation MAY pick a record, MUST NOT authorize effects; `fenced-effects` needs a monotonically increasing
  fencing token from a linearizable owner OR provider dedup under the stable id; else MUST NOT claim and MUST classify
  `at-least-once-risk`; vocabulary `single-region|reconciled-records|fenced-effects`; `last-writer-wins` removed (`:70-80`).
- §E: runs MUST stamp `activityIdentityRecipe` / `semanticRequestRecipe`; v1 histories not recomputed (`:84`).
- §F: five invariants named (`:90-94`); keys never logged in plaintext.
- Wire impact: `safety-fix` (COMPATIBILITY §3), 90-day window (`:12`, `:100`).
- Rejected: attempt-in-id, portable-subset hash, cancel-the-loser, distributed transactions (`:118-122`).

### 3. Artifact quality
- **Acceptance box 6 (`:143`) claims "three new invariants across §A/§B/§D" — FALSE by count.** Only two RFC-0150
  invariants exist in `spec:SECURITY/invariants.yaml`: `logical-effect-id-retry-stable` (`:1366`, blame `e2f6f16b`
  2026-08-12) and `multi-region-stale-owner-no-effect` (`:1402`, blame `e1648402` 2026-08-12). The §A one is absent.
- **§F (`:91`) and commit `201e1c18` (#950) both announce "New invariant `idempotency-store-no-host-generated-keys`" —
  it was never registered.** `grep -rn idempotency-store-no-host-generated-keys` over the corpus hits only the RFC
  (`:91`) and its gap register (`registers/0150-…gaps.md:14`); the #950 diffstat touched only CHANGELOG, the RFC and
  the register. Likewise `idempotency-key-tenant-endpoint-scoped` (`:90`) and `replay-semantic-digest-complete`
  (`:93`) appear nowhere outside `:90-93`. So 3 of 5 §F invariants are unregistered — confirms the prior audit, and
  sharpens it: one of the three was announced as landed.
- **§A never reached `spec/v1/idempotency.md`.** Layer-1 there is still `cacheKey = sha256(tenantId ':' endpoint ':'
  idempotencyKey)` (`spec:spec/v1/idempotency.md:68`); the file has zero occurrences of `lease|reclaim|pending|
  keyspace|host-generated|requestDigest` (grep, `:1-387`); its banner says v1.4 (`:3`) and its last commit is
  `f4ccf281 2026-08-12 (#958, §B run-scoped)`. The RFC's own `Updated` cell says "§A keyspace separation … MUST NOT
  added" (`:10`) — added to the RFC, not to the normative spec. Confirms prior audit.
- **§A "canonical mismatch error" (`:28`) names a code the corpus never defines.** `idempotency.md` defines only
  `idempotency_in_flight` (`:62`) and says "then conflict envelope" (`:253`); OpenAPI's 409 on `POST /v1/runs` is
  `RunClaimConflict` (`spec:api/openapi.yaml:285-294`); `grpc-transport.md:126` lists `idempotency_key_conflict` and
  `idempotency_key_mismatch`; the SQLite reference host emits `idempotency_key_conflict` for a body mismatch
  (`openwop-examples:examples/hosts/sqlite/src/server.ts:2285-2291`); the app emits `idempotency_key_replay_mismatch`
  (`app:src/routes/runs.ts:377-382`). Three spellings, no owner. New finding.
- **§E is a MUST in no schema.** `activityIdentityRecipe|semanticRequestRecipe` occur nowhere in `spec:schemas/`,
  `spec/`, `api/` (grep) — only `RFCS/0150…:84`. Confirms prior audit.
- Conformance section (`:106-112`) names 7 scenario files; none exist under those names (`ls
  spec:conformance/src/scenarios | grep …` returns `effect-identity-composition`, `effect-identity-cross-scope`,
  `multi-region-effect-vocabulary`, `multi-region-idempotency(-behavior)`, `semantic-digest-v2`,
  `semantic-digest-vectors`, `idempotency`, `idempotency-key-determinism`, `replay-llm-cache-key*`). Confirms.
- Acceptance box 1 (`:138`) still says the §C stamp "landed 2026-08-13 — `730ff3de`"; git says `730ff3de` is dated
  2026-08-12 19:00 (`git log -1`). Trivial date drift.
- No correction notes are needed inside the RFC; the `Updated` cell is honest about carried items. What is missing vs
  the roadmap's Part V template: an implementation record naming the app as a §A/§B/§C adopter (it is), and a claim
  record — INTEROP-MATRIX carries the MyndHyve `openwop-semantic-request-v2` writer (`spec:INTEROP-MATRIX.md:13`) but
  no RFC 0150 row for either host.
- Acceptance box 2 (`:139`) is UNMEETABLE-AS-PHRASED without a Python/Go SDK: `openwop-sdks` has no digest
  implementation in any language (`grep -rln semantic-request /Users/david/dev/openwop-sdks` → nothing;
  `openwop-sdks/go/` = client/events only; `spec:sdk/python` has no `semantic` hit). The vector file exists
  (`spec:conformance/vectors/semantic-request-digest-v2.json`, 11 cases) and is consumed by
  `spec:conformance/src/scenarios/semantic-digest-vectors.test.ts` (TS) — TS-only, confirmed.

### 4. Implementation reality on current main
| Section | State | Evidence | Level |
|---|---|---|---|
| §A tuple + lease + reclaim + CAS | LANDED in the app, NOT in the spec | `app:src/host/idempotentResponse.ts:158-188` (lease derived from request timeout, `IdempotentClaim` with `reclaimed`), `app:src/storage/storage.ts:443-497`, tests `app:test/idempotency-tenant-isolation.test.ts:458,476` (reclaim + CAS on SQLite) and `app:test/storage-adapter-parity-testcontainers.test.ts:535,575` (real PG, `skipIf(noDocker)`) | test-seam (SQLite) / test-seam-when-Docker (PG); spec text OPEN (spec-prose) |
| §A keyspace separation | LANDED app | `idempotentResponse.ts:9-24` (two tables: `claimOnce/putOnce` vs `claimIdempotentResponse`); `app:test/idempotency-lane-tripwire.test.ts` | test-seam; corpus invariant OPEN (unregistered) |
| §A 4-state machine | app uses `pending|completed` + DELETE-on-release (`storage.ts:479-497`) — a conforming reduction | — |
| §B v2 identity | LANDED both | `app:src/host/effectIdentity.ts:1-40` (v2 preimage, `tenantId` in, `attempt` out); `app:test/effect-identity-v2.test.ts`; corpus `effect-identity-composition.test.ts` (corpus-structural) | test-seam app; schema/server-free corpus |
| §B cross-scope business identity (v1.4) | LANDED spec (`idempotency.md:147-180`) + app commerce refund key (`effectIdentity.ts:31-40` cites `commerce-refund:<orderId>`) | server-free (`effect-identity-cross-scope.test.ts` reads the corpus, never a host) |
| §C digest v2 | LANDED spec (`replay.md:136-236`, stamp `:175`), vectors, TS consumer; app writer `app:src/providers/llmCacheKey.ts:96` `SEMANTIC_REQUEST_RECIPE_V2`; MyndHyve deployed writer (`INTEROP-MATRIX.md:13`, bundle #11) | deployed-live for two hosts (replay-llm-cache-key legs); Py/Go OPEN (upstream/adoption) |
| §D vocabulary + separation prose | LANDED spec (`idempotency.md:261-372`, `capabilities.schema.json` crossRegion enum) | schema + server-free (`multi-region-effect-vocabulary.test.ts`) |
| §D fencing behaviour | OPEN everywhere: app has zero fencing code (`grep -rni "fencing\|fenceToken" app:src` → only prompt-injection fencing); app pins crossRegion absent (`app:test/agrade-wire-blocked-residue.test.ts:232-244`); corpus seam `simulate-partition` covers records only (`multi-region-idempotency-behavior.test.ts:1-30`) | none (host-evidence + no linearizable owner exists) |
| §E stamps | OPEN (spec-prose: no schema; app: no stamp — grep `activityIdentityRecipe` app:src → 0) | — |
| §F OTel names | LANDED spec (`0843d0a6`); app emits `recordIdempotencyClaim` counters (`app:src/routes/runs.ts:371-374`, ADR 0556 P1) | local |
| §F 3 invariants | OPEN (unregistered) | — |
- Between `fa968b428` and `9b2af4839`: only #3325 (MCP) landed; no idempotency/effect file changed (`git diff --stat`).

### 5. Roadmap bullet-by-bullet (`roadmap:199-221`)
- "Add Python and Go consumers for semantic-request-digest and effect-identity vectors" — OPEN/EXTERNAL (openwop-sdks
  has neither); **effect-identity vectors do not exist** — §B has only a corpus-structural prose gate
  (`effect-identity-composition.test.ts`; register G9 `registers/0150…gaps.md:9`). Half FALSE-PREMISE.
- "Complete pending-lease expiry, recovery, and stale-owner semantics" — OPEN in spec-prose (`idempotency.md` has
  none); DONE in the app (§4). Mis-located: the roadmap should say "land §A text in idempotency.md".
- "Prove provider retries retain one logical effect identity" — OPEN at black-box tier by construction (G9: the
  injected header is seen by the provider, not the caller — `registers/0150…gaps.md:9`); DONE at app test-seam
  (`effect-identity-v2.test.ts`).
- "Prove business-level identity prevents duplication…" — DONE spec (`idempotency.md:147-180`) + app pattern; only
  server-free evidence.
- "Add delayed-delivery, duplicate-delivery, lease-reclaim, stale-worker, partition, failover cases" — lease-reclaim
  DONE app-local (`idempotency-tenant-isolation.test.ts:458-476`); duplicate delivery DONE for the outbox
  (`app:test/dispatch-outbox.test.ts:224`); the rest OPEN; nothing in the corpus suite.
- "Add a live host that implements fenced external effects" — EXTERNAL/OPEN; no host, no linearizable owner.
- "Compose with proposed RFC 0159" — see 0159: DON'T (amend 0150).
- Exit "TS/Python/Go byte-identical vectors" — UNMEETABLE until SDKs exist. Exit "deployed host rejects stale owners
  during a forced partition" — EXTERNAL. Exit "no reconciliation algorithm grants effect authority" — DONE as text
  (`idempotency.md:261-284`), witnessed only structurally.

### 6. Cross-artifact
- Depends on: RFC 0036 (multiRegion block), RFC 0093 (final-outcome caching), RFC 0140/0041 (replay), RFC 0147 SR-3.
- Depended on by: RFC 0151 §C tuple (`compensation.md:186-200`), RFC 0157 (via 0151), ADR 0549 (app adoption),
  ADR 0551 P4 (§D fencing), ADR 0554 (forward id composition `app:src/host/compensationRuntime.ts:296-309`).
- §A.1 freeze: `safety-fix`, already Accepted; landing §A text + registering the 3 invariants is inside accepted
  scope, not new optional wire.
- Part III rows: "Idempotent admission crash window | RFC 0150 | ADR 0549, ADR 0582" — RFC 0150 §A already permits
  atomic reclaim; the crash window (`app:src/routes/runs.ts:363` claim → `:457` run+outbox txn → `:495` complete)
  is host-local; no protocol change needed, so the protocol-owner cell is misleading. "Retry-stable effect identity |
  … | cross-language vectors" — vectors for §B do not exist (see §5).

### 7. Defects & gates-that-cannot-fail
- D-0150-1 (spec, small, Spec Architect): §A absent from `idempotency.md`; the accepted RFC and the Stable spec disagree
  on Layer-1 record shape and lease. Fix = one editorial PR (v1.5) + register 3 invariants.
- D-0150-2 (spec, small): "canonical mismatch error" undefined; three codes in the wild (see §3). Fix = pick one in
  `idempotency.md`, add to error catalogue; the SQLite ref host and grpc-transport.md then need aligning.
- D-0150-3 (spec, editorial): acceptance box 6 over-counts invariants (3 claimed, 2 exist).
- Cannot-fail: `effect-identity-cross-scope.test.ts` and `effect-identity-composition.test.ts` read the corpus
  prose (`describe.skipIf(V1_DIR === null)`) — green against any host; correctly labelled corpus-structural.
- App: in-flight 409 uses `idempotency_key_conflict` + raw key echo (`runs.ts:397-406`) vs canonical
  `idempotency_in_flight` + `details.retryAfter` (`idempotency.md:62`); the corpus `highConcurrency.test.ts:99-116`
  asserts `idempotency_in_flight` but tolerates `errorCode === undefined` and N=10 rarely observes a 409, so it has
  never gone red. Confirms prior audit; owner ADR 0549 (slice D).

### 8. Verdict
Roadmap treatment is directionally right (residue = fencing, vectors, chaos) but mis-located: the biggest hole is
that §A never became normative text and 3/5 invariants (one announced as landed) do not exist, while the app already
implements §A/§B/§C ahead of the spec. Artifact needs: land §A in `idempotency.md` v1.5 with the mismatch code
decided; register the three invariants; correct box 6's count; record app + MyndHyve as adopters in the claim record.
Priority **P1** (spec editorial closing an accepted safety-fix), fencing itself **P3/external**.

---

## RFC 0151 — Compensation and Partial-Failure Profile

### 1. Identity
- Path: `spec:RFCS/0151-compensation-and-partial-failure-profile.md`, 144 lines. `Status:` verbatim (`:7`):
  `| **Status** | \`Accepted\` |`.
- Last substantive edit: `f4cb1525 2026-08-17 spec(0151): S37 — waiveRequiresApproval escalation is a floor … (#1064)`;
  prior: `4123dfae` (S36), `4d9283f2` (deployed-wire + G9), `cb3a12b5` (first host witness), `6c603a19` (UQ4).
- Sections: §A–§G (`:26-89`), Compatibility, Conformance (8 named scenarios `:99-106`), Alternatives, 5 UQs (`:120-124`;
  UQ2/3/4 resolved), 6 acceptance boxes (`:132-137`, 1 checked). Normative surface lives in
  `spec:spec/v1/compensation.md` (448 lines, `Status: Draft`, `:3`).

### 2. What it decides
- §A capability `{supported, profileVersion, orderingModels[], manualIntervention}`, closed
  (`capabilities.schema.json:3462-3495`); reverse-completion MUST, dependency-graph MAY.
- §B node `compensation {nodeTypeId, inputMapping?, retry?, requiresApproval?, waiveRequiresApproval? (S36)}`
  + `irreversibleEffect` sibling (UQ4); policy `settings.compensation` (`compensation-policy.schema.json`, closed
  `triggers` enum of four, `:21-30`); non-advertising host MUST refuse policy with `capability_required`
  (`compensation.md:135-146`); "a trigger not listed does not start an unwind" (`compensation.md:127-129`).
- §C plan-before-first-inverse, identity tuple `(tenant, run, forwardLogicalInvocationId, ordinal, profileVersion)`,
  crash-resume from the persisted plan, MUST NOT rebuild from the definition (`compensation.md:206-215`),
  `onParentCancel`.
- §D six events, closed reason enum (`run-event-payloads.schema.json:4356-4363`), `RunSnapshot.compensationStatus`
  fold table (`compensation.md:290-306`).
- §E approvals bound to `planVersion` (RFC 0049), DLQ (RFC 0053), four operator outcomes, no canonical endpoint
  (G7), substitution = new planVersion (UQ2).
- §F replay never re-fires; §G four invariants; threat model `SECURITY/threat-model-compensation.md`.
- Wire: additive, capability-gated. Rejected: cancel-as-rollback, repair-workflows-only, distributed txns, core.

### 3. Artifact quality
- **`compensation.md:3` contradicts itself in one sentence**: it says "§C/§E/§G prose landed 2026-08-16" and then
  "This document covers **only what has landed on the wire** — … (§A) … (§B) … (§D) … and the replay rule (§F)",
  while §C (`:160`), §E (`:312`), §G (`:379`) are present in the same file.
- **RFC acceptance box 3 (`:134`) is STALE**: "§C's semantic digest is not [landed], so the composition cannot be
  specified end-to-end yet" — RFC 0150 §C landed `730ff3de` (2026-08-12) with vectors `40617a4d`; RFC 0150's own
  header (`0150…:10`) and box 1 (`:138`) say so. `compensation.md` G1 (`:433`) repeats the stale claim ("that digest
  is not landed"). Confirms prior audit.
- Acceptance box 6 (`:136`) says no reference host can demonstrate mid-unwind crash recovery because "there is no
  compensation surface for one to implement" — STALE for the app: it is the reference host and carries a
  storage-level crash-mid-unwind witness (`app:test/compensation-unwind.test.ts:198` "ADVERSARY 1: a crash mid-unwind
  resumes on the REMAINDER") — test-seam, not process-kill; the box should say "app: test-seam; process-kill open".
- Box 2 (`:133`) is current (records `d209d8009` local strict 6/6+3/3, absent legs named). Box 5 [x] correct.
- The `Updated` cell (`:10`) is now ~1,900 characters of interleaved history in reverse-then-forward order — no
  contradiction, but there is no Implementation/Verification/Claim record; INTEROP-MATRIX row `:281` is the de-facto
  claim record and is accurate for 2026-08-17 morning.
- Conformance list (`:99-106`) names 8 files; the real files are `compensation-profile`, `compensation-behavior`,
  `compensation-recovery`, `chain-compensation-expansion` (ls). No `compensation-crash-recovery`, no
  `compensation-approval-authority` — the RFC's own box 2 admits both legs are absent.
- Acceptance "Every advertised trigger executes non-vacuously" (roadmap exit, `roadmap:245`) is UNMEETABLE-AS-PHRASED:
  the closed capability advertises no trigger (`capabilities.schema.json:3462-3495`).

### 4. Implementation reality on current main
Corpus: §A/§B/§D/§F wire + §C/§E/§G prose landed; scenarios profile 19 asserts, behavior 6 legs, recovery 3 legs
(seam §21, `host-sample-test-seams.md:830`); 4 invariants registered (`invariants.yaml:1543-1592`). Open: G4 fork
rollup, G5 retention (text-only, NOT wire, NOT frozen); G6/G7/G9 held under §A.1 (`compensation.md:439-442`); UQ1
dependency-graph.

App (ADR 0554, all pre-`fa968b428` except where noted):
| Leg | State | Evidence |
|---|---|---|
| Advert + `compensationStatus` on every snapshot | LANDED, deployed-live | `app:src/host/compensationCapability.ts:99-113`; `app:src/routes/runs.ts:1354-1358`; INTEROP `:281` deployed-wire 19/19, 5/6 |
| §B validation, node + policy, S36/S37 | LANDED | `app:test/compensation-policy.test.ts`, `compensation-executor-policy-stamp.test.ts` |
| §C reverse-completion, retry-stable id, crash-resume (storage-level), replay no-refire | LANDED test-seam + local-live strict | `compensation-unwind.test.ts:119-360`; INTEROP `:281` local boot 6/6, 3/3 |
| §E approval gate, DLQ, four operator actions + host-ext `start`, RBAC, SoD, audit chain, expectedState CAS | LANDED (P3 #3322) | `app:src/host/compensationRecovery.ts:187-312`, `compensationRecoveryAudit.ts:61-63`, `features/operations/routes.ts:589,637`; tests `compensation-recovery-{route,rbac,partial,audit}.test.ts`, `compensation-approval-sod.test.ts` |
| Triggers | OPEN: sole initiation `app:src/executor/executor.ts:2081` `unwindTerminatedRun({storage,run,definition})` (no trigger arg → `'node-failure'`, `compensationRuntime.ts:405`); `app:src/host/runCancel.ts` has 0 `compensat|unwind` refs; run-duration cap `executor.ts:1651-1661` → `emitTerminalFailure` with no unwind; node-executions cap `executor.ts:1676-1697` → `markFailed` → unwinds under `node-failure` (wrong label); sweeper `runDispatchSweeper.ts:142` and `runDispatch.ts:128` → `emitTerminalFailure` only | host-evidence |
| **NEW since `fa968b428`**: #3325 (`9b2af4839`) inserted a terminal-status guard at the top of `finalizeRun` (`executor.ts:1941-1948`, `finalize_skipped_terminal_run`) that returns BEFORE `unwindTerminatedRun` (`:2081`). A run cancelled mid-flight now never reaches the unwind at all (previously a cancelled run whose disposition ended `failed` would have unwound under the `node-failure` label). Net: on current main a cancel with committed compensable effects yields no unwind under any policy; the only test (`app:test/run-abort-signal.test.ts:214-260`) asserts the cancel sticks, nothing about compensation. Not a regression of a working path (run-cancel never fired), but it removes the accidental one and is unrecorded in ADR 0554. | host-evidence |
| Mint window | OPEN: obligation minted after the effect + `markCompleted` (`executor.ts:1717-1735`), failure caught+logged only (`compensationRuntime.ts:316-322` `compensation_obligation_record_failed`), no test names that log key (grep app:test → 0) | — |
| Branch-fork no-refire | OPEN: only `forkMode:'replay'` no-mint is tested (`compensation-unwind.test.ts:980-991`, `compensationRuntime.ts:198`); no `'branch'` leg (grep `'branch'` in compensation tests → 0) | — |
| Deployed-origin recovery legs | seamAbsent by construction (G9) | INTEROP `:281` |
- Product reality: no shipped chain pack or feature workflow declares `compensation` (`grep -rln '"compensation"'
  packs/ examples/ app:src/features` → only RFC 0022 `inputMapping` hits) — the profile is exercised by tests and seams
  only.

### 5. Roadmap bullet-by-bullet (`roadmap:223-245`)
- "Promote compensation.md from Draft…" — OPEN; correct as stated (banner `:3` self-contradiction should be fixed first).
- "Complete crash-resume, retry, pause, manual, waiver, approval, substitute, termination, dead-letter behavior" —
  DONE as prose (§C/§E) and in the app (P2/P3); suite legs for crash-resume + approval-before-inverse OPEN (RFC box 2).
- "Define retention minimums and stable reason codes" — reason codes DONE (`run-event-payloads.schema.json:4356-4363`,
  STALE bullet); retention OPEN (G5/UQ5).
- "Define fork behavior for partially compensated runs" — OPEN (G4), text-only, not frozen.
- "Provide portable compensation-plan and attempt projections" — OPEN and FROZEN (G9 read projection is new optional
  wire); app serves a host-local projection (`features/operations/routes.ts:589`).
- "Require reverse-completion ordering and stable compensation identity" — DONE (`compensation.md:39-40, 176-200`) — STALE.
- "Keep irreversible effects visible in run rollups" — DONE (UQ4, `6c603a19`) — STALE.
- "Prove replay and fork never re-fire" — replay DONE (`compensation-behavior` leg + `compensation-unwind.test.ts:332`);
  fork OPEN (G4 + no branch test).
- "Compose with proposed RFC 0158" — see 0158: DON'T.
- Exit "Crash at every state transition resumes without duplicate compensation" — PARTIAL (storage-level ADVERSARY 1-4;
  no process-kill; mint window untested). Exit "Partial and irreversible outcomes remain visible and operator-actionable"
  — DONE app (RunCompensationPanel, host-ext routes) — deployed-live for the panel, local for the actions. Exit
  "Every advertised trigger executes non-vacuously" — UNMEETABLE-AS-PHRASED (no trigger advert); the honest form is
  "every trigger the host ACCEPTS in a policy fires" — OPEN (3 of 4 never fire).

### 6. Cross-artifact
- Depends on RFC 0150 §B (identity), 0049 (authz), 0051 (approvals), 0053 (DLQ), 0094 (cancel), 0058/0084 (caps).
- Depended on by RFC 0157 (mirrors), ADR 0554 (host), proposed 0158 (duplicate).
- §A.1 freeze: G6 (reason codes for holds), G7 (operator endpoint family), G9 (plan projection) are the three frozen
  items; G4/G5 are text and unfrozen; the trigger honesty fix needs no wire.
- Part III rows: "Compensation trigger over-claim | RFC 0158 | ADR 0554" — the over-claim is policy ACCEPTANCE (see
  §7), owner RFC 0151 erratum + ADR 0554, no new RFC. "Operator recovery portability | RFC 0151, RFC 0158 | ADR 0554 |
  authenticated black-box recovery tests" — impossible until G7 unfreezes; the app has host-ext routes; the honest
  interim evidence level is local-live via §21.
- Overlap: `spec:RFCS/0157` §B mirrors the policy schema; S36 field is mirrored into RFC 0157 fragments per
  `0151…:10` — verified in `workflow-definition.schema.json:295-314` (both fields present).

### 7. Defects & gates-that-cannot-fail
- **D-0151-1 (app, P1, small): `compensationStatus` reads `pending` on every SUCCESSFULLY COMPLETED run that
  committed a compensable node.** Obligations are minted at forward-commit with `state: 'requested'`
  (`app:src/host/compensationLedger.ts:433`; `compensationRuntime.ts:255-309`); the fold returns `pending` when every
  row is `requested` (`compensationLedger.ts:876,887`, pinned by `app:test/compensation-ledger.test.ts:224-226` "none
  started ⇒ pending"); `compensation.requested` is only emitted at unwind time (`compensationUnwind.ts:425`); the
  snapshot projects the fold unconditionally (`routes/runs.ts:1354-1358`). `app:test/compensation-executor-policy-stamp.test.ts:131-137`
  proves a run that ends `completed` holds exactly one such row. RFC 0151 §D fold: `none` = "No
  `compensation.requested` has been recorded", `pending` = "requested recorded and started has not"
  (`compensation.md:290-306`). So on the deployed origin every completed run with a §B node advertises an unwind
  "about to start" that will never come. Not caught by `compensation-behavior.test.ts:148-205` (it folds only the
  seam's UNWIND run). ADR 0554 noticed the irreversible-only variant (`docs/adr/0554…:836-841`) but not the general
  case. Fix: fold rows against run terminality / a `triggered` marker (or mint the plan at trigger time and keep the
  forward rows as `owed`), plus a test that runs a compensable node to `completed` and asserts `none`. New finding.
- **D-0151-2 (app, P1, small): the inverse action runs from the LIVE definition, not the recorded plan.**
  `invokeInverseAction` takes `declaration` from `collectDeclarations(storage, {runId, definition}, …)` resolved at
  unwind time and passes `declaration.nodeTypeId` / `declaration.inputMapping` (`compensationRuntime.ts:724, 740`;
  `compensationUnwind.ts:464-467`), while the row's mint-time `compensationNodeTypeId` / `compensationInput`
  (`compensationLedger.ts:168-176`, minted `compensationRuntime.ts:274-290`) are only REPORTED (`compensation-unwind.test.ts:671-698`
  asserts `inverseActions[].input`, not what was invoked). A workflow redefined between commit and unwind changes what
  is undone while the §21 report says otherwise — the exact case `compensation.md:212-215` forbids ("MUST NOT rebuild
  the plan from the workflow definition on resume") and the `compensation-input-recorded-facts-only` invariant is
  witnessed only through the report (gate cannot fail for the invocation path). Fix: invoke from the row; fall back to
  the declaration only for pre-flip rows lacking `compensationInput`.
- **D-0151-3 (app + spec, P2): `inputMapping` references are never resolved.** The app passes `inputMapping` verbatim
  as node inputs "so no template evaluation can re-infer" (`compensationRuntime.ts:705-709, 740`), yet RFC 0157 §C 6b
  and the app's own expander treat `${nodes.<id>.…}` inside `inputMapping` as references worth rewriting
  (`spec:RFCS/0157…:46`; `app:src/host/workflowChainPackLoader.ts:971-990` "so the compensator would read a node that
  no longer exists … the unwind would resolve nothing"). A compensator therefore receives the literal string
  `"${nodes.reserve-inventory.output.id}"` — RFC 0151 §B's own example (`0151…:51`) does not work on this host. The
  spec side has no normative grammar for `inputMapping` values (`compensation.md:53-60` says "MUST derive from
  recorded facts" without saying how) — corpus editorial gap; app owner ADR 0554.
- **D-0151-4 (app, P2, small): host-ext `start` is not gated on run terminality or on an existing plan.**
  `features/operations/routes.ts:655-660` loads the run and never checks `run.status`; `compensationRecovery.ts:200-312`
  checks tenant/tree/expectedState only; `LEGAL.requested` includes `started` (`compensationLedger.ts:311`);
  `resumeUnwindForOperator` deliberately skips `policyAdmitsTrigger` because "the unwind already started"
  (`compensationRuntime.ts:458-473`) — but for `requested` rows on a run that never triggered (including a `completed`
  or still-`running` run, per D-0151-1) nothing has started, and `unwindRun` then fires EVERY non-terminal inverse in
  the tree, not the named obligation. This is an operator-request unwind of a healthy run that bypasses
  `compensation.md:127-129` and §E's "on a held or partial plan" precondition (`compensation.md:353`). RBAC-gated
  (`host:compensation:start`), so P2 not P1; ADR 0554 documents `start` as "for the P2 sweeper residue"
  (`docs/adr/0554…:1251-1256`) but the code does not narrow it. Fix: refuse `start` unless the run is terminal-failed/
  cancelled/dead-lettered, or require `operator-request` in the policy.
- D-0151-5 (app, P1, medium): three of four accepted triggers never fire + wrong label on node-executions cap +
  terminal chokes strand rows (see §4). Confirms prior audit; owner ADR 0554.
- D-0151-6 (app, small): mint failure fail-quiet, untested (§4). Confirms.
- D-0151-7 (spec, editorial): `compensation.md:3` banner; RFC box 3 + G1 stale digest claim; box 6 stale for the app.
- Cannot-fail: `compensation-behavior` leg 6 folds only the seam run (see D-0151-1); `compensation-recovery` "recorded
  facts" leg compares two seam reports (`replayed ≡ source`), never the invocation input (D-0151-2).

### 8. Verdict
Roadmap is ~1/3 stale (ordering/identity, irreversible rollup, reason codes are done) and its "every advertised
trigger" exit is unmeetable as phrased; it misses the two live wire defects found here (`pending` on completed runs;
unwind from the live definition). Artifact needs: fix `compensation.md:3`, box 3/G1/box 6, decide G4/G5 (unfrozen),
add an `inputMapping` value grammar, and (after §A.1) G6/G7/G9. App needs D-0151-1/2/5 before any further
deployed-wire claim. Priority **P1** (two deployed mis-claims + trigger honesty), frozen G6/G7/G9 **P2**.

---

## RFC 0157 — Chain fragments carry compensation

### 1. Identity
- Path: `spec:RFCS/0157-chain-fragments-carry-compensation.md`, 88 lines. `Status:` verbatim (`:7`):
  `| **Status**        | \`Accepted\` |`.
- Last substantive edit: `01d2c45b 2026-08-16 feat(conformance): RFC 0157 host-path witness — sample chain pack 1.1.0
  carries two compensating chains; host-expansion legs expand them (1.133.0) (#1048)`.
- Sections §A–§E (`:26-55`), Compatibility, Conformance, Security, 2 UQs, 5 acceptance boxes (`:78-82`; 3 checked).

### 2. What it decides
- `FragmentNode.compensation` byte-mirror of `WorkflowNode.compensation`, carried verbatim through expansion by every
  host (`:28`); `WorkflowChain.compensation` byte-mirror of the policy → `settings.compensation` with copy /
  accept-if-deep-equal / `chain_compensation_policy_conflict` 409, never merged (`:32-38`); expansion rules 3b/5b/6b/9b
  (`:44-47`); mirrors not `$ref`s (`:51`); reference `carryCompensation` composed AFTER the mirrored core (`:55`);
  UQ2 resolved: a child chain owns its own policy (`:74`). Additive.

### 3. Artifact quality
- §E (`:55`) says the mirrored core "is mirrored verbatim by the in-memory reference host and gated in CI
  (`check-workflow-chain-expansion-sync.mjs`)". **That gate is red and has been for ≥100 consecutive runs (all
  failures back to 2026-08-09; zero successes in `gh run list --limit 100`)** — `Conformance Soak` fails at step
  "Workflow-chain expansion drift guard" (`spec:.github/workflows/conformance-soak.yml:72-75`; latest run
  `32069584184` on `54f29548`). Reproduced locally: `OPENWOP_EXAMPLES_DIR=… node scripts/check-workflow-chain-expansion-sync.mjs`
  → `[sync-gate] DRIFT detected` (24 diff lines). The drift is the RFC 0013 WCP2 whole-value raw-typed rule
  (`spec:conformance/src/lib/workflow-chain-expansion.ts:10-37`, from `1fe25017` 2026-07-05 #819) which the mirror
  (`openwop-examples:examples/hosts/in-memory/src/workflow-chain-expansion.ts`, 452 lines, last touched `25b5310`
  2026-08-06) never received — it still stringifies typed params. So the "gated" claim is true in the sense that a gate
  exists, and false in the sense that matters: the drift it exists to catch is present and unremediated. Not a
  compensation drift.
- Box 4 (`:81`) says the app's legs "record `blocked` until the pin reaches 1.133.0 — then this box is measured".
  The app pin is `^1.136.0` since `4dbc7e325` (#3315, 2026-08-17 13:20; `app:package.json:70`), so the box is now
  MEASURABLE, but nothing records a measurement: INTEROP-MATRIX `:281` still says "the two RFC 0157 chains record
  `blocked` until … ≥ 1.133.0" (suite 1.134.0), and no app doc cites `workflow-chain-host-expansion` after #3298
  (grep docs/adr, docs/steward → none). Stale-but-only-just.
- Box 5 (`:82`) correct: mirror has 0 `compensation` occurrences (grep). But it cannot be closed independently — the
  mirror first has to absorb the July drift, then `carryCompensation`.
- No Part V records; the acceptance boxes are the implementation record and are honest.

### 4. Implementation reality
- Corpus: schema mirrors + prose + `carryCompensation`/`expandChainWithCompensation` (`spec:conformance/src/lib/
  workflow-chain-expansion.ts`, 1102 lines) + `chain-compensation-expansion.test.ts` (11 legs `:129-259`, server-free)
  + two host-path legs (`workflow-chain-host-expansion.test.ts:268,307`, fixture pack 1.1.0). Level: server-free +
  local-live (app local strict 11/11 at 1.134.0 per INTEROP `:281`).
- App (ADR 0554 P2b, #3292 `1b2dd6fbb`): third, independent expansion core `app:src/host/workflowChainPackLoader.ts:1013`
  `expandChain` carrying `compensation`/`irreversibleEffect`/policy (`:117-197, 738-743, 971-990, 1058-1075`);
  witness `app:test/chain-compensation-carry.test.ts` (steps 3b/5b/6b/9b, both refusals, from-chain lane `:381-484`).
  Level: test-seam + local-live; the expand seam 404s in prod (`OPENWOP_TEST_SEAM_ENABLED=false`).
- In-memory reference host: OPEN on two counts (July WCP2 drift; no carry). SQLite host: no expansion surface at all
  (`grep -i chain examples/hosts/sqlite/src/server.ts` → audit-chain only). Confirms prior audit's host correction.
- Cross-language expansion vectors: none (`spec:conformance/vectors/` holds only `semantic-request-digest-v2.json`).
- Between `fa968b428` and `9b2af4839`: nothing in this area.

### 5. Roadmap bullet-by-bullet (`roadmap:330-342`)
- "Update every reference host to use the canonical compensation-carrying expansion core" — OPEN for the in-memory
  host (and blocked behind the WCP2 re-sync); N/A for SQLite/Postgres/Python hosts (no expansion surface); the app is
  a third core by design (zero-deps mirror rule does not apply to it) — the bullet should name which hosts.
- "Resolve the current SQLite/reference-host expansion drift" — FALSE-PREMISE on the host name (SQLite has no
  expander); TRUE for the in-memory mirror, and the drift is WCP2 typed-params, not compensation.
- "Exercise the live host expansion path without blocked or seam-only evidence" — UNMEETABLE-AS-PHRASED: RFC 0013
  defines no normative expansion endpoint; the only observation path is the §host-sample expand seam; the honest label
  is local-live/test-seam. Confirms prior audit.
- "Prove nested chains preserve node compensation, chain policy, irreversible markers, deterministic expansion" — OPEN
  as a single assertion; pieces exist (UQ2 leg `chain-compensation-carry.test.ts:363-380`; RFC 0133 composition tests)
  but no nested×compensation leg in the corpus.
- "Add cross-language expansion vectors" — OPEN; and it is the actual drift fix (a vector file makes the three cores
  comparable without a byte-diff).

### 6. Cross-artifact
- Depends on RFC 0013/0124/0133/0134/0135, RFC 0151 §B, policy schema. Depended on by ADR 0554 P2b.
- §A.1: additive, Accepted; nothing further is wire.
- Part III "Chain compensation drift | RFC 0157 | ADR 0554, ADR 0583 | live expansion and mirror parity": the mirror
  lives in `openwop-examples` and no app ADR can own it; the current red is RFC 0013 WCP2 drift owned by nobody
  (soak red 100+ runs, no roadmap row); ADR 0583 (vendoring freshness) is at best the app-side third-core parity
  owner. Row needs a protocol-side owner (RFC 0157 box 5 + the soak).

### 7. Defects & gates-that-cannot-fail
- **D-0157-1 (corpus/examples, P1, small): the drift gate is red for 100+ runs and, because it is step 4 of the SQLite
  soak job, every later step — the full strict suite (`conformance-soak.yml:113`) and the ONLY lane that runs
  `staleClaim`/`restart-during-run` (`:213-232`) — has not executed on main since at least 2026-08-09.** No other
  workflow runs those two scenarios (grep `.github/workflows` in both repos). A red that hides every other signal.
  Fix: port `WHOLE_VALUE_PATTERN` (`workflow-chain-expansion.ts:10-37`) into the mirror (+ `carryCompensation`),
  and move the drift guard to its own job so it cannot mask the suite.
- D-0157-2 (record, small): box 4 / INTEROP `:281` measurable since #3315, unmeasured.
- Cannot-fail: none new; the mirror legs (`chain-compensation-expansion.test.ts:129-146`) are real byte compares.

### 8. Verdict
Roadmap mostly accurate but names the wrong host, misreads the drift's content, and asks for an evidence level the
spec cannot supply. Artifact itself is honest; needs box 4 measured at ≥1.133 and box 5 sequenced after the WCP2
re-sync. Priority **P2** for the RFC, **P1** for the soak red because it silently disables the corpus's durability
witness (relevant to RFC 0162).

---

## Proposed RFC 0158 — Compensation Trigger Negotiation and Portable Recovery API

### 1. Premise check
"the current capability … cannot express that a host implements only a subset of the defined triggers. The app
currently accepts four trigger names while its production executor initiates only the node-failure path" — TRUE.
`capabilities.schema.json:3462-3495` has no trigger field; the app accepts all four (`app:src/host/compensationUnwind.ts:141-164`,
`COMPENSATION_TRIGGERS`) and initiates only from `executor.ts:2081` (no trigger arg → `node-failure`,
`compensationRuntime.ts:405`); the residue register says the same (`app:docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md:94`).
Confirms prior audit. But the premise's conclusion ("therefore a new RFC") does not follow: the honesty gap is closed
by making the host fire what it accepts (no wire), and the spec already contains a refusal rule the erratum can extend.

### 2. Existing owners (bullet → owner)
- `compensation.supportedTriggers` closed vocab — NEW; the vocabulary itself is `compensation-policy.schema.json:21-29`.
- "Prohibit advertising a trigger without behavioral evidence" — RFC 0147 §A req 3/5 (`0147…:44-46`) + RFC 0148 §A.
- Canonical read projections — RFC 0151 G9 (`compensation.md:442`), frozen.
- Portable recovery ops retry/substitute/waive/terminate — RFC 0151 §E (`compensation.md:346-369`) as outcomes; the
  endpoint family is G7 (`:441`), frozen; note §E's verb is "skip with justification", not "waive".
- Approval, SoD, principal binding, audit — §E "Authorization binding" (`compensation.md:326-334`), RFC 0049; SoD is
  NEW (host: ADR 0554 P3 `compensation-approval-sod.test.ts`).
- Optimistic concurrency / `planVersion` — §C (`compensation.md:181-184`) + §E substitution (`:363-369`); the
  `expectedState` CAS is host-local (ADR 0554 P3).
- Reason codes — DONE (`run-event-payloads.schema.json:4356`); retention — G5; redaction — §D/§G; replay — §F; fork — G4.
So 6/7 "normative decisions" are RFC 0151-owned; ~85% duplicate confirmed.

### 3. Genuinely new residue
`supportedTriggers` advert; SoD as a MUST; a refusal rule for a policy naming a trigger the host will not fire
(today `compensation.md:127-129` says an unlisted trigger does not START an unwind — silence about a listed-but-
unimplemented one; ADR 0554 declined to invent refusal, `AGRADE-WIRE-BLOCKED-RESIDUE.md:94`).

### 4. Wire/freeze/compat
`supportedTriggers`, the read projection and the endpoint family are all new optional wire → RFC 0147 §A.1
(`0147…:42`; R3/R9/R14 Open per `registers/0147…risks.md:12,18,23`). The trigger-honesty fix (fire what you accept)
is host-local; a one-line refusal erratum is arguably a safety-fix (a host must not accept a policy it cannot honour —
same principle as `capability_required`, `compensation.md:135-146`) and could clear §A.1 as "essential".

### 5. Recommendation
**DON'T author 0158.** (a) App first, no RFC: wire `run-cancel` in `host/runCancel.ts` (honouring `onParentCancel`),
`cap-breach` at both cap sites (`executor.ts:1651`, `:1676`) and at the sweeper/dispatch chokes (resolve the
definition via `resolveDefinitionForRun`), and `operator-request` for host-ext `start` gated on the policy — each
with a test whose sabotage (deleting the call) goes red; then `supportedTriggers` becomes negotiation sugar. (b) RFC
0151 erratum: "a host MUST refuse at registration a policy naming a trigger it does not fire" — acceptance test
registers a policy naming ONLY the unimplemented trigger and expects `validation_error`; red if the host accepts.
(c) After §A.1: an RFC 0151 revision landing G6/G7/G9 together (`compensation.md:439-442` already says so). Note the
proposed conformance line "an unadvertised trigger is refused" inverts `compensation.md:127-129` — a semantics
change, so it must be an erratum, not additive text.

---

## Proposed RFC 0159 — Fenced-Effect and Provider Idempotency Qualification

### 1. Premise check
"multi-region safety needs a certifiable effect-level profile, not merely record-reconciliation prose" — HALF-TRUE.
The effect-level contract already exists as normative prose AND vocabulary: `idempotency.md:261-310` (fencing token
MUST, stale-token rejection, `at-least-once-risk` classification, `fenced-effects` value in `capabilities.idempotency
.crossRegion`, `capabilities.schema.json`). What is missing is the WITNESS (RFC 0150 G4/G10, `registers/0150…gaps.md:8,15`),
not the profile.

### 2. Existing owners
- `fenced-effects` profile — RFC 0150 §D (`0150…:74-78`; `idempotency.md:286-296`) — a value, not a profile name;
  naming a profile beside it creates two spellings (RFC 0155 discipline).
- Monotonic tokens + stale-worker rejection — `idempotency.md:271-276`.
- Record vs effect authority separation — `idempotency.md:261-269`.
- Adapter classification — `at-least-once-risk` exists (`:278-284`); the 5-way taxonomy is NEW.
- Per-adapter evidence — RFC 0150 G4 ("closed qualification test").
- Ownership-record retention/recovery — RFC 0150 G5 (partly).
- Single/multi-instance/multi-region LEVELS — NEW, but they are durability levels → RFC 0162's territory (collision).
- Conformance list (partition, delayed/duplicate delivery, clock skew, lease expiry, stale owner, adversarial
  provider, timeout-after-commit, region recovery) — RFC 0150 Conformance (`:114`) + G10's "counting effect sink"
  resolution path already name these; none exist.
~70% duplicate confirmed.

### 3. Genuinely new residue
The adapter taxonomy; a per-adapter evidence obligation; the adversarial-provider fixture (a fake provider that
ignores idempotency) — which is RFC 0150 G4's own resolution path.

### 4. Wire/freeze/compat
A named `fenced-effects` PROFILE would be new optional wire under §A.1. The "safety-fix where an existing claim implies
unfenced safety" clause is FALSE-PREMISE: no host advertises `fenced-effects` or `reconciled-records` (RFC 0150 box 6,
`:143`; app pins absent `agrade-wire-blocked-residue.test.ts:232-244`; MyndHyve advertises none — INTEROP `:13`), and
RFC 0150 §D already removed `strict`.

### 5. Recommendation
**AMEND-RFC 0150 (§D annex + G4/G10), DON'T author.** Shape: (i) `idempotency.md` §"Fenced effects — qualification":
adapter classes, the evidence obligation, and the counting-effect-sink seam extension of `simulate-partition`
(`multi-region-idempotency-behavior.test.ts:6-14`); (ii) an adversarial provider fixture. Acceptance tests that can go
red: a `fenced-effects` advertiser MUST show ONE effect at the sink under a forced partition where a
`reconciled-records` host shows two (red if the fenced host shows two, or if the seam is absent under strict);
adversarial-provider leg red if a duplicate suppressed only by the provider is counted as fenced. Levels go to 0162.
Any ADR 0551 "implement RFC 0159 fencing" line (`roadmap:558`) is a from-scratch linearizable-owner build; nothing to
adopt.

---

## Proposed RFC 0162 — Durable Execution and Disaster-Recovery Qualification

### 1. Premise check
TRUE — the whole is a genuine hole. Zero occurrences of `RPO|RTO|disaster` in `spec/ RFCS/ schemas/ docs/`; zero
`outbox|redrive|poison` in `spec/v1/*.md` (grep). The durability contract the corpus DOES cite does not exist:
`production-profile.md:34` requires "`storage-adapters.md` lease and event-log invariants, including stale-claim
recovery", but `storage-adapters.md` (216 lines, last edit `4aa80535` 2026-06-11) contains no `claim|lease` at all;
`RFC 0009:149-150`, `staleClaim.test.ts:1-3` and `restart-during-run.test.ts:1-3` cite `storage-adapters.md
§"Claim acquisition"`, a section that **never existed** (`git log --all -S'Claim acquisition' -- spec/v1/storage-adapters.md`
→ empty; the citation dates from `5f098ffe` v1.0). `scale-profiles.md §"Replay semantics"` (`:101-107`), the other
cited home, says nothing about claims. And the only executable witness (`staleClaim`/`restart-during-run`, opt-in,
SQLite-only, `staleClaim.test.ts:36-42`) lives solely in the Conformance Soak, which has not reached that step in
100+ runs (D-0157-1). So `production-profile §Durability` is currently a MUST with no normative definition and no
executing witness. Confirms and extends the prior audit.

### 2. Existing owners
Admission durability — RFC 0150 §A (reclaim) + ADR 0549/0551 P1 (`app:src/routes/runs.ts:457` run+outbox one txn);
queue/outbox/lease/redrive/poison — RFC 0017 queue bus, RFC 0053 dead-letter (rejects auto-redrive,
`0053…:93`), RFC 0083 trigger bridge, ADR 0551 P1/P2 (`app:test/dispatch-outbox.test.ts:132-343`); multi-region —
RFC 0036 + 0150 §D; durable tasks — RFC 0100; workspace — RFC 0059; version skew — `version-negotiation.md:437`;
recovery audit events — check RFC 0154 telemetry before adding event kinds; profiles — RFC 0009/production-profile.

### 3. Genuinely new residue
RPO/RTO declaration; backup/restore verification; region evacuation; in-flight-run migration; a normative
claim/lease/heartbeat/reclaim contract (the missing §"Claim acquisition"); durable single-/multi-instance/
multi-region levels (absorbing 0159's); the crash matrix (kill after admission before dispatch; during checkpoint
commit; duplicate queue delivery; poison + exhausted redrive).

### 4. Wire/freeze/compat
New optional profiles → §A.1 unless argued essential. The argument writes itself: `production-profile.md §Durability`
is an existing MUST whose contract is undefined and unverifiable — repairing that is safety/essential; the DR
declarations are additive and can wait for R3/R9/R14 if needed.

### 5. Recommendation
**AUTHOR**, sequenced: (0) prerequisite editorial PR — write `storage-adapters.md §"Claim acquisition"` (claim,
heartbeat, TTL, stale reclaim, resume-on-startup — the contract `examples/hosts/sqlite/src/server.ts` and the app
already implement) so the three dangling citations resolve; and un-mask the soak (D-0157-1) so the witness runs.
(1) RFC 0162 proper: levels (absorb 0159's), admission durability, outbox/redrive/poison composed from 0017/0053/0083,
RPO/RTO/DR/evacuation/skew as declaration + runbook + evidence items (deployed-live/external-audit), recovery events
only if RFC 0154 lacks them. Acceptance tests that can go red: kill-after-201-before-dispatch → run still starts (red
if a run stays `pending`; the app already has the storage-level analogue `dispatch-outbox.test.ts:198`); duplicate
outbox delivery → one execution (`:224`); process-kill during checkpoint → resume without duplicate node effect (red
on a second provider call — needs a two-process harness, ADR 0551 P3); poison item → dead-lettered, not looped
(`:283`); `durable-multi-instance` advertiser under strict MUST execute the multi-process legs (red = `blocked` under
`OPENWOP_REQUIRE_BEHAVIOR`). Without a seam the profile is a gate that cannot fail — say so in the RFC.
Priority **P1 spec**; the roadmap's Part III "SLO and operations maturity → RFC 0162" row is wrong — SLOs/alerts/
runbooks touch no wire (ADR 0556 only).

---

## Corrections to prior audit
1. RFC 0150 "3 §F invariants unregistered" — CONFIRMED, and sharper: `idempotency-store-no-host-generated-keys` was
   announced as "New invariant" in `201e1c18` (#950) and never registered; acceptance box 6's "three new invariants"
   over-counts (2 exist). Prior audit did not flag the box.
2. RFC 0150 §A "canonical mismatch error" is undefined in the corpus (three codes in the wild) — NEW; prior audit only
   flagged the in-flight code.
3. RFC 0151: prior audit missed two live app wire defects — `compensationStatus: pending` on every completed run with
   a compensable node (D-0151-1) and unwind invoked from the live definition rather than the recorded plan
   (D-0151-2); plus `inputMapping` refs never resolved (D-0151-3) and ungated host-ext `start` (D-0151-4).
4. RFC 0151 "sole initiation executor.ts:2024" — line is now `2081`; and NEW since the prior audit: #3325
   (`9b2af4839`) put a terminal-status early return (`executor.ts:1941-1948`) ahead of the unwind, so a cancelled run
   never reaches `unwindTerminatedRun` at all. Prior audit predates this and should not be read as current on cancel.
5. RFC 0157 "Conformance Soak red 5/5 on exactly this drift" — CONFIRMED but under-stated: red for ≥100 consecutive
   runs back to at least 2026-08-09, and the drift is the July WCP2 raw-typed rule (#819), NOT compensation; because
   the guard is step 4, the soak has not run the strict suite or the multi-process durability scenarios since — which
   the prior audit's RFC 0162 section ("only staleClaim.test.ts exists — SQLite-only") did not connect.
6. RFC 0157 box 4 "blocked until pin ≥1.133.0" — pin is now `^1.136.0` (#3315); measurable, unmeasured. Prior audit
   listed it as blocked.
7. `storage-adapters.md §"Claim acquisition"` — CONFIRMED dangling; sharper: it never existed in any revision (git -S).
8. RFC 0151 acceptance box 6 ("no reference host … no compensation surface") is STALE for the app's storage-level
   ADVERSARY 1 witness — prior audit did not note the box.
9. Prior audit's "app already serves a host-local plan projection (operations/routes.ts:589-627)" — CONFIRMED (`:589`
   GET, `:637` POST actions).
10. Conformance quarantine — CONFIRMED EMPTY (`app:conformance/quarantine.json` `maxEntries: 0`, baseline
    2026-08-16 df03c3476/1.123.0); the brief's "conformance quarantine" has nothing to inspect.
11. Everything the prior audit said about #3324/#3325 relative to this slice: neither touches idempotency/compensation
    files except the #3325 finalize guard above (`git diff --stat fa968b428 9b2af4839`).
