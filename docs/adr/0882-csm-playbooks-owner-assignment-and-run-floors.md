# ADR 0882 — CSM: run-lane floors, an org-checked computed score, member owners, and playbooks

Status: implemented (2026-10-13; pre-code /architect pass folded in — see the phase table)
Date: 2026-10-13
Feature: `csm` (an extension; the toggle id and default are unchanged: `csm`, OFF, `tenant`)
Supersedes: ADR 0568 (CSM playbooks, Proposed and never started). Its decision is absorbed here as D5–D7,
reshaped where a code read showed the 0568 text did not fit.
Composes: ADR 0016 (feature), 0212 (CSM↔CRM link), 0582 + 0645 (authorization and measurement
honesty), 0832 + 0837 (the `ctx.features` org and tenant floors), 0208 + 0617 (host events and
event-bound runs), 0815 (`onMemberAuthorityLost`), 0464 (subject erasure), 0162 (deterministic ids).
Origin: feature loop round 2, row 42 (`docs/steward/FEATURE-LOOP-2026-10.md`). Workflow grade:
`docs/steward/WORKFLOWS-ASSESSMENT.md` § "round 2 grade (feature loop row 42)".

## Context

The round-1 grades were A− / B+ / A−. Re-measured on `229dd3377`, the chain layer still holds, but
the run lane next to it does not. `test/adr0882-csm-security-probes.test.ts` proves three defects
RED:

- **P1 / `CSM2WF-1`: a Viewer's run writes health.** `ctx.features.csm` was registered with no
  `orgPolicy` (`features/csm/feature.ts:42`), and none of its methods takes an `orgId`, so the
  ADR 0832 org floor never fires and no tenant floor is declared. The HTTP door for the same write
  answers 403. ADR 0837 D2 fixed this exact class for CRM.
- **P2 / `CSM2WF-2`: a run whose person is not a member reads the whole account book** (ARR,
  renewal dates, owners). This includes a scheduled or triggered run caused by someone who has
  since been removed. ADR 0645 D1 fixed the chat tool for this; the node lane beside it was not.
- **P3 / `CSM2WF-3`: a computed score can be measured in the wrong org.** The ADR 0582 §4 guard
  compares only `computedForCompanyId` with `crmRef.companyId`. `csm-ops.health-from-crm` takes
  `orgId` as an independent parameter, so a member of org A can score an account linked to org B's
  company from org A's (empty) deal list. The result is a fabricated `100`, stamped `computed`.

The competitive gap is the largest converged item on the CSM matrix (`docs/steward/UX_UPGRADE-csm.md`
R2, CSM-R2-2): 6/6 comparators ship triggered plays (ChurnZero Plays, Gainsight CTAs and Playbooks,
Totango SuccessPlays, Vitally Playbooks, Planhat Automations). Every one of them assigns a CSM
**owner from the user list**. Here, `owner` is a free-text box. ADR 0582 §13 recorded the cost:
the DSAR sweep is a no-op for the values people actually type, and nothing reacts when the person
named leaves.

## Boundaries audit

| Concern | Single owner (cited) | Decision |
|---|---|---|
| Run-lane authority | `host/featureSurfaces.ts` `gate()`: `orgFloor` + `tenantScopeFloor` (`tenantMethodScopes`, ADR 0837 D2) | Declare a CSM policy. Add no second gate. |
| Membership | `accessControlService.isWorkspaceMember`, `listWorkspaceRootMembers` | Owner validation and the assignee list read these. Channels already validates this way (`channelService.ts:84`). |
| Member removal | `onMemberAuthorityLost` (`accessControlService.ts:1136`, ADR 0815) | Subscribe; do not poll. |
| Erasure | `registerSubjectEraser` (already registered by CSM) | Extend the existing eraser. |
| Tasks | CRM `Task` (`crm/entities/tasks.ts:105`, which already has `companyId` + `assignee`) | Plays write CRM tasks through `ctx.features.crm.createTask`, inheriting CRM's floors, link validation and territory visibility. No parallel todo entity (0568 had the same rule). |
| Event-driven runs | `hostEventDispatcher` bindings (ADR 0208 §1/2) + `core.trigger.event` | Emit one host event; the operator binds it on the Event Bindings page. No CSM daemon. |
| Scheduled runs | Schedules (`core:schedules`) | The renewal play is a chain an operator schedules. No CSM cron. |
| Workflows | chain loader, `examples/workflow-chain-packs/csm-ops` | Two new chains in the SAME pack. |
| Host-event catalogue | `host/hostEventTypes.ts` (the emission gate, scanned by `adr0825-rfc0236-host-events.test.ts`) | Add the one new type. |
| Deep link into the builder | `/builder?template=<chainId>` (`WorkflowsDashboard.tsx:251`, app-builder precedent) | Reuse. |
| Chat | the ONE chat; `registerFeatureAgentTool`; the existing health-insights agent | Add one read tool to the existing agent. No new chat surface. |

Route collision: `grep -rn "/csm/" backend/typescript/src` finds only `features/csm/routes.ts`. The
new `GET /csm/assignees` is under the same prefix and toggle.

## Decision

### D1 — a closed-world surface partition with run floors (`CSM2WF-1`, `CSM2WF-2`)

`features/csm/surface.ts` exports `CSM_SURFACE_READS` and `CSM_SURFACE_WRITERS`, plus
`CSM_SURFACE_POLICY = { tenantMethodScopes: reads → 'workspace:read', writers → 'workspace:write',
methodScopes: { setHealth: 'workspace:write' } }`,
passed as `surface.orgPolicy`. A partition test asserts that every method the surface returns is
classified exactly once (the `adr0837-crm-surface-floors.test.ts` shape), so a new method cannot
ship unfloored. **Reads are floored too**, unlike CRM's. CSM data is tenant-wide, so without a read
floor the removed-member lane (P2) stays open. The floor's subject is the actor, or else the causing
member. **An event-bound run is the "cause" lane, not a personless one**: the dispatcher stamps
`orgScopeSubject = binding.createdBy` (`hostEventDispatcher.ts:356`). The person who armed the
binding must therefore still hold `workspace:read` in the tenant, and `workspace:write` in each CRM
org a play writes to. A binding armed by someone who has since been removed stops working; this is
witnessed. Only a run with no person at all (no actor and no cause) stays tenant-trusted. Event-bound
runs carry no `personalTenant`, so in an anon sandbox an event-bound play is refused. That is stated,
not fixed: anon sandboxes are demo surfaces.

### D2 — a computed score names its org, and the service checks both halves (`CSM2WF-3`)

`setHealth` takes `orgId`. That alone engages the ADR 0832 org floor, so the run's person must be
**write** member of the org it names (`methodScopes`). `setAccountHealthForTenant` requires
`computedForOrgId` on the computed path and refuses unless it **and** `computedForCompanyId` equal
`crmRef`. **The refusal records `measureFailed` before it throws typed**, the `refuseToScore` shape.
The old company-only refusal threw without the marker, so the console showed nothing; that is fixed
in the same change. The node passes `orgId`, and `csm-ops.health-from-crm` binds `{{params.orgId}}`
into `health-write`. Node pack → 1.5.0 (`health-set` 1.5.0); chain → 1.1.0; pack → 1.3.0.

**This breaks every tenant copy of `health-from-crm@1.0.1`, deliberately and visibly.** A from-chain
copy is frozen, and its `health-write` carries no `orgId`. From this change on, each run records
`measureFailed` with the reason "this workflow copy predates ADR 0882; re-create it from the gallery
(Compute Health From CRM 1.1.0)" and fails typed. The alternative was to accept an org-less computed
write, which is P3 itself. `demoOpsPlanningSeed.ts:184` calls the computed path inside
`.catch(() => undefined)`, which would have hidden the break for every seeded account; it now passes
`computedForOrgId`. The manual path (a bare score, or a recorded refusal) names no org and is
unchanged.

### D3 — the owner is a workspace member (ADR 0582 §13; DSAR; removed-member residue)

- **New field `ownerUserId?: string`** on `Account`. HTTP create and PATCH accept it (`null` clears
  it), or `ownerSelf: true` ("assign to me"). The value must be a **canonical `user:` subject** that
  is a workspace-root member (`isWorkspaceMember`); otherwise 422 `invalid_owner`. One exception is
  the caller's OWN personal workspace (`isOwnPersonalWorkspace`), whose owner row is created lazily
  and anon sandboxes have none. There the caller may assign themselves (their canonical id), which
  is the service-desk `selfMemberSubject` precedent (ADR 0878 D5). Legacy `oidc:` member rows are
  not assignable: a later login rekeys them (`rekeyMemberSubject`, which has no hook), and an owner
  stored under the old spelling would match nothing afterwards. Refusing is the safe direction.
  The field is declared PII (entity-scoped, like `owner`).
- **`GET /csm/assignees`** (`workspace:read`, behind the same toggle and entitlement) returns
  `{ assignees: [{ subject, displayName }], me: callerSubjectSpellings(req) }`, the service-desk
  shape (`service-desk/routes.ts:153-161`). Rows with no subject or a non-`user:` subject are
  skipped, and legacy twins are de-duplicated by subject. In the caller's own personal workspace
  the caller is listed even without a member row. "Mine" is `me` contains `ownerUserId`. That works
  for a caller with two spellings, which a single `isYou` boolean computed against one id would
  not.
- **Read projections strip `ownerUserId`.** Surface read outputs are recorded in the durable event
  log (`surface.ts` header), so a subject id must not ride `health-read`, `at-risk-check` or
  `renewals-due`. The HTTP list returns it; the run lane does not.
- **Removal:** an `onMemberAuthorityLost` hook (`reason: 'removed'`, root org) unassigns every
  account whose `ownerUserId === subject` in that tenant, by CAS. A demotion keeps the owner: a
  Viewer may still own an account.
- **DSAR:** `eraseCsmSubject` also clears `ownerUserId` when `subjectKeyForms(subjectKey).forms`
  contains it (the service-desk precedent, `service-desk/tickets.ts:411`).
- **The legacy free-text `owner`** stays readable and clearable. The SPA stops writing it, so new
  rows carry `ownerUserId` only. The API still accepts it, so no client breaks. The ADR 0582 §13
  pin (`csm-privacy-and-concurrency.test.ts`, `it.fails`) STAYS: legacy rows keep the gap until
  someone clears them. That is narrower than before, but it is not closed, and this ADR does not
  claim it is.
- **Identity spelling.** The stored value is the member row's canonical `user:` subject, exactly
  as the assignee list returns it. Validation and removal match it exactly; erasure matches the
  `subjectKeyForms` set. There is no `user:`⇄principal aliasing (memory
  `principals-not-issuer-qualified`; the ADR 0780 D2 revert).

### D4 — CRM task writer carries `companyId` and a member `assignee` (`CSMWF-7`)

`ctx.features.crm.createTask` accepts `companyId` (passed to `assertLinkVisible` and
`assertLinks`, so it must exist in the org and be visible to the run's person) and `assignee`
(refused unless `isWorkspaceMember(assignee, tenantId)`). **The member check sits in the surface
only.** The CRM org route (`orgRoutes.ts:592`) and `demoCrmSeed.ts:268` write free-text assignees
today. They are untouched, and that class is recorded as residue, not claimed closed.
A play task must be attributable to the account it is about.

> **Correction (implementation, 2026-10-13).** This paragraph also said `feature.crm.nodes.create-task`
> would forward `companyId` (pack → 1.12.0). Not done: every schema `$id` in that pack is
> version-stamped, so the bump is a pack-wide re-stamp for one optional input, and no chain in this
> change uses the CRM node — the plays write through the SURFACE, which now takes `companyId`. The
> node-level input is filed as `CSM2WF-5`. `CSMWF-7` is closed at the surface, which is the writer
> the attribution needed.

**Plays must not move the score they react to** (pre-code review HIGH-1). `computeHealthFromCrm`
subtracts 3 points per open task with a matching `companyId`, so a 3-step renewal ladder would pull
an account from 75 to 66. That crosses 70, emits `health-changed` and starts the rescue play, whose
tasks pull the score down further. Play tasks (`taskId` prefix `task:play:`) are therefore
**excluded from `openTasks`**, and they are counted in an unweighted `playTasksOpen` factor (weight
0), so the reader still sees them. Witnessed: running renewal-runway and then health-from-crm leaves
the score unchanged.

**Assignee residue.** Plays write member subjects into `Task.assignee`, which no CRM eraser
covered (`crm/erasure.ts`). D4 adds `task.assignee` redaction to the CRM subject eraser
(`subjectKeyForms`) and an `onMemberAuthorityLost` hook that unassigns OPEN tasks when the person
leaves the workspace root. Done tasks keep their history.

### D5 — `host.csm.account.health-changed` (absorbs 0568 §4; `WF-CSM-8`)

The event is emitted at the two health writers (`updateAccount`, `setAccountHealthForTenant`),
and at `createAccount` when it is created with a score. It fires after the CAS lands, and only
when the stored `healthScore` changed: number → number, unscored → scored, or scored → unscored,
never a re-save of the same score. `previousScore` comes from the row the **winning** CAS replaced:
`mutate` returns `{ before, after }` and the emit happens once after it returns, never inside
`apply`, so a retried CAS cannot double-emit or report a stale pre-read. The payload is ids only:
`{ accountId, previousScore, healthScore, changedAt }`. `changedAt` is the landed row's
`updatedAt` and serves as the transition key. Scores are not PII. `origin` is stamped when
the write came from a run (ADR 0617 D1a), so a chain cannot re-trigger itself. The type is listed
in `hostEventTypes.ts` (v2: `openwop-app.csm-account-health-changed`).

### D6 — playbook nodes (absorbs 0568 §1, reshaped)

`feature.csm.nodes` 1.5.0 adds:

- `at-risk-check` (`role:"action"`, a read). Inputs: `event` (the trigger output, whose
  `payload` carries `accountId`, `previousScore`, `healthScore`, `changedAt`) or a bare `accountId`,
  plus `threshold` (default 70). It outputs `{ accountId, qualifies, reason, transitionKey }`.
  **The crossing is judged on the EVENT**: `event.previousScore` is absent or ≥ T, and
  `event.healthScore` < T. The account is also read NOW (read before write), and it must still be
  below T. That is a guard only: it can turn a crossing off, never on. A late run of an earlier,
  non-crossing event (75→72, read live at 50) therefore does not qualify, and two events cannot
  both qualify for one fall. An unscored account never qualifies (unscored ≠ low, ADR 0582 §4).
  `transitionKey` = `changedAt`.
- `renewals-due` (`role:"action"`, a read). Inputs: `days` (default 90). Through a new surface
  read `listRenewalsDue({ days })`, it outputs `{ accounts, count, any, asOf }` for accounts whose
  `renewalDate` is on or before `asOf + days`. Overdue renewals are included and flagged
  `overdue: true`.
- `create-play-tasks` (`role:"side-effect"`, `["side-effectful"]`). Inputs: `accountId` or
  `accountIds`, `playId`, `steps: [{ title, dueInDays? | daysBeforeRenewal? }]`, `cycle: 'transition'
  | 'renewal' | 'run'`, and an optional `transitionKey`. Through a new surface read
  `playTargets({ accountIds })` (consumed inside the node and never output), it resolves each
  account's `{ name, orgId, companyId, renewalDate, ownerUserId }`. For each one with a `crmRef` it
  calls `ctx.features.crm.createTask({ orgId, companyId, title: "<step> — <account>", dueDate,
  assignee, taskId })`. Assignment is skipped when the owner is no longer a member.
  - The `taskId` is deterministic:
    `task:play:<playId>:<hash(accountId, orgId, companyId)>:<cycleKey>:<i>`. `cycleKey` is the
    `transitionKey` (rescue), the account's `renewalDate` (runway), or the `runId`. Hashing the link
    means a relink to another org or company starts a fresh ladder instead of 404ing on (or
    returning) the old company's row.
  - An existing row with that id counts as **ensured**, so a weekly runway re-run is a success that
    creates nothing new. A play task someone DELETED is re-created by the next run. That is stated,
    and the alternative (a tombstone) is deferred.
  - Accounts with no CRM link go into `skipped[]` with a reason. **Floor refusals (`forbidden_scope`)
    propagate and fail the node**; they are never folded into "skipped". If nothing was ensured, the
    node fails typed (`no_play_targets`), never success-with-empty.
  - Output: `{ tasks: [{ taskId, accountId }], skipped }`. No assignee or names are echoed.

Plays act as the run's person (or cause, D1) through CRM's floors. Nothing is sent outside the
workspace: there is no email leg. 0568's HITL floor for outreach therefore has nothing to bite on
yet; an outreach leg is deferred (OQ-2).

### D7 — two plays, as chains in `csm-ops` (absorbs 0568 §2; `WF-CSM-5`)

- `csm-ops.red-account-rescue`: `core.trigger.event` → `at-risk-check` (`trigger → check.event`)
  → `{truthy qualifies}` → `plays` (`check.accountId → plays.accountId`,
  `check.transitionKey → plays.transitionKey`, both conditioned); `{falsy qualifies}` →
  `core.flow.noop`. The params (`threshold` default 70, and `triggerEventName` defaulting to the
  three-segment `openwop-app.csm.account-health-changed`, the crm-ops precedent) are live. Bind the
  event on the Event Bindings page.
- `csm-ops.renewal-runway`: `renewals-due` → `{truthy any}` `due.accountIds → plays.accountIds`
  (`cycle:'renewal'`, a 90/60/30-day ladder via `daysBeforeRenewal`); `{falsy any}` →
  `core.flow.noop`. Run it on demand or on a schedule. This is the first chain to read
  `Account.renewalDate`.

Both are gallery-reachable and instantiate builder-editable through `…/workflows/from-chain`. The
effect-reject ratchet only looks behind approval gates, so adding the node to `EFFECT_TYPEIDS`
proves nothing here. Instead, a chain test asserts that **every edge into `plays` carries a
condition**, and two runs prove a falsy branch creates zero tasks.

### D8 — chat and SPA

- **Chat:** a read tool `openwop:feature.csm.nodes.renewals-due` on the existing health-insights
  agent (agents pack → 1.3.0). It shares the route predicate (`checkTenantEntitlement` +
  `assertTenantScope(workspace:read)`) and fails empty without an acting user, exactly like
  `health-read`. The prompt names it, pinned by the existing parity test.
- **SPA (`/csm`):** an owner **select** fed by `/assignees` replaces the free-text input on create
  and edit. Legacy text is shown read-only with a clear button, and `owner` is sent ONLY on that
  explicit clear, so an unrelated edit never wipes it. Search matches the owner's display name. There is an "Owner" column (the
  display name, or the legacy text marked as such), a **"Mine"** filter (`isYou`), and a
  **Playbooks** card listing the two plays, each with "Set up in builder"
  (`/builder?template=<chainId>`, the app-builder precedent) and one line on how it triggers. All
  copy is in 4 locales.

## Pre-code `/architect` corrections (2026-10-13)

An independent adversarial pass on the first draft found 3 HIGH, 9 MEDIUM and 6 LOW issues. All are
folded into the decisions above. The ones that changed the design:

- **HIGH-1:** plays would have fed back into the score and triggered further plays. Play tasks are
  now excluded from `openTasks` (D4).
- **HIGH-2:** D2 would have silently broken every frozen tenant copy and every seeded account. The
  refusal now records why, and the seed passes the org (D2).
- **HIGH-3:** personal and anon workspaces would have had nobody assignable. The caller may now
  assign themselves (D3).
- **MEDIUM:**
  - Owners are canonical `user:` subjects only.
  - DSAR matches by `subjectKeyForms`.
  - "Mine" uses `callerSubjectSpellings`.
  - The "event-bound runs have no person" claim was false: they run under the binding creator.
  - The crossing is now judged on the event, not on live state.
  - `previousScore` comes from the winning CAS.
  - CRM task-assignee residue is now covered.
  - Owner ids are kept out of the run log.
  - The task id hashes the link, existing rows count as ensured, and floor refusals propagate.
- **LOW:**
  - The `EFFECT_TYPEIDS` addition could never fail, so it was replaced by real tests.
  - The trigger-name default must be three-segment.
  - The version bumps and ratchets are now listed.
  - `setHealth` asks for write in its org.
  - An unrelated SPA edit can no longer wipe the legacy owner.
  - The fork posture is stated.

## Alternatives weighed

- **Floor the reads at the org level like CRM.** CSM accounts carry no org; the account book is
  tenant-wide by ADR 0582 §2. Only a tenant floor fits.
- **Score-time org check only in the node.** That would be one more place the rule lives. The
  service is the choke both the HTTP and run lanes pass through.
- **A CSM-owned task list.** It would fork the CRM `Task` owner. Rejected, as 0568 rejected it.
- **A CSM sweep daemon for renewals.** Feature-code cron forks the scheduler. ADR 0212 already
  refused a sweep, and the chain-plus-schedule shape is editable.
- **Normalising the legacy `owner` text by matching names to members.** A substring match would
  erase or assign the wrong people (ADR 0582 §11). Legacy text is left for a human to clear.
- **A per-account "what ran here" projection (0568 Phase 3).** It needs account-scoped run
  metadata, which is 0568 OQ-1's RFC 0013 variable-bag question. The tasks a play creates carry
  `companyId` and are visible in CRM, which is today's honest "what ran here". Deferred (OQ-1).

## Matrix

1. Package: `features/csm` only, plus the two CRM surface args (D4). No core route or nav edits.
2. Toggle: `csm`, unchanged. The new route rides `requireEnabled`.
3. `ctx.features.csm`: +`listRenewalsDue`; all methods partitioned and floored (D1).
4. Node pack: `feature.csm.nodes` 1.5.0 (D2, D6). The CRM node pack is unchanged (D4 correction).
5. Envelopes: none. The structured intent is the node graph.
6. Agent pack: `vendor.openwop-app.csm.agents` 1.3.0 (+1 read tool).
7. Public surface: none.
8. RBAC: D1 (run), `requireEnabled` (HTTP), D3 member validation, D4 assignee validation.
9. Replay: `create-play-tasks` is a floor-classified side effect (served on replay) with
   deterministic ids. Reads re-execute, as every live read does; `renewals-due` is date-dependent
   and returns `asOf` so a reader can see which day it measured. `at-risk-check` decides the
   branch and re-executes on `:fork`. A fork whose re-read now takes the truthy branch where the
   source did not reaches an effect with no recorded output and fails closed
   (`replay_source_missing`). That is intended: a fork never invents a side effect.
10. Frontend: D8.

## RFC verdict

Host work only. Host events are host-extension-namespaced (RFC 0086 §E). The v2 advertisement is
derived from `hostEventTypes.ts` behind `OPENWOP_HOST_EVENTS_V2`, and RFC 0236 permits any listed
type. No chain-format facet is added: the conditions are the existing truthy/falsy wire form, and
the ports are the existing port-qualified edges.

## Ratchets and versions this change must move (named up front, review LOW-15)

`csm/feature.ts` `requiredPacks` (nodes 1.5.0, agents 1.3.0); `crm/feature.ts` (unchanged — see the D4 correction);
the `csm-ops` pack version (1.3.0); `FEATURES.md` pack versions; `sideEffectFloor.generated.ts`
(`gen-side-effect-floor`); the `pack-surface-arg-parity` fixture (`listRenewalsDue`, `playTargets`,
CRM `createTask` keys); the `adr0825-rfc0236-host-events` emit-site scan; the prompt/tool parity
tests. No new feature-dependency edge (csm→crm exists).

## Phased plan

| Phase | Scope | Status | Witness |
|---|---|---|---|
| P1 | D1 + D2 (security) | done | `adr0882-csm-security-probes.test.ts` P1–P3 (RED on `229dd3377`), partition, cause lane, frozen copy — sabotage-checked (policy removed → P1/P2/cause red; org half removed → P3 red) |
| P2 | D3 owner + `/assignees` + removal + erasure | done | same file, D3 block (removal hook removed → red) |
| P3 | D4 CRM task args + D5 event | done | D4 block (assignee check removed → red); event via the rescue e2e |
| P4 | D6 nodes + D7 chains | done | `adr0882-csm-playbooks-execution.test.ts` (play-task exclusion removed → HIGH-1 red; crossing guard removed → rescue red), `adr0882-csm-play-node.test.ts` |
| P5 | D8 chat tool + SPA | done | `crm-csm-agent-tools.test.ts` parity, `csmRound2.test.tsx` |

**Post-implementation grades (row 42):** `/grade-code` found 1 Blocker + 1 High in this
implementation (`CSM2CD-1` the play refused any book over 50 renewals; `CSM2CD-2` one failing
account starved the rest) plus 6 more. `/grade-ux` found 1 Blocker (`CSM2UX-1`, focus landed on
the add form on every load) and 4 Highs. All of them are closed in the same branch except the
ones filed in `CODEBASE-ASSESSMENT.md` / `UX-ASSESSMENT.md` (`CSM2CD-7/-9/-10` residue,
`CSM2UX-9/-15`). Filed here: `CSM2WF-5` (forward `companyId` on the CRM `create-task` node).

## Open questions

- **OQ-1** "What ran here" per account (0568 Phase 3) needs run→account attribution. Deferred;
  play tasks are attributed through `companyId` instead.
- **OQ-2** An outreach (email) leg on a play must ride the approval/egress posture (ADR 0469/0470).
  Not built; no play sends anything.
- **OQ-3** Should a Viewer be assignable as owner? Yes, assumed: ownership is attribution, not
  write authority.
- **OQ-4** Legacy free-text owners: a one-off "map to a member" UI for admins. Not built; the pin
  stays.
