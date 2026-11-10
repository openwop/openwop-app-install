# ADR 0926 — Campaign ops: operator inbox and preview-only onboarding

Status: Accepted — P0 implemented; P2 existing-organization client entry implemented; P1 and the remaining guided P2 flow pending

Program: agency campaign operations (ADRs 0921–0928). PRD features **F12**
(campaign operations inbox) and **F17** (guided onboarding with preview-only
mode). Depends on ADRs 0921–0925.

## Context

The operator's first screen shows, across all their clients, the changes waiting
for review, the work in progress and the unresolved results. Operators must not
need to learn Canvases, protocol nodes or model-routing terms. A new agency must
reach a first proposed change with one client, one campaign and a small asset
list, in a preview-only mode (proposals and diffs, no writes) before connecting a
destination.

## Boundaries audit (state on `origin/main` at `38bdc1699`)

- **No campaign operator inbox exists.** The `/campaign-studio` hub
  (`frontend/react/src/features/campaigns/routes.tsx:26`,
  `CampaignStudioHubPage.tsx`) projects campaign features as tabs from the
  features manifest; the per-campaign page shows launch state and the ads
  dispatch ledger (`frontend/react/src/features/campaign-orchestration/
  CampaignStudioPage.tsx:316-345`). `CampaignLedgerSection.tsx` is the team
  intent ledger (ADR 0852), not a work queue. Approvals go to the generic
  Approvals inbox.
- **Org selection:** `frontend/react/src/ui/useOrgSelection.ts` +
  `ui/OrgSelectionState.tsx` (used by 43 files). The only "all orgs" view is in
  `CampaignStudioPage.tsx:231`.
- **Dry-run precedents exist per node** (ads dispatch builds payloads with zero
  calls, `host/adsAdapter.ts:143-214`; ad-budget nodes default to dry run,
  `bootstrap/nodes.ts:3208-3235`; contract `executor/types.ts:732-774`), but there
  is **no run-wide preview-only mode**.
- **Onboarding:** walkthroughs are workflows of `ui.walkthrough.step` /
  `.checkpoint` nodes (`features/walkthroughs/walkthroughNodes.ts:1-40`;
  ADRs 0368/0374/0376/0435/0489); the only onboarding code is
  `frontend/react/src/onboarding/firstRunFlag.ts`.
- **Home dashboard** is ADR 0375 (tiles registered in `allTiles.ts`).

## Decision

### D1 — The inbox is a tab of the Campaign Studio hub

A new `campaign-ops` frontend feature registers an **"Operations"** tab at the
front of the `/campaign-studio` hub (the hub's manifest projection, no new
top-level nav group), routed at `/campaign-studio/operations`. With the
`campaign-ops` toggle on, it is the hub's default tab.

Three columns, each a list of cards, across every client the caller can see
(ADR 0921 D5), filterable to one client with the shared org selector:

1. **Waiting for review** — change sets `in_review`, with who must approve.
2. **In progress** — requests needing facts (question cards answerable inline),
   change sets `proposed`, jobs `running`.
3. **Needs attention** — every open resolution item (ADR 0925 D5), with its one
   recommended action as the card's primary button.

Plus a composer at the top: client → (campaign) → "Describe the change". Cards
use plain words only: "page", "email draft", "approved", "confirmed",
"someone edited this after it was prepared". No canvas, node, chain, model or
provider vocabulary appears; a test pins the inbox copy against a denylist of
those terms in all four locales.

A home-dashboard tile ("Campaign operations: N waiting, M need attention") is
registered in `allTiles.ts` behind the same toggle.

### D2 — Backend read model

`GET /v1/host/openwop-app/campaign-ops/inbox?orgId=` fans out per visible client
through the same org-gated reads (no tenant-wide query), returns cards with ids,
labels, states and counts only, and is bounded (latest 50 per column per client,
with a `truncated` flag). Polling at 15 s on the page; no new SSE channel in v1.

### D3 — Preview-only mode (F17)

`ClientAccount.mode` (ADR 0921 D1) is `preview` for every new client. In
preview:

- requests, questions, change sets, diffs and approvals all work;
- execution is refused `preview_only` at job start (ADR 0924 D6) and at every
  step (ADR 0925 D2), so no destination is written even if a job somehow starts;
- the inbox shows a persistent "Preview: nothing is written" banner per client.

Switching a client to `live` needs `host:members:manage` on the client org and
is audited. It is a client-level switch, not a run flag, so it cannot be set by
a workflow or a model.

### D4 — Guided first change

**Partial P2 correction (OPS-ENTRY-1, 2026-11-06):** the Operations inbox adds
an agency-admin entry to register an existing, non-root organization through the
existing POST client API. This is new UI reachability, not a repair to a shipped
onboarding form or completion of the full guided flow below. It deliberately
requires an existing organization rather than creating another organization.
The server retains preview/agency-approval defaults and exact root-admin
permission checks; no role, invitation, live-mode or portal action is added.
**Correction — org-selection seam (2026-11-07):** the initial registration
picker duplicated its organization read and retry state, violating the existing
org-selection dependency-edge ratchet. It now delegates that state to
`ui/useOrgSelection` with access-control's existing lister. Its returned full
rows are filtered against current clients/root organizations at render time;
the shared hook's automatic first selection is intentionally not used, so the
operator must still choose explicitly. The existing identity guard gates displayed
rows/failure and final submission. Failed reads retain the hook's unknown/null
state and retry uses the hook; no ratchet threshold, exception or assertion is
weakened. This repairs an engineering gate violation, not a newly claimed runtime
product defect. Focused and canonical composition qualification remain required.

The picker reuses access-control's organization list and the inbox's existing
identity generation (PR5623), validates returned org and tenant before selection,
and treats uncertain writes or post-create refresh failures as GET recovery,
not an invitation to send another POST. The inbox owns pending/uncertain
operations outside the dismissible chooser, keeps normal inbox controls usable,
and disables another registration until the write or authoritative GET resolves.
A later client selection is preserved when a background201 completes, including
A → B → A: a local selection-interaction epoch preserves intent rather than
comparing only the current organization. This does not replace the existing
workspace identity generation. Explicit GET recovery can select its confirmed
client.
Focused diagnostics: original inbox 23 failures / 3 controls passing with the
26-case registration harness; a separate selection sabotage probe fails when
background201 overrides a later client selection. A → B → A reproduction also fails against the prior implementation. Restored
implementation 59/59
across registration, existing inbox and copy tests. Scoped ESLint and seven UI statics passed. Canonical composition and live acceptance
remain release-owner work.

A three-step guided flow on the empty state of the Operations tab (not a
walkthrough that auto-launches; ADR 0488 rule: nothing auto-launches):

1. **Add a client** (name → creates the org + `ClientAccount` in preview).
2. **Add assets** (pick one CMS page and one email template of that client, or
   "use sample assets", which runs the demo seeder's single-client half,
   ADR 0927).
3. **Describe a change** → the first change set and its diff.

The flow reaches a first proposed change with no destination connected and no
migration of other accounts. A walkthrough recording of the same flow can be
added to the walkthroughs surface later (P2), reusing ADR 0368.

## As built — P0 (2026-10-19)

1. The Operations tab (`frontend/react/src/features/campaign-ops/`) is the first
   tab of the Campaign Studio hub and reads the per-client endpoints directly;
   the aggregated `GET …/inbox` read model (D2) is P1, with cross-client view.
2. Approve and Reject re-derive the approval id from "Send for review" (the
   backend returns the same id for a change set already in review), so a reload
   never loses the decide target. The hash is sent only in the approve body.
3. A copy test pins the denylist (no node, chain, workflow, run, model, provider,
   hash … in any of the four locales).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Frontend `frontend/react/src/features/campaign-ops/` (`campaignOpsClient.ts`, `OperationsTab.tsx`, cards, guided flow); backend inbox route in `features/campaign-ops/routes.ts`. |
| 2 | Toggle | `campaign-ops`. |
| 3 | Workflow surface | None added (read model for people). |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None. The composer submits to the change planner through the request service; it is not a chat (CLAUDE.md "one AI chat": a structured form, not a talk-to-AI panel). A "Discuss in chat" link deep-links the main chat scoped to the change-planner agent (`/?agent=…`). |
| 7 | Public surface | None. |
| 8 | RBAC | Inbox shows only clients with a row for the caller (ADR 0921 D2/D5). |
| 9 | Replay / fork | n/a. |
| 10 | Frontend | `ui/` primitives and tokens only; a11y for card lists and the inline question form; `/ux-review` before shipping. |

## RFC verdict

**Host extension, no RFC.**

## Phased plan

| Phase | Scope | Demo slice? |
|---|---|---|
| **P0** | Operations tab with the three columns for one client; composer; question cards; change-set card with diff and approve; job card with per-destination state; preview banner + `mode` switch | **Yes** |
| P1 | Cross-client aggregation and client filter; resolution actions on cards; dashboard tile | No |
| P2 | Guided three-step first change; "use sample assets"; optional walkthrough recording | No (the demo uses the seeder) |

## Alternatives weighed

- **A new top-level "Operations" nav group.** Rejected: the PRD puts this in the
  Campaign Studio family, whose hub already projects tabs.
- **A chat-first intake.** Rejected for the primary flow: the request needs
  structured client/campaign/asset context and inline questions; the main chat
  remains reachable through a deep link, so no second chat is built.

## PRD-vs-architecture corrections

1. F12's "first screen" is the Campaign Studio hub's default tab when the toggle
   is on, not a new app home; the home dashboard gets a tile.
2. F17's "preview-only mode" is a client-level setting enforced at job start and
   per step, not a per-run dry-run flag (which a workflow could flip).

## Open questions

- [ ] **Q1** Should `preview → live` also require that each asset has been
      refreshed once (proving the adapter can read it)? Proposed: yes.
- [ ] **Q2** Polling vs the notification stream for inbox freshness. Proposed:
      polling in v1.
- [ ] No `/architect` or `/ux-review` pass has been run on this ADR.

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | campaign-ops change-set PR (follows #5015) | `frontend operationsPage + copyDenylist tests` |


## Correction — recover the inbox after workspace hydration (2026-11-05)

The initial client-list request can run before restored authentication/workspace
hydration finishes. A404 not-enabled result was latched on the mounted inbox:
the page did not observe identity changes, did not clear disabled on a new read,
and only remounting recovered. Live QA observed a full reload show disabled and
SPA away/back show the correctly enabled workspace's empty inbox. This is a UI
read lifecycle correction, not evidence that the stored toggle failed.

Use the existing auth/workspace change signal to synchronously invalidate pending
reads and clear prior clients, agency-admin state, selected org, data and status.
Reload the current authorized client list; success/refusal and org data may only
apply to the identity generation that started them. Keep org-specific guards as
well, and do not let a previous workspace poll fire after the selected org clears.
A new client-list read resets the disabled branch. No toggle writes, role changes,
backend routes, credentials, entitlements or RFC contract changes.

Original-source regression and restored focused diagnostics, independent review,
root-owned canonical composition gate and deployed acceptance remain required.

The disabled card also offers the existing read-retry action, because an auth
signal can precede completion of the backend handshake. It changes no settings.
Child action/status callbacks capture the generation and org that created them,
so a late old action cannot announce into a new workspace. Component cleanup
invalidates pending reads as well.

Focused diagnostic record: the exact new7case harness on original product source
fails7cases (15existingcases filtered); restored product source passes all22cases
in the actual OperationsPage file. These are controlled client-transport UI
checks, not live backend or deployed acceptance. Root owns canonical composition
verification and deployed retest; no database/auth configuration changes belong
to this UI correction.
