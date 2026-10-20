# ADR 0948 — Funnel builder and blueprints

Status: Proposed

**Date:** 2026-10-19
**Program:** Campaign Studio (ADRs 0941–0962), Tier 1. Plan/PRD: the program brief
(David, 2026-10-19). This is net-new planning, not a MyndHyve port.
**Feature:** **extends `funnels`** (ADR 0293/0294 program, implemented). No new toggle.
**Depends on:** 0941 (canonical campaign), 0942 (autonomy gate), 0943 (agent team),
0933 (content rules). **Composes:** 0009 CMS, 0012 publishing, 0236/0294 experiments,
0295/0906 custom domains (and the custom-domain edge-ownership ADR on the unmerged branch `docs/adr-custom-domain-edge-ownership`), 0296 bumps + one-click upsells, 0332 opt-in capture,
0339 SPA viewer, 0404 webinars, 0410 catalog, 0877 settlement, 0163 chain packs.
**Feeds:** 0950 (promotion), 0951 (behavior analytics), 0956 (attribution), 0959
(playbook rollout). **Integrates with, not depends on** (later tiers, ADR 0941 D7):
0949 (D6 experiment migration, P5), 0954 (application-step verdict, P4), 0955
(webinar reminder journeys, P4). Each phase ships when its partner lands; P0–P3
need none of them.
**RFC verdict:** **host-extension — no RFC.** See § RFC verdict.

## Context

The product ask is GoHighLevel/ClickFunnels-style funnel automation. The audit's
first finding is that **most of the funnel spine already ships.** The Funnel
Program (ADR 0293, implemented 2026-07-06) delivered the funnel entity, routing,
per-step analytics, step experiments, custom domains, order bumps and one-click
upsell chains. This ADR does NOT rebuild any of that. It closes the gaps between
"an operator can wire a funnel from pages they built by hand" and "an agent builds
a full funnel from the campaign brief, a human approves it, and it publishes on the
client's domain, linked to the campaign, its experiments and its ads."

The competitive gap (brief § Funnels/CRM): GHL and ClickFunnels ship templates
("snapshots") that are copied once and break on upstream change, AI steps without
an approval node, and basic split tests with no explanation. Nobody generates a
multi-step funnel as a durable, replayable agent run with a role-routed gate.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless noted.

**What exists and is reused (single owners):**

| Concept | Owner | Evidence |
|---|---|---|
| Funnel entity | `features/funnels/funnelsService.ts` | `Funnel` (`:72-89`), `DurableCollection('funnels:funnel')` (`:91`), org-checked read (`getFunnel`, `:100-103`) |
| Step kinds | same | `FUNNEL_STEP_KINDS = landing, optin, sales, checkout, upsell, downsell, thankyou` (`:32`) |
| Step page | CMS (ADR 0009) | step holds `pageId` validated through `getPage` (`funnelsService.ts:21,40`; `features/cms/cmsService.ts:1333`) |
| Draft page write | CMS surface | `ctx.features.cms.createDraftPage` (`features/cms/surface.ts:10,33`), used with a deterministic `pageId` by `publish-landing-page` (`packs/feature.campaign-channels.nodes/index.mjs:489-499`) |
| Routing | `features/funnels/funnelRouting.ts` | pure first-match rules, outcomes `accepted / declined` (`:15`) |
| Public serving | `features/funnels/routes.ts` | `PUB = /host/openwop-app/public/:orgId/funnels` (`:36`), entry/step/next (`:266-295`) |
| Per-step analytics | `features/funnels/funnelStats.ts` | distinct-visitor day rollups (`:25-50`), 50k event window disclosed (`:56,144`) |
| Step experiments | funnels + `host/variantAssignment.ts` | `StepExperiment` (`funnelsService.ts:62`), `assignWeightedVariant` (`variantAssignment.ts:46`), `twoProportionZ` (`:74`) |
| Checkout, bumps, upsells | `features/commerce/routes.ts` | public checkout (`:522`), bumps cap 5 (`:536-544`), `funnelRef` stamp (`:583`, `commerceService.ts:623,1077`) |
| Who takes money | `features/commerce-connect/storefrontSettlement.ts` | `resolveStorefrontSettlement(tenantId)` (`:88`), called by checkout (`commerce/routes.ts:572,764`) |
| Custom domains | `middleware/customDomain.ts`, `host/customDomains.ts` | public funnels/pages admitted on a verified host (`customDomain.ts:6,25-33`); the edge-ownership decision is on branch `docs/adr-custom-domain-edge-ownership` (not yet on main, so not cited by number here) |
| Webinars | `features/webinars/` (ADR 0404) | `MarketingEvent` (`entities/marketingEvent.ts:18`); registration rides forms/funnels (`feature.ts:1-8`) |
| Opt-in capture | forms sink | `registerSubmissionSink` (`features/forms/submissionSinks.ts:59`), funnels sink (`features/funnels/formsAttributionSink.ts`) |
| AI | Funnel Architect | `vendor.openwop-app.funnels.agents.funnel-architect`, tools `openwop:funnels.list/get/step-stats/draft` (`features/funnels/agentTools.ts:37-40`) |
| Chains | `core.openwop.workflows.funnels` | one chain, `funnels.optimize-step`, proposal-only (`examples/workflow-chain-packs/funnels/pack.json`) |
| Nodes | `feature.funnels.nodes` | `list, get, create, set-steps, step-stats` (`packs/feature.funnels.nodes/pack.json`) |

**Gaps (each closed below):**

| Gap | Evidence | Consequence |
|---|---|---|
| F1 Agent cannot author pages | `openwop:funnels.draft` says "ask the user to create it in the Page Builder (you cannot author…)" (`agentTools.ts:214`); `feature.cms.nodes` has no create node (only `get-page, list-pages, get-draft-page, translate-section, update-section-draft, submit-page`) | AI funnel generation stops at an empty skeleton |
| F2 No funnel↔campaign link | `Funnel` has no `campaignId` (`funnelsService.ts:72-89`) | 0941's canonical campaign cannot list its funnels; attribution cannot join |
| F3 Bumps are client-chosen | the public checkout accepts any `bumps[].productId` as a bump (`commerce/routes.ts:539-543`); nothing ties it to a funnel step offer | a visitor can attach any active product as an "order bump"; analytics attach-rate is unreliable |
| F4 No webinar / application kinds | `FUNNEL_STEP_KINDS` (`:32`); ADR 0297 FM-8a deferred webinars with the trigger "a funnel-step kind + scheduler jobs + journey chains — no new engine" (`0297…md:27`) | two of the four GHL funnel archetypes are missing |
| F5 Settlement is per tenant, not per client | `sellers.get(tenantId)` (`storefrontSettlement.ts:94`) | in an agency `ws:` workspace (ADR 0921) every client's funnel checkout settles to the AGENCY's Connect account |
| F6 Only one chain | the funnels chain pack holds `funnels.optimize-step` only | no blueprint gallery; templates are not runnable |
| F7 Experiments are funnel-local | `StepExperiment` + its own results route (`routes.ts:183-210`) | 0949's unified engine would become a second experiment model beside this one |

**Namespace check.** No new route prefix: all new routes sit under the existing
`/host/openwop-app/funnels/orgs/:orgId` (`routes.ts:33`). `/campaign-studio` (the
hub/canvas collision in the brief) is untouched; 0941 owns it.

## Decision

### D1 — Extend the funnel entity; never a second funnel model

```ts
// features/funnels/funnelsService.ts (additive; rows written before read back undefined)
export const FUNNEL_STEP_KINDS = [
  'landing', 'optin', 'sales', 'checkout', 'upsell', 'downsell', 'thankyou',
  'webinar',      // D4: binds a webinars MarketingEvent
  'application',  // D4: binds a form; routes on the qualification outcome
] as const;

interface Funnel {
  // …existing fields…
  campaignId?: string;                 // MarketingCampaign.id (ADR 0941 SoT)
  blueprint?: { chainId: string; version: string; runId: string }; // provenance, D3
}

interface FunnelStep {
  // …existing fields…
  offer?: FunnelOffer;                 // checkout | upsell | downsell only
  webinar?: { marketingEventId: string };   // webinar only
  application?: { formId: string };         // application only
  experimentRef?: { experimentId: string }; // D6, replaces `experiment` over time
}

interface FunnelOffer {
  productIds: string[];          // 1..5, commerce.product ids (ADR 0410), org-checked
  bumpProductIds?: string[];     // 0..5, checkout only
  oneClickProductId?: string;    // upsell/downsell only (ADR 0296 chain)
}
```

Order bump stays an offer on the checkout step, not a step kind (ClickFunnels models
it the same way; ADR 0296 already prices it into the single charge). `campaignId` is
validated against `campaign-orchestration` through its read seam, the same
cross-feature read `pacing.ts` already uses (`features/campaign-intel/pacing.ts:18-19`).

### D2 — Offers are server-validated at checkout (closes F3)

When the public checkout body carries `funnel: { funnelId, stepId }`, the route
loads that published funnel step and **refuses** any `bumps[].productId` not in
`step.offer.bumpProductIds` (400, `bump_not_offered`). Without a funnel ref the
storefront keeps today's behaviour. The one-click chain likewise only accepts
`oneClickProductId`. Money still flows exclusively through
`resolveStorefrontSettlement`; funnels never touch a Stripe key or a second client
(CLAUDE.md Stripe invariants, ADR 0877).

### D3 — Funnel blueprints are workflow-chain packs

A blueprint is a chain in `core.openwop.workflows.funnels` (pack minor bump), never
an in-tree definition. Initial set (David picks, Q3): `funnels.blueprint.lead-magnet`
(optin → thankyou), `.tripwire` (sales → checkout+bump → upsell → downsell →
thankyou), `.webinar` (optin → webinar → replay sales → checkout), `.application`
(sales → application → booking thankyou), `.product-launch`.

Shape of every blueprint chain:

```
params {orgId, campaignId, briefId, productIds?, locale?}
 → campaign-brief get-brief                        (read before write)
 → per step: subChainRef funnels.step.<kind>       (nested chain; loader supports
     ├ copy node (agent: 0943 Copywriter)           subChainRef — workflowChainPackLoader.ts)
     ├ content-rules check (0933, typed failure + ONE repair)
     └ feature.cms.nodes.create-draft-page (NEW, side-effect, pageId = page:<runId>:<stepKey>)
 → feature.funnels.nodes.create  (draft, campaignId, blueprint provenance)
 → feature.funnels.nodes.set-steps (offers validated against the catalog)
 → feature.campaign-orchestration.nodes.autonomy-gate  (ADR 0942, class `content.publish`)
 → feature.funnels.nodes.publish (NEW; only reachable past the gate; 0942 may resolve
     it to `blocked` → the run ends at draft)
```

The ADR 0294 Phase 6 "no publish verb on the surface" rule is **revised, not
removed**: the publish node exists only behind the gate node in a chain, it is
`role: side-effect`, and `ctx.funnels` still exposes no publish method to agents'
chat tools. A pinned test asserts no chat tool can reach publish.

New node: **`feature.cms.nodes.create-draft-page`** wraps `ctx.features.cms.createDraftPage`
(ADR 0162). It is CMS-owned (the CMS node pack), deterministic-keyed so a replay or
`:fork` returns the same page, and it can only create **draft** pages.

Rollout of a blueprint across many clients (versioned, diffable, overrides that
survive upgrades) is ADR 0959's job. This ADR ships the blueprints 0959 rolls out.

### D4 — Webinar and application steps compose existing features

- **webinar** binds a `webinars` `MarketingEvent`. Registration is the step's form
  (ADR 0332 sink, already used by webinars); reminders and replay nurture are journey
  chains owned by ADR 0955; attendance (`host.webinar.*` events) routes the visitor to
  the replay-sales or the live-offer step. No scheduler or session engine in funnels
  (the `funnelRouting.ts:1-13` rule stands).
- **application** binds a form. ADR 0954's qualification writes the verdict; the
  step's outcome is `accepted` (qualified) or `declined`, so the existing routing
  vocabulary (`funnelRouting.ts:15`) is enough. A qualified applicant routes to a
  booking step (ADR 0402 `bookingService`).

### D5 — AI funnel generation through the one chat

The Funnel Architect agent gains two tools (pack-allowlisted, not default-on):
`openwop:funnels.blueprints` (read: blueprint chains with their params) and
`openwop:funnels.generate` (starts a blueprint chain run for the caller's org and
campaign; returns `runId`; the `openwop:campaign-orchestration.run` precedent). The
agent drafts, it never publishes. The Funnels page embeds `chat/EmbeddedChatPanel`
scoped to the architect in its empty state (ADR 0073); the campaign workspace
deep-links `/?agent=…funnel-architect`. No new chat surface.

The architect reads before it writes: `openwop:campaign-brief.get-brief`,
`openwop:cms.get-page`, `openwop:funnels.get`. Invalid step kinds, missing pages or
an unoffered product are typed failures with one bounded repair.

### D6 — Experiments move to ADR 0949; analytics stay here

New split tests are created through ADR 0949's engine and referenced by
`experimentRef`. Existing `step.experiment` rows keep being read (back-compat) until
0949's migration phase moves them; there is never a period where both models write.
`funnelStats` stays the per-step analytics owner and gains: a `campaignId` rollup,
a `utm_source/utm_campaign` breakdown keyed by ADR 0956's UTM governance, and webinar
registration/attendance counts. 0951 adds behaviour data; it does not move stats.

### D7 — Custom-domain publish

Publishing is unchanged (ADR 0294 lifecycle). A funnel MAY name `primaryHostname`
from the org's verified `custom-domains` rows; the funnel's canonical URL, OG tags
and the ad landing URL (0952) use it. Serving is already admitted by
`middleware/customDomain.ts`. The per-deployment edge decision (unmerged branch `docs/adr-custom-domain-edge-ownership`) applies once merged.

### D8 — Client settlement (F5) is a decision, not a silent default

Until David decides Q1, a checkout/upsell step in a **non-root client org** of a
`ws:` workspace publishes only if the settlement lane is `demo`, or an agency admin
has recorded "the agency is merchant of record for this client" on the ClientAccount
(ADR 0921). The publish refusal is typed (`client_settlement_unconfirmed`).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Extends `features/funnels/`; CMS gains one node in its own pack; commerce gains the D2 check inside its checkout route (commerce owns checkout). No core route/nav edits. |
| 2 | Toggle | `funnels` (stable, OFF, `tenant`). No new toggle. Blueprints and generation ride the same toggle; `commerce`, `webinars`, `forms` stay `recommends`. |
| 3 | Workflow surface | `ctx.funnels` gains `create` with `campaignId`/offers; publish stays OFF the surface (D3). |
| 4 | Node pack | `feature.funnels.nodes` + `publish` (side-effect, gate-only); `feature.cms.nodes` + `create-draft-page`. Chain pack `core.openwop.workflows.funnels` + blueprints and `funnels.step.*` sub-chains. |
| 5 | AI chat + envelopes | Chat-time tools only (`funnels.blueprints`, `funnels.generate`). No new envelope kind. |
| 6 | Agent pack | Existing Funnel Architect (allowlist +2). Copywriter/Creative Director nodes come from 0943. |
| 7 | Public surface | Unchanged prefix; D2 tightens checkout. Rate limits and uniform 404 inherited. |
| 8 | RBAC | Writes `workspace:write` via `authorizeOrgScope` on the client org (ADR 0921 D2); `campaignId` and offer products must belong to the same org (uniform 404). |
| 9 | Replay / fork | Deterministic page ids and funnel ids from `runId`; the 0942 policy is frozen at run start; publish is a side-effect node, never re-executed on fork. |
| 10 | Frontend | `/funnels`: blueprint gallery, offer editor on checkout steps, webinar/application step editors, campaign link chip, embedded architect panel. 4-locale i18n. |

## Why this is our advantage

- **Durable, replayable generation.** A generated funnel is a run: every page draft,
  rule check and approval is an event. "Why does step 3 say this?" is answered by
  replaying the run, not by guessing (thesis 1).
- **A named agent per node and a role-routed gate** before anything goes live
  (thesis 2, 3). GHL's Agent Studio has no approval node; ClickFunnels has no agents.
- **Blueprints are code-reviewed chain packs**, not copied snapshots, so ADR 0959
  can upgrade them across clients without breaking overrides.
- **Per-client isolation** (thesis 4): a blueprint run for client A cannot read client
  B's brief, products or pages (org-checked at every node).

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | D1 `campaignId` + D2 offers + D8 settlement guard | route tests: unoffered bump → 400; cross-org product/campaign → 404; client-org checkout publish refused without the MoR flag |
| P1 | `feature.cms.nodes.create-draft-page`; `feature.funnels.nodes.publish` (gate-only) | replay/fork test: same page id; no chat tool reaches publish (pinned) |
| P2 | Blueprint chains (lead-magnet, tripwire) + `funnels.step.*` sub-chains | from-chain instantiation shows in `/builder` and the `/` picker; run reaches the gate with a draft funnel |
| P3 | D5 tools + embedded architect panel | chat creates a draft funnel from a brief end-to-end; invalid output is a typed failure |
| P4 | D4 webinar + application kinds; remaining blueprints | webinar attendance routes; application verdict routes |
| P5 | D6 experiment migration onto 0949; stats breakdowns | no funnel-local experiment writes remain; stats show campaign + UTM splits |
| P6 | D7 `primaryHostname` | canonical/OG URLs use the verified domain |

## Alternatives weighed

- **A new `funnel-builder` feature** beside `funnels`. Rejected: two funnel models.
- **Blueprints as stored JSON templates.** Rejected: a template is a hard-coded
  workflow by another name; chains are editable, versioned and runnable.
- **Agent writes pages through the app-builder canvas.** Rejected: pages are CMS rows.
- **Order bump as a step kind.** Rejected: it is an offer inside the payment step.
- **Per-org Stripe settlement now.** Deferred to David (Q1): it reshapes ADR 0877.

## RFC verdict

**Host-extension — no RFC.** Routes are under `/v1/host/openwop-app/*`; nodes and
chains ride Accepted RFC 0013 (chain packs) and the existing executor; no run-event
field, capability flag or wire endpoint changes. Nothing advertises a new capability.

## Open questions

1. **(David)** F5: should each client org get its own Connect seller (per-org
   settlement), or is the agency always merchant of record? This touches ADR 0877 and
   the Stripe invariants. Until decided, D8 holds.
2. **(David)** ADR 0297 deferred webinar funnels. Is the revisit trigger met (Campaign
   Studio needs it)? Proposed: yes, as D4 composes existing features only.
3. **(David)** Which blueprints ship first? Proposed: lead-magnet and tripwire.
4. Should `funnels.generate` require a confirmed brief (0941), or accept a free-text
   goal? Proposed: confirmed brief only, so the run reads real product data.
5. 0949 migration of `step.experiment`: migrate running tests or let them finish?
   Proposed: let them finish; new tests only on 0949.
6. **Correction to record in ADR 0294 Phase 6** when P1 lands: "the surface exposes
   NO publish verb" becomes "no chat tool and no `ctx.funnels` method can publish; the
   gate-only chain node can."

## Planning rows

- **ROADMAP Overview row:** `| 0948 | Funnel builder + blueprints (extends funnels) | \`funnels\` | 0941, 0942, 0943, 0933 (composes 0294/0296/0404/0877) | \`feature.funnels.nodes\`, \`feature.cms.nodes\`, \`core.openwop.workflows.funnels\` | 🔵 Proposed | — (net-new) |`
- **FEATURES "Future features" row:** **Funnel builder + blueprints (ADR 0948, Proposed)** —
  extends `funnels` (toggle stable, OFF, tenant): funnels link to the canonical
  campaign; checkout offers are server-validated; webinar and application steps;
  blueprints as chain packs; the Funnel Architect generates a draft funnel (pages
  included) from a brief through the one chat, and publish sits behind the 0942 gate.
  Per-client settlement is an open decision for David.
