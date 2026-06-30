# ADR 0080 — Strategy Analyst + enrichment (health rollups, agent/node packs, board memos, templates)

**Status:** implemented (Phases A–E — see § Implementation ledger)
**Date:** 2026-06-19
**Toggle:** **rides the existing `strategy` toggle** (ADR 0079) — no new toggle. These
are enrichments to the shipped Strategy feature, gated by the same on/off.
**Capability:** no new `AgentCapabilityId`, no wire capability. Adds the
`feature.strategy.{nodes,agents}` signed packs (RFC 0076 / RFC 0003) + a new
open-vocabulary `board-update` Documents kind (ADR 0053). The read-only
`ctx.features.strategy` surface (ADR 0079 Phase 6) is **unchanged** — see the
read-only decision below.
**Depends on / composes:** ADR 0079 (Strategy — the feature + the
`ctx.features.strategy` surface this builds on), RFC 0003 (agent manifests),
RFC 0076 (node-pack manifest + Ed25519/SRI install pipeline), ADR 0053 (Documents —
`generateFromTemplate`, open `kind` vocab), ADR 0058 (chat-drivability = agent +
nodes through the ONE chat, no bespoke panel), ADR 0046/0054 (project charter
health/milestones — the rollup signal), ADR 0058 (Priority Matrix — the rank/priority
signal).
**Surface:** host-internal — node/agent packs under `packs/feature.strategy.*`,
the `board-update` Documents kind under `/v1/host/openwop-app/documents/*` (existing
routes, new kebab kind), and the health projection on the existing
`/v1/host/openwop-app/strategy/context` + portfolio reads. No public surface.
**RFC gate:** **NO new RFC.** Every part rides an already-Accepted RFC (0003 agents,
0076 node packs) or an implemented host feature (0053 Documents, 0079 Strategy) and
stays non-normative. No new wire field, event, capability flag, or normative MUST.

---

## Why this exists

ADR 0079 shipped Strategy as a human-authored portfolio with cross-feature links. The
deferred "Later Enhancements" are what make it **AI-driven and richer**: an agent that
audits alignment gaps and drafts board-ready memos, a health signal rolled up from the
execution it links to, and templates that get an executive started fast. This ADR
delivers those without re-opening the wire — they compose the packs/agents/Documents
seams the app already has.

## Goal

(1) A live **strategy health** signal rolled up from linked project + priority state;
(2) a **Strategy Analyst** agent (driven through the existing chat) that audits alignment
gaps and drafts board memos via a **node pack** over the read-only surface; (3) a
**board-update** Documents kind for those memos; (4) **templates** (OKR / annual operating
plan / portfolio bet / working-backwards) that pre-shape a new strategy.

## Boundaries audit (reuse, do not fork)

`Explore` sweep (2026-06-19, post-0079):

- **Node pack template** — `packs/feature.priority-matrix.nodes/{pack.json,index.mjs}`:
  manifest `nodes[]` (`typeId`, `role:'action'`, `capabilities`), ESM `index.mjs` whose
  nodes call `ctx.features['priority-matrix']` and return `{status,outputs}`. The strategy
  node pack mirrors this over `ctx.features.strategy` (the surface ADR 0079 already ships +
  advertises as `host.sample.strategy`).
- **Agent pack template** — `packs/feature.priority-matrix.agents/pack.json`: `agentId`,
  `persona`, `systemPromptRef`, `toolAllowlist: ["openwop:feature.X.nodes.*"]`. The Strategy
  Analyst mirrors the Prioritization Analyst.
- **Pack pipeline** — `requiredPacks` in `feature.ts` → boot `ensureRegistryPacksInstalled`
  (`registryInstaller.ts`, Ed25519 + SRI); dev mount via `scripts/sync-packs.sh`. Reused
  verbatim; no new infra.
- **Documents compose** — `priorityMatrixService.ts:701` composes `createDocument({kind})`
  + `addVersion`, toggle-gated on `documents`, degrading to inline markdown when OFF.
  `documentsService.ts` `SEEDED_KINDS` is an OPEN kebab vocabulary — `board-update` is a new
  seeded kind, **no schema change**.
- **Health signals** — `Project.charter.{status,health,milestones}` (ADR 0054) + Priority
  Matrix `computePriority`/`rank` (ADR 0058) are already readable via `getProject` /
  `listRankedIdeas`, which `strategyService.resolveStrategyContext` already calls. The rollup
  is a **pure computation over data the context resolver already fetches** — no new reads on
  the hot path beyond what's there.

## Decision

### The `ctx.features.strategy` surface stays READ-ONLY (the load-bearing call)

ADR 0079 Phase 6 made the surface read-only ("strategy authoring stays a human/admin act").
This ADR **keeps that invariant**. The Strategy Analyst is **read + Documents-write**:

- It **audits** — reads strategies + their linked projects/priorities (via the existing
  read surface) and computes a deterministic **gap list** (a strategy with no links; an
  objective with no key results; a `workspace`/`org` strategy that's `active` but `off-track`;
  a linked project that's `off-track`; an initiative with no owner).
- It **drafts** — creates a **board-memo Document** (`kind:'board-update'`) summarizing the
  strategy + its health + open gaps. The write lands in **Documents**, never in Strategy.

Agent-driven *mutation of strategy data* (write nodes → new write surface methods) is a
deliberate **later opt-in**, out of scope here. This preserves the Phase-6 RBAC invariant
(no subjectless-run write path; no second authz surface) while still being genuinely useful.

### Health rollup is a computed projection (never stored)

`computeStrategyHealth(strategy, linkedProjects, linkedPriorities)` →
`{ health: 'on-track'|'at-risk'|'off-track', signals }`, derived live from the already-resolved
linked entities (project `charter.health` + milestone completion %, priority ideas' rank in
terminal vs non-terminal columns). Same live-resolve discipline as the context packet —
revocation-safe, no migration, no drift. Surfaced on the context-packet entry + portfolio rows
+ a FE health chip; exposed to workflows via a `get-health` node.

### `board-update` is a new open-vocabulary Documents kind

Added to `SEEDED_KINDS` + a seed template (`seedTemplates.ts`). Open kebab vocab ⇒ no
schema/wire change. The `draft-board-memo` node composes `generateFromTemplate` (in-run,
per the ADR 0053 / priority-matrix precedent), degrading to inline markdown when `documents`
is OFF.

### Templates are create-form presets (not a store)

Four strategy-shaped skeletons (OKR / annual-operating-plan / portfolio-bet /
working-backwards) — objective/KR/initiative scaffolds + horizon defaults — offered in the
"New strategy" modal. Pure client/seed data; no new entity, no schema change, fully reversible.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **A — health rollup** | `strategyHealth.ts` (pure) + `health` on the context entry/portfolio + FE chip + tests | backend vitest + FE build |
| **B — node pack + `board-update`** | `packs/feature.strategy.nodes/` (`list`/`get`/`context`/`get-health`/`audit-alignment`/`draft-board-memo`) over the read surface; `board-update` kind + seed template; sign + `requiredPacks` | node-pack tests; pack installs at boot |
| **C — agent pack** | `packs/feature.strategy.agents/` Strategy Analyst (persona + prompt + tool-allowlist to the node pack); `requiredPacks`; chat-drivable deep-link (no new UI) | `/verify` live chat |
| **E — templates** | `strategyTemplates.ts` presets + "from template" in the create modal; en/pt-BR; optional demo seed | FE build |

(Phase D — board memo — folds into B/C: it's the `board-update` kind + the `draft-board-memo`
node the agent calls.)

## Alternatives weighed

1. **Make the surface agent-writable** (write nodes → write surface methods). Rejected for
   this cluster — reopens the Phase-6 read-only invariant + needs a subjectless-run write-authz
   story. Deferred as an explicit future opt-in.
2. **Store the health rollup.** Rejected — a computed projection stays correct under live
   link/visibility changes; storing it invites drift (the same reasoning as links-canonical).
3. **A bespoke "Strategy Analyst" chat panel.** Rejected hard (CLAUDE.md) — drive it through
   the ONE chat via the agent + node packs (ADR 0058), deep-linked to the agent.
4. **Templates as Document templates.** Rejected — strategy presets shape the *Strategy* entity
   (objectives/KRs), not a document; create-form presets are the smaller, correct surface.

## Open questions

1. **Health thresholds** — the on/at-risk/off-track bands are a first cut; revisit once real
   portfolios exist (no invented precision — surface the component signals honestly).
2. **Agent read scope** — should the Analyst also read `cms`/`documents` for richer memos, or
   stay strategy+projects+priorities only? Start narrow (its own nodes).
3. **Strategy mutation by agent** — the deferred write path; design its authz when the need lands.

## RFC gate (verdict)

**Host-extension — NO new RFC.** Node pack rides RFC 0076; agent pack rides RFC 0003; the
`board-update` kind is open-vocabulary Documents (ADR 0053); the health projection + chat
drivability are non-normative host behavior. No wire surface is touched.

## Implementation ledger

Implemented across 4 phases (D folded into B/C) on `feat/strategy-analyst` (2026-06-19/20).
Each phase: a pre-implementation `/architect` pass + post-implementation `/code-review`
(+ `/ux-review` for the FE phases), findings folded in.

| Phase | What shipped | Tests | Key /architect finding |
|---|---|---|---|
| A — health rollup | `strategyHealth.ts` (pure verdict + signals) + `health` on the context entry + `GET /strategy/health` + FE portfolio chip | 8 (6 unit + 2 route) | computed projection never stored; separate `/health` endpoint; surface the `signals` (no invented precision) |
| B — node pack + `board-update` | `feature.strategy.nodes` (list/get/context/get-health read + create-board-memo write→Documents) + `board-update` kind + `getHealth()` surface | 9 node-pack | no deterministic audit node (LLM reasons); create-board-memo writes Documents, never Strategy (read-only invariant) |
| C — agent pack | `feature.strategy.agents` Strategy Analyst, tool-allowlisted to the node pack; chat-drivable (ADR 0058) | agent-load + no-mutation-tool assertion | single research agent; allowlist has NO strategy-mutation tool; prompt forbids fabricating strategy facts |
| E — templates | `strategyTemplates.ts` (OKR / annual-operating-plan / portfolio-bet / working-backwards presets) + "Start from" create picker; en/pt-BR | FE build gate | pure client presets (no store); backend re-validates the pre-filled input (template is a suggestion, not authority) |

Backend full suite green (2153); FE canonical gate green. Rides the `strategy` toggle;
host-extension throughout — **no new RFC**.

## Follow-on — performance & seam-hardening (post-merge `/architect`)

A holistic `/architect` pass over the full feature (ADR 0079 + 0080, as merged) found
no blockers — the read-only-strategy invariant holds end-to-end, the import graph is an
acyclic `advisory-board → strategy → {projects, priority-matrix}` DAG, core never imports
the feature, and RBAC is single-sourced. Three non-blocking findings were logged; the
first is **landed here**, the other two are tracked for when the feature graduates from
OFF-by-default to broad use:

1. **[landed] Memoize the priority-list reads per `resolveStrategyContext` call.** Without
   it, a portfolio with K priority-idea links into the same list re-ran `listRankedIdeas`
   (a full list re-rank) K times — and `GET /strategy/health` (Phase A) fans this resolve
   across the WHOLE readable portfolio, multiplying the redundancy. A per-resolve
   `Map<listId, …>` for `getList` + `listRankedIdeas` collapses it to one read/rank per
   list per resolve. Behaviour is identical (transparent optimization); proven by a
   call-count regression test (`strategy-context-memo.test.ts`: getList 1×, rank 1× for
   three same-list links, vs 3×/2× before).
2. **[consolidated — naive optimization DECLINED] `GET /strategy/health` reuses the full
   context resolve.** The pre-`/architect` premise here was wrong: a "health-only resolve"
   that skipped priority reads is **unsafe**. `computeStrategyHealth` reads `linkedPriorities`
   — both as the reported `linkedPriorityCount` signal AND via `hasExecution`
   (`projects.length > 0 || priorities.length > 0`), which drives the verdict (objectives with
   no execution ⇒ `off-track`). Skipping priority resolution would change the verdict for a
   strategy whose only execution is priority links, and report a dishonest count. The
   per-resolve memo (#1) already bounds the read cost to O(distinct-lists), so there is no
   correct fast path worth the divergence. **Landed instead:** the duplicated
   `resolveStrategyContext(...).map(toHealthRow)` in the REST route + the `getHealth` surface
   is consolidated into one `resolveStrategyHealth` service function — a single, truthful
   entry point (and the single place a *safe* future optimization would land). A regression
   test (`strategy-health.test.ts`) pins the priorities-feed-the-verdict invariant so the
   unsafe shortcut can't be reintroduced silently.
3. **[landed] Core carried feature-named fields.** `ConversationMeta.strategyContext` and
   `AgentPromptScaffoldInput.strategyContext` were strategy-named fields on CORE types, even
   though the `boardContextResolver` seam is feature-neutral. Both are renamed to the generic
   `injectedContextBlock`. `ConversationMeta` is PERSISTED (`chat:conversation`
   DurableCollection), so the rename is migration-safe: `getConversationMeta` normalizes the
   legacy `strategyContext` key on read (`loadMeta`), so board conversations created before
   the rename keep their injected snapshot rather than silently losing it. Proven by
   `conversation-context-block-migration.test.ts` (legacy key → `injectedContextBlock`).
