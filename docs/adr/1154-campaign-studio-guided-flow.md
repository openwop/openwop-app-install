# ADR 1154 — Campaign Studio guided flow

Status: Accepted (P1 backend records and P2 progress reads built 2026-11-21, with one P1 part still owed, the D4 channel chain step; P3, the step rail on the campaign page, built 2026-11-22 behind `campaigns.guided`, default OFF)

Date: 2026-11-20. Extends `campaigns` (ADR 0200) and `campaign-orchestration`
(ADRs 0158, 0941, 0960). Source: an in-conversation design, drawn at
https://claude.ai/artifact/66y1rAStDwhP6rwMp5erp6 and reviewed with `/plan`,
`/architect` (track A, options mode) and `/feature-refinement`. Net-new; not a
port. Host extension only: **no RFC**.

## Context

Campaign Studio is nine toggled features and about twenty screens. A marketer
has to know which screen holds which part of the work, and nothing tells them
what comes next.

Measured on `origin/main` at `155d2fd85c` (frontend paths under
`frontend/react/src/`, backend under `backend/typescript/src/`):

- **The single console is off by default.** The `campaigns` toggle is `off`, so
  the Marketing nav group shows up to twelve separate entries. With it on, the
  console opens on its first tab, Operations (`hubTab.order` 0 in
  `features/campaign-ops/routes.tsx`).
- **There is no campaign home.** `CampaignStudioHubPage.tsx` owns no data and
  renders six tabs. `CampaignDetailPage.tsx` is one scroll of about eleven
  sections. Opening a campaign leaves the hub, and "back" goes to `/campaigns`.
- **Nothing computes a campaign's position.** `CampaignStatus` is
  `draft|active|paused|completed|archived`, written by exactly one caller, the
  `PATCH` in `features/campaign-orchestration/routes.ts`. No node or service
  moves it. The only "what is missing" checklist, `runPreflight`
  (`features/campaign-autopilot/preflight.ts`), is reachable only through a
  route that needs the default-off `campaign-autopilot` toggle.
- **Links between screens point at the wrong place.** The brief's "Finalized"
  chip goes to the campaign list, not the campaign. Launch state sends creative
  briefs to `/documents`. The brief's knowledge field links to `/kb`, an
  admin-tier page a marketer cannot open.
- **The trackers do not record this.** `docs/steward/UX_UPGRADE-campaigns.md`
  grades the hub's information architecture A, and no tracker names the
  cross-screen flow as a gap.

The work itself is already orchestrated. `campaign-studio.campaign-orchestration`
runs validate → kernel → gate → five channel child runs → production plan →
consistency → finalize, and every run carries the ADR 0941 run tag and is in the
per-campaign run index. The problem is presentation and a few missing links
between records, not a missing engine.

## Decision

Campaign Studio becomes **one nav entry, one home, and one path every campaign
follows**: Brief → Plan → Create → Review → Launch → Measure.

### D1 — The step is derived, never stored

A campaign's step and next action are a **server-side read** folded from records
the existing chains already write. There is no `stage` field, no transition
table and no new driver. The executor, the chain packs, the approval gates and
the run tag stay the only things that move a campaign forward.

`CampaignStatus` stays a stored field. It is changed by hand, or by a node in a
launch run. A read never writes it.

### D2 — What each step reads

| Step | Meaning | Existing owner it reads |
|---|---|---|
| Brief | Who, what and the core message | `CampaignBrief.status`, `validateBrief`, `setupOf`, the kernel and its review; chain `campaign-studio.messaging-kernel` |
| Plan | The plan canvas, production plan, goal and media budget | `campaign.goal`, `productionPlanId`, plan links (`listPlansForCampaign`), `planBudget` |
| Create | Each enabled channel's draft | channel child runs from the run index; the stored channel outcome (D4) |
| Review | Everything waiting on a person | open interrupts on tagged runs, pending approvals with a campaign id (D5), open review windows (`listOpenVetoes`) |
| Launch | Ready to go live, and what went live | preflight (D6), the ads dispatch ledger, the stored channel outcome, `campaign.status` |
| Measure | Results and suggested moves | `listRecords(…, campaignId)`, `kpiSummary`, budget, anomalies, reallocation plans (D7) |

"Plan" keeps the ADR 0941 D8 meaning: the step centres on the plan canvas. When
`campaign-studio` (the canvas feature) is off, the canvas part of the step reads
as unavailable and the rest still works.

Create is driven by `campaign.channels`, not a fixed list of five, so a channel
added later (ADR 1126 film) appears without a change here.

Every section of the read returns `ok`, `unknown` or `unavailable`, the way
`readCampaignLinks` already does. A section that cannot be read is shown as
unknown. It is never shown as not started or as done.

### D3 — A campaign exists from the first click

"New campaign" creates the brief and its draft `MarketingCampaign` together, so
the workspace has one id from the start. Today the row appears only when a run
starts (`ensureDraftCampaign`) or on finalize. Briefs that predate this have no
campaign; the home read lists them at the Brief step and the row is created when
one is opened. No backfill migration.

Brief-step runs (`messaging-kernel`, `market-intel`) are stamped with the run tag
through `stampCampaignRun`, role `brief`, when the brief has a campaign. They
then appear in the run index like every other campaign run.

### D4 — A channel's outcome is written by its chain

Whether a channel draft was approved, rejected or published is not stored today.
It exists only as an interrupt resolution and run events, and the command
snapshot folds events for live runs only.

Each channel chain gains a step after its gate that records the outcome through
a new op on `ctx.features['campaign-orchestration']`. The campaign row gains
`channelState`, keyed by channel: `{runId, state, at}` where `state` is
`drafting|awaiting-review|approved|rejected|published`. The write is keyed by
run id and channel, so a replay or fork writes nothing new. This is the same
shape as `finalize` and `attachAssets`: a node in the run writes host state
through the feature surface.

Campaigns whose channels ran before this have no `channelState`. Their Create
and Review steps read `unknown` until a channel is run again.

### D5 — Approvals carry the campaign

`ReviewRequest` gains an optional `campaignId`, and `listReviews` gains a
`campaignId` filter. `creative-publish-review` stores the id it already checks;
`campaign-spend` stores it beside `briefId`. Access is unchanged: the filter
narrows what the caller could already see.

There is no second inbox. `/inbox` stays the one queue. The home's "Needs you"
list and the Review step are filtered views of it, and a gate is resolved with
the existing interrupt card.

### D6 — Preflight moves down one package

The pure checks in `runPreflight` move into `campaign-orchestration`, with a
read route under that toggle. `campaign-autopilot` imports them, which keeps the
existing import direction (autopilot already imports orchestration). The launch
action stays behind `campaign-autopilot`.

> **Correction, 2026-11-21 (P1).** The preflight was the only autopilot code
> that imported `campaign-brief`, so moving it left autopilot's declared
> `dependsOn: campaign-brief` with no import behind it, which ADR 0439's
> parity test refuses. The brief is now a `recommends` on `campaign-autopilot`,
> as it already is on `campaign-orchestration`. The effect: a workspace can turn
> the brief feature off while autopilot stays on. Autopilot still refuses a
> campaign with no brief (`brief_missing`).

### D7 — Results filter by campaign

`GET /anomalies`, `/overview`, `/attribution` and `/reallocations` in
`campaign-intel` gain an optional `campaignId`, joined with the existing
`campaignJoinKey`.

### D8 — Launch is a run

"Launch campaign" starts a chain run. It adds a `launch` stage to
`AUTOPILOT_STAGES` beside `drafts`: activate the paused ad dispatches through
the existing spend gate, publish each approved draft through its channel's
publish step, then set `status: 'active'`. No route fans out publishes itself.

This depends on publishing an approved channel draft, which is on
`feat/channel-publish-after-approval` and not on `main`. Until it lands, the
Launch step ships as preflight plus an honest launch state. Social posts never
publish (ADR 0953); the step says they are handed to the user.

### D9 — Routes, navigation and the toggle

- Workspace routes are `/campaign-studio/campaigns/:campaignId/:step`, with no
  nav entries (ADR 0941 D5: two segments or more).
- `/campaign-studio` renders the home when the sub-toggle `campaigns.guided` is
  on (off by default, tenant-bucketed), and the six tabs when it is off.
- The Library (Brand, Personas, Playbooks, Clients and team, Connections) links
  to the existing pages. Operations and Playbooks are client-scoped, not
  campaign-scoped, so they live there and not on the path.
- The six legacy paths stay reachable (ADR 0200), so saved menu overrides
  (ADR 0139) keep working.
- The Campaign Studio nav entry is shown whenever any campaign feature is on,
  not only when `campaigns` is on.
- A shared step-rail primitive is added to `ui/` with its rule in `DESIGN.md`.
  It is presentation only and takes the server's read.

### D10 — Chat

No new chat surface and no new agent. Buttons deep-link the one chat with
`/?agent=`. The Strategist's existing `openwop:campaign-orchestration.status`
tool returns the same read as the route, through one shared helper, and returns
nothing without an acting user. One of the two agents both labelled "Campaign
Strategist" is relabelled.

## Corrections to the design

The canvas was drawn before the mechanisms were read. Three things on it are
wrong and are not built:

- **"Send 3 to Review"** — there is no such transition. A channel's gate opens
  inside its own chain. Review is the list of open gates.
- **Status follows the path** — it does not. See D1.
- **"Everything approved" as a preflight check** — it can only be true where D4
  has recorded an outcome; otherwise it reads unknown.

## Alternatives weighed

| Option | Cost now | Debt it leaves | Verdict |
|---|---|---|---|
| A. Derive the step in the browser from today's endpoints | Smallest | N+1 reads per campaign on the home; the frontend becomes the authority; approvals stay unfilterable | Rejected |
| B. Store a `stage` field with transitions | Medium | A second orchestration beside the executor that drifts from the runs | Rejected (`ARCHITECTURE.md` contract) |
| C. Server-derived read plus write-backs from chain nodes | Largest | None new; closes real record gaps | **Chosen** |

What would change this: if channel outcomes could be recovered from the run
index in bounded reads without D4, D4 would be dropped. Today that needs each
finished run's event log, which is unbounded across runs.

A new `campaign-workspace` feature package was also rejected: the home belongs
to the existing console (`campaigns`) and campaign-scoped work belongs to
`campaign-orchestration` (ADR 0941 D5).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `campaigns` (home, shell) and `campaign-orchestration` (read, write-back, preflight). Touches `campaign-brief`, `campaign-channels`, `campaign-intel`, `campaign-autopilot` and `host/reviewProjection.ts`. No new package. |
| 2 | Toggle | Sub-toggle `campaigns.guided`, off, tenant. No other new id. |
| 3 | Workflow surface | One new op, `recordChannelOutcome`, on `ctx.features['campaign-orchestration']`. |
| 4 | Node pack | The op's node in `feature.campaign-orchestration.nodes`; chain pack bumps for `campaign-channels`, `campaign-brief` and `campaign-autopilot`. |
| 5 | Chat | Existing tools; `.status` returns the D1 read. A row in `docs/steward/LLM-EXCHANGE-AUDIT.md`. |
| 6 | Agent pack | None new. One label change. |
| 7 | Public surface | None. |
| 8 | RBAC | Every read through `loadCampaignScoped`; the home read applies it per campaign; `workspace:read` for reads, `workspace:write` for the write-back's route equivalents. |
| 9 | Replay / fork | The write-back is idempotent by `runId` + channel. Nothing reads the toggle inside a run. |
| 10 | Frontend | D9 routes; existing section components re-homed under steps; four-locale i18n; ADR 0941 D8 glossary; the ADR 0926 denylist stays on the ops namespace. |

**RFC verdict:** host extension under `/host/openwop-app/*`. Rides RFC 0013
(chains) and RFC 0118 (parallel dispatch) as today. No capability is advertised.

## Phases

| Phase | What ships | Gate |
|---|---|---|
| P0 | This ADR, the correction notes on ADRs 0200, 0941 and 0960, the ROADMAP and FEATURES rows | Accepted |
| P1 | D3, D4, D5, D6, D7, each with route-level tests | `npm run ci`; backend deploy |
| P2 | `GET …/campaigns/:id/progress` and one aggregated home read; the list uses point reads on campaign and brief rows only; `.status` parity | `npm run ci`; backend deploy |
| P3 | `campaigns.guided`, the step rail, the workspace routes and overview; existing sections re-homed unchanged | frontend build; frontend deploy after P2 |
| P4 | Home (Needs you, campaigns, Library); nav entry rule; wrong-target links; knowledge "Manage" link shown to admins only; label unification; the guided tour updated for both modes | frontend build |
| P5 | Step depth: Brief section nav, Create board, Review with interrupt cards, Measure with approve in place, Launch preflight, then D8 | D8 waits on channel publish |
| P6 | Sub-toggle on for the demo; acceptance pass in a browser; make it the default; retire the tabs and re-pin their tests; mark this ADR implemented | acceptance pass |

P1–P2 and P3 can run in parallel once the shape of the P2 read is fixed.

### Implementation record

| Decision | Built in P1 (2026-11-21) | Still owed |
|---|---|---|
| D3 | `POST …/campaign-studio/campaigns` creates a brief and its draft campaign together; `POST …/campaigns/for-brief` creates or returns the campaign for an existing brief; brief research runs carry the campaign run tag with role `brief`. The existing brief route is unchanged. | — |
| D4 | `channelState` on the campaign row; `recordChannelOutcome` on the workflow surface. The campaign and run id come from the run tag only, never from an argument; the same run and state writes nothing. | No chain calls it yet. The channel chains are also edited by the unmerged channel-publish work, so the node and the chain step follow that. |
| D5 | `campaignId` on `ReviewRequest`; `GET /reviews?campaignId=`. A workflow gate takes its id from the run tag. `creative-publish-review` stores it. A `campaign-spend` approval stores it when a campaign run's policy asked for it, or when a reallocation plan was made for one campaign (added 2026-11-21; a label only, never part of the spend key). | A `campaign-spend` approval raised outside a campaign run (the threshold gate, brand compliance, audience upload) carries none: that code knows only the brief. |
| D6 | `runPreflight` lives in `campaign-orchestration`; `GET …/campaigns/:id/preflight` works with autopilot off; autopilot re-exports it. See the correction under D6. | — |
| D7 | `campaignId` on `/anomalies`, `/overview` and `/reallocations`. On `/attribution` it keeps only that campaign's row, after the whole client's join (added 2026-11-21); the client-level sections are unchanged. | — |

Tests: `backend/typescript/test/adr1154-p1-campaign-records.test.ts` (15 route-level
cases). Sabotage-witnessed red on four mechanisms: the review filter, the run-tag
read, the overview filter and the same-run no-op.

**P2 (built 2026-11-21).** `campaign-orchestration/progress.ts` holds the pure
fold (`foldProgress`) and the per-campaign detail read. Two routes use it:
`GET …/campaigns/:campaignId/progress` and `GET …/home`. The status tool returns
the same fold for a `campaignId`. The current step depends only on the campaign
row, the brief row and the count of waiting reviews, so the home list and the
workspace read cannot disagree. Detail sections (launch checklist, plan links,
review windows, run count) read `ok`, `unknown` or `unavailable` and never
change a step. Measure detail stays with the campaign-intel routes.

Until a channel chain calls `recordChannelOutcome` (owed from D4), the Create
step reads `not-started` for a draft campaign and `unknown` for a finalized one.

Tests: `backend/typescript/test/adr1154-p2-campaign-progress.test.ts` (13 cases).
Sabotage-witnessed red on four mechanisms: the other-client brief rule, the
`unknown` state for a finalized campaign, the per-campaign waiting count on the
route, and the same count in the status tool.

**P3 (built 2026-11-22).** The sub-toggle `campaigns.guided` (default OFF, bucket
`tenant`) is declared in the `campaigns` feature. The campaign page shows the
guided flow only when both `campaigns` and `campaigns.guided` are on; with
either off the page is unchanged and reads no progress.

- **Step rail.** `ui/StepRail.tsx` is a named `nav` holding an ordered list of
  links. It is not a tablist: each step has its own address, the current one
  carries `aria-current="step"`, and each link says its state in words. The rule
  is in `DESIGN.md`.
- **Routes.** `/campaign-studio/campaigns/:campaignId/:step` beside the existing
  campaign route. An unknown step segment shows the overview.
- **Page.** `CampaignDetailPage` reads `GET …/campaigns/:id/progress` through
  `progressClient.ts`. The overview shows the rail and a "Next" link to the
  current step, or to Review when a decision is waiting. A step address shows
  only that step's sections. The existing sections are re-homed, not rewritten.
  A failed progress read is a failure with a retry, never an empty rail, and a
  step the server calls `unknown` is drawn as unknown.

Tests: `ui/__tests__/StepRail.test.tsx` (4 cases) and
`features/campaign-orchestration/__tests__/campaignGuidedFlow.test.tsx` (6 cases).
Sabotage-witnessed red on three mechanisms: the current-step mark, the
two-toggle rule and the step-only sections.

Not in P3: the home, the nav entry rule and the tour (P4); no browser pass yet
(P6).

## Risks

- **Pinned tests.** `adr0200-campaign-hub.test.ts`, `adr0145-rehoming.test.ts`,
  `cscon-grade-probe.test.tsx`, `features.test.ts`,
  `campaignStudioRouteTable.test.tsx` and `e2e/hub-suspense.spec.ts` pin the
  six-tab hub, and the first-brief tour clicks a tab by id. P3 keeps the tab
  metadata so they stay green. P6 changes them on purpose.
- **Home read cost.** It must not fold run events per campaign. It reads only
  campaign rows, brief rows and one filtered approvals query.
- **Untagged runs.** A run started from the `/` picker on a tenant copy of a
  chain carries no run tag and will not appear in the workspace.
- **Overlap.** ADR 0570 (plan to execution linking, Proposed) touches the Plan
  step. ADR 0957 is owned on the other machine.

## Open questions

- [ ] Should a campaign-less brief get its row eagerly on first home load, or
      only when opened (D3 says when opened)?
- [ ] Does the Review step need its own filter for client approvals from
      `campaign-ops`, whose `campaignId` is optional?
- [ ] `GET /pacing` and `/forecast`: whether they already filter by campaign was
      not read. Check in P1.
- [ ] Which agent keeps the "Campaign Strategist" label (D10).
