# ADR 0852 — The project is the one collaboration container: campaign projects, initiative roll-ups, bound channels

Status: Accepted (maintainer decision 2026-10-07: option B) — P1–P5 implemented

- **Program:** ROADMAP § "Collaborative orchestration program", item 2 (the team
  ledger "scoped to a feature or campaign") and the shared prerequisite of items
  3 and 4 (a *bound channel* to capture decisions in and post drift cards to).
- **Composes:** ADR 0831 (team intent ledger, project-scoped), ADR 0084 (a
  project with a `facet` IS a project: notebooks), ADR 0839 D5 (a priority-matrix
  idea is promoted INTO a project), ADR 0054 D5 (visibility ≠ authority), ADR
  0158 (campaigns), ADR 0126 (channels), ADR 0233 (strategy initiatives).
- **Toggle:** none new. Each phase rides an existing toggle (`team-intent-ledger`,
  `campaign-orchestration`, `channels`, `strategy`).
- **RFC verdict:** host-only. No wire change; the run stamp
  (`run.metadata.teamLedger = {ledgerId, version}`) is unchanged, so replay and
  `:fork` behave exactly as today.

## 1. Context

The ROADMAP asks for a ledger "bound to a project, feature, or campaign". ADR
0831 shipped projects only. Measured on `origin/main` (2026-10-07):

| Candidate | Owner | Access | Board | Chat | Host-written run attribution |
|---|---|---|---|---|---|
| Project | `createdBy`, members | `resolveProjectAccess` (org + visibility) | yes | yes (group chat, `ownerSubject`) | `metadata.kanban.boardId`, `schedule.ownerScope` |
| Campaign (`MarketingCampaign`, ADR 0158) | **none** (only `createdBy`) | org-scoped (`hasOrgScope`) | no | no | `metadata.campaignOrchestration.briefId`, `metadata.campaignChannel.briefId` — **caller-settable** |
| "Feature" | **no entity** | — | — | — | — |
| Strategy initiative | `ownerUserId` | strategy rules | no | no | none (nothing runs *on* an initiative) |

General channels (`type:'channel'`) have no binding to any of these;
`createChannel` never sets `ownerSubject`.

Four designs were compared (review 2026-10-07): (A) a second ledger scope for
campaigns; (B) the project as the one container; (C) a new feature entity; (D) a
generic scope adapter. **B** wins on every axis: it duplicates nothing (owner,
members, visibility, board, chat, eraser and delete cascade come with the
project); it keeps ONE authorization rule; run binding reuses the stamp path;
it gives campaigns the board and chat that items 3 and 4 need; and it is the
pattern the app already uses twice (notebooks, promoted ideas). A and D rebuild
for every kind what a project already is; C fights the facet pattern.

## 2. Decision

### D1 — A campaign gets a linked project (`facet: 'campaign'`)

- `MarketingCampaign.projectId?: string`; `Project.facet` widens to
  `'notebook' | 'campaign' | 'feature'`.
- **The link is its own row** (`campaign-orchestration:project-link`, one per
  campaign, written with `putIfAbsent`), not a field on the campaign: two
  concurrent "ensure" calls may each create a project, exactly one link wins and
  the loser deletes its project, and the campaign row is never compare-and-swapped
  for it. `GET …/campaigns/:id` returns the linked `projectId`.
- **Created on finalize** (`finalizeFromBrief`, every finalize, create-or-return)
  — and **fail-soft**: creating the project can fail (the workspace's project
  cap, a storage error), and finalizing a campaign must not.
- **Existing campaigns** get theirs lazily: `POST …/campaigns/:id/project`
  (workspace write on the campaign's org), create-or-return. A link whose project
  was deleted is stale and is replaced — removed only after a re-check, so a
  concurrent ensure's fresh link is never deleted. No bulk backfill.
- **Visibility is `org` and cannot be made private while linked**
  (`setProjectVisibility` refuses for `facet:'campaign'`): the campaign is
  org-readable, and a private project behind it would make the two access rules
  disagree about the same work.
- **Deleting the campaign archives its project** (the charter's
  `status:'archived'`) and clears the facet (lifting the visibility lock) through
  the existing `fireCampaignDeleted` seam; the project, its board, chat and
  ledger history survive and follow the project's own delete and erasure rules.
- `campaign-orchestration` declares `dependsOn: ['projects']`.

### D2 — Campaign runs bind to that project

The ledger's run contributor (`runStamp.ts boundProjectId`) asks a host seam,
`host/runProjectBinding.ts`, after its kanban / schedule branches; the campaign
feature registers the resolver (`metadata.campaignOrchestration.briefId` or
`metadata.campaignChannel.briefId` → `getCampaignByBrief` → the linked project),
so the ledger never depends on campaigns. Both keys are added to
`stripCallerAttribution` (`host/runDispatch.ts`), so `POST /runs` can no longer
attach a run to a campaign the caller names; host code (the campaign agent
tools) keeps writing them. The existing acting-user read check still applies.

### D3 — A feature is a project

Stated, not built as an entity: run a feature as a project. `facet:'feature'` is
an optional label (a chip on the project, a filter on the list) with no
behavior. Nothing else changes.

### D4 — Strategy initiatives show a roll-up of their projects' ledgers

`GET /host/openwop-app/team-ledger/summaries?projectIds=a,b,c` (owned by the
ledger feature, so `strategy` does not depend on it) returns, for each project
the CALLER can read, `{projectId, name, version, openQuestions, pending,
recentDecisions[≤3]}`; unreadable ids are omitted, never 403'd (no existence
oracle). The strategy's Alignment tab calls it for every project linked to the
strategy or to one of its initiatives (`linkedProjectIds`) when the ledger
toggle is on. Read-only; neither a strategy nor an initiative has a ledger of
its own.

> **CORRECTED in P4:** this said "the strategy initiative view". The strategy
> page has no per-initiative project view — projects are linked on the
> Alignment tab — so the roll-up lives there and covers initiatives' projects.

### D5 — A channel can be bound to a project

- `ConversationMeta.boundProjectId?: string` on `type:'channel'` only. A POINTER,
  not ownership: `ownerSubject` keeps its meaning (membership and the read gate).
- Set or cleared by someone with write on the channel AND write on the project.
- **Only an org-visible project can be bound**, and a binding to a project
  later made private goes INERT (composes nothing) until it is org-visible
  again. Reason: an agent's reply in a channel is read by every member, so
  grounding it in a private project's ledger would leak that ledger to members
  who cannot open the project — a per-caller prompt check does not cover the
  audience of the reply.
- Effects: the ADR 0831 B3 chat provider reads `ownerSubject ?? boundProject`;
  the channel's members pane shows a read-only ledger summary with a link to the
  project's Ledger tab. Items 3 and 4 use the binding as "the bound channel".

### D6 — Ledger panels outside the project page

- **Campaign detail:** a Ledger section that renders `ProjectLedgerTab` for the
  campaign's project (creating it on first open via D1's lazy route).
- **Channel members pane:** the D5 summary.
- **Initiative view:** the D4 roll-up.

## 3. Consequences

- One access rule, one store, one eraser, one stamp path for every kind of
  shared work; a new kind later is a facet, not a new subsystem.
- A campaign now has a board and a chat, which items 3 and 4 need anyway.
- Cost: campaign ↔ project consistency (D1's create ordering, the visibility
  lock, the delete → archive seam) — each with a test below.
- Not done: a campaign's `objective` is not mirrored into the project charter
  automatically; the ledger's goal is the project's charter goal (ADR 0831),
  which the campaign creator sets on the project. Mirroring both ways would give
  one fact two owners.

## 4. Phased implementation

| Phase | Scope | Exit |
|---|---|---|
| P1 | D1 link (create on finalize, lazy route, visibility lock, delete → archive) + D2 binding + attribution strip | Tests: finalize creates exactly one linked project; the failed-second-step cleanup; the lazy route under a race yields one project; private refused while linked; delete archives; a campaign agent run is stamped with the project's ledger version; a caller-supplied `campaignOrchestration` on `POST /runs` is stripped |
| P2 | D6 campaign Ledger section | Component test; `e2e/handoff-ledger.spec.ts` gains a campaign leg; `/ux-review` |
| P3 | D5 channel binding + members-pane summary + B3 provider reads the binding | Tests: bind needs write on both; a private project cannot be bound and a bound one made private composes nothing; the summary renders; browser leg |
| P4 | D4 roll-up route + initiative panel | Tests: unreadable ids omitted (not 403); toggle off ⇒ the panel is absent |
| P5 | D3 `facet:'feature'` chip + list filter | Component test |

## 5. Implementation record

| Phase | Branch | Evidence |
|---|---|---|
| P1 | `feat/campaign-project-link` | `test/adr0852-campaign-project.test.ts` (6, real app + routes): finalize creates exactly one org-visible `facet:'campaign'` project, re-finalize reuses it, GET returns it; a failed project create never fails the finalize; a stale link is replaced and ten concurrent ensures yield one project with no orphan; private refused (409) while linked, campaign delete archives + clears the facet + lifts the lock; campaign orchestration AND channel runs are stamped with the project's ledger version, an unknown brief is not; `stripCallerAttribution` removes both campaign keys. **Sabotage-witnessed:** no visibility lock, no run resolver, and `put` in place of `putIfAbsent` (which also proved the first race test vacuous — two HTTP calls serialized — so the race moved to the service) each go red |
| P2 | `feat/campaign-ledger-section` | `<CampaignLedgerSection>` on the campaign detail renders `<ProjectLedgerTab>` for the linked project; unlinked ⇒ "Set up the team ledger" (create-or-return). `campaignLedgerSection.test.tsx` (5): linked renders the project ledger; toggle off renders and fetches nothing; set up then render; a failed setup is said; a failed read is said, never "no ledger". **Sabotage-witnessed:** ignoring the toggle goes red. **CORRECTED — no browser leg:** the exit named an `e2e/handoff-ledger.spec.ts` campaign leg, but a campaign cannot be created model-free over HTTP (finalize requires a messaging kernel, which only a model run produces); a test-only route to fake one was not added |
| P3 | `feat/channel-project-binding` (stacked on ADR 0831 B3) | `PUT /channels/:id/project` (owner + write on an org-visible project; `null` unbinds); a bound channel's turns read the project's ledger through the B3 seam with `viaChannelBinding`, inert once the project is private; `GET /team-ledger/summaries` (caller-scoped, ≤20, omitted-not-403; D4 reuses it); the manage dialog's Project picker and `<ChannelLedgerPanel>`. Backend `adr0852-channel-binding.test.ts` (4), frontend `channelProjectBinding.test.tsx` (6). **Sabotage-witnessed:** a private project bindable, a binding never inert, summaries not caller-scoped, the picker unfiltered, the panel ignoring the toggle. **CORRECTED — no browser leg:** chat renders only with a provider configured; the e2e lane can store no BYOK key (it has no KMS) and has no managed-provider key, so no model-free browser test can open a channel |
| P4 | `feat/initiative-ledger-rollup` (stacked on P3) | `<StrategyLedgerRollup>` on the Alignment tab: the saved links' and initiatives' projects, de-duplicated and capped at 20, via the P3 summaries route. `strategyLedgerRollup.test.tsx` (4): lists and links; one de-duplicated request; the cap; nothing when off or unlinked; a failed read is said. **Sabotage-witnessed:** no de-duplication / cap goes red |
| P5 | `feat/project-feature-label` (stacked on P1) | `PUT /projects/:id/facet {facet:'feature'|null}` (write; a notebook or a campaign's project keeps its facet, 409; anything else 400); Feature / Campaign chips, a "Features only" list filter, and a writer toggle on the project page. Backend `adr0852-feature-label.test.ts` (3), frontend `featureLabel.test.tsx` (4). **Sabotage-witnessed:** no route guard, and the filter ignored |
