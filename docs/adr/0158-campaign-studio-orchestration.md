# ADR 0158 — Campaign Studio: Composable Orchestration

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–3, 2026-06-27) |
| **Date** | 2026-06-27 |
| **Feature id / toggle** | `campaign-orchestration` (OFF, bucket `tenant`, category `Marketing`) |
| **Packs** | `feature.campaign-orchestration.{nodes,agents}` + an artifact-type pack |
| **Depends on** | ADR 0157 (channels), 0156 (brief/kernel), 0155 (brand); core `core.subWorkflow` + `core.dispatch` (RFC 0007, implemented sequential-only) |
| **PRD** | [`docs/campaign-studio-prd.md`](../campaign-studio-prd.md) — fourth of the cluster, the heart |
| **RFC gate** | **RFC 0118** (parallel fan-out) for the P1.5 parallel upgrade — **sequential fallback ships now** on the Accepted spec. Everything else rides Accepted RFCs. |

## Context

This is the workflow that ties Campaign Studio together (MyndHyve's `campaignOrchestrationWorkflow`, CS-008): from a confirmed brief, generate the messaging kernel, fan out the five channels, check cross-asset consistency, and finalize a `MarketingCampaign`. The host **implements `core.subWorkflow`** (sequential sub-run dispatch) and **`core.dispatch` (sequential-only** — `workflowDefinitionValidation.ts` rejects `fanOutPolicy='parallel'`, the exact RFC 0118 §K3 gap). So the parent orchestrates the channels **sequentially** today; the parallel fan-out is a one-config flip once RFC 0118 lands and the host advertises `fanOutSupported`.

## Decision

Ship a `campaign-studio` feature with:

1. **`MarketingCampaign` entity + service** — the campaign container (name, objective, brandId, personaIds, kbCollectionId, enabled channels, the kernel snapshot, status, `briefId` provenance). Tenant+org scoped, `DurableCollection`, RBAC via `accessControl`. CRUD + `finalize(briefId)` (creates the campaign from a confirmed brief).
2. **`feature.campaign-orchestration.nodes`** — `consistency-check` (scores generated drafts vs the kernel, ≥80 advisory) and `finalize` (creates the `MarketingCampaign` from the brief via the surface).
3. **The parent orchestration workflow** (`campaign-studio.campaign-orchestration`, a `builtinWorkflow`) — `validate → kernel → kernel-approve → [5× core.subWorkflow channel children, SEQUENTIAL] → consistency-check → finalize`. The channel nodes dispatch the ADR 0157 child workflows by their stable ids. **Parallel is the RFC 0118 upgrade** (swap the sequential subWorkflow chain for one `core.dispatch fanOutPolicy:'parallel'` node) — documented, gated, non-blocking.
4. **The Campaign Strategist agent** (`feature.campaign-studio.agents`) — the chat-driven orchestrator (ADR 0058): tool-allowlisted to validate / kernel / channel-generate / consistency / finalize, it runs a campaign conversationally (the honest "composable" path in this host — the LLM loop decides the per-channel sequence and gathers results, sidestepping the engine's cross-node data-flow limits).
5. **An artifact-type pack** — `marketing-campaign`, `consistency-report`.
6. **A Campaigns FE page** — list `MarketingCampaign`s + detail (kernel, channels, status) + a "Run a campaign" deep-link to the Strategist chat. The campaign view the PRD references — NOT a parallel analytics dashboard.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Parallel fan-out | SEQUENTIAL `core.subWorkflow` now; parallel = RFC 0118 flip | The host validates `fanOutPolicy='parallel'` as unsupported — sequential is correct (just slower); P1 never blocks on the wire (PRD §6). |
| Orchestrator | The Campaign Strategist AGENT is the primary orchestrator; the workflow is the declarative spine | ADR 0058 chat-drivability; the agent loop handles per-channel fan-out + result-gathering the engine's input-ref vocabulary can't express cleanly. |
| Campaign = container | `MarketingCampaign` holds the brief reference + kernel snapshot + enabled channels + status | Channel drafts are run artifacts (ADR 0157) referenced by the run, not embedded — no giant denormalized blob. |
| finalize from brief | `finalize` creates the campaign from a `confirmed`/`validated` brief | The brief (ADR 0156) is the source; the campaign is its durable, named outcome. |
| FE = campaign view | A Campaigns page + Strategist deep-link, no metrics dashboard | "Build ON orchestration" — intelligence/metrics are ADR 0159/0160. |

### Non-goals

- Parallel fan-out runtime (→ RFC 0118 + its host arm).
- Connectors / performance / budget (→ ADR 0159/0160).
- Pushing channel drafts into page-builder/email as live entities (follow-on).

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Campaign entity + nodes** | `MarketingCampaign` types + service (CRUD, finalize, IDOR) + routes + toggle · `feature.campaign-orchestration.nodes` (`consistency-check`, `finalize`) + `ctx.features['campaign-orchestration']` surface · tests | backend tsc + tests |
| **2 — Orchestration + agent** | `campaign-studio.campaign-orchestration` builtinWorkflow (sequential 5-channel `core.subWorkflow` spine) · Campaign Strategist agent · `marketing-campaign`/`consistency-report` artifact types · DAG + node + agent tests | backend tsc + tests; boot |
| **3 — Frontend** | `src/features/campaign-orchestration/` — Campaigns list + detail + Strategist deep-link · client · `Marketing` nav · en/es/fr/pt-BR | `npm run build` green |

Each phase: **`/architect` before** · **`/code-review` after**; `/ux-review` on Phase 3. HITL avoided.

## Alternatives considered

1. **Block on RFC 0118 for parallel.** Rejected — sequential is correct on the Accepted spec; blocking the whole orchestration on an unmerged RFC violates the PRD's "never blocked on the wire" sequencing.
2. **Monolithic single child workflow (no sub-workflows).** Rejected — loses per-channel run lineage, independent approval, and the RFC 0118 parallel upgrade path.
3. **Pure-workflow orchestrator, no agent.** Rejected — the engine's cross-node data-flow can't cleanly gather 5 child outputs into finalize; the agent loop is the honest orchestrator, with the workflow as the declarative spine.

## Open questions

1. **Consistency-check inputs.** Drafts aren't persisted; the node scores what the agent passes (or returns neutral in the workflow path). Decided: accept `{ briefId, drafts? }`, score vs the brief's kernel, neutral when absent.
2. **Finalize idempotency.** Re-finalizing a brief updates the existing campaign (keyed by briefId) rather than duplicating. Decided: one campaign per brief (upsert on briefId).

## Consequences

- Completes the MVP composable workflow (ADR 0155–0158). Unblocks 0159/0160 (connectors + intelligence over the campaign).
- Adds one toggle, one feature, three packs, one builtin workflow, one FE page.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `MarketingCampaign` entity + service (CRUD, `finalizeFromBrief` upsert-by-brief, IDOR) + routes (`/campaign-orchestration/*`, `/finalize`) + `ctx.features['campaign-orchestration']` surface + `feature.campaign-orchestration.nodes` (`consistency-check` deterministic kernel-echo, `finalize`). |
| 2 | ✅ Done | `campaign-studio.campaign-orchestration` builtinWorkflow — `validate→kernel→approve→5× core.subWorkflow (SEQUENTIAL, onChildFailure:'absorb', inputMapping briefId)→consistency→finalize`; every node keys on `briefId` (shared state). Campaign Strategist agent (cross-pack tool-allowlist). `marketing-campaign`/`consistency-report` artifact types. **Parallel = RFC 0118 flip** (host validates `fanOutPolicy='parallel'` as unsupported — the confirmed gap). |
| 3 | ✅ Done | `frontend/react/src/features/campaign-orchestration/` — Campaigns list + detail (read-only kernel/channels, editable status) + finalize-from-brief picker + Strategist chat deep-link (ADR 0058) on the shared `ui/` layer; en/es/fr/pt-BR. **`npm run build` green**. |

**Verification (all phases):** 9/9 `campaign-studio.test.ts` (+26 across studio/channels/kernel); tsc clean beyond baseline; boot registers the orchestration builtinWorkflow + agent + artifact types; FE build green. `/architect` + `/code-review` (0) + `/ux-review` passed. RFC 0118 gates only the parallel upgrade; sequential ships now.

### §P1.5 — parallel fan-out (✅ implemented as a LIVE opt-in; host arm landed)

The host arm (RFC 0118 executor — openwop-app **#994**, ADR 0165 witness) has **landed on main**: `workflowDefinitionValidation.ts` no longer rejects `fanOutPolicy:'parallel'` (it now gates on the advertised `capabilities.dispatch.fanOutPolicies`), and the host advertises `dispatch.fanOutSupported:true`. The parallel spine is therefore **no longer dormant — it registers against the live host** and is a working opt-in. Default stays SEQUENTIAL pending an operational decision to flip the default.

- `buildOrchestration(parallel)` produces either the sequential `core.subWorkflow` chain (default) or the parallel shape: `core.orchestrator.supervisor` (mockDispatchPlan → one `next-worker` decision naming all five channel workflow ids) → one `core.dispatch` node with `fanOutPolicy:'parallel'` + `joinPolicy:{mode:'wait-all', onChildFailure:'collect'}` (RFC 0118 §B resolved defaults) + `inputMapping:{briefId:'briefId'}`. Same `workflowId` → a clean swap (existing runs snapshot their own def; replay-safe).
- **Activation:** `parallelFanOutEnabled()` (env `OPENWOP_CAMPAIGN_FANOUT_PARALLEL`, default off) — now a live opt-in, not a blocked flag. `TODO`: swap the env read for a synchronous host-capability accessor once one exists (the env switch stays as an ops override).
- Tests assert: default → sequential active; the parallel def's supervisor plan + dispatch config; **and the parallel `core.dispatch` config is ACCEPTED by the live `checkMappingCapability` registration validator** (the end-to-end unblock proof — would have thrown `capability_not_provided` before #994). `campaign-orchestration.test.ts` 14/14.

**Cross-session note:** the host arm + this consumer were built by two parallel sessions; the RFC 0118 host witness landed as **ADR 0165** (an earlier ADR 0162 number collision with the publish last-mile was resolved by renumbering the witness to 0165). The consumer contract verified as-landed: `fanOutSupported:true`, `POST /v1/workflows` accepts `parallel`+`joinPolicy`, node output `{joinOutcome, children[]}`.
