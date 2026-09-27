# ADR 0312 — Skills vs. Agents: a handoff-based agent pack is a *Skill*, not an *Agent*

Status: Accepted (Phase 0 implemented; Phase 1 gated on openwop RFC 0131)

## Context

The word "agent" is overloaded across three architecturally distinct things:

| Layer | What it is | Where it lives |
|---|---|---|
| **Named agent** (Iris, advisors) | user-facing orchestrator; composes the rest | roster instance + `agentProfile` (DB) — **not a pack** |
| **Capability / worker agent** (code-reviewer, SDR) | task-scoped, invoked as a sub-agent via a `handoff` contract | **agent pack** (`core.openwop.agents.*`, `feature.*.agents`) |
| **Tool** | a bare function | **node pack** |

The marketplace labels the middle row **"Agent pack"**, which reads as "a named agent you install" when it is really a **composable capability**. This is a real confusion (an operator asked why the 24 `core.openwop.agents.*` packs were "not installed" and whether they were skills).

Evidence (registry `packs/core.openwop.agents.*`, `schemas/agent-manifest.schema.json`):
- **All 24** `core.openwop.agents.*` packs are the same shape — persona + narrow `toolAllowlist` + `modelClass` + a **`handoff`** (`taskSchemaRef` / `returnSchemaRef`) contract. `handoff` **is** the "invoke me as a sub-agent" interface (`host/agentDispatch.ts`, RFC 0003 §D). None are top-level/conversational.
- Named agents are **roster instances** (`host/agentProfileService.ts` — `agentProfile.capabilities`), never packs.
- The agent manifest has **no** `knowledge` / `kb` / `schedule` / `connections` / `roster` field — those are roster/named-agent concerns already. Its **only** memory surface is `memoryShape` (scratchpad / conversation / longTerm).
- `memoryShape` is applied **inconsistently** across the 24 supposedly-uniform workers: 9 scratchpad-only, **5 declare `longTerm: true`, 4 declare `conversation: true`** — drift (a stateless handoff worker claiming persistent memory + multi-turn conversation).
- `core.openwop.skills-bridge` already normalizes Anthropic/OpenAI **SKILL.md** → an openwop **agent manifest**, so a "skill" and an "agent pack" share the **same artifact**.

## Decision

A composable, handoff-based agent pack is a **Skill** — a *constrained profile of the existing agent manifest*, **not a new pack kind and not a named agent**:

> **Skill** = an agent manifest with `handoff` **required**, `memoryShape ≤ scratchpad` (no `conversation`, no `longTerm`), and no roster/KB/schedule apparatus (already structurally absent). It is a pure, replay-clean, composable capability. A **named/assistant Agent** is a roster instance that *composes* skills.

We do **not** create a new registry "kind" (a "skill pack" would be a parallel system to "agent pack + handoff"; skills-bridge proves the artifact is identical). We make the *role* first-class and reuse the agent-manifest seam, composing RFC 0003 (packs) / 0037 (multi-agent execution) / 0039 (memory lifecycle) / 0041 (replay).

## Alternatives weighed

- **A — new pack kind (`skill` registry tier).** REJECTED: parallel system (duplicates "agent-pack + handoff"), heavy (registry-shape RFC + installer + namespace migration), low reversibility. The artifact is already an agent manifest.
- **B — skill as a constrained *role* on the agent manifest + host relabel.** CHOSEN.
- **C — host-only relabel, no wire change.** Insufficient alone: leaves the wire vocabulary ambiguous cross-host and the `memoryShape` drift unaddressed — but it *is* the safe non-normative Phase 0 of B.

Dominant forces: **single-source-of-truth** (A creates a second system) and **replay determinism** (a worker with `longTerm`/`conversation` is a stateful principal, threatening RFC 0041).

## Why a skill needs no memory/KB/schedules (the load-bearing analysis)

- **KB, schedules, connections, roster** — not agent-manifest fields; already roster/named-agent-owned. A skill receives context via its `handoff` **task input**, reaches credentials only through allowlisted tools, and is a *callee* (never schedules itself). Nothing to add — confirm the boundary.
- **Memory** — a skill gets **scratchpad only** (ephemeral working memory during the single task). `conversation` (multi-turn) and `longTerm` (persistent, RFC 0004) belong to the composing named agent; on a handoff worker they break the stateless/replay-clean contract. The 5 `longTerm` + 4 `conversation` packs are drift to normalize (Phase 2).

## Phased plan

| Phase | Scope | Gate | Artifact |
|---|---|---|---|
| **0** (this ADR) | Marketplace **relabels** a pack whose agents are **all handoff-workers** as **"Skill"** (else "Agent"); non-normative host presentation | none (host-ext, ADR only) | `features/marketplace/listingService.ts` `categoryOf` + test |
| **1** | Formalize the **skill role** on the agent manifest — additive `role: 'skill' \| 'assistant'` (default inferred from `handoff`) + the skill profile (handoff required, `memoryShape ≤ scratchpad`). **Additive / safety-fix** compatibility | **openwop RFC 0131 Accepted** before host `role` support (wire) | `../openwop/RFCS/0131-*.md` + `schemas/agent-manifest.schema.json` |
| **2** | Normalize the 9 drifted packs' `memoryShape` to scratchpad-only; republish via the auto-register flow | Phase 1 | registry `packs/core.openwop.agents.*` |

**Namespace:** do **not** rename `agents.*` → `skills.*` (breaking registry change) — alias/label; a rename waits for a major.

## Open questions / decisions

- [x] New pack kind? — **No** (parallel system).
- [x] Do skills need memory/KB/schedules? — **No** beyond scratchpad; the rest is roster-owned.
- [ ] `role` default: inferred from `handoff` presence, or explicit? — decide in RFC 0131.
- [ ] Multi-agent "crew" packs (3 of the 24) — a crew is still a skill (all-handoff); its internal composition is an RFC 0037 concern, not a taxonomy one.
- [ ] Should `feature.*.agents` orchestrator packs (all-handoff-less) surface as "Agent" or a third "Assistant" label? — Phase 1.

**Falsifiability:** a genuine new tier (A) would be justified only if a skill needed a fundamentally different *artifact* than an agent manifest — skills-bridge proves it does not.
