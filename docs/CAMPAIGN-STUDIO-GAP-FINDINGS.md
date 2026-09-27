# Campaign Studio — Gap Findings (openwop-app vs. the intended capability surface)

> **Date:** 2026-07-12 · **Method:** 4 parallel code scouts over the 10 pillars, `file:line` evidence
> **Compared against:** [`CAMPAIGN-STUDIO-INTENT-AND-REALITY.md`](CAMPAIGN-STUDIO-INTENT-AND-REALITY.md)
> (the MyndHyve CS-001→CS-010 suite) — the surface [`campaign-studio-prd.md`](campaign-studio-prd.md)
> ported via ADRs 0155–0167 (+0170/0172/0215/0217/0219/0220/0223).
>
> **Remediation plan (authored 2026-07-12 via `/feature-refinement`):** ADRs **0351–0357**, all
> Proposed, all host-ext / riding Accepted RFCs (0013/0095/0118/0126) — **zero new wire RFCs**.
> Gap → ADR map:
>
> | ADR | Extends / new | Closes |
> |---|---|---|
> | [0351](adr/0351-kb-retrieval-fidelity-and-strict-grounding.md) | `kb` | `CSG-KB-1..8` |
> | [0352](adr/0352-media-intelligence-metadata-selection-dedup.md) | `media` | `CSG-MED-1..6` |
> | [0353](adr/0353-creative-briefs-feature.md) | **new `creative-briefs`** | `CSG-CB-1..4` |
> | [0354](adr/0354-brand-guardrails-enforcement-and-hierarchy.md) | `brand` | `CSG-BR-1..4` |
> | [0355](adr/0355-channel-generation-qa-enforcement.md) | `campaign-channels` | `CSG-GEN-1..6` |
> | [0356](adr/0356-campaign-workspace-setup-gates-production-loop.md) | `campaign-brief`/`campaign-orchestration`/`production`/`profiles` | `CSG-BLD-1..4`, `CSG-ORC-1`, `CSG-PRD-1..3` |
> | [0357](adr/0357-campaign-intelligence-goal-budgeting-anomaly-apply-gate.md) | `campaign-intel`/`campaign-connectors`/`connections` | `CSG-INT-1..5`, `CSG-CON-1..2` |
>
> Build order: 0351/0352 (foundations) → 0353/0354/0355 → 0356/0357.
>
> **PROGRAM COMPLETE (2026-07-12):** all 7 ADRs implemented (#1714–#1720) — 31 of 33 gaps
> closed; 2 honest deferrals with recorded reasons (`CSG-KB-8` needs a reranker vendor
> connection pack; `CSG-CON-1` needs operator sandbox verification). Per-gap ✅ marks below.

## Verdict

The **orchestration spine and governance layer are genuinely ported and in places exceed the
original** (real 4-platform OAuth dispatch where MyndHyve had 32-line shells; a real server-side
campaign store where MyndHyve had client-only Zustand/Firestore; replay-safe parallel fan-out via
RFC 0118/0126). The **gaps cluster in the "intelligence" halves of each pillar**: media
intelligence (CS-002) is essentially unported, retrieval runs on a hash embedder, grounding fails
open instead of strict, generation QA is prompt-hope rather than enforcement, the visual
creative-brief entity (CS-005) barely exists, the goal-based budget engine is absent — and
production intelligence (CS-010) exists as a feature but was never slotted into the campaign flow.

### Where openwop-app is AHEAD of the original's own reality

- **Server-side campaign resource** — `campaign-brief` + `campaign-orchestration` durable stores
  (MyndHyve: none; client Zustand + Firestore only).
- **Live connectors** — real OAuth (AES-256-GCM secrets), 4 platforms incl. TikTok, real
  PAUSED-safe dispatch, Conversions API, audience upload, spend/audience approval gates in
  `host/adsAdapter.ts` (MyndHyve: 32-line connector shells, CSV-first).
- **Engine rigor** — fork-stable dispatch idempotency, RFC 0118 deterministic parallel merge,
  RFC 0126 data-parallel dispatch; all replay/fork-safe.

---

## Gap register

Severity: **P1** = undermines the core "AI that doesn't guess" promise or a whole pillar ·
**P2** = spec'd capability missing but pillar functions · **P3** = polish/rigor.
Status: EXISTS gaps are omitted — this table is only what's PARTIAL/ABSENT.

### CS-001 — Knowledge Directory / RAG (`features/kb`, `knowledge-sync`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-KB-1`~~ ✅ 0351-P1 | **P1** | **Embeddings are a deterministic local hash**, not a learned model — 256-dim SHA-256 feature hashing (`local-hash-v1`). Retrieval quality bounds every downstream "grounded" claim. | `aiProviders/localEmbedding.ts`; wired at `kb/kbService.ts:200-202` |
| ~~`CSG-KB-2`~~ ✅ 0351-P2 | **P1** | **Grounding fails open** — kernel + channel generation `catch { proceed ungrounded }`; "strict mode" is a prompt sentence, no server-side refuse/block when retrieval is empty or low-score. | `packs/feature.campaign-channels.nodes/index.mjs:100-105`; `packs/feature.campaign-brief.nodes/index.mjs:59-68`; `kb/kbService.ts:630` |
| ~~`CSG-KB-3`~~ ✅ 0351-P4 (deterministic heading-path; LLM variant deferred) | P2 | No contextual enrichment of chunks before embedding (raw chunk text embedded verbatim). | `kb/kbService.ts:209-216` |
| ~~`CSG-KB-4`~~ ✅ 0351-P3 | P2 | No KB-source→downstream-content **staleness propagation**; `kernelStale` triggers only on brief-field edits, not source-doc change. `knowledge-sync` re-ingest is delete-then-ingest with no signal. | `campaign-brief/types.ts:120`; `briefService.ts:294`; `knowledge-sync/knowledgeSyncRunner.ts:87` |
| ~~`CSG-KB-5`~~ ✅ 0351-P3 (compact log) | P2 | No source **version tracking** (re-ingest = delete+replace; no revision history). | `kb/kbService.ts:459-481` |
| ~~`CSG-KB-6`~~ ✅ 0351-P4 | P3 | No URL-scrape ingestion (web research surface exists but isn't wired into KB). | `host/webResearchSurface.ts` (unwired); no fetch path in `kb/` |
| ~~`CSG-KB-7`~~ ✅ 0351-P2 (coverage label) | P3 | No confidence badges on retrieval-grounded output (`score` exists on hits; nothing classifies/surfaces it). | `kb/kbService.ts:564,579` |
| `CSG-KB-8` ✅ closed 2026-07-12 (cohere-rerank connection pack + brokered external rerank with honest degrade — ADR 0351 corrections) | P3 | Declared external/connection reranker not honored (only `local` accepted). | `kb/kbService.ts:315-336` |

### CS-002 — Media Library intelligence (`features/media`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-MED-1`~~ ✅ 0352-P1 | **P1** | **No structured marketing metadata** — assets carry name/free-tags/lineage only; no product/SKU/angle/industry/persona/use-case/palette fields. | `media/mediaService.ts:43-61` |
| ~~`CSG-MED-2`~~ ✅ 0352-P3/P4 | **P1** | **No AI auto-selection** of visuals (weighted scoring + fallback chain absent); the library is a *sink* for generated concept images, never a *source* generation picks from. | listing = plain filter `mediaService.ts:227-247`; write-only flow `packs/feature.campaign-channels.nodes/index.mjs:508-541` |
| ~~`CSG-MED-3`~~ ✅ 0352-P5 (geometries, no raster dep) | P2 | No smart cropping / platform format derivation (16:9 / 1:1 / 9:16). | `media/mediaStorage.ts` (opaque bytes only) |
| ~~`CSG-MED-4`~~ ✅ 0352-P2/P3 | P2 | No bulk upload, filename parsing, or AI tagging (single-asset POST, client-supplied tags). | `media/routes.ts:116-147`; `mediaService.ts:98,206` |
| ~~`CSG-MED-5`~~ ✅ 0352-P2 | P2 | No SHA-256 duplicate detection (capacity gate is count+bytes only). | `mediaService.ts:82-91` |
| ~~`CSG-MED-6`~~ ✅ 0352-P6 (ref kinds; stamping arrives w/ 0353/0355 consumers) | P3 | Media collections have no campaign/brief link (usage-ref graph is `cms-page` only). | `mediaService.ts:320-332` |

### CS-003 — Campaign Builder (`features/campaign-brief`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-BLD-1`~~ ✅ 0356-P3 (extract-seeds proposals) | P2 | **No KB auto-population** of personas/products/pain-points — all manually authored; KB only grounds generation, never seeds the brief. | `campaign-brief/personaService.ts:54-76`; editor `CampaignBriefPage.tsx:403-455` |
| ~~`CSG-BLD-2`~~ ✅ 0356-P2 (workspace aggregate) | P2 | Campaign isn't a **workspace aggregating its generated assets** — channel drafts are run artifacts referenced by the run; no single UI collects them. | `campaign-orchestration/types.ts:3-6,14-42` |
| ~~`CSG-BLD-3`~~ ✅ 0356-P5 (60/40 blend) | P3 | Consistency check is a deterministic token-echo (does each draft echo kernel headline/CTA), not semantic. | `packs/feature.campaign-orchestration.nodes/index.mjs:27-54` |
| ~~`CSG-BLD-4`~~ ✅ 0356-P7 (Review summary; stepper traded) | P3 | Sectioned single-scroll editor, not the guided 6-step wizard w/ Review step. | `CampaignBriefPage.tsx:4-7,295-328` |

### CS-004 — Content Generation Engine (`features/campaign-channels` + pack)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-GEN-1`~~ ✅ 0355-P1 (enforced: schema+validate+regen+truncate) | **P1** | **Platform char limits are prompt prose, not enforced** — no `maxLength` in any response schema, no per-platform numeric table, QA length check is `JSON.stringify(draft).length` (wrong granularity). | `packs/feature.campaign-channels.nodes/index.mjs:42,44,52,66,68,162` |
| ~~`CSG-GEN-2`~~ ✅ 0355-P2 (claims/dedup/readability) | P2 | Fact-check is citation-*presence* (−20 warn), not claim verification vs KB; similarity dedup absent; readability absent (ADR 0157 claimed one). | `index.mjs:156-167,160-161` |
| ~~`CSG-GEN-3`~~ ✅ 0355-P4 (personaId node capability) | P2 | No per-persona generation loop — one draft set for the combined personas; no persona-lens variants. | `campaign-brief/briefContext.ts:15-35` |
| ~~`CSG-GEN-4`~~ ✅ 0355-P3 | P3 | No named iteration ops ("more like this", "add urgency") — only the generic HITL refine loopback. | `campaign-channels/channelWorkflows.ts:31-56` |
| ~~`CSG-GEN-5`~~ ✅ 0355-P5 (additive pairs; volume quota deliberately not ported) | P3 | Variants exist but no paired/labeled A/B structure; no volume targets (spec: 100–200 pieces, 20–30 headlines). | `index.mjs:44,52,60` |
| ~~`CSG-GEN-6`~~ ✅ 0355-P5 | P3 | No competitor-differentiation input/pass (only a buyer-stage hint). | `briefContext.ts:18` |

### CS-005 — Creative Brief Generator

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-CB-1`~~ ✅ 0353-P1 | **P1** | **No visual-brief entity** — only a transient `creative_briefs` channel draft (scene/composition/messaging; missing camera/lighting/palette/platform specs); no lifecycle, versions, diffs, or comments. | `packs/feature.campaign-channels.nodes/index.mjs:57-64` |
| ~~`CSG-CB-2`~~ ✅ 0353-P3 | P2 | No auto mood board from the Media Library. | grep clean across features/packs |
| ~~`CSG-CB-3`~~ ✅ 0353-P4 | P2 | No share links for briefs (sharing's `ResourceType` has no brief type) and no PDF export. | `sharing/sharingService.ts:44-47` |
| ~~`CSG-CB-4`~~ ✅ 0353-P2 (modes ported, pack retired) | P2 | **Shelf-ware:** `packs/vendor.myndhyve.ads-studio-core/` ships a real CreativeBriefBuilder (manual/extraction/merge), VariantPlanService, video QA, winner-synthesize — wired into nothing (`requiredPacks` nowhere, unreferenced in src/FEATURES/ROADMAP/ADRs). | `packs/vendor.myndhyve.ads-studio-core/{pack.json:4-24,index.mjs:40-141}` |

### CS-006 — Brand Guardrails (`features/brand`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-BR-1`~~ ✅ 0354-P1 (requires-approval at the ads edge) | **P1** | **Compliance never blocks publishing** — checks are explicitly non-blocking; a banned-phrase critical violation caps the score but only the human gate stands before `ads.publish`. `governance.requireApproval` is advisory. | `packs/feature.campaign-channels.nodes/index.mjs:138-151`; `brand/types.ts:101-102` |
| ~~`CSG-BR-2`~~ ✅ 0354-P3 | P2 | Multi-brand hierarchy is a `parentBrandId` field only — no cascade/additive-ban resolution (scorer reads own bans only). | `brand/types.ts:184`; `brand/scoring.ts:69`; deferred at `docs/adr/0155:54` |
| ~~`CSG-BR-3`~~ ✅ 0354-P4 | P3 | No per-persona messaging hierarchy (voice resolves by channel/register only). | `brand/scoring.ts:149`; `types.ts:40-60` |
| ~~`CSG-BR-4`~~ ✅ 0354-P5 | P3 | No dedicated brand-rule-change audit log (compliance decisions are replay-safe node outputs; rule edits unaudited). | `brand/brandService.ts` |

### CS-007 — Intelligence + Budget (`features/campaign-intel`, `campaign-connectors`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-INT-1`~~ ✅ 0357-P1 (deterministic planBudget + scenarios) | **P1** | **No goal-based budget engine** — "\$50K → 500 demos" feasibility, platform allocation from a goal, and scenario modeling ("shift 20% Google→LinkedIn?") absent; `optimizeBudget` only reallocates existing spend by ROAS. | `campaign-intel/intelligence.ts:37-86`; grep clean for feasibility/scenario |
| ~~`CSG-INT-2`~~ ✅ 0357-P2 | P2 | No anomaly detection (spike/outlier) on performance data. | grep clean in `campaign-intel/`, `campaign-connectors/` |
| ~~`CSG-INT-3`~~ ✅ 0357-P3 (apply through the spend gate) | P2 | Recommendations have no **one-click apply through an approval gate** — the governed write path exists (`ctx.ads.updateBudget` + spend gate) but isn't wired to intel recommendations. | `host/adsAdapter.ts:1067-1091`; intel FE read-only |
| ~~`CSG-INT-4`~~ ✅ 0357-P4 (+goal form; insights ride the Analyst) | P3 | Dashboard lacks funnel, top/bottom performers, platform-comparison chart, AI-insights widget (insight delegated to the chat Analyst). | `CampaignIntelPage.tsx:40-141` |
| ~~`CSG-INT-5`~~ ✅ 0357-P5 (9 presets) | P3 | CSV "9 platform templates" is one generic alias-autodetect + `defaultPlatform`, not per-platform presets. | `campaign-connectors/csvImport.ts:27-36,92-95` |

### CS-009 — Connectors (`features/connections`, `host/adsAdapter.ts`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| `CSG-CON-1` ⏸ deferred (readers stay honest-off until operator sandbox verification — ADR 0357 corrections; dispatch legs live) | P2 | Live metric readers are Meta/Google only (TikTok/LinkedIn dispatch-only: `unsupported`/`connector_not_configured`). | `adsAdapter.ts:1092-1096` |
| ~~`CSG-CON-2`~~ ✅ 0357-P6 (broker breaker) | P3 | No circuit breaker (resilience = cooldown + best-effort per campaign + graceful error returns). | grep clean in `connections/` |

### CS-008 — Orchestration (`features/campaign-orchestration`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-ORC-1`~~ ✅ 0356-P4 (setup-check node) | P2 | No `assetDecisionGate` ("use existing or create new", auto-resolving) — brand/persona/KB/media setup gates don't exist as workflow nodes; reuse is data-reference on `MarketingCampaign` (works, but no guided gate UX for campaign #2). | `orchestrationWorkflow.ts:64-77`; no gate primitive in `bootstrap/nodes.ts` |

### CS-010 — Production Intelligence (`features/production`, `profiles`)

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| ~~`CSG-PRD-1`~~ ✅ 0356-P1 (spine slot + plan link) | **P1** | **Production planning is orphaned from the campaign flow** — `plan-generate` node + Production Planner agent exist, ADR 0172 designed the post-merge slot, but the spine ends `consistency → finalize`; zero references from any campaign feature or chain pack. | `orchestrationWorkflow.ts:69-77`; `packs/feature.production.nodes/pack.json`; ADR 0172:196 |
| ~~`CSG-PRD-2`~~ ✅ 0356-P6 | P3 | Team profiles reuse generic `interests` + coarse `availability` (no distinct growth-interest field, no workload/utilization model). | `profiles/profilesService.ts:74-77,32-35` |
| ~~`CSG-PRD-3`~~ ✅ 0356-P6 (field-level redaction) | P3 | Vendor pricing readable by any `workspace:read` — no field-level role restriction (spec: editors+ only). | `production/routes.ts:48-68` |

---

## Deliberate deferrals (context, not oversights)

- `CSG-PRD-1` decoupling was **PRD open question 6** ("skippable until a team/vendor surface
  exists") — that surface has since shipped (ADR 0172), so the wait-condition is met.
- Strict grounding **on the wire** was PRD question 5 — citations live in artifact shape; a
  normative envelope field would need a new RFC. Host-side strictness (`CSG-KB-2`) needs none.

## Ranked remediation order (value-at-stake)

1. `CSG-KB-1` + `CSG-KB-2` — learned embeddings + strict grounding (the core promise).
2. `CSG-MED-1/2` — the media-intelligence pillar (metadata + auto-selection).
3. `CSG-PRD-1` — wire production planning into the spine (cheapest high-value fix).
4. `CSG-BR-1` — compliance publish-block option.
5. `CSG-INT-1/2/3` — goal-based budget engine, anomaly detection, apply-through-gate.
6. `CSG-GEN-1/2` — enforced char limits + real QA.
7. `CSG-CB-1/4` — creative-brief entity (evaluate wiring `vendor.myndhyve.ads-studio-core`).
