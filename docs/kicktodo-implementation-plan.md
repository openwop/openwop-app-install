# KickTodo implementation plan — durable tracker

**Source docs:** `docs/kicktodo-prd.md` (twice-reviewed A−, findings folded via #2062) + ADRs 0412–0415 (all `Proposed`; each flips to `Accepted` when its first implementation PR merges).
**Program shape:** six workstreams, ~25–30 PRs to the Wave-1 exit gate. **No OpenWOP RFC** — host-private/additive throughout (PRD §17 triggers re-open that question).
**Process per phase (session goal):** `/architect` review before starting → implement → `/code-review` (+ `/ux-review` when a UI surface changed) → apply fixes → merge. At each ADR's completion: `/grade-code`, `/grade-ux`, `/grade-data` + fixes.
**Hygiene:** every PR from a fresh worktree off `origin/main`; explicit staged paths; DCO sign-off; commits cite ADR + phase; registry/manifest conflicts resolve append-mine; backend deploys before frontend.

## Status legend

`todo` · `in-progress` · `pr-open` · `merged (#NNNN)` · `blocked (<on what>)`

## Workstream A — Goals controller (ADR 0412) — CRITICAL PATH, strictly ordered

| PR | ADR phase | Ships | Status |
|---|---|---|---|
| A0 | P0 | Flag-off guard test (`OPENWOP_GOALS_ENABLED` unset in shipped deploy configs until P5) + corrected `discovery.ts` comment (claims "honored" — it is not) | merged (#2070) |
| A1 | P1 | Run-binding; verifier invocation vs opaque snapshot ref+hash; CAS judge-write (`putGoal` removed — ADR correction); `lastVerdict`; `satisfied/escalated`; host-private `GoalRow` sidecar + `toWireGoal` (wire schema is strict — ADR correction); **first slice of the typed service seam** (create/get/bindRun/evaluate) so WS-C can develop early; convergence + cross-tenant tests | merged (#2072) |
| A2 | P2 | Runtime bounds (iterations/cost/wall-clock) → `bound-exceeded`; exact-bound tests; cost attaches to contributing runs (`bindRun(runId, costUsd)` — OQ2 answered) | merged (#2075) |
| A3 | P3 | Content-free `host.goals.evaluated`/`host.goals.closed` via the ADR 0208 host bus (RFC 0086 §E namespacing; capability-gated emission; replay never re-emits) | merged (#2076) |
| A4 | P4 | Continuation arm/disarm via `scheduleDaemon` (one deterministic job per goal; consumer supplies workflow+cadence); real pause/resume arming; terminal paths disarm; `commitment` confirmed for the P5 drop; daemon integration tests | merged (#2077) |
| A5 | P5 | Principal ownership (uniform not-found, replay-leak-proof); surface completed; **honesty flip** — advert = exactly the honored set | merged (#2079) |

**ADR-complete gate after A5:** DONE 2026-07-18 — ADR 0412 = implemented; grade gate: code **A** / data **A−** / ux **N/A** (no UI surface); GOALS-1/2/4 fixed in the gate PR, GOALS-3 documented, GOALS-D2 CLOSED via KT-D1 (#2103). See docs/steward/CODEBASE-ASSESSMENT.md §KickTodo Goals Controller.

## Workstream B — Platform pre-work — parallel with A, independent PRs

| PR | Ships | Status |
|---|---|---|
| B1 | Kanban `createCard({cardId})` semantics — ALREADY BUILT (ADR 0311/GC-0311-1); pinned by `test/kanban-deterministic-card.test.ts` | merged (#2082) |
| B2 | Roster rename collision-checked mention handle (`PersonaCollisionError` → 409; case-insensitive, tenant-scoped, rename-path-only); AI-disclosure carried to C5 UI | merged (#2084) |
| B3 | `distributions/kicktodo.json` include-mode manifest (closure-gate-passing; backend builds under `OPENWOP_DISTRIBUTION=kicktodo`) | merged (#2085) |

## Workstream C — `kicktodo-core` (ADR 0414) — starts after A1 seam slice; merges gate on A5

| PR | ADR phase | Ships | Status |
|---|---|---|---|
| C1 | P1 | Package + REST + enrollment saga + supersession + bounded Today + collision test + wiring | merged (#2087) |
| C2 | P2 | KickBot provisioning saga — explicit heartbeat-off/review, fixed `host:kickbot`, rename continuity, welcome conversation, squat-conflict surfaced | merged (#2089) |
| C3 | P3 | Progress projection; frozen hash-verified evidence; freeze→judge→project; snooze/resume; replay observed | merged (#2090) |
| C4 | P4 | Packs, surface, chat tools, artifact types, builtinWorkflows, LLM-EXCHANGE row + parity tripwires | merged (#2091) |
| C5 | P5 | Today + Discover; React-free client; 4-locale i18n; nav (+ Canvas repair); ux-review fixes applied | merged (#2092) |

**ADR-complete gate after C5:** DONE 2026-07-18 — ADR 0414 = implemented; grade trio: code **A−** / data **B+** / ux **A−**; KT-2/KT-3 fixed in the gate PR; KT-D1 CLOSED (#2103); KT-1/KT-U1/KT-U2 CLOSED (polish batch). See docs/steward/CODEBASE-ASSESSMENT.md §kicktodo-core.

## Workstream D — Challenge Factory (ADR 0415) — D1 after C1 (`ChallengeDefinition` owner)

| PR | Ships | Status |
|---|---|---|
| D1 | Package + creator routes; risk classification; research spine (stub fail-closed); 3 factory nodes | merged (#2094) |
| D2 | Deterministic plan/day gates; `draftFromPlan`; schema drift-pinned; pack v1.2.0 | merged (#2095) |
| D3 | Versioned rights policy; `challenge-publish` approval kind; separation-of-duties completion (closes KT-R1); atomic idempotent publish | merged (#2096) |
| D4 | Monitor + kill switch (retire-preserving-active); Studio UI + personas → D5 (D4-UI) | merged (#2097) |
| D5 | First-batch content ops (24 candidates) — **code halves SHIPPED** (KTC-2 plan-generation node+workflow, KTC-3 Studio UI + simulation personas — kicktodo/d5-ktc2-ktc3); the content RUN stays **blocked (operator: real search/model/media providers + budget)** | code merged; run blocked (operator) |

**ADR-complete gate after D4:** DONE 2026-07-18 — grade: code **A−** / data **A−** / ux N/A (Studio = D5); **KTC-1 SSRF fixed in the gate PR** (monitor now rides guardedEgressFetch); KTC-2/KTC-3 recorded to D5; ADR 0415 = implemented for P1–P4 (P5 = Wave-3 gate by design). See docs/steward/CODEBASE-ASSESSMENT.md §Challenge Factory.

## Workstream E — Native client (ADR 0413) — parallel from day one

| PR | Ships | Status |
|---|---|---|
| E1 | **blocked (operator: Expo toolchain + real devices)** — the PRD (OQ10) mandates the identity decision be settled by a REAL-DEVICE spike, not assumed. PREPARED headless: the React-free `kicktodoClient.ts` (the ADR 0413 shared-contract layer) shipped in C5; the host surface it rides is complete (C1–C4) | blocked (devices) |
| E2 | blocked (E1 + device push credentials — APNs/FCM) | blocked (devices) |
| E3 | blocked (E2) | blocked (devices) |
| E4 | blocked (E3 + store accounts/signing) | blocked (operator) |

**ADR-complete gate after E4:** deferred with the stream — runs when the device-gated work lands.

## Workstream F — Wave 2–4 gates (author-then-build; NOT current work)

| Gate | Work | Status |
|---|---|---|
| F1 (Wave 2) | **ADR 0419 implemented — P1–P5 ALL MERGED** (#2114/#2115/#2117/#2118 + P5 web). Activation stays Wave-2-gated (toggle OFF) | complete (dark) |
| F2 (Wave 3) | **ADR 0420 implemented** — P1 #2112, P2 #2120, P3+P5 merged (challenge product type, revenue projection, surface/node); P4 vacuously satisfied (no executable challenge packs — falsifiable trigger recorded). Wave-3 ACTIVATION composes existing commerce-connect lanes | complete (dark) |
| **F3** | Integrations (ADR 0421 — calendar feed + write, wearable evidence, messaging routing) | ✅ **implemented** P1–P5 (PRs #2123 + kicktodo/0421-final); toggle `kicktodo-integrations` OFF |

## Workstream G — remaining-PRD ADRs (authored 2026-07-18; build order G1→G4)

| PR | ADR | Ships | Status |
|---|---|---|---|
| G1 | 0425 `kicktodo-engagement` | Opt-in leaderboard (k≥3), deterministic awards via a kicktodo-core check-in observer, variant-stamp experiments (P1–P5) | merged (#2130, #2131) |
| G2 | 0426 `kicktodo-community` | Approval-gated creator profiles, proof-gated one-per-buyer reviews, counts-only analytics, Discover rating k-floor (P1–P5) | merged (#2132, #2133) |
| G3 | 0427 chain-pack signing | `verifyPinned` in `workflowChainPackLoader.ts` + `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES` fail-closed posture; un-vacuates ADR 0420 P4 (P1–P2) | merged (#2134) |
| G4 | 0428 `kicktodo-organizations` | Org libraries (accessControl-composed), org cohorts (0419 primitive), brand ref, k≥5 computed-on-read reports (P1–P5) | merged (#2135 + kicktodo/0428-p4p5) |

**Gating:** G3 MUST be enforced (flag set) before any third-party executable challenge opens. Operator register unchanged: D5 (providers+budget), E1–E4 (devices/stores), pt/es content ops, wave-activation toggles + Stripe registrations, and the dark-backlog deploy.

## Workstream H — PRD-gap closure (authored 2026-07-19 after a full PRD⇄code audit)

Gaps found by diffing the PRD against merged code — the architecture is complete; these are named PRD requirements with no implementation.

| PR | ADR / item | Ships | Status |
|---|---|---|---|
| H1 ✅ | **0429** plan flexibility | Publisher-declared `alternatives[]` + Substitute on Today; per-challenge `missedWindowPolicy` (`skip` default keeps every published version valid); deterministic recovery ids (P1–P5) | merged (kicktodo/0429-p1p2) |
| H2 ✅ | **0430** content localization | `contentLocale` + `translationOf` sibling-version lineage; Discover negotiation independent of UI locale; inherited rights/evidence/risk (P1–P5) | merged (kicktodo/0430-locale) |
| H3 ✅ | **0431** paid cohort seats | Seat products + TTL holds on the capacity CAS (reserve→pay→confirm), refund releases seat, history preserved (P1–P5) | merged P1-P3+P5 (kicktodo/0431-seats); **H3-P4 SHIPPED** (kicktodo/d-seat-purchase) — deferral withdrawn: the buyer route already keys off productId, so a coach-shared link suffices and no marketplace is invented |
| H4 ✅ | **0432** `kicktodo-metrics` | §15 metrics as computed-on-read projections + sampled verifier FP/FN via an approval kind; counts-only, k≥5 (P1–P5) | merged P1-P3+P5 (kicktodo/0432-metrics); **H4-P4 metrics page SHIPPED** (kicktodo/c-metrics-page) — the deferral was withdrawn: no charting primitive exists, so a captioned table IS the accessible representation |

**Non-ADR deliverables from the same audit (tracked so they are not lost):**

| Item | What | Owner / shape | Status |
|---|---|---|---|
| H-DOC1 | **Threat model** for journals, accountability grants, public catalog, AI safety (PRD §12 Wave-0 line) — the mitigations are built + test-pinned; the ANALYSIS ARTIFACT does not exist | `docs/kicktodo-threat-model.md` (doc, not an ADR) | todo |
| H-DOC2 ✅ | **Delegation-record completeness** (PRD §13 AI: parent named-agent + specialist identity/version + budget + merge decision). NOTE the name collision: `host/approvalDelegations.ts` is APPROVAL delegation (act-on-my-behalf), a different concept. The real owner is `host/agentDispatch.ts` (`AgentDispatchRequest`/`Result`) — this is a small **host-seam extension**, not a KickTodo feature | **ADR 0433** — `provenance` on the dispatch request/result, echoed verbatim (kicktodo/e-delegation, #2150) | done |
| H-CHORE1 ✅ | **Manual-test suites** for the G-wave + circles + Studio (PRD §14: "manual test pages cover every feature even while toggled off"); `suites.ts:1046` covers ADR 0414 only | `frontend/react/src/features/manual-tests/suites.ts` — 5 suites + 3 cases (#2148) | done |
| H-CHORE2 | KTG-3 route-level cookie-jar HTTP tests (engagement/community/org-programs) — from the grade gate | `docs/steward/CODEBASE-ASSESSMENT.md` | todo |
| H-CHORE3 | KTD-1 feed-token teardown sweep (hash-keyed rows the tenant purge can't prefix-match) | `docs/steward/DATA-ASSESSMENT.md` | todo |
| H-VERIFY | Live gates unverified: CT-KT1..4 click-through (light+dark, mobile) and the §14 p95 Today target (1.5s @ 10 enrollments) | needs an authed live pass | todo |

**Unchanged operator register:** the D5 24-candidate content RUN (providers+budget), E1–E4 native client (devices/stores), Wave-0 brand/PWA/universal-link/legal bundle, wave-activation toggles + Stripe registrations, `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES` before third-party executable challenges.

## Session outcome (2026-07-18 — the /goal run)

**21 merged PRs** (#2065, #2070–#2099 KickTodo subset). ADR 0412 **implemented** (goals controller, A0–A5 + grade gate). B-stream complete. ADR 0414 **implemented** (kicktodo-core C1–C5 + grade gate — **CORRECTED 2026-07-19 (KTFULL-B4/B5/TD7):** the participant loop's SERVICES work end-to-end in tests, but the built-in workflows are not executable as composed (no declared `variables[]`, mismatched node output/input names) and the daily continuation is never armed (`armContinuation` has no production caller). Treat the loop as service-complete, NOT runtime-complete). ADR 0415 **implemented P1–P4** (factory research/plan/rights/publish/monitor with every trust gate deterministic + fail-closed; grade gate incl. the KTC-1 SSRF fix). Every phase not merged is **blocked with a named owner**: D5 (real providers + budget), E1–E4 (devices/stores), F1–F3 (wave gates). Wave-1 exit blocker KT-D1: **CLOSED**.

## Milestones

- **M1 — Wave-0 exit (PRD §12):** readiness green with real providers; factory produces + safely replays one candidate; one enrollment runs plan-approval → schedule → check-in → frozen evidence → verifier → replay. Needs A0–A5, B1–B3, C1–C4, D1–D3.
- **M2 — Wave-1 exit:** a user completes a multi-week challenge without operator intervention; retries/replay/payment idempotent. Adds C5, D4–D5, E1–E2, first-party Commerce checkout.

## Standing risks (watch every PR)

Goals flag flipped early (A0 guard) · plan-revision duplicate cards (C1 test) · KickBot heartbeat inherit (C2 test) · stub content published (D1/D3 fail-closed) · `DurableCollection.list()` scans + pool budget (poolMax×maxScale ≤ ~22) · Today read fan-out vs per-IP rate limit (one aggregate endpoint) · two-UI drift (E1 shared packages are the single behavior source) · parallel-session registry conflicts (append-mine).
