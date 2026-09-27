# Campaign Studio — Intended Capabilities and Implementation Reality

**Scope:** A deep-dive synthesis of everything Campaign Studio was designed to do, drawn from the
customer requirements notes, the CS-001 through CS-010 PRD suite, the executive summary and technical
spec, and an audit of the actual codebase.

**Reference customer profile:** The product was designed around a **B2B industrial-equipment marketing**
use case. The reference product is an **automated order-fulfillment / robotic picking system** sold
into the **grocery** vertical, targeting **Operations Director, CFO, and Store Manager**
personas. All examples below use that profile.

---

## Origin and vision

Campaign Studio began as a set of **7 core requirements** captured in customer notes, which were then
expanded into a formal analysis and finally into a suite of **eleven PRDs (CS-001 through CS-010)**.
Nine were marked complete by 2026-04-01; CS-010 is a draft (with several phases shipped).

### The one-sentence vision

> **"AI that doesn't guess — it builds from your company's actual brain AND learns from your
> real-world performance."**

The goal is to replace generic AI (off-brand, hallucinated, generic marketing) with a **controlled
creative + strategic engine** powered by four pillars:

- **Documentation (truth)**
- **Media (visual execution)**
- **Brand (consistency)**
- **Data (performance & optimization)**

Positioned as "Notion + Midjourney briefs + ChatGPT, mixed with 6sense / Funnel / ad-optimization
tools — unified into one system."

---

## The 7 requirements → the 11 PRDs

| # | Requirement | PRD | Status |
|---|-------------|-----|--------|
| 1 | Centralized Knowledge Directory | **CS-001** | Complete |
| 2 | Media Library | **CS-002** | Complete |
| 3 | Campaign Builder | **CS-003** | Complete |
| 4 | Content Generation Engine | **CS-004** | Complete |
| 5 | Creative Brief Generator | **CS-005** | Complete |
| 6 | Brand Guardrails | **CS-006** | Complete |
| 7 | Campaign Intelligence + Budget Optimization | **CS-007** (+ **CS-009** live connectors) | Complete |
| — | Architectural glue | **CS-008** Composable Workflow | Complete |
| — | "AI trained on your team" | **CS-010** Production Intelligence | Draft / partly shipped |

---

## What each piece was intended to do

### CS-001 — Knowledge Directory (the foundation)

A **RAG pipeline** so every generated word traces back to the company's own documents — product spec
sheets, ROI calculators, industry case studies, persona profiles, competitive intel, brand messaging.

- Bulk upload (PDF/DOCX/PPTX/TXT/MD), URL scraping, raw-text paste; version tracking that flags
  downstream content as stale when a spec changes.
- Pipeline: parse → heading-aware chunk → **Anthropic contextual enrichment** → embed (Vertex
  `gemini-embedding-001`, 768-dim) → store in Firestore with native `findNearest()` vector search +
  keyword search + Vertex re-ranking.
- **Every output cites its sources** via `[src_N]` markers. **"Strict mode"** makes the AI refuse
  rather than hallucinate when the KB lacks coverage; confidence badges and staleness detection
  (6-month default) round it out.
- Key architecture decision: the Knowledge Directory was **unified with the Media Library** — a
  document is a `MediaAsset` of type `document`, and a Collection flagged `isKnowledgeBase: true`
  triggers indexing.

**Storage:** `workspaces/{wsId}/media_assets/`, `/media_collections/`, `/knowledge_chunks/`
(workspace-scoped; chunks are Cloud-Function-write-only). 213 tests.

### CS-002 — Media Library (creative intelligence layer)

The visual counterpart. Structured metadata (product, SKU, angle, background, industry, persona,
use-case, color palette) so **AI auto-selects the right visual** instead of manual browsing.

- **Weighted selection scoring** (product 40% / industry 25% / use 20% / persona 10% / recency 5%)
  with a 5-level fallback chain ending in a generated "go shoot this" visual brief when nothing
  matches.
- **Smart cropping** via Gemini Vision subject detection → platform formats (16:9 LinkedIn, 1:1
  Instagram, 9:16 Stories).
- Bulk upload with filename parsing + AI tagging; **SHA-256 duplicate detection**; collections linked
  to campaigns/brands. 163 tests.

### CS-003 — Campaign Builder (the orchestrator)

A guided **6-step wizard** — Identity → Product → Audience → Channels → Messaging → Review — that
collects a structured brief **once** and fans out coordinated multi-channel content.

- Auto-populates products/personas/pain-points/objections from the KB; suggests the value prop.
- Generates a **Messaging Kernel** (headline, supporting statement, proof point, CTA, per-channel
  tone) that is approved *before* any content is generated.
- The campaign becomes a **persistent workspace** holding all assets, which share context. A
  cross-asset **consistency check** enforces that the landing-page headline echoes the ad headline
  echoes the email subject. 156 tests.

### CS-004 — Content Generation Engine (from source material only)

The deep text engine — **~100–200 discrete pieces per campaign**, all grounded in the KB.

- 20–30 headlines, 10–15 subheads/CTAs, platform-specific ad copy (Google 30/90, Meta 40/125/250,
  LinkedIn 70/150/600), email sequences, social posts, meta descriptions.
- Controls: strict source-lock mode, tone selector, **persona lens** (generate as if speaking to the
  Ops Director vs. CFO), competitor-differentiation mode, A/B variant pairs.
- QA: brand-compliance scoring, readability targeting per persona, character-limit validation,
  similarity dedup, **fact-checking every claim against the KB**.
- 9 iteration operations ("More like this," "Add urgency," "Make more technical") completing in <30s;
  batch approve/reject with feedback that trains the next pass. 62 tests.

### CS-005 — Creative Brief Generator (for visuals)

Closes the messaging→production handoff. For every asset, auto-generates a **structured visual brief**
— scene, composition, camera angle, lighting, brand color palette, messaging intent, platform tech
specs (incl. Meta's 20% text rule), and an **auto-assembled mood board** from the Media Library.

- **2–3 creative-direction variants** per asset (e.g. "product in use" vs. "before/after" vs. "data
  visualization"), each with a persona-psychology rationale.
- Standalone brief entities with lifecycle (draft → review → approved), version history with
  field-level diffs, section-level comments, **PDF export**, and **cryptographic shareable links** so
  an external designer can execute without an account. 58 tests.

### CS-006 — Brand Guardrails (always-on layer)

Designated "critical" by the customer. Extends the Brand entity with machine-readable rules
(positioning, approved taglines, **banned phrases**, messaging hierarchy per persona, per-channel
voice: *LinkedIn = thought leadership, Meta = conversational, Google = direct*).

- **Injected into every AI prompt** as constraints (pre-generation).
- **Every output scored 0–100** (post-generation) — a hybrid of **deterministic rule checks (60%)** +
  **LLM-as-judge (40%)**. Banned phrases are critical violations that cap the score and can block
  publishing.
- Multi-brand hierarchy (parent → product line → campaign), where bans are strictly additive and
  cannot be removed by children. Full audit trail. 43 tests.

### CS-007 — Campaign Intelligence + Budget Optimization (the data layer)

Turns Campaign Studio from a content generator into a **data-driven optimization platform** — the
biggest single requirement, in five sub-parts.

- **(A) Historical import:** CSV upload with platform templates (Google/Meta/LinkedIn) +
  column-mapping wizard, calculated metrics (CTR/CPC/CVR/CPA/ROAS), validation and dedup.
- **(B) Budget recommendation engine:** *"I have $50K for Q2 and need 500 demo requests"* → AI
  calculates feasibility from historical CPA; platform allocation, pacing, bid strategy, scenario
  modeling ("what if I shift 20% Google→LinkedIn?").
- **(C) Live data:** natural-language queries ("How are my Google campaigns performing this week?"),
  anomaly detection, alerts.
- **(D) Dashboard:** KPI cards, spend pacing, platform comparison, top/bottom performers, conversion
  funnel, AI insights feed, forecasting with confidence intervals — plus an embedded chat widget.
- **(E) Predictive engine:** outcome forecasting, **creative-fatigue detection**, seasonal patterns,
  and 7 recommendation categories (scale up/down, pause, refresh creative, reallocate) with one-click
  apply through an approval gate. 124 tests.

### CS-009 — Live Ad Platform Connectors

Fulfills requirement 7C: **OAuth connectors for Google Ads, Meta Ads, LinkedIn Ads** with automated
daily sync (+ on-demand "Sync Now," 15-min cooldown), replacing manual CSV upload. AES-256-GCM token
encryption via Cloud KMS, deduplication, circuit breaker after 5 failures, graceful "Reconnect" on
revoked tokens. 10 tests.

### CS-008 — Composable Workflow Orchestration (the through-line)

The architectural spine. Two engine primitives — **`subworkflow`** (parent triggers child workflows)
and **`assetDecisionGate`** ("use existing or create new"). This delivers the core promise:

> **You create your brand, personas, and knowledge base once.** Every subsequent campaign reuses them.

The campaign flow:

```
start → brand-gate → persona-gate → KB-gate → brief wizard → validate →
generate kernel → approve →
fork into 5 parallel channel sub-workflows (each: generate → quality-check → brand-check → approve) →
merge → consistency-check → finalize
```

Decision gates **auto-resolve** when an asset is already chosen — so campaign #2 for a new persona
takes minutes, not hours. 50 tests.

### CS-010 — Production Intelligence ("the AI trained on your marketing team")

The newest, most distinctive layer (draft). It addresses the #1 failure point: campaigns dying between
"brief approved" and "production started." Customer framing:

> *"You've never run a video production team before, but we'll give you the insight to get your
> projects done."*

Three new knowledge layers:

- **Self-service Team Profiles** (the core innovation): each member documents their own **growth
  interests, workload, preferred work** — so the AI can say *"Your designer Catherine mentioned she'd
  like more creative print work this year — this project is a direct match for her growth goals."*
  Split into a manager-controlled doc + a self-service subcollection so members can only edit their own
  aspirations.
- **Team Settings + Vendor Database:** facilities/equipment, budget defaults, and a contractor/agency
  roster with pricing and past-project ratings (editors+ read only — sensitive pricing).
- **Production Plans:** for each asset, a recommendation to go **internal / contractor / agency /
  hybrid**, with budget, timeline, team-member matches (surfacing growth alignment), and matching
  vendors.

**Example production plan (product-launch campaign):**

> **Talking-head video — Hybrid.** Film the interview internally in Studio A with video editor Marcus
> (senior, 8 yrs). Outsource the 3D warehouse animation to Alex Chen (preferred contractor, $85/hr,
> previously delivered "Warehouse Automation Explainer," rated excellent). **Budget: $3,000–$4,000.
> Timeline: 2–3 weeks.**
>
> **Social graphics package — Internal.** Designer Catherine (advanced, 5 yrs) — note she recently
> added "creative print ads" to her growth interests, a direct match. **Budget: ~$400. Timeline: 1
> week.**

New workflow node `cs.production.planGenerate` runs **sequentially after the merge node** (so it sees
all generated assets). New `production.plan.create` envelope. `BriefContextAssemblyService` extended
with `teamCapabilitySection` (500 tok) + `vendorSection` (500 tok). Phase 7 (future) would web-search
Upwork/agencies via an MCP tool.

---

## Intent vs. reality (what is actually shipped)

A codebase audit confirms **the vast majority is genuinely built and deep**, with a few honest
caveats.

### Real and deep (production-shaped)

- 6-step brief wizard, messaging kernel, and campaign builder — real, backed by Firestore stores.
- Multi-channel content generation — **real Claude calls** via `AIOrchestrationService`, with a
  graceful synthetic-mock fallback if live AI is disabled.
- Creative briefs (full editor: versioning, mood boards, comments, approvals, public sharing) and the
  deep `ads-studio/` creative engine (per-platform specs for 9 platforms).
- Brand guardrails — the hybrid 60% deterministic + 40% LLM scorer is real.
- Workflow/node orchestration — ~70 registered nodes and many seeded DAGs; the richest, best-tested
  area.
- Envelope-driven chat/AI, personas, playbooks/learnings, the intelligence dashboard UI, and a
  substantial **published-page analytics backend** (heatmaps, sessions, KPIs).

### Partial / scaffolded

- **Live ad-platform connectors:** the generic OAuth proxy works, but the concrete `MetaConnector`,
  `GoogleAdsConnector`, etc. are **32-line shells**. The reliable data path today is **CSV/manual
  import**, not live sync.
- Some dashboards ship with **sample/seed data** until real data is imported.
- The AI advisor soft-fails to an empty `stub` result on error rather than hard-failing.

### Misleadingly named

- The backend **`campaignStudioApi` is the old Landing Page CMS API renamed** — its routes are still
  `/landing-pages/...`, and there is **no server-side "campaign" resource**. The entire campaign domain
  lives in client-side Zustand + Firestore. (Campaign Studio itself is the renamed successor to the
  Landing Page canvas; several schemas still carry `LANDING_PAGE_*` internals.)

### Recurring gap

- The CS-002 **usage-tracking rollback (2026-05-17)** left several features without "used in N
  campaigns" awareness or creative-fatigue-to-asset correlation — an open dependency touching
  CS-003/004/005/007.

### Data-model scoping drift

- CS-001's ADR and CS-002/003 moved everything to **workspace scope**, but several PRD bodies (CS-001
  PRD, CS-004, CS-005, CS-007 data models, CS-006 audit paths) still show **`users/{userId}/`** paths.
  Implementation notes reconcile these to workspace scope, but the written data models are
  inconsistent.

### Two coexisting workflow generations

- V1 28-node monolith (`campaignBriefWorkflow.ts`, preserved for back-compat) and V2 16-node
  composable (`campaignOrchestrationWorkflow.ts`, default). CS-006's brand check and CS-004's quality
  check live in both.

---

## By the numbers (as reported at delivery)

| Metric | Value |
|--------|-------|
| Requirements delivered | 7 of 7 + live connectors bonus |
| PRDs completed | 9 (CS-001 → CS-009); CS-010 draft |
| Automated tests passing | 879 |
| Content channels | 5 (landing page, ads, email, creative briefs, social) |
| Ad platforms — live connectors | 3 (Google, Meta, LinkedIn) |
| Ad platforms — CSV import | 9 (Google, Meta, LinkedIn, TikTok, X, Pinterest, Snapchat, Reddit, YouTube) |
| AI quality gates per channel | 2 (content quality + brand compliance) |

---

## Bottom line

Campaign Studio was intended to be — and largely is — a **knowledge-grounded marketing operations
platform** where a company's product docs, brand rules, personas, and performance data are configured
*once*, then every multi-channel campaign is generated from that "company brain,"
brand-compliance-scored automatically, and continuously optimized against real ad-spend data. CS-010
pushes it one step further into "the AI trained specifically on *your* marketing team," planning not
just *what* to make but *who* should make it and *what it costs*.

The primary reality gaps versus the intended surface are **live ad-platform data sync** (CSV-first in
practice) and a **server-side campaign API** (client/Firestore in practice).

---

## Source documents

- `PRDs/campaign-studio-*-requirements.md` (original + expanded requirements)
- `PRDs/CS-001` through `PRDs/CS-010` (feature PRDs)
- `docs/CAMPAIGN_STUDIO_EXECUTIVE_SUMMARY.md`
- `docs/CAMPAIGN_STUDIO_TECHNICAL_SPEC.md`
- Codebase: `src/canvas-types/campaign-studio/`, `src/seeds/workflows/campaign-studio/`,
  `functions/src/campaign-studio-api/`, `src/core/{knowledge,media,brands,team,vendors}/`
