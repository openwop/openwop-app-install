# ADR 0948 — Funnel builder and blueprints

Status: Accepted (P0 implemented; P0b/P1a/P1b/P3a/P4a/P6a integrated onto main and validated 2026-10-26, see § Integration correction; P2 lead-magnet implemented 2026-10-26, see § P2; P2c implemented 2026-10-26, see § P2c; the tripwire blueprint implemented 2026-10-26, see § Tripwire; P3b, P4b, P5, P6b NOT implemented)

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

> **CORRECTED 2026-10-26 (P2c): these server checks had no UI caller.** The public
> funnel viewer rendered a step's CMS page plus a generic Continue. It dropped
> `step.offer` and never sent an `outcome`. Nothing on the funnel path called the
> checkout with a funnel ref or bumps, or called the one-click route; the only caller
> was `/store`, which sends neither. So a funnel could not take a payment, a bump or an
> upsell decision, and every visitor walked through to the downsell. The checks were
> correct and unreachable. P2c gives them their caller and tightens them (§ P2c below).

### D3 — Funnel blueprints are workflow-chain packs

A blueprint is a chain in `core.openwop.workflows.funnels` (pack minor bump), never
an in-tree definition. Initial set (David picks, Q3; **decided 2026-10-26: lead-magnet, then tripwire, ship first**): `funnels.blueprint.lead-magnet`
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

> **CORRECTED 2026-10-20 (P1b, P3a /architect):** the chain shape above ends
> `create → set-steps → autonomy-gate → publish`. No node publishes (P1b): a blueprint ends
> `create → set-steps`, and its step pages are SUBMITTED for review
> (`feature.cms.nodes.submit-page`), because `request-publish` refuses unpublished pages.
> The funnel publish request is a later, separate act (the Funnels page, the architect,
> or ADR 0942 P3's waiting mode once the pages are live).

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

> **CORRECTED 2026-10-20 (P4 /architect):** "attendance routes the visitor" can only
> mean a RETURN visit. Attendance arrives later from the provider, and the viewer advances
> as soon as the registration form is submitted. The outcome is derived by the SERVER
> from the visitor's own registration plus the CRM attendance activity, and is never
> taken from the client. The return link itself is ADR 0955's. The application verdict is
> ADR 0954's `LeadGrade`, keyed by contact; until ADR 0954 exposes a verdict read, an
> application step has no outcome and routing stays sequential. Routing is navigation,
> not authorization: what a branch leads to (a booking link) carries its own gate.

### D7 — Custom-domain publish

Publishing is unchanged (ADR 0294 lifecycle). A funnel MAY name `primaryHostname`
from the org's verified `custom-domains` rows; the funnel's canonical URL, OG tags
and the ad landing URL (0952) use it. Serving is already admitted by
`middleware/customDomain.ts`.

> **CORRECTED 2026-10-20 (P4/P6 /architect): that last sentence is false.**
> - On a custom domain, only page, blog and podcast paths become documents (`customDomain.ts:55-77`).
> - There is no funnel document and no app shell there.
> - Public form submits are excluded (ADR 0295).
> - Nothing produces a funnel canonical or OG URL today.
>
> P6 splits:
> - **P6a** (the field plus `funnelPublicUrl`, which falls back to the platform URL unless the domain is serving AND custom-domain funnels are enabled);
> - **P6b** (a custom-domain funnel document with canonical and OG, after the edge-ownership ADR merges). The exit "canonical/OG URLs use the verified domain" can only be met in P6b. The per-deployment edge decision (unmerged branch `docs/adr-custom-domain-edge-ownership`) applies once merged.

### D8 — Client settlement (F5) is a decision, not a silent default

Until David decides Q1, a checkout/upsell step in a **non-root client org** of a
`ws:` workspace publishes only if the settlement lane is `demo`, or an agency admin
has recorded "the agency is merchant of record for this client" on the ClientAccount
(ADR 0921). The publish refusal is typed (`client_settlement_unconfirmed`).

> **CORRECTED 2026-10-20 (P0, David's decision #5038 — "each client org settles
> through its own Connect seller via the ADR 0877 resolver; a client checkout step
> refuses to publish until that client has onboarded").** The merchant-of-record flag
> above is superseded. As built:
> - **One predicate** `isNonRootWorkspaceOrg(tenantId, orgId)` in
>   `host/accessControlService.ts`: any non-root org of a `ws:` workspace. It keys on
>   the org model, not on a `ClientAccount` row existing, so a missing row can never
>   reopen the agency's lane, and commerce-connect does not import campaign-ops.
> - **The ONE resolver is org-aware:** `resolveStorefrontSettlement(tenantId, orgId)`.
>   A client org is `demo/client_seller_required` even while the workspace's own seller is
>   ready: it never settles on the agency's account, and never on the platform. All
>   seven callers (`commerce/routes.ts`) pass the org.
>   **Money impact (flagged for the release coordinator):** this applies to every lane,
>   including subscription cycles and quote accept, so a pre-existing client-org
>   store that settled to the agency now takes no live money. That is the no-charge
>   direction and is exactly the decision; before deploy, check read-only whether any
>   `ws:` non-root-org seller-settled orders or subscriptions exist.
> - **The publish guard asks that resolver** (`assertClientSettlement`): a money step
>   (checkout, upsell, downsell) in a client org publishes only on a `connect` lane.
>   It runs on `publishFunnel` and on `updateFunnel` of a published funnel, so adding
>   a checkout to a live funnel cannot route around it; every lane (route, surface,
>   node, agent tool) writes through the service. Refusal: `409`,
>   `client_settlement_unconfirmed`, with the lane and reason.
> - **Architect call:** a host with no Stripe key (`demo/no_key`) does not block,
>   because no account anywhere can take money there; agency demo builds keep working.
> - **Next (P0b):** per-client-org Connect onboarding (org-keyed seller rows, an
>   org-scoped onboard route, webhook routing by org). Until it lands, client orgs are
>   honestly `demo` and their money steps cannot publish, which is the decision.

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
| P1a | `feature.cms.nodes.create-draft-page`; funnels writers → `side-effect`; run-derived funnel ids; WF-P0-1 descriptions | replay fork → same page and funnel; branch fork → its own page |
| P1b | `feature.funnels.nodes.request-publish` + the `funnel-publish` approval kind (the human decision publishes) | census: only the route, environment promotion and the decide handler call `publishFunnel`; a composed `request-publish` leaves the funnel draft |
| P2 | Blueprint chains (lead-magnet, tripwire) + `funnels.step.*` sub-chains | from-chain instantiation shows in `/builder` and the `/` picker; run reaches the gate with a draft funnel |
| P2c | money steps in the viewer: a checkout sells exactly its offer; upsell/downsell through a funnel-bound, single-use, per-step capability; routing past an offer from the recorded decision | a visitor can buy, add a bump, accept or decline an upsell, and is routed by what they decided; replayed or cross-funnel capabilities refused |
| P3 | D5 tools + embedded architect panel | chat creates a draft funnel from a brief end-to-end; invalid output is a typed failure |
| P3a | generate route + `funnels.blueprints` / `funnels.generate` tools (one service) + embedded architect panel + Studio deep link | a FIXTURE blueprint run drafts a page and a funnel; every refusal is typed; no blueprints ⇒ an honest empty list |
| P3b | the P3 exit against the real `lead-magnet` blueprint | after P2b and the sub-chain replay + param forwarding work (#5129) |
| P4 | D4 webinar + application kinds; remaining blueprints | webinar attendance routes; application verdict routes |
| P4a | the two kinds, their bindings, server-derived webinar outcome, `outcome_server_derived` refusal, editor pickers | bindings org-checked; a forged outcome refused; attended/no-show route on return |
| P4b | the application verdict arm and the "application verdict routes" exit; ADR 0955 return links | after ADR 0954 exposes a verdict read |
| P5 | D6 experiment migration onto 0949; stats breakdowns | no funnel-local experiment writes remain; stats show campaign + UTM splits |
| P6 | D7 `primaryHostname` | canonical/OG URLs use the verified domain |
| P6a | the `primaryHostname` field (a serving same-org domain), digest + publish check, `funnelPublicUrl` (platform URL until P6b), editor picker | an unverified or foreign domain refused; a removed one blocks publish; the URL never points at a domain that cannot serve |
| P6b | the custom-domain funnel document with canonical and OG | **BLOCKED** on the edge-ownership work (ADR 0906 custom-domain edge certificates, ADR 0940 white-label custom hosts): today a custom domain serves only page, blog and podcast documents, with no funnel document, no form submits and no funnel OG |

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
   **Decided (2026-10-19, David): Yes. Each client org settles through its own Connect seller via the ADR 0877 resolver; a client checkout step refuses to publish until that client has onboarded.**
2. **(David)** ADR 0297 deferred webinar funnels. Is the revisit trigger met (Campaign
   Studio needs it)? Proposed: yes, as D4 composes existing features only.
   **Architect call (P4a, 2026-10-20, per the build brief's decide-and-record rule): yes.**
   The step composes the existing webinar, forms and CRM records, with no scheduler and no
   session engine. That is the condition ADR 0297 set. Revisit if David disagrees.
3. **(David)** Which blueprints ship first? Proposed: lead-magnet and tripwire.
   **Decided (2026-10-26, David): lead-magnet and tripwire first, in that order.** Lead-magnet has no checkout step, so it ships without waiting on settlement. Tripwire follows and exercises the checkout, order-bump, upsell and downsell path under Q1's per-client Connect settlement. Webinar waits on Q2. Application and product-launch come after those.
4. Should `funnels.generate` require a confirmed brief (0941), or accept a free-text
   goal? Proposed: confirmed brief only, so the run reads real product data.
   **Resolved (P3a): confirmed brief only** (`brief_not_confirmed`).
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

## Implementation record

| Phase | PR | Commit | Tests |
|---|---|---|---|
| P0 D1 `campaignId` + offers, D2 server-validated bumps and one-click, D8 client settlement | #5068 | (filled at merge) | `test/adr0948-p0-offers-settlement.test.ts` (7), `commerce-bumps`, `commerce-one-click` (+1 D2 case); sabotage-witnessed: bump check, one-click check, client-org resolver arm, publish guard, update-while-published guard |

| P1a create-draft-page, side-effect writers, run-derived ids, WF-P0-1 | #5083 | (filled at merge) | `test/adr0948-p1-draft-nodes.test.ts` (5: replay fork, branch fork, derived ids, stale-reuse refusals, page reuse), `funnels-packs`, `cms-node-replay-classification`; sabotage-witnessed (8): `create` not served, `create-draft-page` not served, an id without the tenant, no idempotent return, an input `pageId` honoured, `set-steps` not draft-only, a stale funnel reused, a stale page reused |
| P1b `request-publish` + the `funnel-publish` approval kind | (this PR) | (filled at merge) | `test/adr0948-p1b-request-publish.test.ts` (9: a run leaves a draft and one review; self-approval refused; a second writer publishes; a stale edit consumes nothing; reject; unpublished pages refused; a failed publish leaves the review pending; re-request after a decision opens a new review; supersede, step rename and experiment are stale; the causing member cannot approve; the write bar is pinned; census of publish callers); sabotage-witnessed (10): a decided row reported pending, digest without name/experiment, causes outside SoD, no supersede, a read-only org bar, no precheck and no reopen, no SoD, node publishes directly, pages rule off, both stale checks off |
| P3a generate route, blueprints/generate tools, embedded architect panel | (this PR) | (filled at merge) | `test/adr0948-p3a-generate.test.ts` (4: empty set, fixture end-to-end + reuse, typed refusals, authority + tool), `funnelArchitectPanel.test.tsx`, census / exemption / Gemini-schema / allowlist pins updated |
| P4a webinar and application steps | (this PR) | (filled at merge) | `test/adr0948-p4a-webinar-application.test.ts` (bindings, carry, digest, publish; forged outcome refused; attended/no-show/before-event/elsewhere routing; kind parity) |
| P6a primary hostname | (this PR) | (filled at merge) | `test/adr0948-p6a-primary-hostname.test.ts` (same-org serving only; digest; publish refuses a removed domain; platform URL; the serving predicate) |
| P0b per-client-org Connect seller (onboarding, binding, webhooks, resolver, owner UI) | (this PR) | (filled at merge) | `test/adr0948-p0b-client-seller.test.ts` (10, incl. live mock-Stripe concurrency), `paymentsNotice.test.tsx` (+8); sabotage-witnessed: resolver falling back to the agency seller, a tenant-only binding, an org-blind webhook, a weakened onboard scope, an org-blind payout list, an org-blind reconcile, a scope-blind `canOnboardClient`, `sellerRows` accepting any org |
| P2 lead-magnet blueprint + `funnels.step.optin` / `funnels.step.thankyou` sub-chains + `compose-step-page` / `step-result` / `collect-steps` nodes | (this PR) | (filled at merge) | `test/adr0948-p2-lead-magnet.test.ts` (5: listed and instantiable through from-chain; generate drafts and submits both pages and creates one draft funnel on them; another org's form fails `form_not_found`; invalid model output fails after one repair; a replay fork drafts nothing new), `adr0948-p3a-generate` leg 1 updated; sabotage-witnessed (3): unchecked form, no bag write, a second repair |

**P0 architect calls (2026-10-20):**
- **Offers carry across edits.** An editor that predates offers re-submits steps
  without the `offer` key; an omitted key keeps the stored offer (by `stepId`, same
  kind), and `offer: null` clears it — the `carryExperiments` rule.
- **Offers are org-checked against the catalog** with `getProduct(tenant, org, id)`
  (never `getProductInTenant`): another org's, an inactive or a missing product are
  the same 404. Offers sit only on money steps, bumps only on checkout, the one-click
  product only on upsell/downsell, at most 5 of each.
- **`campaignId`** is validated with `getCampaign` plus an org compare (that read
  checks only the tenant); a miss is 404, `null` clears. The stored direction of the
  funnel↔campaign link is being agreed with ADR 0941 (#5052 stores
  `campaign.funnelIds`): one stored edge, not two.
- **D2 checkout:** a funnel ref must name a step of the right kind on a PUBLISHED
  funnel of the path org; every miss is one uniform `400 funnel_step_not_found`.
  Bumps must be in `offer.bumpProductIds` (`400 bump_not_offered`). A one-click accept
  naming an upsell/downsell step must charge `offer.oneClickProductId`
  (`400 one_click_not_offered`). Residual: a one-click WITHOUT a funnel ref is a
  storefront upsell and keeps today's behaviour.
- The public step read now includes the step's `offer`, so a renderer can show the
  offered bumps.
- **Dependency ratchet 99 → 102** (`feature-dependency-parity.test.ts`):
  `funnels → campaign-orchestration`, `funnels → commerce-connect`,
  `commerce → funnels`, each a read that is the point of a decision, each left
  undeclared (no disable-lock); `docs/FEATURE-DEPENDENCIES.md` regenerated.

**P0 reviews (2026-10-20):**
- `/code-review`: no banned patterns, `tsc` clean. Fixed in this PR: a client org's
  owner payments notice used `connect_required`, which offered a Commerce Connect link
  that would onboard the AGENCY's seller. Now there is a distinct
  `client_seller_required` reason with honest copy (4 locales) and no link. Also added
  the FEATURES.md note. Accepted: main cart lines are not checked against
  `offer.productIds`; D2 scopes server validation to bumps and one-click.
- `/grade-workflows` (scope: funnels surface, `feature.funnels.nodes`,
  `funnels.optimize-step`, `openwop:funnels.draft`):
  - **Chains-or-stacks:** compliant. No workflow, chain or pin site is added.
  - **Replay:** the new validation runs at node or tool execution; a replay reads the
    recorded output and does not re-run it.
  - Pre-existing, owned by P1: `create` mints a random `funnelId`, so a re-executed
    node on a diverged `:fork` creates a second draft. P1's deterministic ids close it.
  - Fixed here: `openwop:funnels.draft` now describes `offer` and accepts `campaignId`.
  - **WF-P0-1 (Improvement, P1):** the `feature.funnels.nodes` `create` / `set-steps`
    descriptions still omit `offer` / `campaignId`. That pack's version bump rides P1,
    which adds the `publish` node, so they are corrected together.

**P1 (2026-10-20) — split by the /architect review.**
- **Correction to D3, "only reachable past the gate":** that is not a safety property. `openwop:workflows.compose-and-run` (`host/workflowComposeTool.ts`) composes a workflow from any catalog node and runs it. A plain publish node would therefore publish with no human in the loop. ADR 0942 D5 says the same: the gate node is optional and the chokepoint is mandatory. So **no node publishes.**
  - P1b ships `feature.funnels.nodes.request-publish`. It queues a new `funnel-publish` PendingApproval (the ADR 0905 `email-campaign-send` template), pinned to a digest of slug, steps, offers and campaignId, and returns `{status:'pending_approval', approvalId}` without suspending (the `submit-page` precedent).
  - The human decide handler publishes. It refuses `step_pages_unpublished` and never publishes pages itself, because the owning kind wins.
  - A waiting mode waits for ADR 0942 P3's `resumeRunsAwaitingApproval`. Its `content.publish` row needs a `funnel-publish` chokepoint; cs-0942 has been asked.
  - Open question 6 becomes: "no chat tool and no `ctx.funnels` method publishes; `requestPublish` queues an approval whose human decision publishes". The ADR 0294 Phase 6 correction lands with P1b.
- **P1a, as built:**
  - `feature.cms.nodes.create-draft-page` (CMS pack 1.7.0) derives `page:<runId>:<nodeId>[:<key>]` and never takes a `pageId` input. Taking one would let a node claim any existing page in its org as its draft, since `createPage` returns the existing row.
  - The funnels `create` and `set-steps` nodes are now `side-effect` (pack 1.1.0). The header's "All role:'action' (recorded)" was false: the executor serves only manifest-declared side-effect nodes on replay, so a replay fork re-ran `create`.
  - A run's `create` gets `runFunnelId(tenant, runId, nodeKey)`, derived in the surface and never from args. It is idempotent before the per-org limit and the slug check, insert-if-absent under concurrency, and a uniform 409 in any other tenant or org. The collection is keyed on `funnelId` alone, so an args-supplied id would have been a cross-tenant overwrite.
  - **Fork semantics:** a replay fork is served the recorded output (same ids). A branch fork is an independent run and drafts its own page. A root-run key would have handed a branch the source's page, possibly already published.
- **Review-round fixes (code-review and grade-workflows, 2026-10-20):**
  - **A node run again in one run is refused, not handed its first draft.** ADR 0772 lets a node execute more than once. A derived id is reused only for the same create re-delivered: same tenant and org, still a draft, same name, campaign and step shape. That reuse is reported as `reused: true`. Anything else fails `run_funnel_exists`, including a draft published since. `create-draft-page` does the same with `run_page_exists`. Both nodes take an optional loop `key`.
  - **`set-steps` is draft-only, like the chat tool** (`funnel_not_draft`, 409). Editing a live funnel's steps is publishing them, and a branch fork taken after `create` would otherwise edit a funnel a human has published since.
  - A missing funnel is a `not_found` failure, never a recorded empty success.
  - Node descriptions now state section types, defaults, slug uniquifying, `key` sanitizing and outputs.
  - ADR 0294 carries a correction note.
  - A diverged replay fork that re-executes `create` derives a new id and is refused on its slug: a typed failure, not a duplicate.
- **Recorded, not fixed here:**
  - `feature.campaign-channels.nodes.publish-landing-page` is `role:action` keyed on the fork's run id, so a replay fork drafts a second page. This is the same CMSLWF-2 shape and is owned by that pack.
  - `coerceSteps` mints a random `stepId` when one is missing; the side-effect role closes that for replay.
  - The nested case (`create-draft-page` inside a `funnels.step.<kind>` sub-chain) gets its replay leg in P2, where the sub-chains land.
- **Ratchets and packs:**
  - side-effect floor 351 → 354, served 276 → 279 (generator);
  - `feature.cms.nodes` 1.6.0 → 1.7.0 and `feature.funnels.nodes` 1.0.1 → 1.1.0 (pins plus regenerated steward manifest);
  - `pack-surface-arg-parity` fixture regenerated (spread 94 → 96, nonLiteral 19 → 18).

**P1b (2026-10-20) — `request-publish`, as built.**
- **Kind `funnel-publish`**, owned by funnels on the core approval hooks (the ADR 0905 `email-campaign-send` template):
  - `APPROVAL_KINDS`, with a redactor (`submitters`);
  - an audience row: the org's writers, `workspace:write`, the bar the human publish route sets;
  - a `KIND_DISPATCH` recipe with its audit action;
  - `createFunnelPublishApprovalOnce`, which creates a row with a deterministic id by CAS from null;
  - a decide-handler hook that the funnels feature registers at boot.
- **The pin:** `funnelPublishDigest` covers slug, steps (stepId, kind, pageId, name, routing, offer, and a running experiment's status and variants), campaignId and completion CTA. The funnel's own name is left out, so an internal rename does not invalidate a review.
  - **Review cycles:** the row id is derived from (tenant, funnel, createdAt, digest, cycle). The same request converges on the OPEN row. Once that row is decided (rejected, or approved and later unpublished), the next request takes the next cycle, so the same content can be reviewed again and a branch fork still converges.
  - A new request closes this funnel's older open requests as superseded.
- **Decide order:**
  - IDOR;
  - authority (`workspace:write` in the org);
  - re-read the funnel: if it is gone or no longer a draft, the review is closed `review_closed`;
  - pin check (`stale_review`, before the CAS, so nothing is consumed);
  - separation of duties (the shared `selfApprovalBlockedCore`; the requester cannot approve while another writer exists);
  - CAS resolve;
  - publish. On any refusal the review is reopened, so it never claims a publish that did not happen.
- **The ONE publish function, `publishFunnelAsApproved`** (cs-0942's condition): `publishFunnel(…, {requirePublishedPages: true, expectedDigest})`.
  - The write is a CAS from the checked row, so an edit landing between the check and the write is refused rather than published unapproved.
  - It refuses `step_pages_unpublished` on every path: a funnel publish never publishes its pages.
  - ADR 0942's chokepoint calls it on `auto` / `notify-after`, and calls `requestFunnelPublish` on `approve`.
  - The human route's `publishFunnel` is unchanged (no pin, pages need only exist).
- **Node `feature.funnels.nodes.request-publish`** (pack 1.2.0, `side-effect`) calls `ctx.funnels.requestPublish`, which queues the review and returns `{status:'pending_approval', approvalId, created}` without suspending (the submit-page precedent). Its refusals are typed: `funnel_not_draft`, `step_pages_unpublished`, `not_found`. A chain receives them namespaced (`openwop-app.<code>`).
- **Census (pinned):** `publishFunnel` / `publishFunnelAsApproved` are called only by the human route, environment promotion and the decide handler. No chat tool, node or surface method reaches them.
- **Open question 6, resolved:** no chat tool and no `ctx.funnels` method publishes; `requestPublish` queues an approval whose human decision publishes.
- **Owed by whichever of 0942 and 0948 merges second:** a test that a campaign-run funnel publish resolves through the policy (cs-0942, agreed). There is no waiting mode and no resume path here; that rides 0942 P3's `resumeRunsAwaitingApproval`.
- **No UI change:** the inbox renders the kind from its `proposal` text, as it does `email-campaign-send`.
- **Review-round fixes (code-review and grade-workflows, 2026-10-20):**
  - **A decided row is never reported as pending.** Previously a re-request after a reject, or after publish-then-unpublish, converged on the decided row, reported `pending_approval`, and locked that content out of review. Fixed by the review cycles above.
  - **The digest pins step names and experiments**, because both change what a visitor is served.
  - **Separation of duties counts the member who caused an actorless run** (`submitterCauses`, ADR 0859 D4, redacted with `submitters`).
  - **The funnels surface's writes need `workspace:write`** (`orgPolicy.methodScopes` for `create`, `setSteps` and `requestPublish`). The org floor had been `workspace:read`, so a read-only member's run could draft or request; P1a carried the same gap for `create` and `set-steps`.
  - **Every publish refusal runs before the review is resolved** (`assertFunnelPublishable`, shared with `publishFunnel`), so a refusal consumes nothing. The reopen covers only a real race.
  - The approval lane always writes by CAS, including ADR 0942's `auto` lane, which has no digest.
  - **The `policy` passthrough was removed.** Named approvers were advertised, but neither the audience, the handler nor the shared eligibility check honoured them. ADR 0942's binding must extend all of them together; cs-0942 has been told.
  - The census now catches namespaced calls and refuses aliased or namespace imports of the publish functions.
- **Residuals (recorded, not fixed here):**
  - A reopen after a race leaves the earlier `approved` entry in the governance chain and keeps `decidedBy` on the row. This is shared with ADR 0905's email send; the fix belongs to core `reopenApproval`.
  - No "review requested" notification is sent: reviewers find it in the inbox.
  - The frontend `PendingApproval['kind']` union omits the kind, so the inbox renders it generically (email is the same).
  - The decider is matched on one identity spelling, as in email.
  - Product prices are not pinned; products are governed by commerce.
  - The human publish, archive and delete routes do not close open requests. A decision on one then closes it as `review_closed`.
- **Packs and ratchets:**
  - `feature.funnels.nodes` 1.1.0 → 1.2.0 (pin and steward manifest regenerated);
  - side-effect floor and served set each +1 (generator);
  - `pack-surface-arg-parity` fixture regenerated (literalNoSpread 295 → 296, assertedPairs 286 → 287).

**P3a (2026-10-20) — generate, as built** (after /architect):
- **One service, two doors.**
  - `features/funnels/generateService.ts` `generateFunnelFromBlueprint` sits behind `POST …/funnels/orgs/:orgId/generate` (`authorizeOrgScope`, `workspace:write`) and the Funnel Architect's `openwop:funnels.generate` tool (the same RFC 0049 check), plus `GET …/blueprints`.
  - Refusals are typed: `unknown_blueprint` (listing what is available), `brief_not_found` (absent or another org's, the same answer), `brief_not_confirmed`, `campaign_mismatch`, `invalid_params`, and `generate_in_progress`.
  - `invalid_params` exists because the params are validated against the chain's own `parameters` and `startWorkflowRun` validates nothing.
  - A run-start refusal keeps its own code, unlike the orchestration precedent, which flattens it to `dispatch_failed`.
  - An identical repeat inside the ignition window reuses the run.
- **Blueprints:** one predicate (`blueprints.ts`). The pack must be `core.openwop.workflows.funnels`, pinned by name, and the id must start `funnels.blueprint.`. Blueprints are registered chain-backed under the funnels toggle, so they have a deterministic id and a gated launch. Editable copies come from the gallery's from-chain. `parameters` reach the model verbatim through a schema-carrying read (`openwop:funnels.blueprints`, in `SCHEMA_READ_EXEMPT_TOOLS`).
- **Gemini:** the generate tool takes `paramsJson` (a JSON string), not an open object, because Gemini cannot declare a property-less object and the free-form ratchet does not grow. The HTTP route takes a real object.
- **Agent pack:** `vendor.openwop-app.funnels.agents` goes to 1.1.0. Its allowlist gains 4 tools: the two new ones plus the D5 read-before-write reads `openwop:campaign-brief.get-brief` and `openwop:cms.get-page`. The prompt no longer says "you cannot author pages".
- **No second chat.** The Funnels empty state embeds `chat/EmbeddedChatPanel` (lazy) scoped to the architect, with starter prompts that name the org. Campaign Studio deep-links `/?agent=…funnel-architect`.
- **Honest before P2b.** No real blueprint exists yet, so the list is empty (with a note) and generate says `unknown_blueprint`. A fixture chain in tests witnesses the mechanism; the P3 exit is P3b.
- **Owed by whichever of ADR 0941 / 0948 merges second:** call `stampCampaignRun` from `generateFunnelFromBlueprint` so a generate run carries the campaign tag ADR 0942 resolves a policy from, plus its test. Until then `campaignId` rides as an input only.
- **Recorded:** a chain pack installed at runtime does not register new blueprints until the next boot. The one predicate keeps both tools consistent with that.
- **Review-round fixes (code-review, grade-workflows, ux-review, 2026-10-20):**
  - The ignition key is the canonical (deep, key-sorted) JSON of the params. The first cut used an array replacer, which drops nested keys at every depth and collapsed distinct requests onto one run (the ADR 0917 defect).
  - A blueprint must declare the params generate fills (`orgId`, `briefId`, `campaignId`) and a schema that compiles. Otherwise it is not listed, rather than listed and unrepairable.
  - `registerFunnelBlueprints` also registers each blueprint's sub-chains same-id. A chain-backed parent binds a `subChainRef` to the same-id child, so P2b's nested `funnels.step.*` children would otherwise dangle.
  - 409 refusals carry `conflict`, and a non-object `params` on the route is a 400.
  - The generate tool shows its run in the chat (`surfaceDispatchedRun`), and the prompt tells the model to ask for brief and page ids (it cannot list them).
  - **UX:**
    - The architect is the shared `ChatPocket`, not an inline panel. The pocket is bounded, keyed by org, open by default only when there are no funnels, and refreshes the list after each turn.
    - Starter prompt labels name the org; the sent text carries its id.
    - The prompts are honest while no blueprint exists, with the read-only one first.
    - "No funnels" points at the architect.
    - The Studio button is quiet, shown only when funnels is on, and in a wrapping action bar. Its agent id is pinned by test.
  - **Tests added:**
    - nested params produce distinct runs;
    - a real campaign of another org, and one of another brief, are refused;
    - the tool door refuses another org's brief;
    - the launch gate refuses the run itself when funnels is off;
    - a no-contract chain is not listed;
    - the empty-set note is asserted unconditionally.
  - **Residual:** an org focus binding on the chat seam (ADR 0777 `focus`, `kind:'org'`) would let typed messages carry the org without starter prompts. That is a chat-owned seam, recorded for a follow-up.

**P4a (2026-10-20), as built:**
- **New kinds:**
  - `webinar`, which binds `{marketingEventId}`. It must be same-org, is checked at write and at publish, and the webinar needs a registration form.
  - `application`, which binds `{formId}` (same-org).
  - A binding is allowed only on its own kind. An offer is still refused on these steps.
- **Bindings persist and are pinned:**
  - The carry rule (an omitted key keeps the stored value while the kind is unchanged; `null` clears it) now covers `webinar` and `application` as well as `offer`.
  - The publish digest covers both bindings, so an approval pins them.
- **Server-derived outcome:** `stepOutcome.ts` `resolveServerOutcome`, called by the public `next` route.
  - A client `outcome` on these kinds is refused (`400 outcome_server_derived`).
  - Webinar: after the event, the visitor's own registration (a submission on the webinar's form, with this funnel and step as context, not held, naming a contact) plus the attendance activity → `accepted`; no attendance → `declined`.
  - Before the event, or with nothing attributable, there is no outcome.
  - Application: no outcome until ADR 0954 (P4b).
- **Public payload:** the step shows the webinar's title and start time only.
- **Viewer:** carries `?submission=` from a return link (ADR 0955 builds the link).
- **Editor:** a webinar picker and a form picker; switching kind drops a binding that no longer fits.
- **One kind list:** the tool text is generated from `FUNNEL_STEP_KINDS`, and a parity test pins the frontend mirror and the four locales.
- **Packs:**
  - `feature.funnels.nodes` 1.3.0 (descriptions);
  - `vendor.openwop-app.funnels.agents` 1.2.0 (prompt: the bindings, read before revise).
- **Ratchet:** feature dependencies 103 → 105 (`funnels → webinars`, `funnels → crm`).

**P6a (2026-10-20), as built:**
- `Funnel.primaryHostname` must be a SERVING custom domain of the same org, checked through `getDomain`, which also checks the tenant, and the shared `isServingDomain`. That predicate is extracted from `resolveCustomHost`, so the host lookup and funnels apply one rule. `null` or `''` clears the field.
- The hostname is in the publish digest. Publish refuses a domain that has stopped serving (`domain_not_serving`).
- `funnelPublicUrl` returns the platform viewer URL. `CUSTOM_DOMAIN_FUNNELS_SERVED` is false until P6b, so no link points at a domain that cannot serve the funnel. The funnel GET returns `publicUrl`.
- The editor offers a picker of the org's live domains. Its copy says the links keep the platform address until P6b.
- **P6b is BLOCKED, visibly:** the exit "canonical/OG URLs use the verified domain" cannot be met until a custom-domain funnel document exists. That depends on the edge-ownership work (ADR 0906, ADR 0940). Until then `CUSTOM_DOMAIN_FUNNELS_SERVED` stays false and every funnel link is the platform URL.
**P0b (2026-10-20) — a client org's own Connect seller.** As built, with the architect amendments (H1–H8):
- **Separate store:** `commerce-connect:client-seller`, keyed `tenant::org` and tenant-indexed. The tenant's own `sellers` collection, and its readers (marketplace listings, KickTodo payouts, operator import), are untouched. One adapter, `sellerRows({tenantId, orgId?})`, serves onboarding, sync and webhooks, so the client lane is the same code as the tenant lane.
- **The binding is (tenant, org):** `bindSellerAccount(tenant, acct, org?)` refuses `binding_conflict` unless both match. The agency's account can never become a client's, nor the reverse. Webhook account and payout events act on exactly the row the binding names, and payouts carry `orgId`.
- **The resolver reads ONLY the client's seller.** It returns:
  - `client_seller_required` when the client has no seller;
  - the seller's own not-ready reason when it is half-onboarded;
  - `connect` on the CLIENT's account when ready, gated on the tenant's `commerce-connect` toggle.

  It never returns the agency's account or the platform. **Architect call:** the storefront fee is the workspace's (`getStorefrontFeePct(tenantId)`), because the agency operates the store on this host, charged on the client's account.
- **Routes:** `GET|POST /commerce-connect/orgs/:orgId/seller[/onboard|/sync]`. Onboard and sync are **owner-only** (`host:org:manage` on the client org): choosing where a client's money is paid out is stricter than the tenant route's `workspace:write`. A workspace root gets `400 not_a_client_org`.
  - **Recorded:** an agency owner who is not a member of the client org is refused (403). ADR 0815 D1b says an org-scoped check reads that org's membership, and this route does not widen it. To set up a client's payments, be its owner.
- **Owner UI:** `GET …/commerce/orgs/:orgId/payments` adds `clientOrg`. For a client org the notice offers "Set up this client's payments", or "Finish…", which calls the org route and follows Stripe's hosted page. It never links to the agency's Commerce Connect page. Copy is in 4 locales.
- **Erasure:** the new namespace is classified with the other Connect financial records, which tenant teardown reclaims.
  - **Correction (review, same day):** the first draft said deleting a client org "leaves its seller row". That is false. `deleteOrg` refuses while any row carries the org's `orgId` (`accessControlService.ts:790`, the RI-7 refuse-while-populated rule). The client seller, its account binding and every client payout carry one, so **a client org with a seller cannot be deleted at all**, and a client org that was ever paid out never can, because payout rows are money records.
  - That fails closed: no orphaned seller, and no binding left pointing at a missing org. It is still a dead end for offboarding. **Handed to ADR 0921 client offboarding**, which must decide which of these rows it retires and whether `payout` counts toward the guard.
- **Review-round fixes (code-review, ux-review, grade-workflows, 2026-10-20):**
  - The operator import refuses an account bound to a client org, and binds before it writes, so a lost bind leaves no agency row.
  - `listPayouts` filters by org, so a client's payouts never appear as the agency's, either in the tenant payouts route or in the `seller-stats` node's "own seller" read.
  - `reconcileSellerBindings` checks a client binding against the client seller.
  - `sellerRows` refuses an `orgId` that is not a client org, rather than minting a row the resolver never reads.
  - The live fill compares-and-swaps from this request's own claim again (CC2CD-1).
  - Readiness returns `canOnboardClient` (owner scope and the Connect toggle, the onboard route's own predicate). Only the client org's owner sees the button. Others read "ask this client organization's owner", or the operator sentence when Connect is off.
  - Errors are shown in the reader's language, never the server's scope message.
  - The button stays busy while the browser leaves for Stripe.
  - Returning from Stripe syncs the client seller and re-reads the notice. An expired link says how to continue.
- **Deferred to P1:** the `set-steps` node description does not say a published client-org funnel can be refused `client_settlement_unconfirmed`. P1 edits the funnels node-pack descriptions anyway (WF-P0-1), and a description-only bump here would cost a pack version, pins and a steward manifest twice.
- ONE Stripe client and ONE webhook URL are unchanged.



Recovery source checkpoint — 2026-10-25 (not yet executed): the composed candidate
retains the current creative/variant recovery and all original funnel histories.
Both inboxes now have explicit funnel-publication groups, public-purchase copy,
an Approve & publish verb and an accurate completion toast. An incomplete row
cannot offer approval. The three frontend regression cases are authored UNRUN.

The publish request now freezes a delegated requester's canonical human before a
key can be revoked, retaining the shared separation-of-duties mechanism. Existing
or CAS-winning review rows must match kind, tenant, org, funnel and digest before
they can be returned/indexed. Two real-storage/runtime regressions for key
revocation and an occupied review id are authored UNRUN. The earlier source
checkpoint's campaign-run stamping and atomic Stripe account reverse binding
also still require execution. No additional Stripe client, webhook or secret
binding was introduced.

`content.publish` autonomy integration and named-policy approvers remain owed;
the request node continues to require a human. The earlier assertion that the
chokepoint already called this publish helper was incorrect and is corrected in
its source comment. Canonical qualification and production rollout are pending.

## Integration correction (2026-10-26, branch `feat/0948-funnels-integration`)

The recovery checkpoint above is now executed. P0b, P1a, P1b, P3a, P4a and P6a were
merged onto `main` (`7009245df`) as one branch. That branch supersedes #5077, #5083,
#5120 and the no-PR branches `feat/cs-0948-p3a-generate`,
`-p4a-webinar-application` and `-p6a-primary-hostname`. Every test Codex authored but
never ran was executed. **P2, P3b, P4b, P5 and P6b were never implemented and are not
claimed here.**

- **The stale checks were measured, not assumed.**
  - The P1 replay test and the cms leg-2 test were red only because the side-effect
    floor was stale. Regenerated: floor 391 → 395, served 348 → 352.
  - The pack-surface parity fixture and FEATURE-DEPENDENCIES were regenerated.
  - The undeclared-edge ratchet went 118 → 121 for exactly three funnels edges
    (`campaign-brief`, `webinars`, `crm`). Each degrades safely when its target is off.
  - P6a's test now uses main's ADR 0906 D4 `removeDomain`; force removal exists only
    after failed provider releases.
- **P0b: charge only on a confirmed binding.**
  - `resolveStorefrontSettlement` takes a `connect` lane only while the account's
    immutable reverse binding (`accountIndex`, first-writer since `ce9a8986e`) names
    exactly this seller, tenant AND org. Otherwise the lane is
    `demo/connect_incomplete`. This applies to the tenant lane too.
  - It is still ONE resolver and ONE brand mint, with `features/billing` untouched;
    the ADR 0877 charge-gate ratchet holds.
  - The anon guard now runs before the client-org check, so an `anon:` tenant is
    refused as `anon_tenant` on both lanes.
  - Witnessed (`adr0948-p0b-client-seller`, 14):
    - an account bound elsewhere never takes a charge;
    - deauthorization makes the client lane demo at once, and the agency lane is
      unaffected;
    - an `account.updated` that disables charges also makes it demo;
    - Codex's concurrent-bind regression is red under a get-then-put.
- **P0b residual, accepted (release-manager decision).** Account-state events stay
  toggle-gated (the CLAUDE.md money-truth rule covers money events only). So while
  `commerce-connect` is OFF, a deauthorization is not applied to the seller row.
  That is safe, for two reasons:
  - The resolver refuses (`connect_disabled`) for as long as the toggle is off.
  - Stripe refuses a charge to a deauthorized account.

  On re-enable, the stale row stands until the next `account.updated` or
  `/seller/sync`, which is ADR 0877's open question about stale state after a toggle
  flip. Recorded here beside it rather than fixed in this ADR.
- **P1b: named autonomy approvers are now honoured.** This closes the "owed" line
  above.
  - A `request-publish` from a campaign-bound run asks
    `enforceCampaignAction(content.publish, ceiling: 'approve')`, so a funnel never
    publishes without a person.
  - `blocked` refuses the request (`autonomy_blocked`) before any row exists.
  - `approve` stamps the policy's approvers and the source run on the row. The ONE
    shared ADR 0942 eligibility check (`registerAutonomyPolicyRowEligibility`,
    registered at funnels boot) admits only an eligible non-requester, IN ADDITION to
    the decide handler's `workspace:write` floor.
  - An unbound request (no campaign, autonomy off, a human) keeps the writers-only
    review.
  - The gate (policy hash + rule) is part of the row identity. A writers-only review
    therefore never stands in for a gated one: a plain request returns the open gated
    review, and a gated request supersedes an open writers-only one.
  - The owning CMS `content-publish` review is unchanged.
  - D3's plan to front blueprints with the in-run `autonomy-gate` node for
    `content.publish` cannot work. That class is on ADR 0942's PendingApproval lane,
    where the gate node answers `lane_unavailable`. The approval row is the lane.
  - Witnessed by `adr0948-p1b-autonomy` (5).
- **P3a.** A campaign-linked generate stamps `campaignOrchestration` at dispatch.
  This is asserted on the real run row, and the run appears in the campaign's run
  list. Child inheritance is main's generic `inheritedRunMetadata`, witnessed by
  `adr0942-p1-run-stamp`. No shipped blueprint declares a sub-chain yet.
- **Frontend.**
  - The primary-domain read now has its own failed state; it had counted as a
    failed-read sentinel.
  - The four FunnelDetailPage suites mock the new domains client; it had triggered
    the ADR 0661 live-fetch guard.
  - The eager i18n chunk was 110 B over its 156 kB budget, from the four
    notification keys. Per the release manager, no budget raise: #5252 (lazy
    `workforces`/`settings` catalogs) restores ~7.8 kB of headroom, and this branch
    merges after it. The next lever, when that runs out, is splitting the `chat` AREA
    catalog by surface.

## P2 (2026-10-26) — the lead-magnet blueprint, as built

Q3 decided lead-magnet first, then tripwire. This records the lead-magnet half. Tripwire
(sales → checkout + bump → upsell → downsell → thank you) is the next PR on the same
plumbing; it adds the money-step kinds to `compose-step-page` and takes `productIds`.

- **Chains** (`core.openwop.workflows.funnels` 1.2.0, the examples chain pack):
  - `funnels.blueprint.lead-magnet` (params `orgId`, `briefId`, `campaignId?`,
    `formId`, `name`, `provider?`, `model?`): two `core.subWorkflow` nodes
    (`subChainRef` `funnels.step.optin`, then `funnels.step.thankyou`,
    `onChildFailure: fail-parent`), `collect-steps`, then `feature.funnels.nodes.create`
    with the campaign. Each child's step comes back through `outputMapping`
    (`optinStep`, `thankyouStep`), declared in `producedVariables`. Params reach the
    children through ADR 0964 P1's forwarding (#5129).
  - Each `funnels.step.<kind>` reads the brief (`get-brief`), writes copy with
    `core.ai.structuredOutput` against a closed schema (`retryOnInvalidJson: 1`, so
    one error-fed repair, then the typed `structured_output_invalid`), composes the
    page, drafts it (`create-draft-page`), returns the step (`step-result`) and
    submits the page for review (`submit-page`).
  - Nothing publishes. The pages wait in review and the funnel is a draft; the
    publish request stays the separate, human-approved act of P1b.
- **Nodes** (`feature.funnels.nodes` 1.4.0, all pure, `role: action`):
  - `compose-step-page` builds the sections closed-world. Only named copy fields
    reach the page, and the CMS sanitizes again. The opt-in **form is the caller's
    `formId`, checked against the org's own forms** (`feature.forms.nodes.list-forms`
    wired in), never a form the model names. The CMS form section stores a bare
    reference, so without this check a blueprint could embed another client's form.
  - `step-result` writes the step to the run's variable bag. A sub-chain's result can
    only leave the child run through the bag (`outputMapping` reads variables), and
    `create-draft-page` writes none. It also outputs a flat `pageId`, because edge
    ports cannot address a nested field (`copy.data` works; `page.page.pageId` does
    not).
  - `collect-steps` orders the returned steps and fails `step_missing` rather than
    create a funnel with a step dropped.
- **Corrections to D3's chain shape:**
  - **No parent `get-brief`.** Each step sub-chain reads the brief itself, because the
    copy node needs it and a parent read cannot reach the child except through the bag.
    `generate` has already proven the brief is this org's and confirmed.
  - **No 0943 Copywriter pin yet.** The agent runner returns free text, with no
    output schema and no repair. The copy node is `core.ai.structuredOutput`, which
    meets the exchange rules (closed schema, one error-fed repair, typed failure).
    Swap to the Copywriter once ADR 0943 gives the runner a structured mode.
  - **No content-rules check.** ADR 0933 is still Proposed and ships no node. Add it
    between `copy` and `compose` when it lands.
  - **No `autonomy-gate` node.** This repeats the integration correction: the review
    rows are the lane.
- **Exits:**
  - The blueprint is listed by the generate lane (its sub-chains are not) and
    instantiates through `from-chain` with every typeId resolving.
  - A generate run drafts the opt-in page (hero, bullets, the caller's form) and the
    thank-you page, submits both (`in_review`), and creates one draft funnel with
    steps `[optin, thankyou]` on them.
  - A replay fork drafts no second page and mints no second funnel. This was owed
    by P1 for the nested case.
- **Residuals:**
  - A step chain can be started on its own by id, since it is registered same-id
    so the parent can bind it. It is hidden from the gallery and the generate list,
    and it is gated by the funnels toggle. Its `get-brief` node passes no `orgId`,
    so the read is checked against the brief's OWN org and the run caller's access
    there (`scopedBrief`), not bound to the step's `orgId`. Started directly, it
    could write copy from a brief of another org the caller can read into a page
    of the given org. Fixing that is a `feature.campaign-brief.nodes` change (pass
    `orgId`), not this PR.
  - The architect cannot list forms, so it must ask the user for `formId`. The
    param description says so.

## P2c (2026-10-26) — money steps in the viewer, as built

The release manager scoped it, the user approved it, and it comes before the tripwire
blueprint: a blueprint whose funnel cannot take a payment should not be shown. The
design went through an adversarial `/architect` pass BEFORE any code. All four HIGH
findings are built in (H1 to H4 below).

**Server** (`features/funnels/offerDecisions.ts`, `commerce/routes.ts`, `funnels/routes.ts`)
- **A funnel checkout sells exactly its offer.**
  - One main line, one of `offer.productIds`, quantity 1 (`product_not_offered`).
  - Bumps are distinct, offered, and quantity 1 (`bump_not_offered`).
  - Prices stay the catalog's (`createOrder`). The page posts only ids.
- **The return URL is the funnel's own checkout step.** It is `/fn/<org>/<slug>?step=<ix>&paid=1`, with the offer capability in the **fragment**: `#order=…&ft=…`. The fragment is never sent to a server and never appears in a Referer or request log. A cancel returns to `?step=<ix>&canceled=1`.
- **The capability `ft`.**
  - It is an HMAC (session secret) over tenant, org, parent order AND funnel, domain-separated and length-prefixed (the `oneClickToken.ts` shape). It carries no expiry of its own.
  - The window is the server's: the parent must be `paid`, be stamped with that funnel (`funnelRef`), and be within `FUNNEL_OFFER_WINDOW_MS` (2 h) of `paidAt`. A slow Stripe checkout therefore cannot expire it early.
  - A funnel purchase is extended only through `ft`. The storefront `oc` is refused on it, with or without a funnel ref (architect L3).
- **One decision per step.**
  - The decision row `funnels:offer-decision` (tenant, parent, funnel, step) is claimed with `putIfAbsent` after every cheap refusal and before any order or charge.
  - Only the step the funnel's OWN routing reaches may be claimed (`currentOfferStep` walks the rules from the checkout step over the recorded decisions). A downsell is therefore closed while its upsell is undecided or charging, and accept-after-decline, decline-after-accept and a replay all find the step taken (H4).
  - A second click on an accepted offer returns that purchase with no second charge.
- **The one-click funnel path:**
  - quantity is fixed at 1 (H2);
  - the idempotency key is per step, `oneclick:<parent>:<funnel>:<step>`, because an upsell and its downsell may offer the same product (H3);
  - **a Stripe error after the claim** keeps the step `charging` and the child order (and its stock) alive for the webhook, and answers 202. `charging` routes as accepted, the end of the offers, never a silent downsell after a possible charge (H1);
  - **a bank challenge** (`requires_action`) is a decline: the viewer has no on-page confirm, so nothing could complete it (architect Q4). The child is cancelled and the step routes as declined.
- **New public routes:**
  - `…/orders/:orderId/funnel-decline` records "No thanks".
  - `…/orders/:orderId/funnel-offer` answers paid/open while the webhook lags the redirect.
  - Both take the same capability checks; every refusal is the uniform 404.
- **Routing.** `upsell` and `downsell` join `SERVER_OUTCOME_KINDS`, so a client `outcome` is refused (`outcome_server_derived`). The outcome is the recorded decision, read only with the capability, which the viewer sends in the `X-OpenWOP-Funnel-Order` / `-Offer` headers (CORS-allowed). With no capability, routing is sequential, never an error.
- **Ownership.** The decision store lives in funnels. Commerce lends its order read through `registerOfferParentReader`, so funnels never imports commerce (no new feature edge).
- **Retention.** Decision rows carry ids only and are swept after 90 days by a default-window sweep.
- **Unchanged:** ONE settlement resolver, ONE Stripe client, ONE webhook, and fulfilment as the order-row CAS `pending→paid`. No live Stripe call in any test.

**Viewer** (`FunnelViewerPage.tsx`, new `FunnelOfferPanel.tsx`, 4 locales). It is never a dead end for a buyer who paid: every state that cannot sell offers Continue.
- **Checkout:**
  - It shows the offer (the products' public reads), a product choice, add-ons, email, name and an unticked "save my card for a one-click offer".
  - It has no bare Continue.
  - Live leaves for Stripe. Demo says no payment was taken and continues.
- **Back from Stripe:**
  - The capability is read from the fragment, kept in sessionStorage for this funnel, and removed from the address bar.
  - The viewer waits for `paid`, then advances.
- **Upsell/downsell with the capability:**
  - Yes, add it / No thanks; the server routes on the decision.
  - A card decline, a pending charge or a closed offer is said, with a Continue.
- **Without a purchase:** plain content with Continue.

**Tests**
- `test/adr0948-p2c-money-steps.test.ts` (8), against a mock Stripe server.
- `funnelMoneySteps.test.tsx` (5).
- `commerce-one-click` adapted: a funnel purchase uses `ft`, a storefront purchase keeps `oc`.
- `funnels-phase2`'s client-outcome leg moves to a `sales` step.

**Sabotage-witnessed** (each alone turns a leg red):

| Guard | Lane |
|---|---|
| The one-main-line check | server |
| The bump dedupe/quantity | server |
| `putIfAbsent` → `put` | server |
| The token HMAC | server |
| The parent's funnel binding | server |
| The server outcome kinds | server |
| The reachability check | server |
| `charging` routing as accepted | server |
| The funnel quantity cap | server |
| Sending a price | viewer |
| The capability in the URL | viewer |
| Leaving the fragment in the address bar | viewer |
| A Continue on checkout | viewer |

The concurrent-accept leg stays green with the claim sabotaged, because reachability serialises those requests in practice. The direct claim leg is its witness.

**`/code-review` (invoked, 2026-10-26).** All six money invariants were CONFIRMED against the code: one resolver, the CAS fulfilment, catalog amounts, the bound single-use capability, server-side routing, and no live Stripe. It found no CRITICAL. Fixed in this PR:
- **HIGH:** an upsell whose offer has no one-click product, or whose product was archived or failed to load, rendered nothing while Continue was hidden. A paying buyer had no way on. The panel now says so and offers Continue, plus a retry on a failed read.
- **MEDIUM:**
  - A checkout with no products left had no way on.
  - A `?paid=1` return with no purchase in the tab waited forever.
  - A refused accept (no saved card, chain limit) offered an Accept that could never work. It now reads as "no longer available" with Continue.
- **LOW:**
  - The duplicate-accept answer is now checked before the chain limit and reports the child's real status.
  - Funnel ids are trimmed once.

The dead-end leg in `funnelMoneySteps` is sabotage-witnessed: the panel rendering nothing and the endless wait each turn it red.

**Residuals (recorded)**
- **A Stripe error before the charge is classified as "unknown".** A bad key or invalid params takes the same path as a timeout: the step stays `charging` and routes as accepted, so the buyer skips the downsell. That is the safe direction, never a second charge. Definitive no-charge errors could settle as declined.
- **On a bank challenge the PaymentIntent is left in `requires_action`, not cancelled.** No money moves without the client secret. Cancelling it would need a new Stripe call.
- **`markAsPaid` throwing after a successful charge** leaves the step `charging` with no child id and a 500 to the buyer. The webhook still fulfils it, which mirrors the storefront.
- **The decision sweep scans the whole collection each window.** Small rows, but it belongs with EVID-4's per-tenant scan growth.
- **No active reconciler for a `charging` step.** The webhook marks the child paid by the intent's metadata, and the reservation is extended to cover it. If the webhook never arrives, the child expires unpaid and the step stays routed as accepted. A Stripe lookup by idempotency key before the expiry sweep is the follow-up the architect named.
- **A bank challenge on an offer is a decline.** An in-viewer on-session confirm would need Stripe.js on the public page; that is its own phase.
- **UTM rules are not part of reachability.** A routing rule keyed on UTM is not followed by `currentOfferStep`, which fails closed: such a funnel's offers may refuse a buyer the visitor-facing route would have sent there.
- **Live money in production is not exercised.** A real charge needs the user's go.

## Tripwire (2026-10-26) — the second blueprint (Q3), as built on P2 and P2c

`funnels.blueprint.tripwire`: sales → checkout (+ optional order bump) → one-click
upsell → downsell → thank you, drafted from a confirmed brief. It runs on P2's plumbing,
and its money steps are sold by P2c's viewer.

- **Chains** (`core.openwop.workflows.funnels` 1.3.0):
  - **Params:** `orgId`, `briefId`, `campaignId?`, `name`, `productId`, `bumpProductId?`, `upsellProductId`, `downsellProductId`, `provider?`, `model?`.
  - **Sub-chains:** five in order (`funnels.step.{sales, checkout, upsell, downsell}`, new, plus the shared `funnels.step.thankyou`), then `collect-steps`, then `create`.
  - **Each money step** reads the brief AND the org's products (`feature.commerce.nodes.list-products`) and writes copy against a closed schema with one repair. The prompt forbids stating a price, because the viewer shows the real one. It then drafts the page, returns the step and submits the page.
- **Nodes** (`feature.funnels.nodes` 1.5.0):
  - `compose-step-page` gains the four money kinds: a hero and points, copy only. The buy controls come from the step's offer in the viewer, never from the page.
  - `step-result` takes a fixed `stepId` and builds the step's `offer` from the caller's product ids:
    - checkout: `{productIds:[entry], bumpProductIds?:[bump]}`;
    - upsell and downsell: `{productIds:[p], oneClickProductId:p}`;
    - a money step without a product fails with `offer_missing`.
  - `collect-steps` carries `stepId`, `offer`, and the blueprint's literal routing map (`upsell` accepted → `thankyou`).
  - The shared thank-you step now has the fixed id `thankyou`.
- **The products are the caller's choice, and the funnels write decides.** `coerceOffer` refuses another org's or an inactive product, so the run fails before any funnel exists. The architect cannot list products, so the param descriptions say to ask the user.
- **Nothing is published or charged by the run.** The pages wait in review and the funnel is a draft. Selling starts only after a human publishes, through P2c.
- **Test:** `test/adr0948-tripwire.test.ts` (3).
  - Listed, and instantiable through from-chain.
  - A generate run drafts five pages in review and one draft funnel. It has the fixed stepIds, the offers built from the caller's products (bump on checkout only, one-click on upsell/downsell), the upsell routing, and no price or product id on any page.
  - Another client's product fails the run with `not_found` from the offer check, and no funnel is created.
  - **Sabotage-witnessed:** `collect-steps` dropping `offer`, dropping `routing`, `step-result` dropping `stepId`, and the bump mapped to the upsell.
- **Ratchet:** `seeded-chain-unfilled-params` 147 → 152, a declared +5 for exactly these chains.

