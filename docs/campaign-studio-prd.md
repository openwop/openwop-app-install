# PRD — Campaign Studio: the composable multi-channel marketing workflow

| Field | Value |
|---|---|
| **Status** | Draft (planning) — authored via `/prd` 2026-06-27 |
| **Owner** | David Tufts |
| **Source** | MyndHyve **Campaign Studio** (Bryce / FlashPick, first customer). PRDs `CS-001`…`CS-010` + `campaign-studio-bryce-requirements-expanded.md`; the orchestration workflow `src/seeds/workflows/campaign-studio/campaignOrchestrationWorkflow.ts` (CS-008). |
| **Target** | openwop-app host. Self-contained feature package(s) per ADR 0001, gated by server-authoritative toggles, surfaced through the existing run/chat/notification surfaces. |
| **Wire dependency** | **RFC 0118** (`../openwop/RFCS/0118-parallel-subworkflow-fan-out-and-join.md`) — parallel sub-workflow fan-out. Everything else rides **already-Accepted** RFCs. |
| **Proposed ADR cluster** | **0155–0160** (next free after 0154). Author each with `/architect` before/with implementation. |

> **Read first:** [`FEATURES.md`](../FEATURES.md) § feature-toggle system, [`docs/adr/0001-feature-first-package-architecture.md`](adr/0001-feature-first-package-architecture.md), and the memory rule **"Build ON orchestration, not parallel surfaces"**. Campaign Studio is the largest single composition the port has attempted; its value is that it is *almost entirely composition* of features that already shipped. The discipline of this PRD is to add the marketing-specific layer and **nothing that duplicates** KB, Media, Email, CRM, Analytics, or Connections.

---

## 1. What the source workflow actually is

The "super complex marketing workflow" Bryce got is the **Campaign Studio composable orchestration** (CS-008): a 20-node parent workflow (`campaign-studio.campaign-orchestration`, v2.1.0) that turns a one-time setup of brand + persona + knowledge base into repeatable, multi-channel, brand-compliant, knowledge-grounded campaigns. It is the thing that makes campaign #2 take minutes instead of hours.

### 1.1 The parent flow (node-by-node)

```
start (manual trigger)
  → brand-gate          (setup.brand.gate — HITL: use existing brand or create new; REQUIRED)
  → persona-gate        (core.workflow.assetDecisionGate — HITL: pick persona, filtered by brandId)
  → kb-gate             (setup.knowledgeBase.gate — HITL: pick/skip a KB collection)
  → media-gate          (setup.media.gate — HITL: confirm/upload product imagery)
  → brief-creation-gate (brief.creation.gate — pre-populates a brief w/ the 4 selections, opens the brief wizard, waits)
  → brief-validate      (brief.validate — completeness + KB coverage; SETS the `enabledChannels` variable)
  → kernel-generate     (brief.kernel.generate — AI: the "messaging kernel" — the shared strategic foundation)
  → kernel-approval     (core.chat.approvalGate — HITL: approve/refine the kernel; refine loops back)
  → channel-fork        (core.control.parallel)
      ⟂  5 PARALLEL channel sub-workflows (each a standalone child workflow):
         sw-landing-page    → campaign-studio.channel.landing-page
         sw-ad-variants     → campaign-studio.channel.ad-variants
         sw-email-sequence  → campaign-studio.channel.email-sequence
         sw-creative-briefs → campaign-studio.channel.creative-briefs
         sw-social-posts    → campaign-studio.channel.social-posts
      (each fork→child edge is GATED: condition `enabledChannels contains <channel>` — disabled channels never start)
  → channel-merge       (core.control.merge — join on all enabled channels)
  → production-plan      (brief.production.plan — AI: per-asset routing/budget/team; skippable)
  → production-plan-approval (core.chat.approvalGate — HITL)
  → consistency-check   (brief.consistency.check — AI LLM-as-judge vs the kernel; minConsistencyScore 80)
  → finalize            (brief.campaign.finalize — creates the MarketingCampaign entity)
```

Each **channel child workflow** (built by one factory, `channelWorkflowFactory.ts`) is the same 5-node shape:

```
start → generate (channel AI generator) → quality-check (content.quality.check)
      → brand-check (brand.compliance.check) → approval (core.chat.approvalGate)
      ↺ approval --refine--> generate   (feedback loopback)
```

Per-item refine (`itemsFrom`) lets a user accept a subset (e.g. 3 of 5 emails, one platform's ad set) and refine the rest — the "Partial Accepter" archetype.

### 1.2 The two engine primitives CS-008 had to add (and where openwop-app stands)

| Primitive | MyndHyve | openwop-app wire status |
|---|---|---|
| **Runtime sub-workflow** (parent run → child run w/ `parentRunId`, blocking, input/output mapping, `onChildFailure`) | `core.control.subworkflow` executor | **Already specified** — `core.subWorkflow` (RFC 0007/0022), attestation (0063), ancestry (0040). No gap. |
| **Parallel channel fan-out + join** (`core.control.parallel` → N children concurrently → `core.control.merge`) | DAG scheduler fork/merge, conditional channel-skip edges | **GAP** — RFC 0007 §K3 defers `fanOutPolicy: 'parallel'`. Closed by **RFC 0118** (this PRD's only new wire surface). |
| **Asset decision gate** (HITL "use existing or create new", auto-resolves from a pre-set variable) | `core.workflow.assetDecisionGate` + `setup.*.gate` | **Expressible today** as an interrupt (RFC 0104 HITL routing + chat-card-packs) — host node, no RFC. |
| **Approval gate w/ refine loop + per-item** | `core.chat.approvalGate` | **Exists** — HITL interrupt + `HitlDecisionCard`; per-item is a chat-card detail. |

### 1.3 The data/integration layer the workflow depends on

- **Knowledge grounding (RAG):** every generator assembles context via `BriefContextAssemblyService` — KB chunks (≈3000-token budget), brand voice, persona — and every output carries `[src_N]` **citations** (`sourceDocIds`). Strict mode = "KB only, say so if coverage is thin."
- **Brand model + guardrails:** a rich `Brand` entity (voice profile, formality 1–5, tone registers, banned/approved phrases, positioning, per-channel voice rules). Compliance is scored 0–100 = deterministic (banned-phrase/formality) 60% + LLM 40%.
- **Messaging kernel:** `{ headline, supportingStatement, proofPoints[], primaryCta, secondaryCta, tone, channelTones{}, sourceDocIds[] }` — the single source of truth all five channels echo; consistency-check scores every asset against it.
- **Live ad connectors (CS-009):** Google Ads / Meta Ads / LinkedIn Ads OAuth, daily sync, "Sync Now" (15-min cooldown), dedup (`platform|campaign|adSet|date`), unified metrics (spend/impr/clicks/conv/revenue → ctr/cpc/cvr/cpa/roas).
- **CSV import (CS-007):** column-mapping wizard, 9 platform templates, validation (clicks≤impr, conv≤clicks), dedup, computed fields.
- **Campaign intelligence (CS-007/010):** KPI dashboard, budget recommendation engine (heuristic + AI scenarios), forecasting (creative fatigue, scaling), NL queries, alerts/digests.

---

## 2. Reuse map — what already shipped vs. what's net-new

The port's discipline lives in this table. **Left column = do NOT rebuild.**

| MyndHyve piece | openwop-app home (REUSE) | Net-new in this PRD |
|---|---|---|
| Knowledge Directory / RAG, citations | **ADR 0011 `kb`** (RAG, chunks, retrieval) + **0038/0042** per-subject knowledge | A brief-scoped **context assembler** that composes `kb` retrieval + brand + persona into a grounded prompt with `[src_N]` citation passthrough |
| Media Library, tagging, smart crop | **ADR 0007 `media`** | AI **media-selection / mood-board** matcher (scores library assets to a creative brief) |
| Email sequences/campaigns | **ADR 0019 `email`** (campaigns over CRM) | The **email-sequence channel generator** (kernel→drip) emits drafts *into* `email`; no parallel send system |
| Landing pages, blocks, SEO | **ADR 0009 `cms` / page-builder** + **0012 `publishing`** | The **landing-page channel generator** emits page content into the page-builder |
| Audience / contacts / personas | **ADR 0008 `crm`** (contacts, tags, segments) | A marketing **`Persona`** model (buyer stage, objections) — distinct from a CRM contact |
| Analytics, measurement | **ADR 0018 `analytics`** | Campaign **performance store** + KPI projection (ad-spend metrics analytics doesn't track) |
| External credentials / OAuth | **ADR 0024 `connections`** + **0033/0037** RFC 0095 connection packs | **Connection packs** for Google/Meta/LinkedIn Ads + a daily **sync node** |
| Workflow engine, HITL, approval, sub-workflows | core host + **RFC 0007/0022/0063** + RFC 0104 HITL | **Parallel fan-out** (RFC 0118) + the campaign **node pack** (gates, kernel, generators, checks, finalize) |
| AI chat to drive it | **RFC 0005 chat** + **ADR 0073 EmbeddedChatPanel** + agent-pack pattern (ADR 0058) | A **"Campaign Strategist" agent pack** (persona + tool allowlist) — never a new chat panel |
| Workflow packaging | **RFC 0013 workflow-chain packs** (loader landed #960) | The campaign **workflow-chain pack** (parent + 5 channel children) |
| Artifact persistence/typing | **artifact-type-packs.md** | An **artifact-type pack** for kernel / channel drafts / production-plan / consistency-report |

**Net-new is the marketing layer, not the infrastructure.** Brand+guardrails, messaging kernel, channel generators, creative briefs, asset-decision gates, campaign intelligence/budget. Everything they stand on already exists.

---

## 3. Feature decomposition (proposed ADR cluster 0155–0160)

Each is a self-contained ADR-0001 feature package (`backend/src/features/<id>/` + `frontend/src/features/<id>/` + `feature.<id>.*` packs), toggle-gated, authored via `/architect`. Sequenced so each unblocks the next.

| ADR | Feature | Toggle id | Depends on | Packs | RFC gate |
|---|---|---|---|---|---|
| **0155** | **Brand & Guardrails** — `Brand` entity (voice/formality/tone-registers/positioning/banned+approved phrases/per-channel rules); compliance scorer (deterministic+LLM); brand-voice resolver | `brand` | 0001, 0006 (RBAC), 0011 | `feature.brand.nodes` (`brand.compliance.check`, `brand.voice.resolve`), `feature.brand.agents` (Brand Steward) | Rides Accepted (host) — **no RFC** |
| **0156** | **Personas & Campaign Brief** — marketing `Persona` (buyer stage/objections/pain points); the **brief** model + wizard; brief context assembler (kb+brand+persona → grounded prompt w/ citations) | `campaign-brief` | 0155, 0011, 0008 | `feature.campaign-brief.nodes` (`brief.validate`, `brief.kernel.generate`, asset-decision + setup gates, `brief.creation.gate`) | Rides Accepted — **no RFC** |
| **0157** | **Channel Generation** — 5 channel generators (landing/ads/email/creative/social), each grounded + cited; `content.quality.check`; per-item refine; channel child workflows | `campaign-channels` | 0156, 0007, 0009, 0019 | `feature.campaign-channels.nodes` (5 generators + `content.quality.check`), `feature.campaign-channels.workflows` (5 channel chain packs) | Rides Accepted — **no RFC** |
| **0158** | **Campaign Orchestration** — the parent workflow chain pack; production-plan + consistency-check + finalize; the `MarketingCampaign` entity; the **Campaign Strategist** agent pack | `campaign-studio` | 0157, RFC 0013 loader | `feature.campaign-orchestration.{nodes,agents,workflows}` + artifact-type pack | **RFC 0118** (parallel fan-out) — sequential fallback until host advertises `fanOutSupported:true` |
| **0159** | **Live Connectors & Performance** — Google/Meta/LinkedIn Ads connection packs; daily-sync node; CSV import; performance store + dedup + unified metrics | `campaign-connectors` | 0024, 0033, 0037, 0018 | RFC 0095 connection packs (`vendor.*.connections.{google,meta,linkedin}-ads`) + `feature.campaign-connectors.nodes` (`ads.sync`, `ads.import.csv`) | Rides Accepted RFC 0095 — **no RFC** |
| **0160** | **Campaign Intelligence** — KPI dashboard projection; budget recommendation engine (heuristic+AI); forecasting (fatigue/scaling); NL queries via the Strategist agent; alert/digest rules over Notifications | `campaign-intel` | 0158, 0159, 0018, 0010 (notifications) | `feature.campaign-intel.nodes` (`budget.optimize`, `performance.forecast`), agent tools | Rides Accepted — **no RFC** |

> **Why six, not one:** each maps to a Bryce requirement cluster and ships independently behind its own toggle. 0155–0158 are the MVP composable workflow; 0159–0160 are the intelligence/data layer (Bryce's Phase 2–3). A reviewer can accept and ship 0155 (Brand) without 0158 (Orchestration) existing.

---

## 4. The orchestration workflow as openwop artifacts (ADR 0158, the heart)

### 4.1 Parent chain pack (`feature.campaign-studio.workflows` → `campaign-studio.campaign-orchestration`)

Authored as an **RFC 0013 workflow-chain pack**. Node typeId mapping from MyndHyve → openwop:

| MyndHyve node | openwop node typeId | Notes |
|---|---|---|
| `setup.brand.gate` | `feature.brand.nodes.gate` | asset-decision specialization (existing-or-create), HITL interrupt |
| `core.workflow.assetDecisionGate` (persona) | `feature.campaign-brief.nodes.persona-gate` | filtered by `brandId` input; auto-resolves from a pre-set `personaId` var |
| `setup.knowledgeBase.gate` | `feature.campaign-brief.nodes.kb-gate` | composes `kb` collections; optional/skippable |
| `setup.media.gate` | `feature.campaign-brief.nodes.media-gate` | composes `media`; optional |
| `brief.creation.gate` | `feature.campaign-brief.nodes.brief-gate` | pre-populates brief, opens wizard, suspends |
| `brief.validate` | `feature.campaign-brief.nodes.validate` | **sets `enabledChannels`** variable |
| `brief.kernel.generate` | `feature.campaign-brief.nodes.kernel` | AI envelope `brief.kernel.create`; artifact `campaign-brief.kernel` |
| `core.chat.approvalGate` | `core.chat.approvalGate` (host) | reuse; refine loopback edge |
| `core.control.parallel` → 5× `core.control.subworkflow` → `core.control.merge` | **`core.dispatch` w/ `fanOutPolicy:'parallel'`, `joinPolicy:{mode:'wait-all',onChildFailure:'collect'}`** (RFC 0118) | the one new wire feature; **fallback `'sequential'` until host advertises `fanOutSupported`** |
| `brief.production.plan` / `brief.consistency.check` / `brief.campaign.finalize` | `feature.campaign-orchestration.nodes.{production-plan,consistency-check,finalize}` | AI + deterministic |

**Conditional channel skip:** MyndHyve gates fork→child edges on `enabledChannels contains <channel>`. On the openwop wire, the orchestrator's `next-worker` decision simply **chooses which `nextWorkerIds` to include** (RFC 0118 §G9/gap-register confirms no per-child predicate field is needed) — `brief.validate` sets `enabledChannels`, the dispatch-driving supervisor reads it and emits only the enabled children. Disabled channels are never dispatched.

### 4.2 Channel child chain packs (`feature.campaign-channels.workflows`)

Five chain packs from one factory shape, IDs `campaign-studio.channel.{landing-page,ad-variants,email-sequence,creative-briefs,social-posts}`. Each: `start → generate → content.quality.check → brand.compliance.check → core.chat.approvalGate (↺ refine)`. Each is **independently runnable** (single-channel generation) AND dispatchable as a child — exactly the MyndHyve property.

### 4.3 Artifacts (artifact-type pack)

`campaign-brief.kernel`, `campaign-brief.{landing-page,ads,email,creative,social}`, `production-plan`, `consistency-report`, `marketing-campaign`. Each carries `citations[]` (`{docId, docTitle, marker}`) so any headline traces to its KB source — the grounding contract.

### 4.4 AI generation envelopes

Channel generators emit typed AI envelopes (`brief.<channel>.create`) consumed by the host AI loop; the kernel emits `brief.kernel.create`. These ride the existing **ai-envelope.md** surface — no new envelope wire type. Grounding/citations live in the *artifact shape* (host concern), not the wire.

---

## 5. Driving it from AI chat (no second chat — ADR 0058/0073)

Per CLAUDE.md "AI chat — reuse, never recreate": Campaign Studio ships a **"Campaign Strategist" agent pack** (`feature.campaign-studio.agents`) — a persona + a `toolAllowlist` over the campaign node tools (`kernel`, the 5 generators, `budget.optimize`, `performance.forecast`, `ads.sync`). The campaign UI deep-links the main chat scoped to that agent (`navigate('/?agent=campaign-strategist')`) or embeds the shared **`EmbeddedChatPanel`** with `agentId="campaign-strategist"`. HITL gates (kernel approval, channel approvals, budget approval) surface as the existing interrupt **decision cards** in that thread. Natural-language intelligence ("allocate my $5k across platforms by historical ROAS") is the Strategist calling `budget.optimize` — not a bespoke analytics chatbox.

---

## 6. Phasing (mapped to Bryce's MVP / Phase-2 / Phase-3)

| Phase | Ships | ADRs | Gives Bryce |
|---|---|---|---|
| **P1 — Composable MVP** | Brand+guardrails, persona+brief+kernel, the 5 channel generators (sequential fan-out fallback), grounded generation w/ citations, consistency+finalize | 0155, 0156, 0157, 0158 (seq) | "Define brand+persona+KB once; generate 5 channels of cited, on-brand content per campaign." The core workflow, end-to-end, correct (just serialized). |
| **P1.5 — Parallel** | Flip to `fanOutPolicy:'parallel'` once host advertises `fanOutSupported:true` (RFC 0118 implemented) | 0158 (parallel) | ~5× faster campaigns; one channel's approval stall no longer blocks the others. **Config flip, no workflow rewrite.** |
| **P2 — Data layer** | Live ad connectors (Google/Meta/LinkedIn), CSV import, performance store, KPI dashboard, budget recommendations | 0159, 0160 (core) | "Connect ad accounts; daily sync; ask AI where to shift budget." |
| **P3 — Intelligence** | Forecasting (creative fatigue/scaling), NL queries, weekly optimization digests, alerts | 0160 (full) | "Predictive recommendations + automated optimization suggestions." |

**Critical-path dependency:** P1.5 is the only step gated on an external RFC. P1 ships *now* against the Accepted spec with `fanOutPolicy:'sequential'`; the parallel upgrade is a one-line config change in the parent chain pack once RFC 0118 lands and the host advertises the capability. This is deliberate — the port is never blocked on the wire.

---

## 7. Evaluation against the feature matrix

| Dimension | Verdict |
|---|---|
| **Feature-package architecture (ADR 0001)** | ✅ 6 self-contained packages, each backend+frontend+packs, no parallel surfaces — composes kb/media/email/crm/cms/analytics/connections. |
| **Toggle / admin** | ✅ 6 server-authoritative toggles (`brand`, `campaign-brief`, `campaign-channels`, `campaign-studio`, `campaign-connectors`, `campaign-intel`), OFF by default, `tenant` bucket; auto-register in `/feature-toggles`. |
| **Workflow + node packs** | ✅ Node packs per feature; 6 workflow-chain packs (1 parent + 5 channels) via RFC 0013 loader; artifact-type pack. |
| **AI-chat envelopes + agent packs** | ✅ Campaign Strategist + Brand Steward agent packs; channel/kernel AI envelopes on the existing ai-envelope surface; driven through the ONE chat (deep-link/EmbeddedChatPanel). No new chat. |
| **RBAC** | ✅ Brand governance (lock levels, allowed editors, requireApproval) maps to `accessControl` (RFC 0049); campaign/brief/connection reads gated by `resolveOne(<id>, subject)`. |
| **Replay / fork safety** | ✅ Channels are `core.subWorkflow` children (lineage + attestation); RFC 0118 §G `mergeOrder` guarantees parallel-merge determinism on replay/fork; variant stamps on `run.metadata`. |
| **RFC gate** | ✅ Exactly one new wire dependency — **RFC 0118** (parallel fan-out), Draft authored. Everything else rides Accepted RFCs (0013/0095/0007/0022/0063/0104/0005). Per CLAUDE.md, no other spec change is needed; the rest is honest host work. |

---

## 8. Open questions / risks

1. **RFC 0118 acceptance timeline.** P1.5 (and the campaign's headline "parallel" value) waits on RFC 0118 → Accepted + host implementation. Mitigated by the sequential fallback (P1 ships without it). Owner: track RFC 0118; openwop-app is the motivating implementer and should commit to the reference-host parallel leg.
2. **`Persona` vs CRM contact.** A marketing persona (buyer stage/objections) is NOT a CRM contact. Risk of a parallel "audience" model — must compose `crm` segments where audiences are real people, and keep `Persona` as a *content-targeting* abstraction. (ADR 0156 boundary call.)
3. **Email channel ↔ ADR 0019.** The email-sequence generator must emit drafts INTO the existing `email` feature, not a second send pipeline. (Strong "no parallel surfaces" tripwire — ADR 0157.)
4. **Connection-pack honesty.** Advertising Google/Meta/LinkedIn Ads connections requires real broker reachability (ADR 0037 fail-closed). Day-1 honesty matrix per ADR 0033 — advertise `supported:false` until wired.
5. **Grounding strictness on the wire.** Citations live in artifact shape, not the wire. If a future need arises for a *normative* "grounded-generation/citation" envelope field, that is a SEPARATE RFC — explicitly out of scope here.
6. **Production-plan / team-matching** (MyndHyve `brief.production.plan`) pulls team/vendor data openwop-app may not model. Mark it skippable (as MyndHyve does) until a team/vendor surface exists; do not invent one for this PRD.

---

## 9. Deliverables of this planning pass

- **This PRD** — `docs/campaign-studio-prd.md` (the host port plan).
- **RFC 0118** — `../openwop/RFCS/0118-parallel-subworkflow-fan-out-and-join.md` (+ `.gaps.md`, `.risks.md`) — the one proven wire gap.
- **Next steps:** author ADR 0155 (Brand) via `/architect`; add the 6 rows to `ROADMAP.md` + `FEATURES.md`; shepherd RFC 0118 through its comment window. Implementation follows the per-feature lifecycle in `ROADMAP.md` § "Per-feature workflow".

## References

- MyndHyve: `PRDs/CS-008-composable-workflow-orchestration.md`, `campaign-studio-bryce-requirements-expanded.md`, `docs/CAMPAIGN_STUDIO_EXECUTIVE_SUMMARY.md`; `src/seeds/workflows/campaign-studio/{campaignOrchestrationWorkflow.ts,channels/channelWorkflowFactory.ts}`.
- openwop-app: ADR 0001 (feature packages), 0007 (media), 0008 (crm), 0009 (cms/page-builder), 0011 (kb/rag), 0018 (analytics), 0019 (email), 0024/0033/0037 (connections + RFC 0095 packs), 0038/0042 (per-subject knowledge), 0058 (chat-drivability), 0073 (EmbeddedChatPanel); `FEATURES.md`, `ROADMAP.md`.
- openwop spec: RFC 0013 (workflow-chain packs), 0095 (connection packs), 0007 (dispatch), 0022 (i/o mapping), 0063 (sub-run attestation), 0040 (cross-host causation), 0104 (HITL routing), 0005 (conversation primitive); **RFC 0118** (this port's new dependency).
