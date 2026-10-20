# ADR 0941 — Campaign Studio program and the canonical campaign

Status: Proposed
Date: 2026-10-19

Program: **Campaign Studio** (ADRs 0941–0962). This ADR is the program charter
and the data-model keystone; ADR 0942 (per-campaign autonomy policy) is the
governance keystone. Net-new program from David's 2026-10-19 request ("think big,
but root it in OpenWOP"; "all features must be grounded in existing architecture,
not hard-coded workarounds"). Not a MyndHyve port. **Extends** existing features;
it adds no toggle of its own.

## Context

The ask is a campaign studio that takes a real product to market end to end:
landing pages and funnels, ads with governed budgets, multivariate tests,
behaviour analytics, auto-selection of winners, creative generated from real
product assets, email/SMS/social, lead capture and grading, agency multi-client
operations, and human review wherever a campaign needs it. Every step runs as a
workflow with a named agent per node.

Most of the parts already ship, built by different programs at different times
(ADRs 0153–0160, 0200, 0236, 0267, 0351–0357, 0410, 0852, 0905, 0907, 0921–0934).
They do not share a spine. The word "campaign" names five different records, the
hub and the canvas both claim `/campaign-studio`, three toggles are labelled
"Campaign Studio", and the one entity that should anchor everything —
`MarketingCampaign` — does not exist until the **last** node of the orchestration
run. Building 21 more features on that floor would multiply the drift. This ADR
fixes the floor first.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths under `backend/typescript/src/` unless they start with `frontend/`,
`docs/`, `packs/` or `examples/`.

**A. Five "campaign" concepts.**

| # | Record | Where | Keyed by | Link to the others |
|---|---|---|---|---|
| C1 | `MarketingCampaign` | `features/campaign-orchestration/types.ts:14-47`, store `campaign-orchestration:campaign` (`campaignService.ts:25`) | `tenant::uuid` | `briefId`, `assetIds` (media ids, `:37-39`), `budget`, `utm` |
| C2 | Canvas campaign doc (`canvas.campaign`) | `features/campaign-studio/artifactTypes.ts:49-58` (channels / funnel / `assets[]` as free text) | canvas id | **none** |
| C3 | Email send ("`Campaign`") | `features/email/emailService.ts:97-122` | `campaignId` (its own) | `sourceBriefId` only (`:110-113`) |
| C4 | Ad dispatch | `host/adsAdapter.ts:221-233` `AdDispatchRecord` | `idemKey` | `briefId?`, `campaignName?`; **no `orgId`** |
| C5 | Campaign-ops asset / change request | `features/campaign-ops/types.ts:39-43` (`campaignId?`), #5022 `ChangeRequest.campaignId?` | asset/request id | an unvalidated string |

Attribution joins on yet another key, `utm.campaign` (`campaign-brief/types.ts:64`, `:124`,
`features/campaign-intel/attribution.ts`). The campaign→project binding (ADR 0852
D1) derives from `metadata.campaignOrchestration.briefId`
(`features/campaign-orchestration/agentTools.ts:174`).

**B. The campaign is born last, and not atomically.** `finalizeFromBrief`
(`campaignService.ts:142-157`) runs as the orchestration's final node
(`orchestrationWorkflow.ts:69-77`). It does `getCampaignByBrief` — an O(tenant)
`listByPrefix` scan (`:113-116`) — then `put` with a `randomUUID()` id (`:147`).
Two concurrent finalizes produce two campaigns for one brief (TOCTOU), and no run
before `finalize` can name the campaign it belongs to, so no per-campaign policy,
budget cap or experiment can bind to a running workflow.

**C. The product is free text.** `CampaignBrief.productName/productDescription`
(`campaign-brief/types.ts:115-117`). The commerce catalog (ADR 0410,
`features/commerce/commerceService.ts:241-250`) already holds `productId`,
`orgId` and `imageAssetTokens` — the real product imagery creative needs — and a
delete hook (`features/commerce/productLifecycleSeam.ts:28`).

**D. Route and label collision.**
- `/campaign-studio` = the `campaigns` console hub
  (`frontend/react/src/features/campaigns/routes.tsx:26`).
- `/campaign-studio/:canvasId` = the ADR 0153 canvas editor
  (`frontend/react/src/features/campaign-studio/routes.tsx:15`; framework
  `editorPath: '/campaign-studio'`, `campaign-studio/definition.tsx:60`). Any new
  one-segment child (`/campaign-studio/autonomy`) is either shadowed by
  `:canvasId` or shadows a canvas id; `/campaign-studio/new` is already the canvas
  "new" path.
- Three toggles labelled "Campaign Studio": `campaign-orchestration`
  (`features/campaign-orchestration/feature.ts:49`), `campaign-studio`
  (canvas, `features/campaign-studio/feature.ts:29`), `campaigns`
  ("…console", `features/campaigns/feature.ts:27`).

**E. Parallel checkers, spend math, approval lanes, adapters, brand.**
- Compliance: `features/brand/scoring.ts`, packs `vendor.myndhyve.ads-policy` and
  `vendor.myndhyve.ads-creative-validate`, and the campaign-channels generate-node
  checks. ADR 0933 D1/D7 defines ONE `host/contentRules/` (not yet on `main`).
- Spend: `campaign-intel/pacing.ts` (band alerts only), `budgetPlanner.ts` (pure
  goal engine), `intelligence.ts` (suggestions). The only budget WRITE is
  `adsAdapter.updateBudget` behind the spend gate (`host/adsAdapter.ts:1414-1417`,
  ADR 0357). `host/workflowBudgets.ts` / `host/runBudgetService.ts` are model/run
  cost budgets — a different concept with the same word.
- Approvals: `PendingApproval` kinds (`host/approvalService.ts:40-66`, incl.
  `campaign-spend`, `content-publish`, `email-campaign-send`; #5022 adds
  `campaign-change-set`) and `core.approvalGate` interrupts
  (`bootstrap/nodes.ts:953-1062`). ADR 0068 already projects both into one
  inbox read-side (`host/reviewProjection.ts:1-19`).
- Destinations: ADR 0922 `DestinationAdapter` (`campaign-ops/types.ts:89-100`) vs
  `adsAdapter` per-platform strategies (`host/adsAdapter.ts:1277`).
- Brand: per-org kit `features/brand` vs host white-label `host/brandAssets.ts`.
- Experiments: one bucketing (`host/variantAssignment.ts:1-12`, consumed by
  `cms/pageExperimentsService.ts`, `funnels/funnelsService.ts`,
  `campaign-journeys/surface.ts:12-17`) but **three** experiment records:
  `PageExperiment` (`pageExperimentsService.ts:61`), funnel `StepExperiment`
  (`funnels/funnelsService.ts:62-70`), CDP journey holdout (ADR 0267).

**F. Enforcement holes the program must not build on.**
- `vendor.myndhyve.ads-publish-meta` publishes to Meta with `net.outbound` +
  `ctx.secrets.resolve` (`packs/vendor.myndhyve.ads-publish-meta/pack.json`
  `runtime.requires`, node `ads.publish.meta`), i.e. outside the `adsAdapter`
  spend gate.
- `examples/connection-packs/meta-ads/pack.json:53` declares `apiHosts` with no
  `adapterOnly`, so the generic `core.openwop.http.fetch` can be credentialed for
  Meta (the `adapterOnly` rule, `host/connectionInjection.ts:164-171`).

## Decision

### D1 — `MarketingCampaign` is the single source of truth

Every campaign-scoped record in the program keys on `MarketingCampaign.id`, and
the campaign carries `orgId` = the **client org** (ADR 0921 D1). Owner:
`features/campaign-orchestration` (store unchanged). The model grows additively:

```ts
interface MarketingCampaign {          // existing fields unchanged (types.ts:14-47)
  briefId?: string;                    // D2: optional — ops/imported campaigns need no brief
  productRefs?: Array<{ productId: string; role: 'primary' | 'secondary' }>; // ADR 0410, same orgId
  funnelIds?: string[];                // funnels the campaign drives (owner: funnels)
  autonomy?: { policyId: string; version: number };  // ADR 0942 binding (null ⇒ org default)
  goal?: CampaignGoal;                 // D2b; frozen into each run at start
  // NOT here: experiments, variant sets, assets, sends, dispatches, caps.
}
interface CampaignGoal {               // owned here; consumed by 0952 caps, 0956, 0960, 0961 (0961 D5 does not redefine it)
  outcome: { metric: 'conversions' | 'purchases' | 'revenue' | 'leads' | 'qualified_leads'
                   | 'roas' | 'cpa' | 'cpl'; target: number; by?: string };
  mediaBudget?: { totalMinor: number; currency: string; dailyCapMinor?: number }; // plan; 0952 enforces caps
  guardrails?: Array<{ metric: string; op: '<=' | '>='; value: number }>;         // 0949/0950 read these
  version: number;                     // bumped on every edit; the frozen copy names it
}
```

**Child records point at the campaign; the campaign does not hold their lists.**
Experiments (0949), variant sets (0946), destination assets (0922), email sends
(0905), ad dispatches (0907/0952), social posts (0953), spend caps (0952) each
carry `campaignId` and are owned by their feature. `MarketingCampaign.assetIds`
stays the media edge it is (ADR 0922 rejected widening it). A read projection
`GET …/campaigns/:id/links` fans out to the owners' org-gated reads (the ADR 0570
D3 read-back rule: a failed read is reported, never shown as "unlinked").

Every child write validates `campaign.orgId === child.orgId` (uniform 404 on
mismatch, the ADR 0921 D3 loader); a dangling `campaignId` is refused, not stored.

### D2 — The campaign exists before its first run

- Deterministic id: `cmp_` + base32(sha256(`tenant`, `briefId`)) for a briefed
  campaign; `cmp_` + uuid for a brief-less one. A brief index row
  (`campaign-orchestration:brief-index`, `putIfAbsent`) replaces the
  `getCampaignByBrief` scan.
- `ensureDraftCampaign(brief)` runs at **ignition** (`runOrchestrationRunTool`,
  `agentTools.ts:147-176`, before `startWorkflowRun`), not at `finalize`.
  `finalize` becomes an update of that row. Concurrency: `putIfAbsent` on the
  index; the loser reads the winner.
- **Run stamp:** the host-written `campaignOrchestration` block (already
  caller-stripped, `host/runDispatch.ts:94-104`) gains `campaignId` and `orgId`.
  `briefId` stays for ADR 0852's project binding. Every Campaign Studio run is
  started by a feature service or tool that writes this block; a run without it
  is not a campaign run and no campaign policy applies to it.

### D2b — The campaign run tag, the run index and the frozen goal

- **Run tag.** The ADR 0941 run tag is the host-written block above:
  `campaignOrchestration = {campaignId, orgId, briefId?, goalVersion, role?}`, where
  `role` is `'spine' | 'stage' | 'optimizer' | 'report'` (set by the launching
  service; 0960 shows it, 0961 sets it; a fork is recognised by its `forkMode`). It is in
  `CAMPAIGN_ATTRIBUTION_KEYS`, so it is stripped from caller metadata
  (`host/runDispatch.ts:94-104`). Only campaign services and tools write it,
  through one helper (`stampCampaignRun`), and `:fork` copies it verbatim. That
  makes it non-spoofable. Every campaign-scoped read (0960 cockpit, 0942 policy,
  0952 caps) trusts **only** this tag, never a `campaignId` argument.
- **One tag, not several.** Program ADRs name this block "the run tag" and read
  the client from its `orgId`. They add no second campaign stamp (0960 D2 and 0961
  D4 use this one). ADR 0921's `openwop-app.campaignOps` client stamp
  (`bindRunToClient`) stays for client-scoped runs that belong to no campaign
  (campaign-ops change sets, MCP reads before a campaign is named). Where both
  are present they must name the same org, or the run is refused `wrong_client`.
- **Per-campaign run index.** `campaign-orchestration:run-index`, keyed
  `tenant::campaignId::startedAt::runId`, is written by the same helper at run
  creation (`putIfAbsent`; a fork writes its own row with `forkOf`). It is a
  point-lookup prefix, never a tenant scan, and it is what 0960 lists. It is
  cleared with the campaign by the ADR 0852 delete hook.
- **Frozen goal.** A run-start contributor stamps
  `run.metadata.campaignGoal` (a copy of `CampaignGoal` at that version), added to
  `RESERVED_RUN_METADATA_KEYS` (`host/runDispatch.ts:81`). It contributes nothing
  when `derivedFromRun`, and a child run copies its parent's goal. A goal edit
  affects only runs started after it, the same rule as the ADR 0942 policy stamp.

### D3 — Product link to the commerce catalog

`productRefs` names catalog products of the **same org**; validated through
`ctx.features.commerce` reads, never by copying product fields. Brief free text
stays as a description. `onProductDeleted` (`productLifecycleSeam.ts:28`)
detaches the ref and flags the campaign `needs_attention` (no cascade delete of a
campaign). ADR 0945 owns how creative uses `imageAssetTokens`.

### D4 — One owner per duplicated concept

| Concept | Single owner | Others become | Migration step |
|---|---|---|---|
| Campaign | `MarketingCampaign` (C1) | C2 canvas = the campaign's **plan document** (`campaignId?` on the doc); C3 = "email send" with `marketingCampaignId`; C4 dispatch gains `campaignId` + `orgId`; C5 `campaignId` validated | P2 (below) |
| Content/compliance checks | `host/contentRules/` (ADR 0933) | brand scoring, `ads-policy`, `ads-creative-validate`, channel checks become ruleSets or thin pack wrappers calling it | 0946 D5 (P2) extends 0933 D7 with `ruleSet:'channel-policy'`; no fifth checker |
| Spend writes | `adsAdapter` (the chokepoint) | pacing/planner/intelligence stay pure read models; reallocation = apply through the spend gate (ADR 0357) | 0952 adds caps + auto-pause at the same chokepoint |
| "Budget" word | media budget = `campaign.budget` + 0952 caps | `workflowBudgets`/`runBudgetService` renamed "run budget" in UI copy only | glossary |
| Approvals | the two existing lanes, one projection (ADR 0068) | no third lane; ADR 0942 owns the bridge | 0942 |
| Destinations | ADR 0922 `DestinationAdapter` | the ads destination **wraps** `adsAdapter`; never a second ads client | 0952 P0 |
| Brand | per-org `features/brand` by `campaign.brandId` | `host/brandAssets.ts` is never used for client creative | ratchet test in P4 |
| Experiments | ADR 0949's one record over `variantAssignment` | `PageExperiment`, `StepExperiment`, journey holdout become adapters | 0949 |
| Ads egress | `adsAdapter` + `adapterOnly` connection packs | `vendor.myndhyve.ads-publish-*` are refused in campaign chains until they call `ctx.ads` | P4 (below) |
| Agent memory | per **client org** (David, 2026-10-18) | never per agency | 0944 |

### D5 — Routes and labels

- `/campaign-studio` stays the hub. **No new one-segment child** of
  `/campaign-studio`. New surfaces are two segments or more:
  `/campaign-studio/campaigns/:campaignId/*` (campaign detail; the 0960 cockpit
  lives here) and `/campaign-studio/clients/:orgId/*` (agency views).
- The canvas editor moves to `/campaign-studio/plans/:canvasId`
  (`editorPath: '/campaign-studio/plans'`); `/campaign-studio/:canvasId` stays as a
  redirect that accepts only canvas-id shapes and `new`. A route-table test
  asserts the only one-segment child is that redirect.
- **Toggle rule for the program.** A new capability inside an existing feature is
  a **sub-toggle**: an `extraToggleDefaults` entry of the parent feature with id
  `<parent>.<capability>` (precedents `creative-video.t2v`, `app-builder.deploy`,
  `service-desk.widget`). A sub-toggle carries no `dependsOn`, because ADR 0194's
  `dependsOn` is declared per `BackendFeature`. Its consumer checks the parent and
  any other required toggle in code (an AND-gate). Only a new feature package
  gets a new top-level kebab id with `dependsOn`. Existing kebab sub-toggles
  (`campaign-ops-client-portal`, `analytics-visitor-identity`,
  `email-approval-gate`) keep their ids.
- **Which parent.** Campaign-scoped work extends `campaign-orchestration`, the owner
  of `MarketingCampaign` (this ADR, 0942's campaign override, 0946, 0960, 0962).
  Client-scoped configuration extends `campaign-ops`, the owner of `ClientAccount`
  (ADR 0921): 0942's client default, 0943's agent bindings, 0944's client memory,
  0957, 0958. The split follows the record each feature owns, so it is coherent.
- Toggle **ids stay**: `campaigns`, `campaign-studio`, `campaign-orchestration`,
  `campaign-brief`, `campaign-channels`, `campaign-intel`, `campaign-connectors`,
  `campaign-journeys`, `campaign-ops`, `campaign-ops-client-portal`,
  `email-approval-gate`, `creative-briefs`, `brand`, `funnels`, `cms`. Only
  display labels change: `campaigns` → "Campaign Studio", `campaign-orchestration`
  → "Campaign Studio — orchestration", `campaign-studio` → "Campaign plans
  (canvas)" (4 locales).

### D6 — The program's differentiator, concretely

Positioning: *you see and sign off on every change; automation runs inside limits
you set; every decision can be replayed.* Each program ADR must name which of
these it uses and which competitor gap it closes (brief § Competitive scan):

| OpenWOP primitive (existing) | What it gives a campaign | Competitor gap it closes |
|---|---|---|
| Durable runs + `:fork` + replay (`routes/runs.ts`, `executor/forkInterrupts.ts`, `executor/replayDivergence.ts`, `executor/sideEffects.ts`) | "Why did this variant win / this budget move?" answered by replaying the run that decided it, with the policy it ran under (ADR 0942 stamp) | Meta Advantage+ silent swaps; Unbounce Smart Traffic and Braze "hard to trace"; Google "transparency without control". n8n has per-tool HITL but no replay. |
| A named, governed agent per node (`executor/agentRegistry.ts`, roster, ADR 0163 chain packs, sub-chains, ADR 0311 stacks) | Strategist → Creative Director → Media Buyer as accountable nodes with evals (ADR 0889), not a generic "AI step" | GHL AI step (60 s, free text), HubSpot "Run Agent" beta |
| Role-routed human gates inside runs (`approvalService`, `approverResolution`, `approvalSla`, `approvalDelegations`, `core.approvalGate`) | HITL dialled per campaign and per risk (ADR 0942) | Ziflow/Workfront gate assets, Klaviyo/Braze have one approve button; GHL Agent Studio has no approval node |
| Agency = `ws:` workspace, client = org (ADR 0921) | Per-client brand, connections, memory, spend caps and approvers in one control plane | No incumbent isolates agents/memory/brand/spend per client |
| Open protocol + MCP server/client | Campaign operations callable by outside agents under the same gates (ADR 0962) | Competitors use MCP only as an outbound data door |
| Honesty invariants (CLAUDE.md lanes) | Typed failure, closed-world validation, verified read-back (ADR 0925), real-product fidelity checks (ADR 0945) | Nobody verifies generated creative against the catalog product; no vendor auto-promotes with an audit trail |

### D7 — Program dependency tiers

| Tier | ADRs | Depends on |
|---|---|---|
| 0 — foundations | **0941** canonical campaign · **0942** autonomy policy · 0943 agent team + node assignment · 0944 client-scoped memory | 0921, 0852, 0410, 0036, 0068 |
| 1 — creative + pages | 0945 product-grounded creative + fidelity · 0946 variant factory · 0947 proofing + staged review · 0948 funnel builder + blueprints | Tier 0, 0933, 0410, 0411, 0924 |
| 2 — channels | 0952 paid media + spend control · 0953 social publishing · 0955 lifecycle journeys · 0954 lead intelligence | Tier 0–1, 0907, 0905, 0267 |
| 3 — measure + optimize | 0949 experimentation engine · 0950 governed auto-promotion · 0951 consent-gated behaviour analytics · 0956 attribution + incrementality | Tier 0–2, 0236, 0099 |
| 4 — agency scale | 0958 vendor/guest collaboration · 0957 client reporting + portal · 0959 playbooks + governed rollout | Tier 0–3, 0924, 0934 |
| 5 — capstone | 0960 command center · 0961 brief-to-launch autopilot · 0962 open agent interface (MCP/A2A) | everything above |

**Rule:** within a tier, ADRs are listed in build order. An ADR may depend only on
an ADR in an earlier tier or earlier in its own tier. A reference to a later ADR
is written "integrates with, not depends on": the earlier ADR ships without it
and gains the integration when the later one lands. Program review applied this
rule: 0947→0958, 0948→0949/0954/0955, 0942→0943/0945, 0950→0960, 0952→0956/0960,
0953→0956, 0955→0949/0950/0954 (0955's experiments waiting on 0949 is the known
soft dependency), and 0960→0961 are integrations. Tier 2 was reordered so 0954
follows 0955 (0954 uses 0955's eligibility function and inbound SMS); Tier 3 so
0951 follows 0949 (it files hypotheses into 0949's backlog); Tier 4 so 0957
follows 0958 (its portal identity is 0958's collaborator).

Hard sequencing: **nothing that creates an external effect (0948 publish, Tiers
2–3) ships before 0942 P3** (chokepoints consult the policy); 0950 needs 0949;
0961 needs 0943 + 0942 + one channel per lane.

### D8 — Glossary (binding on every program ADR and UI string)

- **Agency** — a shared `ws:` workspace (tenant); its root org is the agency's house account.
- **Client** — a non-root org in the agency workspace (ADR 0921). The isolation key.
- **Campaign** — a `MarketingCampaign` row: one client, one goal, one autonomy policy.
- **Plan** — the canvas document (ADR 0153) describing a campaign; not the campaign.
- **Email send** — a `features/email` `Campaign` row (the code name stays).
- **Variant set** — the concept-diverse group of creative/copy/page variants made together for one experiment (ADR 0946).
- **Action class** — a dotted id for an effect a campaign can cause (`ads.budget`, `email.campaign-send`), the ADR 0036/0028 namespace (ADR 0942).
- **Gate** — the point where a campaign's autonomy policy decides an action class's outcome: auto, notify-after, approve, or blocked (ADR 0942).
- **Playbook** — a versioned chain pack (or stack template) that instantiates a campaign for a client, rolled out under change control (ADR 0959).
- **Media budget** — money spent on platforms (campaign budget + caps). **Run budget** — model/compute cost of runs. Never one word for both.
- **Member** — one item of a variant set (copy, image, video, landing page or email), bound to a concept and a channel (ADR 0946). Never called an "asset".
- **Run tag** — the host-written `campaignOrchestration` block on a campaign run (D2b): `{campaignId, orgId, briefId?, goalVersion, role?}`. The one source of "which campaign and client is this run for".
- **CampaignGoal** — the campaign's outcome target, media budget and guardrails (D1), frozen into each run as `campaignGoal` (D2b).
- **External collaborator** — a vendor, freelancer or client stakeholder (ADR 0958): an ordinary user of their own home tenant holding per-resource grants, or a grant-backed sharing link. Never a member of the agency workspace and never a new principal kind.
- **Agent roles** — exactly ADR 0943 D1's ten: Strategist, Creative Director, Copywriter, Media Buyer, CRO Analyst, Lifecycle Marketer, Lead Qualifier, Compliance Reviewer, Reporting Analyst, Producer.

### D9 — Program-level wire facts

- **One wire-RFC dependency.** The chain-pack manifest schema is closed and has
  **no `agent` field** (`schemas/workflow-chain-pack-manifest.schema.json`), so a
  chain node cannot declare its named agent portably. v1 binds agents host-side
  after expansion (ADR 0943), which is host-only and frozen at run start. Making
  the binding portable needs an **RFC 0013 revision in `../openwop` via `/prd`**.
  It is the program's only wire-RFC dependency, and it gates nothing in v1.
  This ADR owns it; ADRs 0943 and 0961 cite it.
- **RFC positions across the program.** Every program ADR is a host extension.
  Beyond the one recommended RFC above: 0942's portable `actionClass` on
  `PackNode` is optional and not recommended; 0945's `referenceImages`/`seedImage`
  on the generator capabilities (the ADR 0411 P4 item) and 0959's slot marker or
  new RFC 0098 `ExportKind` are optional, deferred until a portable pack or a
  second host needs them; 0958 flags a conditional RFC only if an external person
  must resolve a run interrupt as themselves on the wire; 0962's A2A phase (P4)
  may need an RFC and is not built without `/prd`.
- **Sub-chain nesting has already landed**: RFC 0133 (workflow-chain composition)
  has been **Accepted** since 2026-07-23 (`../openwop/RFCS/0133-workflow-chain-composition.md:7-10`).
  The CLAUDE.md paragraph that calls nesting an unexpressed "additive RFC 0013
  extension" is stale. Program ADRs use nested chains (playbooks 0959, autopilot
  0961) without a new RFC. The lead corrects CLAUDE.md, not this ADR.
- **Two separate surfaces, not one.** The ADR 0926 operator inbox (cross-client
  campaign-ops change sets) and the ADR 0960 cockpit's Command tab (live run graph
  per campaign) stay separate. Both read the ADR 0068 review projection; neither
  owns approval state.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | No new package. Extends `features/campaign-orchestration` (model, ignition, links projection), `features/campaign-studio` (doc field, route move), `features/email`, `host/adsAdapter.ts`, `features/campaign-ops` (validation). Core edit: one key added to the host-written attribution block. |
| 2 | Toggle | **None new.** All ids in D5 stay stable; labels change only. |
| 3 | Workflow surface | `ctx.features['campaign-orchestration'].getCampaign({campaignId})` and `.links({campaignId})`, org-checked against the run stamp (ADR 0921 D3 style). |
| 4 | Node pack | `feature.campaign-orchestration.nodes.campaign-context` (role `read`): resolves the run's campaign, product refs and policy summary for downstream nodes. Pack version bump + registry republish. |
| 5 | Envelopes | None. |
| 6 | Agent pack | The Campaign Strategist (`vendor.openwop-app.campaign-orchestration.agents`) gains read tool `campaign-orchestration.get-campaign` (read before write; ADR 0308 `registerFeatureAgentTool`, sharing the route's access predicate). |
| 7 | Public surface | None. |
| 8 | RBAC | Unchanged predicates: read `workspace:read`, write `workspace:write` on the campaign's client org; child links validated same-org; uniform 404. |
| 9 | Replay / fork | The stamp's `campaignId` is host-written, reserved from callers, copied verbatim on `:fork`; `ensureDraftCampaign` is outside the run (no replay effect). |
| 10 | Frontend | D5 routes; campaign detail page shell at `/campaign-studio/campaigns/:campaignId`; links panel; product picker over the commerce catalog. 4-locale i18n. |

## RFC verdict

**Host extension, no RFC.** Every change is a host store, a host-written run
metadata key, or a route under `/v1/host/openwop-app/*`. Nothing is advertised.
Program-wide: the only wire dependency is the optional RFC 0013 revision for a
portable node→agent binding (D9). It does not block v1.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0** | Deterministic id + brief index; `ensureDraftCampaign` at ignition; `finalize` → update; run tag via `stampCampaignRun`; per-campaign run index; `CampaignGoal` + frozen `campaignGoal` stamp | Route test: two concurrent ignitions produce one campaign; the run tag names it; a caller-supplied tag or goal is stripped; the index lists the run without a tenant scan |
| P1 | `productRefs`, `funnelIds`, `goal`, `autonomy` fields; same-org validation; product-delete hook; `GET …/links` projection | Wrong-org product ref → 404; deleted product → `needs_attention`; links shows a failed read as failed |
| P2 | Back-links: email `marketingCampaignId`; `AdDispatchRecord.{campaignId, orgId}` (reads fall back to `briefId`); canvas doc `campaignId` (validator + AJV + pack + agent tool together, the ADR 0570 rule); `CampaignAsset.campaignId` / `ChangeRequest.campaignId` validated | A dangling id is refused at every writer; legacy rows read back |
| P3 | Frontend: route rule + canvas move + redirect; label renames; detail shell; product picker | Route-table test; `npm run build`; 4 locales |
| P4 | Consolidation guards: ratchet tests that campaign chains contain no `vendor.myndhyve.ads-publish-*` node and no `host/brandAssets` read; `adapterOnly` on the four ads connection packs (verify the injection path first) | Sabotage-witnessed red for each ratchet |
| P5 | `ctx` surface, `campaign-context` node, Strategist read tool, prompt-catalog parity test | `promptCatalogParity` green; agent reads before it plans |

## Alternatives weighed

- **Make the canvas doc the campaign.** It already has channels/funnel/assets.
  Rejected: free text, no org-scoped child records, no versions of record; a plan
  is a view of intent, not the system of record.
- **A new `campaign-studio-core` entity.** Rejected: a sixth campaign concept;
  ADR 0922 and 0852 already chose `MarketingCampaign`.
- **Campaign holds child id lists.** Rejected: every owner would need a CAS on
  the campaign row to link; drift-prone hand-kept lists. Children point up.
- **Keep the campaign born at finalize.** Rejected: nothing in a running workflow
  can bind to it, which defeats per-campaign policy (0942), caps (0952) and
  experiments (0949).

## PRD-vs-architecture corrections

1. "Campaign studio" in the ask is a product, not a feature id: it maps onto
   existing toggles, and the name moves to the console label.
2. ADR 0158's "one campaign per brief, created at finalize" — **corrected**: one
   campaign per brief still holds, but it is created at ignition (D2). ADR 0158
   needs an inline correction note when P0 lands.
3. "Manage email campaigns" = email **sends** linked to a campaign, not a second
   campaign entity.

## Open questions

1. **(David)** Naming: may the canvas toggle's label become "Campaign plans" and
   the console take the "Campaign Studio" name?
2. **(David)** May a campaign exist without a brief (agency ops, imported
   campaigns)? Proposed: yes, `briefId` optional.
3. Multi-product campaigns: is `productRefs` with one `primary` enough, or does
   0946 need per-variant product binding? Proposed: per-variant in 0946.
4. `AdDispatchRecord` has no `orgId` today — back-fill from the brief's org, or
   leave legacy rows tenant-only and exclude them from client views? Proposed:
   back-fill where the brief resolves; exclude the rest.
5. Should `utm_campaign` values be minted from `campaignId` going forward
   (attribution stops depending on operator-typed strings)? Proposed: yes, in 0956.
6. No `/architect` review has been invoked on this ADR yet.

## Corrections requested in other ADRs

Program ADRs found statements in ADRs outside 0941–0962 that this program
overturns. The owners apply each correction as an inline note when the program
phase lands. ADR 0924 belongs to a0, so this program does not edit it.

- **ADR 0924 D4** — `ClientAccount.approvalPolicy` becomes the `ApproverSpec` of the
  client's `campaign.change-set.apply` rule. Why: one per-client approval setting,
  not a second store beside the autonomy policy. Program ADR: 0942 D9.
- **ADR 0924 D5** — the separate `ClientApprover` token store is replaced by an ADR
  0958 `client-stakeholder` collaborator with a `decide` grant, reached through a
  grant-backed sharing link. Why: ADR 0448 D3 allows one home for link-shaped
  capabilities (sharing resolvers), and e-sign already lives there. Program ADRs:
  0958 D3, 0957 D5, 0947 D6.
- **ADR 0926** — its operator inbox and the ADR 0960 Command tab stay separate
  surfaces; 0926's copy denylist applies to the inbox only, and the inbox links to
  the Command tab. The "Campaigns needing you" home tile is one tile, owned by 0926.
  Why: the inbox is plain-language and cross-client, the cockpit is a per-campaign
  run view; both read the ADR 0068 projection. Program ADRs: 0960 D7, 0941 D9.
- **ADR 0158** — "one campaign per brief, created at finalize" becomes "created at
  ignition, updated at finalize". Why: no running workflow could bind to a campaign
  that does not exist yet. Program ADR: 0941 D2.
- **ADR 0294 Phase 6** — "the surface exposes NO publish verb" becomes "no chat tool
  and no `ctx.funnels` method can publish; a gate-only chain node can". Why:
  blueprint chains publish behind the 0942 gate. Program ADR: 0948 D3, Q6.
- **ADR 0297 (FM-8a)** — the deferral of webinar funnels is lifted: its revisit
  trigger ("a funnel-step kind + scheduler jobs + journey chains, no new engine")
  is met. Program ADR: 0948 D4, Q2.
- **ADR 0166** — "live social dispatch is RFC-gated" is stale; outbound posting rides
  Accepted RFCs 0045/0046/0047/0079/0095, as ADR 0167 showed for ads. Program ADR:
  0953 S1, D6.
- **ADR 0357 §3** — the promised "pause" recommendations and applied/skipped
  stamp-back were never built. Program ADR: 0952 P3 delivers both (D1, D3).
- **ADR 0905 D3** — the send-approval pin becomes a variant-set pin
  `{variantId → (templateVersion, contentHash)}` for email experiments. Program ADR:
  0955 D6.
- **ADR 0907** — the `meta-ads` connection pack authorizes against Graph `v19.0`
  while the adapter calls `v25.0`; filed against 0907, not fixed by the program.
  Program ADR: 0952 P7.
- **ADR 0236 / ADR 0294 P4** — the page and funnel-step `significant` flag is a
  fixed-horizon z-test read on every request (peeking). It gains warnings in 0949 P0
  and is replaced by 0949's engine. Program ADR: 0949 E-1.
- **CLAUDE.md** (not an ADR, owned by the lead) — sub-chain nesting and produced
  variables are expressed by RFC 0133 (Accepted 2026-07-23). Program ADRs: 0941 D9,
  0959, 0961.

## Defects found while writing the program

Live defects on `main`, found by program ADRs. Severity is **high** when money,
consent or authorization fails open.

| Defect | Where | Owning ADR | Severity |
|---|---|---|---|
| Ads spend gate fails open: a governance-policy read error is "treated as unset" and the live write proceeds | `host/adsAdapter.ts:348` | 0952 (P2) | high |
| Ads audience gate fails open the same way | `host/adsAdapter.ts:1320` | 0952 (P2) | high |
| `vendor.myndhyve.ads-publish-meta` publishes to Meta with `net.outbound` + `ctx.secrets.resolve`, outside the adsAdapter spend gate | `packs/vendor.myndhyve.ads-publish-meta/pack.json` | 0941 P4, 0942 D6 | high |
| `meta-ads` connection pack declares `apiHosts` without `adapterOnly`, so the generic `http.fetch` can be credentialed for Meta | `examples/connection-packs/meta-ads/pack.json:53` | 0941 P4 | high |
| Consent toggle OFF makes `isAllowed` permit every non-strict category | `features/consent/consentService.ts:908-909` | 0951, 0955 | high |
| `marketing.sms` is not strict opt-in (only WhatsApp is) | `features/consent/consentService.ts:56` | 0955 (J3) | high |
| The generic `sms-send` node ignores consent and STOP; the adapter checks only the idempotency ledger | `packs/core.openwop.integration/index.mjs:184-193`, `host/smsAdapter.ts:47-108` | 0955 (J4) | high |
| An MCP caller can approve its own run's gate when the gate names no approver | `host/mcpSemantics.ts:282-323` | 0942 D10, 0962 D4 | high |
| Public funnel checkout accepts any active product as an order bump | `features/commerce/routes.ts:539-543` | 0948 (F3) | high |
| A client org's funnel checkout settles to the agency's Connect account (settlement keyed by tenant) | `features/commerce-connect/storefrontSettlement.ts:94` | 0948 (F5, D8) | high |
| Contacts are tenant-scoped, so every agency operator with CRM read sees every client's leads | `features/crm/contactsService.ts:79-120, 823` | 0954 (L1), blocker handed to 0941 + accessControl owner | high |
| Suppression is email-keyed and tenant-wide: one client's bounce suppresses another's | `features/crm/suppressionService.ts:113, 155` | 0955 (J2) | medium |
| Journey enrollment carries no client, so a client-A run can act on any contact | ADR 0222 enrollment key | 0955 (J9) | high |
| `promoteExperiment` reads no results: any running arm can be promoted, at 100%, at once | `features/cms/pageExperimentsService.ts:436-510` (`:446`) | 0949, 0950 | medium |
| A/B `significant` flag is a fixed-horizon z-test computed on every read (peeking); no SRM check | `pageExperimentsService.ts:602-612`, `features/funnels/funnelStats.ts:242-249` | 0949 (E-1, E-4) | medium |
| Funnel step results read only the newest 50,000 tenant events, silently | `features/funnels/funnelStats.ts:226` | 0949 (E-2) | medium |
| The agent runner ignores the node's `agent` pin (inputs → config → configurable only) | `host/agentRunnerNode.ts:65-98` | 0943 (F1) | medium |
| The run lane ignores `memoryScope`, so a `per-user` agent reads and writes the shared agent scope | `host/agentRunnerNode.ts:346-350` | 0944 (M2) | high |
| Lead score scans the whole tenant's events per contact and caps silently at 50,000 | `features/crm/leadScoreService.ts:36` | 0954 (L3) | medium |
| ADR 0357 promised "pause" recommendations and applied/skipped stamp-back; neither exists | `features/campaign-intel/routes.ts:117-145` | 0952 (P3) | low |
| Pacing joins spend to a campaign by name as a fallback | `features/campaign-intel/pacing.ts:75` | 0952 (P4) | medium |
| Spend-and-write generation nodes are `role:"action"`, so a `:fork` re-dispatches (and re-pays) them | `packs/feature.creative-video.nodes`, `feature.creative-briefs.nodes`, `feature.campaign-channels.nodes` (`render-concepts`, `publish-ad-variants`) | 0945 (G5), 0952 (P6) | medium |
| Provenance is lossy: the renderer's lineage is dropped by `cleanLineage`; prompts cut to 500 chars | `features/creative-briefs/render/renderService.ts:438`, `features/media/imageGenRoutes.ts:147, 279` | 0945 (G3) | low |
| Product image tokens are unvalidated strings that nothing ties to the product's org | `features/commerce/commerceService.ts:364` | 0945 (G2) | medium |
| A2A 0.3 card lists every installed pack agent as directly dispatchable, outside a run | `host/a2aCard.ts:91-97`, `host/a2aServer.ts:226-231` | 0962 (X3, D8) | medium (high if live tools are reachable, 0962 Q3) |
| Two `getCampaignByBrief` finalizes race (TOCTOU), producing two campaigns for one brief | `features/campaign-orchestration/campaignService.ts:142-157` | 0941 (D2) | low |
| Doc rot: orchestration still documented as `builtinWorkflows`; toggle text says fan-out is sequential | `features/campaign-orchestration/orchestrationWorkflow.ts:2-5`, `feature.ts:50-52` | 0961 (A-G6) | low |

## Planning rows

**ROADMAP (new "Campaign Studio program" section, Tier 0, order 1):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| 1 | **Program charter + canonical campaign** ([ADR 0941](docs/adr/0941-campaign-studio-program-and-canonical-campaign.md)): `MarketingCampaign` as SoT keyed by client org, created at ignition, product link to the catalog, child records point up, route/label collision resolved | *(extends `campaign-orchestration`; no new toggle)* | 0158, 0410, 0852, 0921, 0922 | `feature.campaign-orchestration.nodes.campaign-context` | Host extension | 🔵 Proposed |

**FEATURES "Future features" row:**

- **Campaign Studio program — canonical campaign (ADR 0941, Proposed 2026-10-19)** —
  every campaign-scoped record (plans, email sends, ad dispatches, assets,
  experiments, variant sets, caps) keys on `MarketingCampaign.id` and the client
  org; the campaign exists from the first run, links real catalog products, and is
  the anchor for ADRs 0942–0962. No new toggle (extends `campaign-orchestration`;
  labels only change). No RFC.
