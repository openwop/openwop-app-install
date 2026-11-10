# ADR 1052 — BI honest metrics: a wrong number is a typed failure, a partial one says so

Status: implemented (2026-11-03, branch `feat/fl2-84-bi`)

Feature: `bi` (feature loop round 2, row 84). Extends ADR 0417 (the semantic metric
catalog) and ADR 0846 (the dashboard-tile read exits). Grade record:
`docs/steward/workflows-assessment/2026-11-03-bi-row84.md`.

## Context

ADR 0417 gave the app a governed metric catalog: a metric is a closed-world definition
(entity type, aggregate, numeric field, structural filters, group-by, time field) that
four lanes evaluate through one function, `runMetric` (`features/bi/biService.ts`):
the `/metrics` page and the dashboard tile (HTTP), the `openwop:bi.run-metric` chat tool,
and the `feature.bi.nodes.run-metric` workflow node. ADR 0846 fixed who the rows are read
as. The row-84 grade found the remaining defect class is not access but **honesty**: the
evaluator can return a wrong number that looks right, on every lane at once.

1. **Stale definitions run.** Validation happens only at write time. When the entity type
   later loses or re-types a field the metric names, the run never re-checks. User-type
   rows are projected to the live schema (ADR 0847 D3), so the removed key reads
   `undefined`: `sum`/`avg` over it aggregate nothing, and a filter on it matches the
   wrong rows. A `neq` filter matches **every** row, so "deals not lost" silently becomes
   "all deals".
2. **The row cap sits before the org filter.** `fetchRows` slices the tenant-wide row
   list to 5000, then the org and viewer filters run. In a tenant with more than 5000
   deals, an org with three gets an aggregate over whichever of its three survived the
   slice, flagged `truncated` (which also tells it the tenant has 5000+ rows). No
   consumer renders `truncated`.
3. **The group cap is silent.** Groups past 100 are sliced off with no flag.
4. **The dashboard tile's "latest month" can be the undated bucket.** Bucketed runs key
   rows with no date as `undated`, which sorts after every `YYYY-MM`, so the tile's
   "latest" value is the sum of deals with no close date.
5. **Editing a metric in the UI deletes its filters.** The form has no filters control,
   and PATCH replaces the definition (deliberately, ADR 0417), so saving any filtered
   metric changes what it measures.
6. **Readers are offered New / Edit / Delete,** which the server refuses (403).

Smaller gaps from the same grade: filter value types are not checked against the field
(`gt '100'` on a number compares strings); the evaluator reads `orgId: ''` as "no org
filter" (every caller refuses it first, but the evaluator is the exit); user-type metrics
page through `queryEntities`, which re-lists the whole type for every 200-row page;
`createMetric` is check-then-put; `ctx.features.bi.listMetrics` returns raw definitions
including `createdBy`; `bi:metric.createdBy` sits on the DSAR actor-attribution debt list.

There is no warehouse connector, no stored credential and no AI-authored metric path (both
chat tools are reads), so the cost-bound-on-warehouse and AI-authoring checks have nothing
to bind to. Catalog write authority (`host:members:manage` in the path org over a
tenant-wide catalog) matches this app's tenant tier, which is the union over org
memberships (`assertTenantScope`), the same resolution the consent regime took (ADR 0849).

## Decision

> Revised after the pre-code adversarial `/architect` pass (record at the end): 3
> Blockers and 6 Highs were in the first draft of this section. The changes are folded
> in below rather than left as notes, because no code had been written against the
> draft.

**D0 — The catalog is per org** *(the lead's decision 2026-11-03, option A of three)*. The
catalog was tenant-wide while every write was authorized in one org, so an admin of
org A could create, redefine or delete the metrics org B's page, tools and nodes run.
Requiring a "tenant-level" scope does not close that: this app's tenant tier is the
union over the caller's org memberships (`assertTenantScope` →
`resolveSubjectScopesUnion`), which admits the same people. Stored metrics are keyed
`tenant:org:metricId` and carry `orgId`; every lane lists the in-code system metrics
plus the caller's org's own; writes need `host:members:manage` in that org. Prod holds 0
stored metrics (read-only measurement 2026-11-04T01:51Z), so there is no migration and no
orphan.

The run lane has no org of its own (`BundleScope` carries no org), so a node or tool names
the org and the run's person must hold `workspace:read` in it (`assertRunScopeOrg` /
`resolveReadOrgScope`, ADR 0846 D3). The org is never trusted from input alone; an
actorless run stays tenant-trusted, the standing `assertRunScopeOrg` contract.
**No run, node or chat-tool lane writes the catalog** (the surface and both tools are
reads); create, edit and delete exist only on the HTTP routes, which require
`host:members:manage` in the path org. A future write lane must refuse actorless runs
and require that scope in the named org (the lead's ruling, 2026-11-03).

*Note for row 31 (consent, ADR 0849):* its "tenant-level" regime authority is the same
union tier, so it is no stronger than "admin of any org". Filed as a row-31 follow-up
(`BI84WF-11`); consent is not changed here.

**D1 — Re-validate at run time; a stale metric is a typed failure.** `runMetric` re-checks
the stored definition against the live type with the same predicates the write path
uses, never an empty or partial result:
- the type exists. A missing **user** type (any name without a dot) is stale on
  `entityType`; the "honest empty" result stays only for a `KERNEL_METRIC_TYPES` name
  the tenant has not minted yet. A system type must still be in `KERNEL_METRIC_TYPES`;
- `field` exists and is `number` for non-count aggregates;
- every filter key exists and its value still fits the field (D7, including `enum`
  options, so a filter on a removed option is stale, not "matches every row");
- `groupBy` exists; `timeField` exists and is `date` or `string`.

The refusal is `422 validation_error` with `details: { reason: 'metric_stale', metricId,
field }` (no new error-code spelling, so no `OpenwopErrorCode` change and no v2 vendor
prefix). Clients key on `details.reason` and `details.field`, never on the English
message. The catalog projection carries the same verdict (`stale: { field }`), one type
read per distinct entity type, so the model and the page see a stale metric before
running it. System metrics are code and pass the same check; a test mints every kernel
type through its owner and pins every system metric valid against it.

*Residue (filed, `BI84WF-10`):* kernel types are checked against the STORED type record,
which `mintSystemType` updates only when the owner next re-mints (on a write). A field
removed in code therefore stays valid for BI in a tenant until its next write. Closing it
needs a code-declared kernel schema registry across the five owners.

**D2 — No row cap; org scope by type class.** Every row is already loaded before any
filter, and the kernel caps a type at `ENTITY_ROW_CAP_PER_TYPE` (10,000), so a 5,000-row
slice saved nothing and made an org's answer depend on `listByPrefix` order. `MAX_ROWS`
and `truncated` are removed. Org scope is decided by the type, not by a field name:
- kernel types filter on `values.org_id` (a test asserts every `KERNEL_METRIC_TYPES`
  schema declares it), then the owning feature's row filter (ADR 0846 D2);
- user types are tenant-scoped, matching the entities read (`workspace:read`, root
  namespace, ADR 0847). A user field that happens to be named `org_id` no longer scopes
  anything. The result says which: `scope: 'org' | 'tenant'`.

`totalRows` counts the rows in that scope (no tenant-size disclosure for kernel types).

**D3 — The group cap is reported and keeps a defined set.** At most 100 points.
`groupsTruncated: true` plus `droppedGroups: n` when more existed. A bucketed series keeps
the most recent 100 buckets. A grouped result keeps the 100 groups with the most rows
(`n` descending, key ascending on ties), whatever the aggregate, then sorts by key.

**D4 — Dates are strict; undated rows are counted, not bucketed.**
- `since`/`until` must be strict ISO dates (`YYYY-MM-DD`) or datetimes, else 422.
  Comparison happens at the bound's granularity: a date-only bound compares against the
  value's date part, and a date-only `until` includes that whole day.
- A bucketed run excludes rows whose time value is missing or not a strict date or
  datetime, and reports `undatedRows: n`. The `undated` and `invalid` keys disappear.
- With both bounds, a bucketed `count`/`sum` series is zero-filled between them, so
  consecutive points are consecutive periods.

**D5 — One projected read for user types.** `entitiesService` gains
`listLiveEntities(tenantId, typeName)`: a ROOT-namespace USER type's rows, live-projected
(the `liveProjector` `queryEntities` applies), one read. It refuses system types. Drafts
count, as they do in `queryEntities` (the authed read; only the public read excludes
them). BI stops paging `queryEntities`.

**D6 — The evaluator refuses an empty org** (`422`), instead of reading it as "every org".

**D7 — Filter values are type-checked at write** with the rules `queryEntities` applies
(range ops: a number on a number field, a string otherwise; `contains`: a string; `in`: an
array of scalars) plus enum membership: an `enum` field's `eq`/`neq`/`in` values must be
current options.

**D8 — Catalog writes are versioned compare-and-swap.** Create is `putIfAbsent` (409 on a
lost race). PATCH carries `expectedUpdatedAt`, which the page round-trips, and a mismatch
is `409 conflict`; the write is a `compareAndSwap` against the row it checked, single
attempt (a retry would re-apply a stale edit, the ADR 0845 lesson). Delete uses
`compareAndDelete` against the row it read.

**D9 — The surface and the tools list one projection.** `ctx.features.bi.listMetrics`,
`getCatalog` and `openwop:bi.list-metrics` return the same entries: the definition
(`field` and `filters` included, so a model can say what a metric measures) plus `stale`,
without `createdBy`, `tenantId` or timestamps.

**D10 — Partial and stale results are visible.** The `/metrics` page renders
`groupsTruncated`, `undatedRows` and `scope:'tenant'` as notes on the run result, and a
stale metric as a row state naming the field (built client-side from `details.field`).
The run tool's error JSON passes `details` through, and its description states what each
flag means (parity-pinned). The node pack is unchanged (its `result` carries the flags).

**D11 — The page offers only what the caller may do.** `GET …/metrics` returns
`viewer: { canManage }`, computed by calling the write doors' own predicate
(`requireOrgScope(req, 'host:members:manage')`) and catching its 403. A projection, never
authority. The page hides New, Edit and Delete for non-managers.

**D12 — Editing keeps, shows and edits filters.** The edit form round-trips the stored
filters and `updatedAt`, lists the filters, and lets a manager remove or add one (field,
op from the closed vocabulary, value). PATCH stays "replace" (ADR 0417): the client now
sends what it means.

**D13 — DSAR re-attributes the author.** A `bi:metric` eraser rewrites an erased
subject's `createdBy` (any of `subjectKeyForms`) to the `ERASED` sentinel with a
compare-and-swap. The row is org config resolved by id, so it is kept. `bi:metric` leaves
`ACTOR_ATTRIBUTED_DEBT` (`ACTOR_DEBT_CEILING` 18 → 17), witnessed by a test.

**D14 — The two deal system metrics measure what their titles say.** "Open deals"
(`sys-deal-count`) and "Pipeline value" (`sys-pipeline-value`) counted won and lost deals.
Both gain `deal_status neq 'won'` and `deal_status neq 'lost'` (a missing status is open,
`deals.ts` `projectDeal`). "Average deal size" stays over all deals. The dashboard tile
reads "Pipeline closing this month": the `sys-pipeline-value` monthly series over the
last 12 months through the current one, read by month KEY (not by position), with the
delta against the previous month.

## Alternatives weighed

- **Return the stale metric's result with a warning** (D1). Rejected: a consumer that does
  not read the warning shows a wrong number, and three of four consumers did not read
  `truncated`. A refusal cannot be shown as a number.
- **Merge semantics on PATCH** (D12). Rejected again for the reason ADR 0417 gave:
  merging resurrects optionals the caller removed. Fixing the client keeps one rule.
- **Keep the catalog tenant-wide and require a tenant-level scope** (D0). Rejected: the
  tenant tier is the union over org memberships, so it admits the same admins.
- **Tenant-wide catalog, write requires the scope in EVERY org.** Rejected: odd
  semantics, and one org without an admin blocks every write.
- **Keep a 5000-row cap after the caller's filters.** Rejected (architect pass): the rows
  are already in memory before any filter, the kernel caps a type at 10,000, and the cap
  only turned an org with 5,001-10,000 rows into a partial answer over an arbitrary slice.
- **A new `metric_stale` error code.** Rejected: it joins the closed `OpenwopErrorCode`
  union and takes a vendor prefix under v2. `validation_error` with `details.reason`
  carries the same information.

## Trade-offs

- A stored metric that is stale today starts failing (422) where it used to return a
  number. That number was wrong; the UI names the field and offers Edit.
- Bucketed runs no longer include undated rows in any point. Their count is reported.
- A metric defined in org A no longer appears in org B (D0). System metrics still do.
- Response fields added (`groupsTruncated`, `droppedGroups`, `undatedRows`, `scope`,
  `stale`, `viewer`) and removed (`truncated`, never rendered anywhere): host-extension
  routes (`/v1/host/openwop-app/*`), non-normative, so no RFC.

## RFC gate

None. All routes are host extensions under `/v1/host/openwop-app/*`; the node pack is
unchanged.

## Replay

The node is `role:action` (recorded): replay reads the recorded output, so evaluator
changes do not diverge a replay. Tool and node text carry no run-scoped id (ADR 1002).

## Implementation plan

| Phase | Content | Witness |
|---|---|---|
| P1 | D0–D9, D13, D14 (backend) | red on `46301fb8f` first |
| P2 | D10–D12, D14 tile (frontend) | FE tests red on `46301fb8f` first |

One PR (well under 2,000 changed lines; the only shared seam touched is the new
read-only `listLiveEntities` export in `entitiesService`).

## Architect pass (pre-code, independent)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Blocker | a deleted user type returned an "honest empty" 0 | D1: stale on `entityType` |
| 2 | Blocker | kernel checks read the stored type record, which lags code | D1 residue, filed `BI84WF-10` |
| 3 | Blocker | "Open deals" / "Pipeline value" include won + lost; the tile reads one | D14 |
| 4 | High | the 5000 cap bounds nothing once rows are loaded | D2: removed |
| 5 | High | org scope keyed on a user-definable field name | D2: by type class, `scope` |
| 6 | High | `since`/`until` unvalidated, string-compared | D4 |
| 7 | High | the tile's "latest" is the furthest-future month; no zero-fill | D4 zero-fill + D14 |
| 8 | High | enum options unchecked: the `neq` bug through another door | D1/D7 |
| 9 | High | `hasOrgScope` is a private copy with a different subject | D11: the door's own predicate |
| 10 | Medium | CAS without a client version closes only a millisecond window | D8: `expectedUpdatedAt` |
| 11 | Medium | the catalog still offers stale metrics to a model that cannot edit | D1/D9: `stale` |
| 12 | Medium | an unspecified new error code | D1: `details.reason` |
| 13 | Medium | "top by value" is ill-defined for min/avg/negatives | D3: by row count |
| 14 | Medium | the projection hides `field`/`filters` | D9 |
| 15 | Medium | D13 lacked the ceiling, CAS and witness | D13 |
| 16 | Medium | a node-pack change needs a bump, pin and re-sign | D10: node unchanged |
| 17 | Low | drafts, D5 scope, entities toggle, i18n, strict dates | D4/D5/D10; entities toggle: open question |

## Open questions

- [x] D0 option A (per-org catalog): the lead's decision, 2026-11-03.
- [ ] BI evaluates user-type metrics while the `entities` toggle is off. Kept: `bi` is its
  own toggle and the metric was defined while entities was on; flagged for the owner.

- [ ] Prod exposure: stored metrics with filters (who could hit D1), kernel rows per
  (tenant, type) against the cap (D2). Requested read-only.
- [ ] `BI84X-2` (groupable fields in the catalog projection): filed, not in this ADR.
- [ ] `BI84WF-9` (no chain consumes the BI nodes): filed.

## Closing grades and corrections (independent graders, after implementation)

`/grade-code` (B+, then re-graded) and `/grade-ux` (B−, then re-graded) ran on
`513c5213e` as independent subagents. Their findings, as corrections to the decisions
above rather than silent edits:

- **D7 was incomplete (grade-code H1).** It type-checked range ops and enum options
  only, so `neq '0'` on a number field matched every row and `eq 2` on a text field
  matched none: the wrong-number failure D1 names, through another door. Every op now
  compares like with like (number/string/boolean by field kind; `contains` only on text;
  booleans only `eq`/`neq`), refusals name the filter (`details.index`), and a filtered
  field that changes kind is stale.
- **D0's teardown sentence was false (grade-code M2).** `deleteOrg` does not reap
  metrics: RI-7 refuses (409) to delete an org that still holds any org-scoped row, and
  a stored metric is now one. Kept as the rule (metrics are org config the owner removes
  first), pinned by test, and the comment corrected.
- **D3 (grade-code M4/L5).** A bounded series longer than 10,000 buckets is a 422, not a
  silently shortened one; `droppedGroups` counts only groups that held rows, and
  `groupsTruncated` is set whenever the cap cut the series.
- **D9 (grade-code L7).** The routes' single-metric, create and update responses return
  the projection plus `updatedAt`, never `createdBy`/`tenantId`.
- **D13 (grade-code L6).** The eraser throws after four lost races instead of reporting
  success over a row that still names the person.
- **D14 looked backwards (UX H1).** An open deal whose close month has passed is
  overdue, not pipeline. The tile's window is the viewer's current LOCAL month plus the
  next 11; it shows this month and the 12-month total, with no delta (a schedule is not
  a trend).
- **D12 (UX H2, M4–M8, M10).** A filter typed but not added blocks Save with the reason
  on the filter; the condition list and value control follow the field's kind; focus
  and a polite announcement follow add/remove; a conflict disables Save and Reload
  reopens the editor on the newer version; the stale reason is visible text, with its own
  copy for readers and for built-in metrics; readers get their own empty state; an org
  switch closes an open editor (grade-code M3).

**Residue (filed):** `BI84WF-10` kernel schema lag (D1); `BI84WF-11` row 31's union tier;
`BI84WF-13` the node pack declares no input schema, so a saved
workflow learns `orgId` is required from a typed 422 (no node pack in the repo declares
inputs); `BI84X-2` groupable fields in the catalog (also closes `BI84UX-4`: the entities types route hides kernel types, `entities/routes.ts:258`, so built-in types' fields get no kind-aware filter controls or suggestions on the page); `BI84UX-13` `.form-grid` has no CSS
(pre-existing).

**Re-grades (same independent graders, on `2d811189a`): code A−, UX A−.** The lead made
three Lows must-fixes, all landed and sabotage-witnessed:

- **Late replies are dropped (code re-grade L1).** The page keeps the current org in a
  ref; a list, run or post-conflict reload reply for an org the user has left changes
  nothing. Before, a slow org-A reply after a switch to B could show A's rows and
  manage permission, or reopen A's editor inside B so a save went to B.
- **The eraser finishes the tenant (L2)** and throws once at the end, naming each metric
  it could not re-attribute.
- **Pre-1052 metrics no longer vanish on upgrade (`BI84WF-12`, fixed rather than
  filed).** A row written before this ADR has no org and keeps its key
  `tenant:metricId`. Chosen over a migration into a "default" org, which would have to
  guess an org for a tenant with several: such a row is listed (`legacy: true`),
  runnable and READ-ONLY in every org of the tenant, exactly as visible as it was; edit
  and delete answer `409 metric_legacy`; a manager of an org moves it in with
  `POST …/metrics/:id/adopt` (insert-if-absent, then compare-and-delete of the legacy
  row, undone if that row changed), after which it leaves every other org. An org's own
  metric of the same id wins over the legacy one. Prod holds 0 such rows; this exists
  for white-label adopters.

UX re-grade items fixed: a metric found stale on Run is announced and focus moves to its
reason; the "add or clear" error sits on the focused control, with a Clear action; the
typed value survives a field change of the same kind; a failed post-conflict reload
keeps the conflict; repeated announcements re-announce; the tile's empty copy no longer
tells a workspace with only overdue deals to add close dates (`BI84UX-5`, an "Overdue"
figure, is filed). Built-in types' fields reach the filter editor only as free text
(`BI84UX-4`, see `BI84X-2`); the server's D7 checks validate that path.

