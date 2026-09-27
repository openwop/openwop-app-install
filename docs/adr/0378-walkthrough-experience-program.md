# ADR 0378 — Walkthrough experience program: steps panel, HITL beacon, per-user progress, instrumentation packs

Status: implemented (2026-07-16/17) — P1 #1909 (correctness sweep + the recorded-
drafts-invisible fix), P2a #1911 (steps panel + def-derived position), P2b #1913
(HITL beacon), P3 #1915 (per-user progress — the resume-hijack fix — + run-derived
funnels), P4 #1919+#1920 (packs: chat/agents/workflows/runs/keys — ALL five P0
blocker manual-test cases backed; tutorial "Show me" 1→3 steps), P5 #1917
(check-orphan-classes gate, red-on-seeded-orphan verified).
Deferral RESOLVED (2026-07-17, follow-up PR): the FUNNELS pack shipped
(anchors + funnels.page.view + walkthrough.funnels.list, backing the
build-your-first-funnel tutorial step 3.1 "Create the funnel"), plus a MODELS
pack (models.page.view, backing connect-your-ai 3.1) — tutorial "Show me"
coverage is now 5 steps across 3 tutorials. Honestly NOT backable (recorded,
not faked): the open-your-storefront tutorial — the storefront is a PUBLIC
per-workspace URL (/store/<workspace>) outside the app shell, and the commerce
admin is API-only ("no dedicated page", its own suite's words); the funnel
tutorial's remaining steps target the CMS/commerce editors — instrumenting
those editors is real per-surface work for whoever owns them next. OQ1 resolved: localStorage-remembered. OQ2 resolved: server-side
aggregation. OQ3 resolved: chat→agents→workflows/runs→keys shipped; funnels deferred.

Date: 2026-07-16
Lane: **extension of the existing `walkthroughs` feature** (ADR 0368/0374/0376) — NO new
feature package, NO new toggle. P4's per-surface action packs live in their owning
features and register into the ONE walkthrough action registry (the campaign-brief
precedent, `features/campaign-brief/routes.tsx:38`).
RFC verdict: **host work only, no RFC.** Everything here is FE chrome, host-ext routes
(`/v1/host/openwop-app/walkthroughs/*`), the host-local action registry, and a
host-ext data-shape change. The one wire-adjacent read (the steps panel fetching
`GET /v1/workflows/{id}`) uses the EXISTING spec endpoint (`routes/workflows.ts:125`,
`operationId=getWorkflow`) — consuming an already-normative read adds nothing to the wire.

## Why

A three-scout architecture deep-dive (2026-07-16) of the walkthrough engine concluded:
the **core is best-in-class** — a walkthrough is a durable workflow whose steps suspend
with interrupts; the run IS the state (pause/resume/reload/cross-tab free); semantic
`data-walkthrough` anchors + the action registry beat industry CSS-selector rot
(Pendo/WalkMe's #1 failure mode); checkpoints make divergence honest; record→AI-enrich→
transient-draft→promote out-governs commercial no-code authoring. **The gaps are all
presentation + instrumentation:**

1. **No step position anywhere** — the interrupt payload carries no index/total; the FE
   player has no lookahead (only the current step, `useWalkthroughPlayer.ts:205`) and no
   client for `getWorkflow`. "Step 3 of 7" and a step list are impossible today.
2. **HITL is under-signaled** — "Your turn" lives only in the bottom caption chip; the
   element the user must touch carries no affordance (industry: pulsing hotspot/beacon).
3. **Progress is tenant-level and binary** — `progressStore.ts` has no userId and only
   `started|completed`; per-user onboarding ("you haven't done the intro walkthrough")
   and step-level drop-off funnels can't exist.
4. **The content bottleneck**: the entire app registers **4 actions + 1 checkpoint**
   (Campaign Studio only). 199 manual-test cases and 30 of 31 tutorial steps have no
   walkthrough because their surfaces have no semantic actions — the engine is a highway
   with one on-ramp.
5. **Correctness residue** (found in the same review): synthesis still emits legacy
   `ui.tour.step` typeIds + `tour.recorded.` ids (`walkthroughSynthesis.ts:20,49`); the
   "I did it" button resolves via a second path that bypasses the player's
   `interrupt_not_found` tolerance (`WalkthroughOverlayHost.tsx:138` — the exact race
   class #1886 fixed); scripted `verb:'select'` falls through to `el.click()`.
6. **The CSS-orphan incident** (fixed #1905): the 0376 rename orphaned the overlay's
   entire stylesheet and NO gate could catch a className↔selector mismatch.

## Boundaries & pre-existing-surface audit

| Concept | Single owner (compose, never fork) |
|---|---|
| Semantic actions/checkpoints | `walkthroughs/actionRegistry.ts` — P4 packs register INTO it from their owning features (lazy, the campaign-brief idiom) |
| Player state | the durable run + `useWalkthroughPlayer` — the steps panel READS player state; it never becomes a second state owner |
| Overlay chrome | `WalkthroughOverlayHost` — the steps panel mounts INSIDE it (lives/dies with the walkthrough) |
| Progress | `progressStore.ts` (`walkthrough-progress` collection) — P3 changes its key shape in place; no second store |
| Step analytics | **the run's own interrupt history** — funnels derive from run events; NO new analytics store (see Decision 4) |
| Right-drawer visuals | `.notifpanel-*` geometry (`global.css:7419-7432`) — copied, with the Modal-semantics carve-out below |
| Workflow-def read | existing `GET /v1/workflows/{id}` — new thin FE client wrapper only |

Route collisions: none — no new backend routes except none at all in P1/P2; P3 extends
the existing progress routes' payload. Toggle: `walkthroughs` (existing, ON in prod via
the migrated canary row).

## Decisions

### 1. P1 — correctness sweep (small, ships first)
- Synthesis emits `ui.walkthrough.step`/`.checkpoint` + `walkthrough.recorded.` ids +
  `metadata.walkthrough` (the aliases keep old drafts alive; new artifacts stop minting
  legacy ids).
- The "I did it" button resolves through a `player.confirmHitl()` hook API — ONE resolve
  path with the #1886 race tolerance; the component stops reading the hook's
  sessionStorage key directly.
- `performStep` gains an explicit `select` branch (native value setter + `change` event);
  a scripted select no longer silently clicks.
- `run.metadata.guidedTour` is **kept and documented as a held persisted key** (chat-feed
  scoping reads it; renaming a run-metadata key buys nothing user-visible — the ADR 0376
  held-value discipline).

### 2. P2a — step position + the steps slideout panel
- **Position**: at launch/re-attach the player fetches the def once (new
  `workflowsClient.getWorkflow(id)`) and derives `{index, total}` by matching the open
  interrupt's `nodeId` against the def's node order. No payload/schema change, works for
  hand-authored and legacy defs alike. The caption chip gains "Step n of m".
- **The panel**: a right slideout listing every step (narration, HITL badge,
  done/current/upcoming state) + the walkthrough controls. Visually it mirrors
  `NotificationPanel` (400px right dock, mobile full-bleed, motion tokens,
  `--ease-enter`/`--dur-enter`), **but it does NOT compose `ui/Modal`**:
  **⟶ Correction to DESIGN.md:287** ("edge-docked panels ride ui/Modal, never hand-roll
  a role=dialog"): `ui/Modal` hard-codes `useFocusTrap` + `aria-modal` + Escape-close —
  all three are WRONG here. A walkthrough requires the user to interact with the PAGE
  (HITL steps); trapping focus in the panel breaks the product. The steps panel is a
  **non-modal `role="complementary"` region** mounted inside `WalkthroughOverlayHost`
  (z-index 1001, above the overlay's 1000), toggled from the caption bar, no scrim of
  its own (the walkthrough scrim already owns the page). Escape keeps its existing
  meaning (pause the walkthrough — `WalkthroughOverlayHost.tsx:83`). DESIGN.md gets a
  carve-out note: *modal drawers ride ui/Modal; non-modal companion panels inside an
  interaction layer (walkthrough steps) implement the visual pattern without the dialog
  semantics.*
- Collapsed by default on mobile (the caption bar remains the primary chrome ≤719px).

### 3. P2b — the HITL beacon ("quiet = watch, pulse = act")
A `.walkthrough-beacon` accent-hue pulsing ring rendered at the target **only while
`waiting-user`**; scripted steps keep the calm spotlight. Pure CSS animation from motion
tokens; `prefers-reduced-motion` ⇒ static double-ring (the universal reduce block +
an explicit guard, the `.notifpanel-tab` idiom). Disappears the instant `hitlComplete`
fires. No color literals — the peer-hue/token discipline.

### 4. P3 — per-user progress + honest funnels
- **Progress key becomes `tenantId:userId:walkthroughId`** (userId = the authed
  session's durable subject, stamped server-side; never client-supplied). Old
  tenant-level rows stay readable as tenant-fallback (dual-read union, user rows win);
  **no destructive migration** — the ADR 0376 copy-don't-move discipline. The
  resume-or-restart probe (`useWalkthroughPlayer.ts:250`) narrows to the caller's own
  rows, fixing a real latent bug: today ANY tenant member's in-flight run hijacks every
  other member's launch of the same walkthrough.
- **Step funnels derive from run interrupt history** — the runs already record every
  step (interrupt created/resolved timestamps). A small read-only aggregation on the
  `/walkthroughs` page ("n started, drop-off by step") over recent runs. **No new
  analytics store**; the ADR 0371 retention window (30d) bounds the funnel horizon and
  that limitation is displayed honestly in the UI.

### 5. P4 — instrumentation packs (the content program)
Per-surface `walkthroughActions.ts` in each owning feature (chat, agents,
workflows/runs, keys/BYOK, funnels — the top-5 by manual-test priority), lazy-registered
from the feature's `routes.tsx` (the campaign-brief idiom, incl. the lazy-import
bundle-budget guard). Each pack lands with: `data-walkthrough` anchors, actions +
checkpoints, a conventions test row, and **walkthroughId wiring into the P0/blocker
manual-test cases + the matching tutorial steps** (the `walkthroughId?` fields and
Play/"Show me" buttons already exist and render conditionally — content-only wiring).
Manual tests are BACKED, never replaced: the walkthrough drives, checkpoints assert the
machine-checkable, the human still records pass/fail on visual judgments (HITL confirm).

### 6. Gate — `check-orphan-classes`
A build-gate script cross-checking feature-prefixed classNames (`walkthrough-*`,
`notifpanel-*`, `netpanel-*`, …) emitted in `.tsx` against selectors present in
`global.css`/`brand.css` — the #1905 bug class becomes unshippable.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Extension — backend `features/walkthroughs/`, FE `src/walkthroughs/`; P4 packs in their owning features (registry inversion, no cross-feature imports) |
| 2 | Toggle | `walkthroughs` (existing; ON in prod). No new toggle; the steps panel + beacon ride it |
| 3 | `ctx.<feature>` | Existing read-only `ctx.features.walkthroughs` unchanged; `walkthroughProgress()` gains the per-user shape (additive fields) |
| 4 | Node pack | None new — `ui.walkthrough.*` nodes unchanged (position derived client-side, no config change) |
| 5 | Envelopes | None — the Tour Author agent tool (ADR 0368 P6c) is unchanged |
| 6 | Agent pack | None new |
| 7 | Public surface | None |
| 8 | RBAC | Progress routes stay toggle+tenant gated; userId stamped from the session server-side (never trusted from the client); funnel reads are tenant-scoped run reads |
| 9 | Replay/fork | Untouched — position derivation is read-only; legacy typeId/kind aliases (ADR 0376) unaffected; `guidedTour` run stamp held |
| 10 | Frontend | Steps panel (non-modal, tokens, a11y: `role=complementary`, aria-current on the active step, live-region reuse), beacon (reduced-motion), Step n/m chip; 4-locale i18n parity |

## Alternatives weighed
- **Steps panel composes `ui/Modal`** — rejected: focus trap + aria-modal break HITL
  (the user must reach the page). The visual pattern is mirrored; the dialog semantics
  are deliberately not.
- **Stamp stepIndex/total into node config at synthesis** — rejected: hand-authored and
  pre-existing defs would lack it; def-fetch derivation covers every def with one read.
- **A new step-analytics store** — rejected: the run history already records every
  step; a second store would drift (single-source-of-truth). Retention bounds accepted.
- **Renaming `guidedTour`/`tourId` run+wire stamps in P1** — rejected: persisted keys,
  zero user benefit (the ADR 0376 held-value rule).
- **Converting manual tests INTO walkthroughs (deleting the checklist)** — rejected:
  a manual test's essence is human judgment; walkthroughs drive + assert, humans judge.

## Open questions
- OQ1: does the steps panel persist collapsed/expanded per user (localStorage) or reset
  per walkthrough? (Default: remember, localStorage — access-hub posture.)
- OQ2: funnel aggregation server-side (one host-ext read) vs client-side over
  `listRuns`? Default server-side to avoid N+1 run fetches (rate-limit budget).
- OQ3: P4 surface order — proposed chat → agents → workflows/runs → keys → funnels by
  manual-test P0 density; maintainer may reorder.

## Phased plan
| Phase | Scope | Gate |
|---|---|---|
| 1 | Correctness sweep (synthesis ids, ONE resolve path via `player.confirmHitl`, select verb, docs for held keys) | backend+FE tests green; /code-review |
| 2a | `getWorkflow` FE client + position derivation + Step n/m chip + steps panel (non-modal, DESIGN.md carve-out note) | FE build + /ux-review + /code-review |
| 2b | HITL beacon + reduced-motion + tokens | FE build + /ux-review |
| 3 | Per-user progress key (dual-read, server-stamped) + run-derived funnels on /walkthroughs | backend vitest (key-shape + hijack-fix tests) + /code-review |
| 4 | Instrumentation packs ×5 surfaces + walkthroughId wiring (P0/blocker cases + 2 tutorials) | per-surface conventions tests; /ux-review per surface |
| 5 | `check-orphan-classes` gate | gate red on a seeded orphan, green on main |
