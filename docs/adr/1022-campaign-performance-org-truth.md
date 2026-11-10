# ADR 1022 — Campaign performance: each org sees its own numbers, every write is declared, every cap holds

Status: implemented (2026-11-01, row 71; see the implementation record)

Date: 2026-10-31 · Features: `campaign-connectors`, `campaign-intel` (extensions; both toggle ids
unchanged) · Feature loop round 2, row 71 · Extends ADR 0159 (connectors + performance), ADR 0160
(intelligence), ADR 0220 (pacing), ADR 0907 (ads metrics sync + Conversions API), ADR 0952
(paid-media spend control), ADR 0956 (attribution) · Rides ADR 0832 (the org-scope surface floor)
and ADR 0816 (notification audience) · RFC gate: none (host work)


> **Correction (2026-11-07, PERF-4 — reporting availability is not numeric zero).**
> Raw revenue remains number|null, and the existing numeric KPI revenue/ROAS
> sentinels and reporting-only denominator are unchanged. The summary now emits
> optional `reportedRevenueRecordCount` on totals and each platform, always an
> integer including 0 from the new server, counting actual nonnull revenue rows.
> Measured zero and zero-spend reported rows each count; the count does not establish
> a mathematically defined ratio when its denominator is 0. Campaign Performance
> renders localized Not reported only when the count is exactly 0. An absent field
> from an older server keeps legacy numeric rendering; it cannot establish
> reporting availability. Partial reporting retains the existing disclosure.
> This additive host DTO/UI repair changes no imports, stored records, providers,
> ratio math, optimizer, currencies or public OpenWOP schema (no new RFC).
> Other consumers are not all repaired: campaign-ops report section projection
> still drops the optional counts, so generated-report honesty is not qualified.
> New actual-service and page-fixture regressions are authored **NOT RUN** at
> the source checkpoint; no fixed, gate, deployed or live acceptance is claimed.

## Context

Row 71's workflows grade (`docs/steward/workflows-assessment/2026-10-31-campaign-performance-row71.md`,
`CP71WF-*`, baseline **C** on `origin/main` @ `5c7cf6733`) found the chains-or-stacks doctrine
met and eight Blockers in what the chains and doors do. They fall into four classes.

1. **One org sees another org's numbers** (`CP71WF-1`, `-2`, `-6`, `-7`):
   - `planSync` takes ad-account ids from the WHOLE tenant's dispatch ledger
     (`campaign-connectors/syncService.ts:261`; ledger from `host/adsAdapter.ts:2056`), so org A's
     sync reads org B's accounts through org A's connection and saves the rows under org A.
   - `buildAttribution` returns every org's email engagement (`campaign-intel/attribution.ts:189`).
   - An empty `orgId` on either run surface lists every org's performance rows
     (`performanceService.ts:34`; the floor skips `''` by design, ADR 0832 residue S-A).
   - Pacing and spend-cap alerts are tenant broadcasts (`pacing.ts:134`, `spendCaps.ts:418`), so
     a client org's campaign name, spend and budget reach every member of a shared workspace.
2. **A viewer writes through a workflow** (`CP71WF-5`). Neither surface declares `orgPolicy`, so
   the ADR 0832 floor asks `workspace:read` of `importCsv`, `recordAccountRows`, `claimSync`,
   `recordSyncedMetrics`, `pushCatalog` … The HTTP doors for the same acts ask `workspace:write`.
   `buildAudienceUpload` takes no orgId, so no floor fires for the tenant-wide contact list.
3. **A spend cap does not hold on one door** (`CP71WF-3`). `adsAdapter.updateBudget`
   (`host/adsAdapter.ts:2199`) never asks the cap checker. Launches (`:2289`) and reallocation's
   `applyOp` do. `/recommendations/apply` can raise a capped or breached campaign's budget.
4. **Replay and status lie** (`CP71WF-4`, `-8`). `sync`, `audience-sync`, `import-csv` and
   `pacing-check` write but are declared `role:"action"` with no `side-effectful` capability, and
   none is in `executor/sideEffectFloor.generated.ts`. A replay fork of `daily-metrics` claims the
   live cooldown and then fails on the egress backstop. A sync where every account failed returns
   `status:'success'`.

Token handling was graded A−: every platform call rides `brokeredPost`/`brokeredFetch`, which
resolves the credential from the Connections broker. Nothing in this ADR changes that.

## Boundaries audit

- **Org scope:** the ONE floor is `host/featureSurfaces.ts` `orgFloor` (`methodScopes`) and
  `tenantScopeFloor` (`tenantMethodScopes`, ADR 0837 D2). Routes use `assertOrgScope` /
  `requireTenantScope` (`featureRoute.ts`). Nothing new is invented; both surfaces declare policy.
- **Org audience for a notice:** no shared helper exists. The precedent is
  `features/service-desk/sla.ts:85` (org members who hold `workspace:write`, each addressed by
  `recipientUserId`) and `features/crm/senderHealth.ts:118`. ADR 0816's
  `materialiseRecipients` answers only tenant/role audiences.
- **Cap check:** `capBlocksIncrease` (`campaign-intel/spendCaps.ts:572`) is the one predicate;
  core (`host/adsAdapter.ts`) cannot import a feature, so it is injected the way
  `setAdsCapChecker` already is.
- **Org of a dispatch:** `listCampaignDispatchRecords` (`host/adsAdapter.ts:345`) is the rule: a
  row's own `orgId` wins; a pre-0941 row with none belongs to the org whose campaign owns its brief
  (`getCampaignByBrief`, campaign-orchestration; read-only import, no edit there).
- **Side-effect floor:** `executor/sideEffectFloor.generated.ts` is generated from the pack
  manifests (`scripts/` generator, pinned by its own test).

## Decision

**D1 — Sync reads only the org's own accounts (`CP71WF-1`).** The ownership rule already exists
in `spendCaps.resolveTargets` (client scope, `spendCaps.ts:249-251`): a row with a `campaignId`
belongs to its own `orgId`; a row without one belongs to org O when its `briefId` is one of O's
campaigns' briefs and its `orgId` is absent or O. It is lifted into ONE exported predicate in
`host/adsAdapter.ts`, `dispatchBelongsToOrg(row, orgId, orgBriefIds)` (the caller supplies the
brief ids, because core cannot import the campaigns feature), and `resolveTargets`, `planSync`
and the pause path call it. Because the filter sits inside `planSync`, the route
(`runMetricsSync`) and backfill callers are covered too.

`recordAccountRows` no longer trusts the node's plan (B1). The node sends `{orgId, platform,
scope?, since, until, batches:[{adAccountId, rows}]}`; the server re-runs `planSync` and drops any
batch whose `adAccountId` is not in the server plan's accounts, for BOTH scopes. Node and surface
change together (pack bump, D6).

Not in this ADR: the sync still reads through `ctx.ads`, which the executor builds with
`orgId: run.tenantId` (`executor/executor.ts:1036`), i.e. the run owner's connections, not a
client org's. Filed as `CP71WF-46`.

**D2 — Attribution's email block is the org's (`CP71WF-2`).** Engagement rows are kept only when
their `campaignId` is one of `listEmailCampaigns(tenantId, orgId)`'s ids, before either loop.

**D3 — Org data needs an org (`CP71WF-6`).** `listRecords` and `kpiSummary` take a REQUIRED
`orgId` and refuse `''` (`validation_error`) in the service, so routes, agent tools and both
surfaces inherit it; the intel surface stops coercing with `String(args.orgId ?? '')`. Both
surfaces are removed from `ABSENT_ORG_IS_TENANT_WIDE_PINNED` (`test/adr0830-kb-ratchets.test.ts:43`),
which retires residue S-A for them. Behaviour change, stated: a seeded `pacing-check` or
`daily-metrics` chain launched with `orgId:''` used to read (and alert across) every org; it now
fails with a typed error naming the missing org. That is the honest answer.

**D4 — Writes ask write (`CP71WF-5`).** `campaign-connectors` declares
`orgPolicy.methodScopes` = `workspace:write` for `importCsv`, `claimSync`, `planSync`,
`recordAccountRows`, `deliverConversions`, `pushCatalog`; and `tenantMethodScopes`
`buildAudienceUpload: 'workspace:write'` (contacts are tenant-wide, the CRM door's own bar; the
HTTP `/audience-sync` moves to `requireTenantScope` too, `CP71WF-12`). `campaign-intel` declares
`workspace:write` for `pacingCheck`, `proposeReallocation`, `applyReallocation`, `enforceCaps`
(each method name is checked against the surface at implementation; a listed name that is not a
method is a test failure). `recordSyncedMetrics` and `checkSyncCooldown` have no caller and are
deleted (`CP71WF-32`). A run with no person at all (no actor, no causing member) still skips
the floor and stays tenant-trusted, as every surface does today (ADR 0832); a schedule fires as
its creator, so scheduled chains are on the actor lane and do meet it.

**D5 — Every budget change meets the caps (`CP71WF-3`).** `host/adsAdapter.ts` gains an injected
`setAdsCapIncreaseChecker(fn)`; `campaign-intel` installs one built on `capBlocksIncrease`. In
`updateBudget`, before the spend gate (so no approval is opened and then refused), dry-run or not:

- The target's org is resolved from the dispatch ledger with D1's predicate, never from
  `deps.orgId` (the chain lane sets that to the tenant id, M1). An unledgered campaign carries no
  org, and account coverage still applies.
- No checker, or the checker answers `null` ⇒ proceed.
- A block ⇒ read the live budget (`getCampaignBudget`). A new budget below the live one proceeds;
  anything else, or an unreadable live budget (`unsupported` on an unverified reader, a transient
  failure), is refused with the SAME vocabulary `applyOp` uses: `${reason}:${capId}`, and
  `budget_unreadable` for the read. Decreases are therefore allowed only when the live budget is
  readable; `setDeliveryStatus('paused')` (never gated) stays the safe-direction door. A dry run
  reports the refusal it would get.
- A checker throw ⇒ `cap_unreadable`.

**D5a — One broken cap refuses only its own org (`CP71WF-18`, B3).** `coverage()` throws on an
unresolvable cap before it knows whether that cap covers the target. In `capBlocksIncrease` and
`checkLaunchAgainstCaps`, an unresolvable cap refuses a target only when `cap.orgId ===
target.orgId` or the target's account is one the cap is known to cover from its configured
accounts; otherwise it is skipped and logged. Stated consequence (unchanged posture): a tenant with
a cap but the watchdog toggle off gets `cap_unenforceable` on every increase to a covered campaign,
exactly as launches and reallocation already do.

The callers of `updateBudget` are three: `/recommendations/apply`, reallocation's `applyOp`, and
the core `ad-budget-update` node (`bootstrap/nodes.ts:3404`). All three now meet the check.

**D6 — Writes are declared as writes (`CP71WF-4`).** `sync`, `audience-sync`, `import-csv`
(connectors) and `pacing-check` (intel) become `role:"side-effect"` +
`capabilities:["side-effectful"]`. Node and pack versions bump; the side-effect floor is
regenerated; the `campaign-sync` chain's `typeId` pins bump; the steward served-set counts move in
the same PR. A replay fork then serves the recorded output and calls nothing. A branch fork re-runs
them: `sync` and `pacing-check` are idempotent through the cooldown and memo CAS; `audience-sync`
re-uploads, held only by its approval gate (stated, not claimed idempotent). A replay-fork witness
for `daily-metrics` asserts no egress and an untouched cooldown.

**D7 — A sync that pulled nothing is a failure (`CP71WF-8`, `-9`).** The node returns
`status:'failed'`, `error.code:'sync_failed'` with the first account's reason when no account
returned `ok`; a partial failure stays `success` with `failures[]`. The route returns 502 with the
same code. On the chain, the failed node ends the run before `notify`: the failed run and the ADR
0710 run-failure notice to its owner are the signal (accepted, M6). Sync state gains
`lastSuccessAt` (written only when ≥1 account returned ok) and `lastAttempt {at, outcome,
reason?}`; the page shows "Last successful sync" and a failure note.

**D8 — A client's alerts reach that client's people (`CP71WF-7`).** One helper in campaign-intel,
`emitToOrg(tenantId, orgId, notice)`. When `isWorkspaceRootPair(orgId, tenantId)`, the notice is
emitted as today (the tenant audience IS the root org's). Otherwise it is emitted once per member
of the org (`listMembers`) for whom the existing `orgScopeGranted(…, 'workspace:write')`
(`campaign-intel/routes.ts:45`, reused, not copied) holds, each by `recipientUserId`, deduplicated
by subject. With no such member it is addressed `recipientRole:'admin'`. `metadata.orgId` is set.
The pacing memo rolls back only when every emit failed; a member whose single emit failed does not
get that escalation again (stated).

**D9 — Honesty fixes that ride the same files.**
- `CP71WF-10`: an unmapped conversions or revenue CSV column records `null`, not 0.
- `CP71WF-26`: a failed `narrate` sets `narrativeError` instead of reporting nothing.
- `CP71WF-23`: the reallocation approval passes `orgId` and `submitters:[createdBy]`.
- `CP71WF-28`: erasure writes in UTM governance and attribution settings use CAS with retry;
  plan-creator erasure retries like the caps loop.
- `CP71WF-29`: `sync` emits a `summary` string (counts only: accounts, rows, failures; no campaign
  names or money) and `daily-metrics` wires `sync.summary → notify.message` with the notify
  `audience` changed from `tenant` to `self` (the run owner), so one org's result is not a
  workspace broadcast (B2).
- `CP71WF-11`: the five connectors routes use `resolveCallerUser` + the shared `assertOrgScope`.
- `CP71WF-36`: `resolveKpiCurrency` checks the campaign's org.
- `CP71WF-44`: the stale toggle copy.
- `CP71WF-17`: reallocation targets and the cap pause path use the shared ownership predicates
  (`dispatchBelongsToOrg`, `dispatchBelongsToCampaign`), not a brief-id join.
- `CP71WF-35`: sync failure reasons are translated (`syncReason_*`, four locales).
- `CP71WF-43`: the pacing-check chain description no longer says the two nodes run in order.

**Filed, not in this ADR** (each in the per-run file with its reason): `CP71WF-13/14` (public
conversions intake abuse controls), `-15` (natural-key CAS for performance rows), `-16` (showcase
seed labelled `csv`), `-19/-24` (per-currency money math), `-20` (invented `'USD'` and null-as-0 in three reports: needs a null-currency display path in
the intel page, not only the service), `-21` (lookback + `asOf`), `-22` (name joins), `-25` (Analyst eval fixtures), `-27` (cap re-arm CAS), `-30` (declared outputs off the
primary node), `-31` (port schemas), `-33` (agent reach), `-34` beyond the D6 witness, `-46` (sync
reads the run owner's connections), `-41` (re-measured: a signed-out
`/recommendations/apply` is refused 403 before the handler, so the proposed actor check could not
be witnessed; left open), and the remaining Nice items. A shared `org:` notification audience
(ADR 0816 extension) is filed against D8.

## Alternatives weighed

- **Make the ADR 0832 floor refuse `''` globally** instead of D3. Rejected here: it changes every
  surface and the forms-intake honest-not-found path (WF-FORM-2) depends on it. D3 is scoped to the
  two surfaces where `''` means "all orgs".
- **Check caps in the route, not the adapter** (D5). Rejected: the adapter is the ONE write door;
  any other caller (an agent tool, a future node) would bypass a route check, which is exactly how
  this hole exists.
- **Org-addressed notices via a new emitter audience** (D8). Better long-term, but it changes the
  notifications seam (ADR 0816) for every feature. The per-member emit is the existing precedent;
  a shared `org:` audience is filed as a follow-up.

## Replay / wire

D6 changes how replay treats four nodes. The fast path is keyed by typeId membership in the
floor (`executor.ts:1191`) and recorded outcomes are indexed from the source run's event log for
every node (`sideEffects.ts:392`), so runs recorded BEFORE the change are also served from their
recorded outcomes once it lands (corrected by the /architect pass; the first draft said they would
replay live). D1–D5, D7–D9 change no wire shape. No RFC.

## /architect corrections (independent pass, 2026-10-31)

Accept-with-changes; 4 Blockers and 7 Majors in the first draft, all folded in above:
B1 `scope:'account'` plans were node-trusted (D1 re-plans server-side); B2 the summary would have
gone to a tenant broadcast (notify `self`); B3 D5 spread one org's broken cap to every org (D5a);
B4 "a decrease is always allowed" was false on unreadable budgets (D5 wording). M1 org from
`deps.orgId` is the tenant on the chain lane (ledger-resolved org); M2 D3 belonged in the service
and the S-A pin edit is mandatory; M3 one shared ownership predicate, not a third copy; M4 the
replay claim was wrong; M5 root-org test is `isWorkspaceRootPair`, reuse `orgScopeGranted`; M6
D7's failed run is the signal; M7 filed `-46`.

## Phases

| Phase | Scope | IDs |
|---|---|---|
| P1 | D1–D9 + D5a in one PR (row 71) | Blockers `-1`…`-8` + D9 list |

## Open questions

- **Q1** Should a pre-0941 ledger row whose brief has no campaign be synced at all? D1 excludes it
  (no org can be proven).
- **Q2** D8's admin fallback: is "no org writer" better surfaced as an operator log only?

## Implementation record (2026-11-01)

| Decision | Where | Witness |
|---|---|---|
| D1 sync reads only the org's dispatches; host re-plans the node's batches | `syncService.planSync`, `campaign-connectors/surface.ts` `recordAccountRows`, `adsAdapter.dispatchBelongsToOrg` | `adr1022-campaign-performance-org-truth` D1, `campaign-sync` two-org + legacy-join cases |
| D2 attribution email per org | `attribution.ts` | `adr1022-…` D2 |
| D3 org required | `performanceService.listRecords`/`kpiSummary`/`importCsv` | `adr1022-…` D3/D4; `adr0830-kb-ratchets` pin list shrank |
| D4 write floors | `CAMPAIGN_CONNECTORS_SURFACE_POLICY`, `CAMPAIGN_INTEL_SURFACE_POLICY` | `adr1022-…` D3/D4 + policy-keys test |
| D5/D5a caps on every budget change; verified-org skip | `adsAdapter.updateBudget`, `capTargetOrg`, `spendCaps.coverage` | `ads-campaign-budget` D5 + ledger-org cases; `adr1022-…` D5a |
| D6 four write nodes side-effect | both node packs, floor, served set | `adr1022-daily-metrics-replay` (real executor, replay fork) |
| D7 typed `sync_failed`, `lastSuccessAt` / `lastAttempt` | node pack, `syncService`, the page | `campaign-connectors` node tests, `adr1022-…` D7, FE freshness tests |
| D8 org alert audience | `campaign-intel/orgAlerts.ts` | `adr1022-…` D8 |
| D9 list | as listed | per item (`adr1022-cas-rewrite`, `campaign-intel`, `campaign-intel-reallocation`, CSV case) |

> **Added by the independent grades (not in the decision text above).** `CP71CD-1`: the budget
> apply route now proves the campaign is the org's (`campaign-intel/adOwnership.ts`, 404 otherwise),
> and the ledger outranks account-scope settings (`CP71CD-11`). `CP71CD-4`/`-12`: an ad account
> belongs to one client org, checked when settings are saved (legacy rows resolved by brief). Two
> saves of the same id at the same moment can still both win: filed. `CP71CD-8`: every sync-state
> write is a CAS merge. Grades: WF C → A−, code B− → A−, UX C+ → B+.


## Follow-ups after implementation

- **Q-1 (#5467, 2026-11-02): the core `ad-budget-update` node.** The node took a caller-chosen
  campaign id and called `ctx.ads.updateBudget` with no ownership check. It now resolves the
  run's org (the host-written client stamp), applies the ADR 0832 floor, and asks the same
  `orgOwnsAdCampaign` predicate as `CP71CD-1`, which campaign-intel registers through a host
  setter (`setAdsCampaignOwnershipChecker`). An unstamped run could name its org with `orgId`.

  > **CORRECTED (adapter seam, 2026-11-02): the check moved into the adapter, and the
  > `orgId` fallback was removed.** The executor hands `ctx.ads` to every node, so a pack could
  > call `updateBudget` or `setDeliveryStatus` directly and skip the node's check. Both methods
  > now ask the predicate first (`adsOwnershipRefusal` in `adsAdapter.ts`), dry runs and pauses
  > included. The org comes only from inputs a caller cannot choose: the stored run's client
  > stamp, else `deps.orgId` (the executor's `run.tenantId`, or the org a feature route
  > authorized). The node's `orgId` fallback came from node config, which is caller-controlled,
  > so the seam could not honour it without reopening the bypass. It was removed (option A,
  > decided by the lead). That affects 0 production runs: row 71 measured that production has
  > never run a connector. A step that names an org other than its run's is now refused
  > (`forbidden_scope`). The callers keep their earlier typed refusals; the seam is the
  > backstop. The ADR 0832 floor stays at the callers, because the adapter has no
  > `orgScopeSubject`: "floor at the seam" is filed. Witness:
  > `adr1022-ads-ownership-seam` (a pack node in a real run; five guards sabotage-witnessed).

- **The read door (Q-7 PR 3, 2026-11-04): `getMetrics`.** The write doors met the seam, but
  `getMetrics` still read a caller-chosen campaign: through the core `ad-metrics` node or a
  pack's `ctx.ads.getMetrics`, a run for client A could read client B's spend, clicks and CPC
  over a shared agency token. It now asks `adsOwnershipRefusal` first (same org resolution),
  and the node keeps the seam's code (`ad_campaign_not_in_org`, `capability_not_provided`,
  `forbidden_scope`) as a TYPED refusal, never `metrics: null` ("no data"). Witnessed red on
  `main` first. Witness: `adr1022-ad-metrics-org` (node and pack lanes, two guards
  sabotage-witnessed). Still filed: `getCampaignBudget`, also a read of a caller-chosen
  campaign on `ctx.ads` (`campaign-connectors`), which today meets the seam only when it runs
  inside `updateBudget`.

  > **CORRECTED (2026-11-04, report only, not implemented) — "the adapter has no
  > `orgScopeSubject`" is not a blocker for the floor at the seam.** The seam already reads
  > the stored run (`adsActingOrg`), and the run carries `metadata.orgScopeSubject` (the
  > executor reads it from there, `executor.ts` `bundleOrgScopeSubject` and the node context
  > build), while `deps.actingUserId` is already in the adapter's deps. So for a run lane the
  > seam could call `assertRunScopeOrg({ tenantId, actingUserId, orgScopeSubject:
  > run.metadata.orgScopeSubject }, org, 'workspace:write')` with no change to its deps. Route
  > lanes (no stored run) already ran `requireOrgScopeFor`; actorless runs stay a no-op, as at
  > the node. "Floor at the seam" stays filed: feasible, not done.
