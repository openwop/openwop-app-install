# ADR 0216 — Campaign Studio: workspace fields (budget · UTM schema · hierarchy) + brief templates

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `campaign-brief` (entity + editor), `campaign-orchestration` (carry-through + hierarchy), `feature.campaign-channels.nodes` (UTM stamping) |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C8** (E1 "campaign workspace" gaps: spend plan, UTM schema, hierarchy, templates) |
| **RFC gate** | **None** — host-ext entity fields + routes only. |
| **ADR numbering note** | Renumbered 0214 → 0216 at rebase: main landed `0214-channel-activity-notifications.md` first (docs/adr/README duplicate-number policy — first-created is canonical; 0216 verified free). |

## Context

The gap analysis graded the campaign-workspace epic **B−**: the brief→kernel→channels→finalize spine shipped (ADRs 0155–0162), but the *workspace* half was missing — no spend plan, no UTM schema (the C5 attribution join key), no campaign hierarchy, no templates. The research doc's E1 spec calls all four table stakes.

## Decision

Additive fields on the entities that already exist — never a parallel store:

1. **`CampaignBrief.budget?`** (`{ totalMinor?, currency?, perChannel? }`, minor units mirroring the ads adapter's `dailyBudgetMinor`) — **advisory**: the enforcement points are the B3 spend gate and the C7 pacing chain. Budget joins the **protected-field set** (a post-approval budget edit demotes the brief to draft, forcing re-approval — the B4 rule).
2. **`CampaignBrief.utm?`** (`{ source?, medium?, campaign?, term?, content? }`) — the UTM schema stamped onto outbound URLs at publish time. `publish-ad-variants` appends it to `landingUrl` (existing URL params win; `utm_campaign` falls back to the briefId), making the C5 attribution join key deterministic. NOT protected (tracking-only).
3. **Carry-through at finalize:** `buildCampaignFromBrief` copies `budget`/`utm` onto the `MarketingCampaign` (the kernel-snapshot precedent).
4. **`MarketingCampaign.parentCampaignId?`** — a plain same-org reference set via `PATCH /campaigns/:id` (validated: exists, same org, not self). No cascade semantics — hierarchy is a reporting/roll-up affordance, not a lifecycle one.
5. **Templates = a verb, not an entity:** `POST /briefs/:id/duplicate` (`duplicateBrief`) copies the content fields into a fresh **draft** (kernel dropped, version 1); the editor gains a Duplicate action. The showcase seeder's confirmed brief doubles as the demo template.

Editor: a "Plan & tracking" section (budget total in major units ÷100 on display ×100 on save; currency; UTM source/medium/campaign) + a revision chip.

## Alternatives rejected

- A separate `CampaignPlan` entity — a parallel store that would drift from the brief (the /insights-suite failure mode).
- Budget enforcement in the brief service — enforcement belongs at the spend chokepoints (B3 adapter gate, C7 pacing), not on a planning field.
- A template entity/library — the duplicate verb + seeded examples cover the research doc's acceptance ("create a campaign from a template") without a second content type.

## Verification

`campaign-workspace-fields.test.ts` (budget/utm sanitize + protected-budget demotion + carry-through + duplicate + parent validation) + existing suites green; FE build + eslint green.
