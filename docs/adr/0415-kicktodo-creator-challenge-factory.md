# ADR 0415 — `kicktodo-creator` / Challenge Factory

Status: **implemented (P1–P4)** — 2026-07-18; P5 is the Wave-3 gate by design; D5 content-ops blocked on real providers (phase record at the end of this file)

> **Correction (ADR 0458 Phase 2, 2026-07-21):** the six-gate model described here
> was partially theater — the simulation gate never executed until ADR 0458 made
> it real (three convened sim personas, closed-world verdicts feeding
> `assertGates`) and corrected the pipeline's executor assumptions (acyclic DAG,
> no node re-entry; per-lesson gates live in the parent run). The factory is now
> driven chat-first per ADR 0458 §2.1–2.2.


**Requirements source:** `docs/kicktodo-prd.md` §7 (the factory workflow family, gates, and node list live there).
**Depends on:** ADR 0414 (`kicktodo-core` — the `ChallengeDefinition` owner it publishes into), workflow-author (0072), the pack pipeline + `approvalService`, web-search/RAG/media owners, Projects.
**Surface:** host-extension `/v1/host/openwop-app/kicktodo/creator/*`. **NO new RFC.**

## Why this exists

The first KickTodo catalog must feel researched and tested, not prompt-split. The Challenge Factory is a **family of versioned OpenWOP workflows** that runs reproducible research → evidence graph → Challenge Plan → daily-action decomposition → media acquisition, and **refuses publication** until independent evidence/instructional-design/behavior/safety/rights/accessibility/simulation gates pass. It produces an immutable, evidence-backed `ChallengeDefinition` + a signed release bundle.

## Boundaries audit (Step 3 — verified against live code)

- **The N-gate publication pattern already exists** — `host/approvalService.ts`: one durable queue, many `kind`s including **`content-publish`** (`:463`, ADR 0066 gates CMS `draft→in_review→published`), quorum/named-approver/delegation policy (`ApprovalPolicy` `:137`), atomic CAS resolve (`:662-678`), tamper-evident audit-chain. In-workflow gating is the registered `core.approvalGate` node (`bootstrap/nodes.ts:825`) + the `gatedFlow` template ("prep → one-or-more approvalGates → apply", `workflowTemplates.ts:112-124`). The `approvals` workflow-chain pack proves sequential multi-stage sign-off. **N gates before publish is a first-class shape — reuse it.**
- **AI authoring is catalog-grounded + closed-world** — `features/workflow-author/workflowAuthorService.ts` (ADR 0072): every authored `node.typeId` must exist in the live catalog; one shared `validateWorkflowDefinition`; honors per-workspace disabled packs. Use this for the factory's own workflow authorship.
- **Reusable primitives** (PRD §7.4) exist: `core.openwop.web-search`/`http`, RAG URL/file loaders, YouTube-caption/transcription nodes, KB semantic search + citation-aware RAG, structured-output/extract/classify/guardrail, image/audio/video nodes, HITL form/approval/ask-user, JSON-Schema validation.
- **Signing gap (review finding M1):** node/agent/plugin packs are Ed25519 `verifyPinned` against a host keyring (ADR 0367), but **workflow-chain-pack signature verification is a registry-fetch path NOT wired on the in-tree loader** (`workflowChainPackLoader.ts:24-28`). MVP ships built-in + pinned node/agent packs (covered); publisher-key-signed third-party challenges (Wave 3) need that leg built on `packSignature.ts`.
- **Honesty fail-closed:** `core.web.search` returns a deterministic `stub:true` fixture when `host.webSearch` is unavailable → a publication run **must fail closed** on stub search and on placeholder/demo/unresolved model+media output (PRD §7.4, §13).

## Decision

New feature package `src/features/kicktodo-creator/`. It registers the canonical factory workflows as `builtinWorkflows`, ships the KickTodo-specific nodes, and models publication as gated approval. Content structure follows PRD §7 (the 8-stage family, `ChallengePlan`/`DailyActionUnit` artifacts, the 90/100 + no-category-below-80% + zero-sev-1 release rubric).

### New nodes (PRD §7.5) — `feature.kicktodo.nodes`
`research-frame`, `source-normalize`, `evidence-graph`, `plan-generate`, `plan-validate`, `decompose`, `day-validate`, `rights-decide`, `alignment-audit`, `release-evaluate`, `publish-version`, `monitor`. Generic nodes do the mechanics; these own canonical artifacts + durable policy. Rights rules are **versioned policy artifacts** (terms change independently of code; an LLM's copyright guess is never executable truth).

### Agent taxonomy (PRD §7.4)
Persistent factory coworkers (Research Lead, Challenge Architect, Producer, Release Coordinator) may be **named roster/profile agents** in the operator/creator workspace; task-scoped critics (evidence/behavior/rights/accessibility/safety/rubric) are **handoff skills** in `feature.kicktodo.agents` (scratchpad-only, no standing memory/schedule/authority). Deterministic policy/state (schema validation, rights application, score aggregation, publication state) stays in nodes/host services — never delegated to a persona. **Generator and evaluator are separated; no generator holds publication authority.**

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Feature package + `/kicktodo/creator/*` REST; intake+risk-classification and research/evidence-graph workflows over existing search/RAG/ingestion nodes (fail-closed on stub search); `research-frame`/`source-normalize`/`evidence-graph` nodes. |
| **P2** | `plan-generate`/`plan-validate` + `decompose`/`day-validate`; `ChallengePlan`/`DailyActionUnit` artifact schemas; deterministic validators. |
| **P3** | Resource/media acquisition sub-workflows + `rights-decide` (fail-closed on unknown rights); independent `release-evaluate` gates via `core.approvalGate`/`gatedFlow`; the 90/100 rubric; `publish-version` (pin+sign+atomic immutable publish into the ADR 0414 `ChallengeDefinition` owner). |
| **P4** | `monitor` (link/freshness/policy/incident) + operator kill switch; Creator Studio web surface (opinionated, not a raw canvas); simulation/pilot personas. |
| **P5 (Wave-3 gate)** | Third-party creator onboarding + **chain-pack registry-fetch signing (M1)** + the H2 commerce entitlement work — deferred to `kicktodo-commerce`. |

**Core-app extension surface:** `feature.kicktodo.nodes` + `feature.kicktodo.agents` (signed, pinned `requiredPacks`); `ctx.features.kicktodo-creator`; `kicktodo.challenge-plan|release-bundle|safety-review` artifact schemas; factory `builtinWorkflows`. `/.well-known`: nothing.

## Feature matrix

Feature-package ✔ · Toggle `kicktodo-creator`, **default OFF**; ON for the operator tenant in Wave 0 with editor/publisher authz still fail-closed; `bucketUnit: tenant`. · Workflow surface: `ctx.features.kicktodo-creator` + the factory built-ins. · Node pack ✔ (12 nodes). · Envelopes: none. · Agent pack ✔ (specialist skills + optional named coworkers). · Public surface: none (publishes into `kicktodo-core`'s Discover). · RBAC: creator mutations need `workspace:write` + resource ownership; **publish requires an eligible reviewer distinct from the author** (separation of duties) for risk-classified content. · Replay/fork: parent run owns cost/time/iteration bounds; forks never inherit publication approval; replay never republishes/duplicates assets/recharges (PRD §7.8). · Frontend: Creator Studio web-first (not ported to RN).

## PRD-vs-architecture corrections

- The factory is an **ordinary bounded parent run with child runs, not a standing goal** (RFC 0097 is reserved for a participant's durable outcome) — correct; recorded to prevent misuse of the ADR 0412 controller.
- Parallel research uses RFC 0118 bounded fan-out (`maxFanOut` 16) with a tested **sequential fallback** when a host doesn't advertise it — no silent semantic change.

## Open questions

1. Which rights-policy service/qualified counsel owns the initial rights-policy artifact + refresh cadence (PRD §18 Q9)?
2. Do factory coworkers live in one operator tenant or a dedicated creator workspace for Wave 0 (affects Projects topology, PRD §8.5.3)?
3. Autonomous publication is prohibited for sensitive tiers — is the editor-approval gate one queue kind (`challenge-publish`) added to `approvalService`, or reuse `content-publish`? (Recommend a new additive kind — cheap, typed inbox card.)

## Implementation record (phase → PR)

| Phase | Landed |
|---|---|
| P1 — `src/features/kicktodo-creator/` (candidate intake with DETERMINISTIC reviewable risk classification — prohibited topics refused at intake with matched signals; `/kicktodo/creator/*` routes joined to the collision-test union); research spine: deterministic question framing (host policy, model-free) → `core.web.search` → source normalization (canonical url/domain/title/hash/ENGINE records) → structure-checked evidence graph (unsupported claims RECORDED, never silently kept); **stub/demo retrieval FAILS CLOSED at record time** (the PRD §7.4 honesty rule, test-pinned); `feature.kicktodo.nodes` v1.1.0 adds `research-frame`/`source-normalize`/`evidence-graph` (pin lockstep enforced); `openwop-app.kicktodo.research` builtin; toggle `kicktodo-creator` OFF/tenant + `dependsOn: kicktodo-core` + seed ACK + distribution manifest | kicktodo/d1-factory-research |
| P2 — plan gates + decomposition (`planService.ts`: `validatePlan`/`validateDays` — the deterministic gates reporting EVERY defect at once as error-fed-repair input: measurable outcomes, orphan achievements, unserved outcomes, action traceability, stacked workload vs the daily budget, recovery presence, day-1 win; `draftFromPlan` — a VALIDATED plan deterministically becomes a `kicktodo-core` draft, the single challenge owner; typed `PlanInvalidError` with the full defect list, never a partial draft; `kicktodo.challenge-plan` artifact schema registered + drift-pinned to a real valid plan; pack v1.2.0 adds `plan-validate`/`decompose`, pins bumped in lockstep) | kicktodo/d2-plan-gates |
| P3 — rights + gated publication (`publishService.ts`: VERSIONED rights policy applied deterministically — TED-class domains `blocked` per their terms, unknown domains get the safe `link-only` citation floor since MVP scope is CITATION-ONLY (content-reuse lanes deliberately out of scope — an LLM never guesses copyright); a claim entailed only by blocked sources fails; publication = submit (hard gates: real evidence, zero effective-unsupported claims, non-prohibited tier) → ONE `challenge-publish` approval on the shared `approvalService` queue (the OQ3 additive-kind decision, implemented) → complete by a DIFFERENT identity (separation of duties — closes the KT-R1 accepted risk) → atomic immutable publish into the kicktodo-core owner; idempotent completion, replay never re-publishes) | kicktodo/d3-rights-publish |
| P4 — monitoring + kill switch (`monitorService.ts`: injected-fetcher source-health checks — ok/redirected/broken/unreachable — that open findings and never edit content; the operator kill switch retires the published version through the kicktodo-core owner — NEW enrollments refused, ACTIVE enrollments keep their pinned version, test-pinned — and withdraws the candidate with the audited reason). **Recorded open (not silently dropped):** the Creator Studio web surface + simulation personas ship with the D5 content-ops wave (they need the live-provider loop the studio operates), tracked as D4-UI in the KickTodo tracker. | kicktodo/d4-monitor-kill |
| P5 (Wave-3 gate) — third-party onboarding + chain-pack registry signing (M1) + H2 commerce entitlement | pending (blocked on Wave 2) |

## RFC verdict

**Host-ext, no RFC.** Built-in workflows + signed node/agent packs use accepted distribution contracts; publication rides the existing approval owner. A new RFC is triggered only if a normative agent-manifest `role: skill` field, a portable cross-host challenge/pack schema, or a `challenge.*` capability/event is proposed (PRD §17).

## D5 code-halves record (2026-07-18 — KTC-2 + KTC-3)

- **KTC-2 (plan generation) SHIPPED:** `feature.kicktodo.nodes.plan-generate` (pack v1.9.0) — generates with the run-scoped provider (`ctx.callAI`), judged AUTHORITATIVELY by the creator surface's closed-world `validatePlan` (the SSoT — no schema copy in the pack), ONE bounded error-fed repair naming the validator's actual defects, typed `plan_invalid` after (never success-with-empty), `capability_missing` fail-closed without a provider (the stub posture). Wired as the `openwop-app.kicktodo.plan-generation` builtin workflow (generate → decompose). Test-pinned: exactly two model calls max; defects fed verbatim into the repair.
- **KTC-3 (Studio + personas) SHIPPED:** `/kicktodo/studio` behind the EXISTING `kicktodo-creator` toggle (no new feature id) — intake with server-side risk classification surfaced (tier + matched signals visible), pipeline + publication state; i18n ×4. Simulation personas (`sim-newcomer`, `sim-time-poor`, `sim-skeptic`) join `feature.kicktodo.agents` v1.2.0 as READ-ONLY scratchpad reviewers for the evaluation stage.
- The 24-candidate first-batch content RUN remains operator-gated (real search/model/media providers + budget) — unchanged.
