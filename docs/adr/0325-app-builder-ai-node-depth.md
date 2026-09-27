# ADR 0325 — App-Builder AI node depth: research, per-screen deepening, quality audit

Status: Accepted (2026-07-09)

## Context

The MyndHyve parity audit (`docs/research/myndhyve-app-builder-audit.md` §G.3)
left ONE program open: the AI pipeline's depth. MyndHyve ran persona/brand/
moodboard **research** nodes, a per-screen **content-generation** executor, and a
**quality-audit** node, orchestrated by a browser-side `StackAutoplayRunner`
that dispatched each screen as its own run. openwop-app's `app-builder.design`
builtin chain (ADR 0305 F) is real-BYOK but shallow: prd → plan → render →
review, with the whole app generated in ONE plan call.

Discovery settled the architecture: **pack nodes receive `ctx.callAI`** — the
spec-defined `host.aiProviders` entry point (BYOK-safe; the key never crosses
into the node; the `core.openwop.agents` pack is precedent). So MyndHyve's
research/per-screen shapes map onto **server-side pack nodes** inside the
existing chain — no browser orchestration, no new wire.

## Decision

Three new nodes in the existing `packs/feature.app-builder.nodes` (1.4.0), and
the `app-builder.design` chain rewired around them:

```
idea → prd → research → plan → render → deepen → audit → review
```

1. **`…nodes.research`** — ONE `ctx.callAI` call producing structured research
   (`personas[]`, `brand` voice/tone, `visualDirection` incl. theme-color
   suggestions) from the idea + PRD. Its JSON feeds the plan prompt so screen
   copy, tone, and theming are grounded. MyndHyve ran three 40-line configs of
   one factory; one call carries the same value at a third of the cost.
2. **`…nodes.deepen`** — the MyndHyve `perScreenExecutor` shape, server-side:
   takes the rendered doc, picks the ≤4 **thinnest** screens (component count
   under a threshold), makes one `ctx.callAI` per screen (sequential), and
   re-normalizes every result through the SAME `normalizeComponent` gate the
   render node uses (the grade-pass seam lesson: enriched output must survive
   the same normalization or it is dead on the wire). Emits the final artifact
   — **the chain's single `outputRole: 'primary'`** (render drops its role; one
   deliverable per run).
3. **`…nodes.audit`** — **deterministic, zero AI**: semantic quality checks the
   validators deliberately don't own — unreachable screens (connector graph
   from `isInitial`), empty screens, dangling `navigateTo`, duplicate routes,
   theme-color contrast (relative luminance), plus a "deepen skipped" finding
   when the enhancer soft-failed. Outputs `{score, findings[]}` + a summary,
   and **passes the artifact through** so the review gate's upstream binding
   (ADR 0083) still receives the app, with `itemsFrom: 'screens'` intact.
   It MUST NOT re-implement `validateAppDoc` validity checks (single owner).

**Soft-fail posture (loud).** research and deepen are *enhancers*: an AI error
or bad JSON never fails the run (the user already paid for prd/plan) — the node
passes through unchanged and says so via a `warning` output, a log line, and an
audit finding. Silent degradation is banned.

**Cost honesty.** The chain adds ≤5 BYOK calls per run (1 research + ≤4 deepen),
all through the same provider/model resolution as the existing prd/plan nodes
(config pass-through to `ctx.callAI`; no separate credential path).

## Explicitly superseded / not built (the MyndHyve inventory, honestly closed)

- **Capability-intersection routing** (`StackTargetMapper`) → ADR 0104 grants +
  `effectiveToolAllowlist` already own capability narrowing. Superseded.
- **Browser `StackAutoplayRunner` + per-task kanban cards** → replaced by the
  in-chain server-side loop; no browser task materialization exists to card.
- **RFC 0126 child-run fan-out for screens** → rejected for this scale: ≤4
  bounded calls in one restart-safe node beats a run tree (that dispatcher is
  the durable-agents seam).
- **Insights dashboard UI** → research + audit land as chat-visible run outputs
  now; a dedicated dashboard surface is a recorded follow-up (product surface,
  not plumbing).
- **`component-library` research node** → orphaned even in MyndHyve (registered,
  never in the seed workflow). Not ported.

## Wire/RFC

None needed: `ctx.callAI` rides the already-specced `host.aiProviders`
capability; new pack nodes + builtin-workflow stages are host work; no new
artifact types; no capability advertisement changes. Compatibility: Additive.

## Correction notes (2026-07-09 grade pass — the reasoning trail, not a rewrite)

The same-day `/grade-code` + `/grade-data` pass found four seam defects in the
shipped decision; each is corrected in place and the lesson stands: **test the
delivered value at the consumer, not the definition shape.**

1. **Grounding was dead on the wire.** The plan consumed research via a second
   input port, but `core.ai.chatCompletion`'s `toMessages()` returns on the
   FIRST priority port — the research JSON never reached the model. research
   now emits `planContext` (PRD + research combined; PRD alone on soft-fail)
   as the plan's SOLE input.
2. **The review gate was corrupted, not helped, by the pass-through edge.**
   `sourceOutput: 'artifact'` delivered a bare envelope: the gate folded its
   string fields into two junk picker options (suppressing the ApprovalCard's
   artifact fetch) and `detectTypedArtifact` missed (no `.artifact` key) —
   untyped preview, dead "Open in editor". The edge now carries the WHOLE
   outputs map, audit keeps NO top-level string outputs (`summary` lives inside
   `report`), and audit holds the chain's single `outputRole: 'primary'`
   (deepen's copy would mint a duplicate Library row + second working copy).
3. **Provider config.** No host default exists for `callAI` — every AI node now
   stamps `provider`/`model` (the insights-suite/notebooks precedent); without
   it prd/plan failed hard and research/deepen soft-failed on every run.
4. **`itemsFrom: 'screens'` removed.** No runtime consumes `itemsFrom` (the
   gate neither reads nor forwards it) — the per-screen-refine claim is
   deleted rather than asserted. Implementing real per-item review is a
   recorded follow-up. Additionally: deepen deep-clones its input (the
   scheduler delivers outputs by reference), render passes `themeColors` +
   `dataSources` through (they are schema fields it silently stripped — the
   audit's theme check was unreachable), and the plan's dictated JSON shape
   gained `themeColors`.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | research node + chain rewire + plan-prompt grounding | this change |
| 2 | deepen node (≤4 thinnest screens, same-gate renormalization, primary) | this change |
| 3 | audit node (deterministic, artifact pass-through to the gate) | this change |
| 4 | tests (node units w/ mocked ctx.callAI + chain-shape tripwires) + audit-doc G.3 close-out | this change |
| follow-up | insights dashboard surface (product decision) | recorded |
