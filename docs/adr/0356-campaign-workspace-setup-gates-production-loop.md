# ADR 0356 — Campaign workspace, KB-seeded briefs, setup gates, semantic consistency, production-in-the-loop

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–7, 2026-07-12 — see corrections) |
| **Date** | 2026-07-12 |
| **Feature** | extends **`campaign-brief`** (ADR 0156) + **`campaign-orchestration`** (ADR 0158) + wires **`production`** (ADR 0172) + touches `profiles` — all toggle ids stable, no new toggle |
| **Closes** | `CSG-BLD-1..4`, `CSG-ORC-1`, `CSG-PRD-1..3` ([gap register](../CAMPAIGN-STUDIO-GAP-FINDINGS.md)) |
| **Composes** | `kb.rag` (ADR 0351 policies), approvalService + `core.approvalGate`, `feature.production.nodes.plan-generate` (ADR 0172 — the designed post-merge slot), brand LLM-judge blend pattern (ADR 0155), run-artifact projections (no second store) |
| **RFC verdict** | **Host-ext, no new RFC.** Spine changes are host builtin-workflow definitions; chain-pack updates ride RFC 0013 (Accepted). |

## Context (boundaries audit)

- Personas/products are manually authored (`personaService.ts:54-76`); KB only grounds, never seeds.
- Channel drafts are run artifacts referenced by the run (`campaign-orchestration/types.ts:3-6`);
  no UI aggregates a campaign's assets.
- Consistency check is deterministic token-echo (`packs/feature.campaign-orchestration.nodes/
  index.mjs:27-54`).
- No `assetDecisionGate`; reuse is by reference on `MarketingCampaign` (works, no guided UX).
- **Production planning is orphaned**: `plan-generate` + Production Planner agent exist; ADR 0172:196
  designed the post-merge slot; the spine ends `consistency → finalize`
  (`orchestrationWorkflow.ts:64-77`) with zero campaign references to production (grep clean).
  PRD open question 6 deferred this "until a team/vendor surface exists" — **ADR 0172 shipped that
  surface**, so the wait-condition is met.
- Profiles: growth interests = generic `interests`, workload = coarse availability
  (`profilesService.ts:74-77,32-35`); vendor pricing readable at `workspace:read`
  (`production/routes.ts:48-68`).

Single owners confirmed: brief/persona → `campaign-brief`; spine + `MarketingCampaign` →
`campaign-orchestration`; plans/vendors → `production`; people → `profiles`. This ADR only extends
those owners and wires existing seams.

## Decision

1. **KB-seeded briefs (CSG-BLD-1).** A `brief.extract` envelope + node: `kb.rag` over the bound
   collection → **proposed** personas / products / pain-points / objections / competitors, each
   carrying `sourceDocIds`. Proposals land as *draft rows the user confirms* (AI-first, never
   silent); the brief editor gains a "Seed from knowledge base" action; the Brief Strategist agent
   gains the same verb in chat.
2. **Campaign workspace (CSG-BLD-2).** `/campaigns/:campaignId` becomes an aggregating read model —
   kernel, per-channel drafts (resolved from run artifacts), compliance/consistency reports,
   production plan, dispatch status — **a projection over existing stores, no second store**
   (the artifact-workbench precedent). Deep-linked per ADR 0336.
3. **Setup gates (CSG-ORC-1).** A `campaign.setup.gate` node in
   `feature.campaign-orchestration.nodes`: given a slot (`brand`/`persona`/`kb`/`media`) it
   **auto-resolves** when the brief already carries the ref (the CS-008 semantic), else raises the
   existing approval-gate interrupt with a "use existing / create new" choice card in chat/run UI.
   Prepended to the spine (config-gated `setupGates: true`) — campaign #2 sails through
   automatically; campaign #1 gets the guided flow. Built on approvalService — **no new engine
   primitive, no wire**.
4. **Semantic consistency (CSG-BLD-3).** The consistency node blends deterministic token-echo (60%)
   with an LLM-judge rubric (40%) — the exact brand-scorer pattern (`feature.brand.nodes`
   precedent), graceful degrade to deterministic-only without a provider.
5. **Production-in-the-loop (CSG-PRD-1).** The spine slots
   `production.plan-generate` **post-merge, pre-consistency** exactly as ADR 0172:196 designed:
   skippable via variable (`enableProductionPlan`, honest-off when the `production` toggle is off),
   receives the merged channel assets + `briefId`, and `finalize` links the resulting `planId` on
   `MarketingCampaign`. The workspace (item 2) renders it.
6. **Profiles + vendor RBAC polish (CSG-PRD-2/3).** `profiles` gains an explicit
   `growthInterests: string[]` (self-editable, distinct from generic interests; ranking prefers it,
   falling back to `interests`) — additive. Vendor **pricing fields redact** for callers without
   `host:members:manage` (list/get strip `priceRanges` unless privileged) — field-level, fail-closed.
7. **Wizard mode (CSG-BLD-4).** A lightweight stepper over the existing sectioned editor (progress
   affordance + a Review step summarizing before confirm) — same components, no second editor.

## Phases

| Phase | Ships | Gaps |
|---|---|---|
| 1 | Production slot in the spine + plan link on campaign + workspace renders it | PRD-1 |
| 2 | Campaign workspace projection page | BLD-2 |
| 3 | `brief.extract` seeding (envelope + editor action + agent verb) | BLD-1 |
| 4 | Setup gates node + spine prefix (config-gated) | ORC-1 |
| 5 | Semantic consistency blend | BLD-3 |
| 6 | `growthInterests` + vendor pricing redaction | PRD-2, PRD-3 |
| 7 | Wizard/stepper + Review step | BLD-4 |

## Matrix highlights

Toggles stable (`campaign-brief`, `campaign-orchestration`, `production`, `profiles`). Packs:
`feature.campaign-brief.nodes` (+extract), `feature.campaign-orchestration.nodes` (+setup-gate,
consistency v2) — version bumps, signed. Replay/fork: gate outcomes ride approvalService (fork-stable
keys); extraction proposals + judge scores are node outputs; the plan slot is a normal node in the
builtin workflow (deterministic ordering). RBAC: extraction/workspace read = `workspace:read`;
confirm-seed writes = `workspace:write`; pricing redaction privileged as above. AI-first: seeding,
gates, and the workspace are all drivable from the Campaign Strategist in the ONE chat.

## Alternatives weighed

- *A new `assetDecisionGate` engine primitive*: rejected — approvalService + a feature node gives
  identical semantics with zero engine/wire surface.
- *Embedding channel drafts into the campaign row*: rejected — duplicates run artifacts; the
  projection keeps one source of truth.
- *Auto-applying KB-extracted personas*: rejected — proposals-with-confirm preserves trust.

## As-built corrections (2026-07-12)

- **The production slot ships UNCONDITIONALLY in the spine** (not config-gated): the node
  itself SKIPS honestly (success + skipped) when the production toggle is off — simpler than
  a variable, and campaign runs never fail on it. The node also resolves org/channels from
  the brief (production pack 1.1.0), and finalize links the newest brief-carrying plan.
- **Setup gates ship as the `setup-check` NODE** (auto-resolving: a fully-bound brief
  reports `ready: true`), now **wired into the Campaign Strategist agent's `toolAllowlist`**
  (`feature.campaign-orchestration.agents` 1.1.0) — the chat-driven path this ADR preferred:
  the agent runs `setup-check` conversationally and, on named missing slots, walks the human
  through "use existing / create new" in the ONE chat rather than a hard-coded spine prefix
  with a conditional approval gate (open Q1 superseded: no default-ON toggle needed for a
  check node). Prepending it to the builtin spine remains a future caller/chain choice.
- **`brief.extract` is node/agent-only** (no REST route): generation is run-scoped by this
  host's rules — the "Seed from knowledge base" UX is the Brief Strategist in the ONE chat.
- **The wizard stepper was traded for a Review summary section** on the sectioned editor —
  the Review-step value (what generation will use: brand/persona/kb/grounding/competitors
  chips) without a second editor shape.
- The workspace is a GET aggregate (`/campaigns/:id/workspace` — campaign + brief + linked
  production plan); console folding is FE follow-on (open Q2).

## Phase → implementation record

| Phase | Ships | Evidence |
|---|---|---|
| 1 | Spine slots `production-plan` post-merge/pre-consistency (BOTH spines) · node skip-when-off + brief-resolved inputs (production pack 1.1.0) · `MarketingCampaign.productionPlanId` linked at finalize | `orchestrationWorkflow.ts`, `packs/feature.production.nodes`; `test/campaign-workspace-gates-production.test.ts` |
| 2 | `GET /campaigns/:id/workspace` aggregate (projection, no second store) | `campaign-orchestration/routes.ts` |
| 3 | `extract-seeds` node (kb.rag → PROPOSALS w/ citations, fails closed on no coverage) + Brief Strategist allowlist (brief packs 1.2.0/1.1.0) | pack + test |
| 4 | `setup-check` node (auto-resolve / named missing slots) — orchestration pack 1.1.0 · wired into the Campaign Strategist `toolAllowlist` (agents pack 1.1.0, feature.ts pin) | pack + test (`campaign-orchestration.test.ts` allowlist) |
| 5 | Consistency = 60% token-echo + 40% LLM judge, deterministic-only degrade | pack + test |
| 6 | `profiles.growthInterests` (self-editable, ranking-preferred) + vendor `priceRanges` redaction below `host:members:manage` | `profiles/*`, `production/*` |
| 7 | Review summary section on the brief editor (+i18n ×4) | `CampaignBriefPage.tsx` |
