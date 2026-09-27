# ADR 0489 — Adaptive walkthroughs: the `already-satisfied` checkpoint + the anchor coverage ratchet

Status: **implemented** (P1–P5, 2026-07-25)

## Implementation record

| Phase | Shipped | Evidence |
|---|---|---|
| **P1** | `CheckpointVerdict` (3-valued) + fail-closed `narrowCheckpointVerdict` + player skip path + skipped step state + skip toast; `resumeSchema` widened | `actionRegistry.ts`, `useWalkthroughPlayer.ts`, `WalkthroughOverlayHost.tsx`, `walkthroughNodes.ts`; 9-case malformed matrix + legacy-contract regression |
| **P2** | The anchor ratchet — 96 nav screens enumerated, 75 NO-GROWTH exemptions, ceiling + staleness + duplicate guards | `__tests__/anchorCoverage.test.ts`; **proven red by sabotage** (deleting one anchor names the route) |
| **P3** | `buildRegistrationStub` / `buildRegistrationStubs` + the recorder's "Copy stubs" affordance (honest clipboard failure) | `walkthroughRecorder.ts`, `useWalkthroughRecorder.ts` |
| **P4** | Instrumented `campaign-studio`, `commerce`, `tutorials`; `chat` recovered by the scanner fix. Exemptions 79 → 75 | see the measurement correction above |
| **P5** | Focus return to the launching control; HITL focuses the TARGET (**corrects** the ADR's wording — see below); WCAG 2.2 §2.4.11 scroll-padding | `WalkthroughOverlayHost.tsx`, `.walkthrough-scroll-inset` |

**Correction (P5).** The ADR said "move focus into the caption on step change".
Implementation showed that would **break HITL**, where the entire point is that
the user reaches the page. Focus now follows the step's nature: HITL focuses the
target (a keyboard user otherwise cannot find "your turn"); scripted steps do not
steal focus (the caption is already announced via `role="status"`).

Reviews: `/code-review` (1 HIGH — a skip was announced then overwritten, fixed
with a toast; 1 banned `as unknown as`, removed) and `/ux-review` (component
registered in `DESIGN.md §5`, closing pre-existing drift). Gates: frontend
`npm run build` green, 54 walkthrough tests, full backend suite 9298 passing.

**Requirements source:** the interactive-tutorials deep-dive ([`docs/research/interactive-tutorials-architecture.md`](../research/interactive-tutorials-architecture.md)) — split out of the tutorials work because it changes the **walkthrough engine**, a different feature-package with a different owner and toggle.
**Depends on:** ADR 0368 (the engine), ADR 0376 (tour→walkthrough rename), ADR 0378 (the experience program — steps panel, HITL beacon, per-user progress, instrumentation packs, the `check-orphan-classes` gate), ADR 0472 (walkthroughs are RFC 0013 chain packs), ADR 0435 (samples are seeded example data).
**Companion:** **ADR 0488** — the tutorials half. **This ADR's Phase 2 is the hard dependency for ADR 0488 Phase 4**; 0489 can ship entirely on its own.
**Surface:** `features/walkthroughs/` (backend) + `frontend/react/src/walkthroughs/` — **extends the existing `walkthroughs` feature. No new feature-package, no new toggle** (toggle `walkthroughs`, `bucketUnit: tenant`, ON in prod — unchanged).
**RFC verdict: host work only — NO new RFC.** Node `config` is opaque to the wire; the engine reuses runs/events/interrupts unchanged.

---

## Why this exists

Two gaps block the walkthrough engine from carrying real teaching load. Both are in the
engine, not in the tutorials that reference it — which is why they are here and not in ADR 0488.

### 1. A checkpoint has only two outcomes, and one of them is "destroy the run"

`useWalkthroughPlayer.ts:166-181` — a checkpoint evaluates app state, then:

- **pass** ⇒ resolve the interrupt, continue;
- **fail** ⇒ `setStatus('needs-update')` + **`cancelRun(...)`** + teardown.

That is honest, and it was the right call for *verification*. It is wrong for *teaching*. A
learner who has already connected a provider, or already created a funnel, hits a step whose
work is done and the walkthrough either performs a redundant action or dies. There is no way
to express *"this is already true — skip ahead and say why."*

The learning-science case is strong and old: Carroll's guided-exploration studies found
learners spent **less than half the time** and made **half the errors** of manual-followers,
precisely because the material let them skip what they had already mastered. The checkpoint
infrastructure to support this already exists; only the outcome vocabulary is missing.

### 2. Instrumentation is the program's real bottleneck — and it has already slipped once

Verified counts on `origin/main`:

| Metric | Count |
|---|---|
| `data-walkthrough` anchors, whole SPA | **31** |
| Real `registerWalkthroughAction(...)` sites | **6** |
| `walkthroughActions.ts` modules | 8 |
| One-step page-spotlight walkthroughs (test infrastructure) | ~25 |
| Genuinely multi-step walkthroughs | **2** |
| **Nav-entry screens WITH an anchor** (measured during P2) | **17 of 98** → **21 of 96** after P2/P4 corrections |

> **Measurement correction (P2/P4).** The first scan said 17/98. Two scanner bugs
> inflated the debt: redirect-only routes (`<Navigate/>`, `*Redirect`) are not
> screens and should never have counted, and a route component is often a thin
> shell that delegates to the real screen (`/chat` → `ChatTab` → `TabChatDeck`,
> where the `chat.send` anchor actually lives) — checking only the route's own
> file reported fully-driveable screens as uninstrumented. The ratchet now excludes
> redirects and follows relative imports one level. With four screens instrumented
> in P4 (`campaign-studio`, `commerce`, `tutorials`, plus `chat` recovered by the
> scanner fix), the exemption list stands at **75**, which is the recorded ceiling.

ADR 0378's own status block records the slip honestly: the funnels + models packs shipped,
but *"the funnel tutorial's remaining steps target the CMS/commerce editors — instrumenting
those editors is real per-surface work for whoever owns them next."* That deferral was
correct and it has not been picked up since. **31 anchors cannot support a driving tutorial
library**, and nothing in the build makes the gap visible.

This repo already knows the remedy and has stated it as a principle: *"an audit is a snapshot,
a test is a ratchet"* (ADR 0419 §Correction). ADR 0378 P5 itself shipped a
`check-orphan-classes` gate. The anchors need the same treatment.

---

## Boundaries audit (verified against `origin/main`)

| Check | Finding |
|---|---|
| **Feature ownership** | `features/walkthroughs/feature.ts` owns the nodes, the chain-backed registration, the author tool, and the progress store. This ADR edits that package + its FE half. **No new package, no new toggle.** |
| **Node ownership** | `ui.walkthrough.step` / `ui.walkthrough.checkpoint` are **host-registered by design** — `feature.ts:115` notes `requiredPacks: [feature.walkthroughs.nodes]` covers `ctx` reads only, *"the ui.walkthrough.* step nodes stay host-registered by design"*. This ADR adds no node type; it extends an existing node's **`config`**, which is opaque to the wire. |
| **Checkpoint registry** | `frontend/react/src/walkthroughs/actionRegistry.ts` — `registerWalkthroughCheckpoint` / `getWalkthroughCheckpoint`, `WalkthroughCheckpoint.evaluate(): string \| null` (string = failure detail, null = pass). The single owner; extended in place, not forked. |
| **Existing ratchet precedents** | `test/walkthroughs-coverage.test.ts`, `test/builtin-workflow-ratchet.test.ts` (NO-GROWTH + shrink-only quarantine), `test/subject-erasure-coverage.test.ts` (enumerate-and-enforce), ADR 0378 P5's `check-orphan-classes`. The anchor ratchet copies these; it invents no new enforcement mechanism. |
| **Anti-rot reverse lookup** | `findWalkthroughActionForElement()` already exists for the recorder and *"NEVER reads a CSS selector"*. The Phase 2 stub generator reuses it — no second matcher. |
| **Wire** | Runs, events, interrupts, and the RFC 0013 chain shape are all unchanged. Node `config` carries the new field. |

---

## Decision

### D1 — A third checkpoint outcome: `already-satisfied`

Widen the checkpoint contract from *pass/fail* to *pass / already-satisfied / fail*:

```ts
export interface WalkthroughCheckpoint {
  /** null = pass · string = failure detail (unchanged).
   *  { satisfied: true, because } = the state this step would produce ALREADY holds. */
  evaluate(): Promise<CheckpointVerdict> | CheckpointVerdict;
}
type CheckpointVerdict = null | string | { satisfied: true; because: string };
```

Player behavior on `{ satisfied: true }`:

- resolve the interrupt with `{ passed: true, skipped: true, because }` — the step is
  **done**, not failed, so the run stays healthy and the durable record stays truthful;
- narrate the skip (`because`) through the existing `role="status"` caption, and mark the
  step **skipped** (a third state alongside done/current/upcoming) in the steps panel;
- **never** cancel. Cancellation remains reserved for genuine divergence.

**Backward compatible by construction:** existing checkpoints return `null | string` and are
untouched. This is a widening of a host-local FE interface — no wire, no node type, no pack
version bump.

### D2 — Skip-ahead is bounded and honest

A skip advances **one step**, evaluated per step. It never fast-forwards a whole phase on one
verdict, and a skipped step is visibly skipped rather than silently absent — the learner must
always be able to see what was bypassed and why. Skip is a teaching affordance, not a
shortcut that hides the product.

### D3 — The anchor coverage ratchet

A build-time test, following the `builtin-workflow-ratchet` shape:

1. **Enumerate** every screen with a nav entry (`frontend/react/src/chrome/features.tsx` —
   already the SSoT for routes/nav/tier).
2. **Require** each to expose `data-walkthrough` on its page root **and** on its primary
   action.

   > **Correction (implementation, P2):** the shipped ratchet enforces **"at least one
   > anchor on the screen"**, not "root AND primary action". *Primary action* is not
   > reliably detectable by static scan — identifying it means guessing which button
   > matters, and a guess that fires the build is worse than no guard. The narrowing costs
   > nothing against the actual bottleneck: an uninstrumented screen cannot be driven at
   > all, and that is what 79 of 98 screens were. OQ3 already scoped widening to the
   > drawdown; revisit there with evidence rather than by assertion.
3. **Exemptions are an explicit, NO-GROWTH list** — each entry carries a one-line reason.
   The list may shrink, never grow; a new nav entry without an anchor fails the build.
4. **Probe for vacuity** (the repo's standing lesson — *"a concurrency test must make writers
   actually collide; probe by sabotage"*): the test must be proven red by deleting one real
   anchor before it is trusted.

Seeding the exemption list with today's gaps is **deliberate**: the ratchet's job is to stop
the bleeding first and make the existing debt *visible and shrinking*, not to block the build
on ADR 0378's unfinished sweep.

### D4 — Make adding an anchor a one-line change

The recorder already classifies unmatched interactions as Tier-2 and synthesizes a
non-promotable placeholder carrying a `describe`. Extend that output into a copy-pasteable
`registerWalkthroughAction` stub scoped to the owning component. The research on tour
durability is consistent that the data-attribute approach is what turns onboarding from a
maintenance burden into set-and-forget infrastructure — but only if adding one is trivial.

### D5 — No silent caps

If the sweep bounds its own coverage, it says so. A ratchet that quietly exempts is worse than
no ratchet, because it reads as "covered" when it is not.

---

## Phases

| # | Deliverable | Gate |
|---|---|---|
| **P1** | **D1 + D2** — `CheckpointVerdict`, player skip path, skipped state in the steps panel, narration of `because`. Unit tests incl. the legacy `null \| string` contract | `walkthroughs` FE tests + a legacy-contract regression |
| **P2** | **D3 + D5** — the anchor ratchet, exemption list with reasons, **vacuity probe by sabotage** | the ratchet must be proven red before merge |
| **P3** | **D4** — recorder emits a registration stub from Tier-2 `describe` | recorder tests |
| **P4** | Exemption drawdown — instrument the highest-value uninstrumented surfaces ADR 0378 deferred (CMS/commerce editors), shrinking the list | list shrinks; ratchet stays green |
| **P5** | A11y: move focus into the caption on step change; return focus to the trigger on stop; WCAG 2.2 **2.4.11 Focus Not Obscured** beyond today's `captionTop` heuristic; a keyboard advance affordance | `/ux-review` + the browser skill in light **and** dark |

P1–P2 are independently valuable and unblock ADR 0488 P4. P4 is the honest long pole and is
sequenced so it can proceed incrementally without gating anything.

---

## Alternatives weighed

1. **Let a failed checkpoint pass silently when state already matches** — no new vocabulary,
   but it destroys the distinction between *verified* and *skipped*, and the run record would
   lie. **Rejected** — honesty is the engine's defining property.
2. **A separate `ui.walkthrough.skipIf` node type** — a new node instead of a widened
   verdict. More surface, a pack version bump, and it splits "evaluate app state" across two
   node types. **Rejected.**
3. **Lint anchors instead of a build test** — lint is advisory and drifts. The repo's own
   experience is that only a ratchet holds. **Rejected.**
4. **Require 100% anchor coverage immediately (no exemption list)** — would fail the build on
   day one for debt this ADR did not create, and would pressure teams into fake anchors.
   **Rejected** in favor of NO-GROWTH + drawdown.
5. **AI/self-healing selector fallback when an action fails to resolve** — the commercial
   answer to selector rot. **Rejected:** this engine defeats selector rot *structurally* via
   the semantic registry; adding a fuzzy fallback would reintroduce the failure mode and
   undermine the honest `needs-update` state.

---

## Open questions

- **OQ1** — Should `already-satisfied` be surfaced in the run-derived step funnels (ADR 0378
  P3) as its own bucket? *Assumption: yes — a skip is signal about the learner, not noise.*
- **OQ2** — Does a fully-skipped phase count as "completed" for tutorial progress (ADR 0488
  D4)? *Assumption: yes, with the skip recorded — the learner demonstrably has the outcome.*
- **OQ3** — Should the ratchet also require an anchor on **secondary** actions, or only the
  page root + primary? *Assumption: root + primary in P2; widen only if the drawdown shows
  it is the binding constraint.*
- **OQ4** — P4 ownership: the CMS/commerce editor anchors are per-surface work owned by those
  features. Does this ADR carry them, or file per-feature follow-ups? *Assumption: this ADR
  carries the ratchet + drawdown of the top surfaces; the rest ride each feature's next
  touch, with the exemption list as the tracker.*
