# ADR 0157 — Campaign Studio: Channel Generation

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–2, 2026-06-27) |
| **Date** | 2026-06-27 |
| **Feature id / toggle** | `campaign-channels` (OFF, bucket `tenant`, category `Marketing`) |
| **Packs** | `feature.campaign-channels.{nodes,agents,workflows}` + an artifact-type pack |
| **Depends on** | ADR 0156 (brief + kernel), 0155 (brand voice + compliance), 0011 (kb grounding), 0007 (media), 0009/0012 (page-builder/publishing — landing target), 0019 (email — sequence target) |
| **PRD** | [`docs/campaign-studio-prd.md`](../campaign-studio-prd.md) — third of the cluster |
| **RFC gate** | None — host work riding Accepted RFCs (0011, 0014, 0005). **No new RFC.** |

## Context

With the messaging kernel in place (ADR 0156), each **channel** turns it into a concrete deliverable: a landing page, ad variants, an email sequence, creative briefs, and social posts — every one grounded in the brief's knowledge base (with `[src_N]` citations), echoing the kernel, and scored for content quality + brand compliance before a human sees it. In MyndHyve this was the `channelWorkflowFactory` (one node shape, per-channel config: `generate → quality → brand → approval` with a refine loopback) plus five generators.

openwop-app already has the brand compliance scorer (`feature.brand.nodes.compliance-check`, ADR 0155) and the kernel (ADR 0156). This ADR adds the **channel generator** + **content quality** nodes and the five **channel child workflows** that the orchestration (ADR 0158) fans out over. It forks nothing — generation rides `ctx.callAI`, grounding rides `kb.rag`, compliance reuses the brand node.

## Decision

Ship a `campaign-channels` feature with:

1. **One parameterized `generate` node** (the channelWorkflowFactory pattern) — inputs `{briefId, channel, provider?, model?}`; reads the brief + kernel, composes brand voice (`resolveVoice` with the channel rule) + KB grounding (`kb.rag`) + the kernel, applies a **channel-specific system prompt + responseSchema**, calls `ctx.callAI`, and returns the channel `draft` artifact (recorded → replay-safe). One node, five channel shapes — no five near-identical executors.
2. **A `content.quality.check` node** — scores a draft (readability heuristic, citation presence, length vs the channel cap, kernel echo) 0–100; non-blocking (the report flows to the approval gate). Complements the brand compliance node.
3. **Five channel child workflows** (`feature.campaign-channels.workflows`, registered via the `builtinWorkflows` seam) — each `start → generate(channel) → content.quality.check → brand.compliance.check → approval` with a refine loopback on the approval gate. Independently runnable AND dispatchable as a sub-workflow by the orchestration (ADR 0158).
4. **An artifact-type pack** registering the channel draft types (`campaign-channel.{landing-page,ads,email,creative,social}`).
5. **A Channel Generator agent** (`feature.campaign-channels.agents`) tool-allowlisted to the generate + quality nodes — drives single-channel generation from the one chat (ADR 0058).

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| One generate node vs five | ONE parameterized `generate(channel)` | MyndHyve's factory pattern — the per-channel difference is the prompt + schema, not the executor; one node, five workflow configs. |
| Drafts = recorded node outputs | The `draft` is the node output (an artifact), NOT a new store | The orchestration (0158) bundles drafts into the `MarketingCampaign`; no parallel "drafts" table. Replay reads the recorded draft. |
| Quality vs compliance | `content.quality.check` (this ADR) + reuse `brand.compliance.check` (0155) | Two distinct, non-blocking scores per channel — quality (readability/citations/length) and brand (banned/voice). |
| Grounding | `kb.rag` in the node (citations → draft); generators echo `[src_N]` | The 0156 seam — grounding in the node, citations in the artifact shape. No new RFC. |
| Per-item refine | The approval gate's `itemsFrom` (array channels: ads/email/creative/social) | The MyndHyve "Partial Accepter" — refine a subset; landing page is single-item. Realized in the channel workflow's approval node config. |
| No dedicated FE | Generated assets surface through the existing run/artifact workbench + the campaign view (ADR 0158) | The "build ON orchestration, not parallel surfaces" rule — channels are a backend capability, not a bespoke dashboard. |

### Non-goals

- The parent orchestration + fan-out (→ ADR 0158).
- Pushing the landing page into the page-builder / the email into ADR 0019 as *live* entities — v1 emits the draft artifact; the wiring INTO those features is an 0158/follow-on concern.
- A dedicated channels FE page (assets surface via the run/artifact + campaign view).

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Generator + quality nodes** | `feature.campaign-channels.nodes` (`generate` parameterized by channel + per-channel prompt/schema; `content.quality.check`) · `feature.campaign-channels.agents` (Channel Generator) · the `campaign-brief` surface `assembleContext` extended to return the kernel · tests over stubbed surfaces + a stub `ctx.callAI` | backend tsc + tests; boot installs packs |
| **2 — Channel workflows + artifact types** | Five channel child workflows via `builtinWorkflows` (`generate→quality→brand→approval`+refine, per-channel `itemsFrom`) · the artifact-type pack (`campaign-channel.*`) · DAG-validity + workflow-shape tests | backend tsc + tests |

Each phase: **`/architect` before** · implement · **`/code-review` after, apply fixes** (`/ux-review` N/A — no user-facing surface; assets surface through the existing run/artifact workbench). HITL avoided.

## Alternatives considered

1. **Five separate generator nodes.** Rejected — the per-channel difference is data (prompt + schema), not behavior; five executors drift. One parameterized node + five workflow configs is the MyndHyve factory, DRY and replay-identical.
2. **A `campaign-channels` drafts store.** Rejected — drafts are run artifacts the orchestration bundles into the campaign; a parallel store is the no-parallel-architecture tripwire.
3. **A dedicated channels dashboard FE.** Rejected — the "build ON orchestration" rule; generated assets belong in the run/artifact workbench + the campaign view (0158).

## Open questions

1. **Per-channel output schemas.** Landing page = sections[]; ads = platformSets[]; email = emails[]; creative = briefs[]; social = posts[]. Decided: define the five inline in the node (the MyndHyve shapes).
2. **Quality thresholds.** Readability/citation/length weights. Decided: a simple weighted score, non-blocking, threshold 70 (advisory).
3. **Channel workflow ids.** `campaign-studio.channel.<channel>` (MyndHyve parity) so the orchestration dispatches by a stable id.

## Consequences

- Unblocks ADR 0158 (the orchestration dispatches the five channel workflows in parallel).
- Adds one toggle, one feature, three packs (nodes/agents + an artifact-type pack), five built-in workflows. No core edits beyond registry appends.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `feature.campaign-channels.nodes` — one parameterized `generate` (5 channel prompt/schema shapes; composes kernel + brand voice + `kb.rag` grounding + `ctx.callAI`; bundles content-quality + brand-compliance) + standalone `content-quality-check`; Channel Generator agent; `assembleContext` extended to return the kernel. `/architect` (executor input-ref limits → generate bundles checks; no parallel store) + `/code-review` (0). |
| 2 | ✅ Done | `channelWorkflows.ts` — 5 `generate→approve` child workflows via `builtinWorkflows` (stable `campaign-studio.channel.*` ids, per-item `itemsFrom` on array channels) + `feature.campaign-channels.artifact-types` pack (5 `campaign-channel.*` types). `campaign-channels.test.ts` 10/10; boot registers all 5 artifact types + agent. `/code-review` (0). `/ux-review` N/A (assets surface via run/artifact workbench — no bespoke page, the "build ON orchestration" rule). |

**Verification:** 10/10 tests; tsc clean beyond baseline; boot installs nodes/agents/artifact-types + registers the 5 builtin workflows. No new RFC.
