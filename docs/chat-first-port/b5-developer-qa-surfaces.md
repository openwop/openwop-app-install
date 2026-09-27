# B5 — Developer & QA surfaces — chat-first port review

**Scope resolved:** backend `features/{developer-tools, developer-keys, manual-tests, walkthroughs}`
+ frontend `features/{manual-tests, tutorials}` + the walkthrough player (`frontend/react/src/walkthroughs/`)
+ the developer-tools inspectors (`chat/EnvelopeInspector.tsx`, `devtools/NetworkPanel.tsx`).
Single-feature mode, read-only audit.

**Headline:** this unit already rides the engine. `walkthroughs` is a reference-grade
chat-first implementation — a walkthrough *is* an ordinary workflow, playing it is
`createRun` + SSE + `resolveByRun`, every HITL step is a real suspend/interrupt, and
authoring already routes through the ONE chat + a `registerFeatureAgentTool` tool on the
ADR 0315 default-on baseline. **No PARALLEL and no THEATER anywhere.** The only substantive
gap is that `developer-keys` (a fully-wired, auth-executed credential capability) has **no
management surface at all** — a deferred page, not something bespoke to demolish.

---

## Verdict table

| # | Capability | Today | Verdict | Port target / note |
|---|---|---|---|---|
| 1 | `developer-tools` toggle gates the inspectors + `/test` nav | route-less feature; toggle only (`developer-tools/feature.ts:23-37`) | **RIDES** | Rides the feature-toggle system; demo-aware default. Leave. |
| 2 | Envelope (wire-shape) inspector | read-only per-turn viewer (`chat/EnvelopeInspector.tsx`) | **PAGE-LEGIT** | Read-only provenance. Keep. |
| 3 | Network inspector | read-only call log (`devtools/NetworkPanel.tsx`) | **PAGE-LEGIT** | Read-only status. Keep. |
| 4 | Issue a scoped `owk_` API key (shown once) | `POST developer-keys` (`developer-keys/routes.ts:51-65`) → `issueApiKey` (`apiKeyService.ts:60-84`) | **RIDES** (UI **deferred**) | Rides `mintToken`/`hashToken` capability-token primitives (`apiKeyService.ts:13,68`). **No frontend surface exists** (grep `owk_`/`developer-keys` in `frontend/react/src` → 0 hits). See Gap 1. |
| 5 | List a caller's keys | `GET developer-keys` (`routes.ts:44-49`) → `listApiKeys` (`apiKeyService.ts:52-57`) | **RIDES** (UI deferred) | `keyScopeOf` self-service/admin scope (`routes.ts:35-39`). No UI. |
| 6 | Revoke a key (IDOR-safe 404) | `DELETE developer-keys/:id` (`routes.ts:67-76`) → `revokeApiKey` (`apiKeyService.ts:104-111`) | **RIDES** (UI deferred) | Scoped, fail-closed. No UI. |
| 7 | Verify a presented `owk_` bearer (auth seam) | `verifyApiKey` (`apiKeyService.ts:118-138`) wired into `middleware/auth.ts:610-611` + `entities/routes.ts:119` | **RIDES** | The capability is fully executed (not theater — the verifier runs in core auth). Leave. |
| 8 | Run a manual-test suite; mark pass/fail/blocked/skip; notes; durable per-user | `/test` runner (`manual-tests/ManualTestsPage.tsx:147-314`) + host-ext store (`manualTestsService.ts`) | **PAGE-LEGIT** | A human reads steps and records outcomes — a QA tool, not an intent conversation. Structural self-scoped store (`manualTestsService.ts:36,49-60`); no platform owner for "QA runs" to shadow. Keep. |
| 9 | Copy run log → Markdown for `docs/steward/MANUAL_TESTS.md` | `copyRunLog` (`ManualTestsPage.tsx:186-200`) | **PAGE-LEGIT** | Read-only export. Keep. |
| 10 | Launch a walkthrough from a test case | `requestWalkthroughLaunch` (`ManualTestsPage.tsx:265`) | **RIDES** | Rides the player bus → `createRun`. Leave. |
| 11 | Browse + read data-driven tutorials; per-step local progress | `TutorialsPage.tsx` (card list + renderer; localStorage `useTutorialProgress:22-45`) | **PAGE-LEGIT** | Documentation/reference; content is authored data, one renderer. Local checkbox progress shadows no owner. Keep. |
| 12 | "Show me" launches the backing walkthrough | `requestWalkthroughLaunch(step.walkthroughId)` (`TutorialsPage.tsx:168`) | **RIDES** | Rides the player. Leave. |
| 13 | Play a walkthrough = run its workflow, SSE, resolve steps | `useWalkthroughPlayer.launch` → `createRun({workflowId})` (`useWalkthroughPlayer.ts:350-357`), `subscribeToRun` (288), `resolveByRun` (80-88) | **RIDES** | A walkthrough is an ordinary `WorkflowDefinition` (`walkthroughNodes.ts:53-76`). Reference-grade. Leave. |
| 14 | HITL step / checkpoint honesty | step suspends w/ `walkthrough-step` interrupt (`walkthroughNodes.ts:61-75`); failed checkpoint ⇒ `cancelRun` (`useWalkthroughPlayer.ts:177`) | **RIDES** | Rides the real interrupt/resume primitive; the spotlight overlay is a purpose-appropriate *renderer* (not a second chat). Leave. |
| 15 | Record a walkthrough (capture semantic actions) | `walkthroughRecorder.ts` (capture-phase listener, no PII) | **ADAPTER** | Bespoke capture, but output flows through the SAME builder `POST /workflows` path (`walkthroughSynthesis.ts:77-85`). Thin + honest. Watch for drift. |
| 16 | Synthesize → save transient draft | `synthesizeWalkthrough` + `saveRecordedWalkthrough` (`walkthroughSynthesis.ts:40-85`) | **RIDES** | ADR 0369 transient lifecycle via the builder route; no parallel registration. Leave. |
| 17 | Enrich with AI | `stageComposerDraft(...)` → nav `/` (`WalkthroughOverlayHost.tsx:239-249`) | **RIDES** | Routes the recording into the ONE chat (ADR 0058) — explicitly "never a bespoke AI panel." Leave. |
| 18 | `walkthroughs.register-draft` agent tool | `registerFeatureAgentTool` (`walkthroughAuthorTool.ts:33-103`); on the default-on baseline (`agentToolAllowlistService.ts:75`) | **RIDES** | Validates DAG, transient lifecycle, ownership; run-once promote is the OQ5 human gate. Leave. |
| 19 | Archive / manage owned walkthroughs | `archiveWorkflow` (`WalkthroughsPage.tsx:65-76`) | **RIDES** | The workflows-dashboard remove verb. Leave. |
| 20 | Walkthrough funnel stats | `GET walkthroughs/funnel` (`feature.ts:150-188`), on-demand FE (`WalkthroughsPage.tsx:22-47`) | **PAGE-LEGIT** | Derived from the runs the engine already records — no second analytics store; window stated honestly. Keep. |
| 21 | Progress store + cross-tab resume | `progressStore.ts` (per-user keyed) + resume in `launch` (`useWalkthroughPlayer.ts:333-349`) | **ADAPTER** | Own small store, but resume rides the durable run; `runId` dangle is deferred honestly (`progressStore.ts:15-24`). Watch. |
| 22 | `ctx.features.walkthroughs` read surface | `buildWalkthroughsSurface` (`surface.ts:29-55`) | **ADAPTER** | Thin, read-only (list + progress); no imperative launch (honest deferral, `surface.ts:4-8`). Leave. |
| 23 | Builtin page-spotlight walkthroughs (test infra) | 25 one-step defs (`feature.ts:55-79,100`) | **RIDES** | Real runs via the player; unknown action ⇒ `needs-update` (honest). Leave. |

**VERDICTS: R=14  A=3  P=0  T=0  PL=6**

---

## Blockers (from scouting) — each with the honest alternative

**None that block a port** — this unit is not mid-port, it is largely already there. Two
scouting facts worth pinning as design constraints for anyone who touches it:

- **The action registry is FE-only**, so the host cannot validate `actionId`s in
  `register-draft` (`walkthroughAuthorTool.ts:44-49`). Honest alternative already in place:
  the OQ5 run-once promote gate — an unknown id `needs-update`s at play time, the run can't
  complete, promotion is blocked. Do **not** add a host-side actionId check; it can't see
  the registry. Keep relying on the play-time gate.
- **Walkthrough interrupts are resolved by the player overlay, not the reviews inbox.**
  That is correct, not a parallel HITL: the interrupt is the canonical primitive
  (`resolveByRun`), and a full-screen guided overlay is the right *renderer* for a
  "watch-me / your-turn" step. Don't try to force walkthrough steps into chat interrupt
  cards — the spotlight geometry is the point.

---

## Gaps (deferred honestly, not theater)

**Gap 1 — `developer-keys` has no management surface (rows 4-6).** The routes, scoping,
issuance, revocation, and the auth-path verifier all work and are exercised
(`middleware/auth.ts:610`), so this is a **missing UI, not theater**. Port target, in
priority order of honesty:
- **Preferred: a small PAGE-LEGIT keys page** — list + issue-once (copy-the-token modal) +
  revoke — because issuing/revoking a scoped credential is a *decision/structural* act, not
  an "describe intent" one. Model it on the existing credential surfaces; reuse
  `keyScopeOf` verbatim so the page and routes share one predicate (authority-parity).
- **Optional add-on: a thin agent tool** `openwop:developer-keys.issue` / `.revoke` that
  **shares `keyScopeOf`** (one helper, route + tool both call it; issue fails typed without
  an acting user) — only if there's demand for "mint me a scoped key" in chat. Not required.
- Until then, mark it deferred-visibly in FEATURES/docs — do **not** paint a keys page that
  reads nothing.

**Gap 2 (enhancement, low priority) — no chat-driven walkthrough launch.** All launches are
button-only via the bus (`walkthroughBus`). A "show me how to X" ask can't currently drive a
walkthrough. If wanted: a thin `openwop:walkthroughs.launch` intent that the FE player
consumes (the launch is a client act, so this is an envelope/FE-bus hop, not a server run
starter). Optional — the walkthrough catalog is already agent-discoverable as workflows.

---

## Demolition list (with regression pins to add)

Nothing to demolish — no bespoke surface substitutes for a primitive here. The one thing to
**keep from regressing**:

- **Enrich-with-AI must stay a `composerSeed` → ONE-chat path**, never a resurrected bespoke
  AI panel (the removed `AiAuthorPanel` precedent). Pin: `enrichPromptParity.test.ts` already
  exists (`walkthroughs/__tests__/`); keep it, and if a keys page lands, assert no second
  "talk to AI" textarea is introduced for key issuance.

---

## New-code inventory (small)

1. `developer-keys` keys page (list/issue/revoke) reusing `keyScopeOf` + the credential-modal
   pattern — the only real net-new surface.
2. (Optional) `openwop:developer-keys.issue|revoke` agent tools sharing the route predicate.
3. (Optional) `openwop:walkthroughs.launch` FE-bus intent.
No new stores, no new workflows, no new envelope kinds.

---

## Phased plan (gated on `npm run ci` + `/code-review` + `/ux-review`)

- **Phase 1 — close Gap 1 (page):** build the keys management page against the existing
  routes; share `keyScopeOf`; token-shown-once modal; empty/error states. Gate: build +
  vitest green, ux-review on light/dark, authority-parity check (page ⇔ route ⇔ tool).
- **Phase 2 (optional) — chat reach:** add the key issue/revoke agent tools if demanded;
  add the walkthrough-launch intent. Gate: allowlist test + acting-user fail-typed test.
- **No demolition phase** — nothing bespoke to remove.

---

## Deferred honestly

- `developer-keys` UI (Gap 1) — deferred, backend fully functional via API today.
- `ctx.features.walkthroughs` imperative launch — deliberately not built (a backend run has
  no live FE player; `surface.ts:4-8`).
- Legacy hashidx pointers without `tenantId` — lazy-healed, backfill tracked not run
  (`apiKeyService.ts:33-39,131`).
- Progress `runId` dangle after retention sweep — 404-gated resume, accepted
  (`progressStore.ts:15-18`).
