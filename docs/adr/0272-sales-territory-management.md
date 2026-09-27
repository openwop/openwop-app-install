# ADR 0272 — Sales Territory Management

**Status:** implemented (all phases P1–P6 landed on PR #1312; see §11)
**Date:** 2026-07-05
**Depends on:** ADR 0001 (feature-package architecture), ADR 0006 (RBAC / accessControl —
the single owner of orgs/members/roles/scopes), ADR 0008 (CRM) + ADR 0208–0213 (CRM
entities, stage history, pipeline reporting), ADR 0014 (workflow-surface `ctx.features.*`),
ADR 0015 (workspace-as-tenant). Composes the `sharing` per-record-ACL precedent (ADR 0013).
**Toggle:** `territories` (new, default **OFF**, `bucketUnit: tenant`)
**Surfaces:** authed `/v1/host/openwop-app/territories/*` (host-extension, non-normative)
**RFC gate:** **Host-extension — NO new wire RFC** (verdict derived in §6; rides Accepted RFC 0049).

---

## 1. Context & motivation

openwop-app has a strong CRM *deal/pipeline/reporting* core (ADR 0008 / 0208–0213) but no
**sales-organization layer**: no territories, no sales divisions/hierarchy of reps, no
quotas, and no row-level visibility over CRM records. A competitive deep-dive across the
best-in-class field (Salesforce Sales Territories / former Enterprise Territory Management,
MS Dynamics 365 Sales, Zoho CRM, and the SPM planners Anaplan / Fullcast / Xactly) found a
single highest-leverage primitive: **a layered, parent-child territory model that
simultaneously (a) is an org sub-unit — a division/region, (b) governs which records a
subject can see, and (c) is the axis quotas and forecasts roll up along.** One object
unlocks four of the nine "sales-org" concepts (regions, divisions, hierarchy, goals) on top
of the deals we already have.

This ADR shapes that primitive into a first-class openwop feature-package. Per the product
decision recorded in refinement, **v1 is the ambitious cut**: it includes territory-scoped
record **visibility** (a territory is a record-sharing boundary, Salesforce-parity) and
**per-territory + per-rep** quotas.

**Deferred (recorded gates, later ADRs):** dynamic geographic maps (concept 9 — no map
library ships in the frontend today; a territory here is defined by *rules*, not drawn on a
map); rep **commissions** tied to deals (concept 5); **dealer/outlet** records + PRM
(concepts 7/8). None are cut from the vision — each is a follow-on with its own ADR.

---

## 2. Boundaries & pre-existing-surface audit (Step 3)

Proving what is new before asserting it. All citations are `file:line` in
`backend/typescript/src` unless noted.

- **Namespace is clear.** `territor*` → **zero hits** anywhere in the backend. `division`
  → zero relevant (only arithmetic in `csvImport.ts:97`). `/v1/host/openwop-app/territories`
  is a **free route prefix** (nearest neighbours `tasks`, `strategy`, `roster`, `roles` —
  no collision).
- **`region` is taken by unrelated owners** — AWS/blob (`host/blob/s3SigV4.ts`) and the
  commerce shipping address (`commerceService.ts:386`). A sales *region* is just a named
  territory here; we do **not** add a `region` field or route.
- **`goals` COLLIDES — do not reuse.** There is a live `goals` feature package
  (`features/goals/feature.ts`, RFC 0097 standing-goals for agents, ADR 0039) owning
  `/v1/host/openwop-app/goals`. Our sales targets are named **`quotas`**, scoped *under*
  the territory feature — never `goals`. Likewise avoid a bare `quota` route/middleware
  name (the rate-limit layer owns `runQuota`, `middleware/rateLimit.ts`).
- **CRM storage = per-entity `DurableCollection`, tenant-indexed.** Deals
  (`crm/entities/deals.ts:56`, `'crm:deal'`), companies (`companies.ts:35`), pipelines
  (`pipelines.ts:40`), each with a `tenantOf` secondary index. Territories follow the same
  storage idiom (new collections `crm:territory*`), not a new persistence abstraction.
- **The `Deal` record already has an opaque `owner`** (`deals.ts:42-43`, an RFC 0048
  subject id) — **unindexed and never consulted for access today.** Territory assignment +
  per-rep quota splits are the first meaningful consumers of `owner`.
- **The `Company` record has no geography/owner field** (`companies.ts:15-30`). Assignment
  rules will match on existing fields + `customFields`; we add **no** column to CRM entities
  (assignment is stored on the territory side).
- **Reporting groups by `stageId` ONLY.** `reportService.ts:35-44` computes weighted
  pipeline (`Σ amount × stage.probability/100`), funnel, aging, snapshots — **no owner,
  team, or territory dimension, no rollup by rep/quota.** Territory forecast rollup is
  net-new: a territory-dimensioned report that reuses the existing weighting math.
- **CRM has NO row-level visibility.** `listDeals` (`deals.ts:147-159`) filters
  `tenantId` + `orgId` and nothing else; every member with `workspace:read` sees **all**
  org deals. Territory-scoped visibility is therefore the **first row-level access filter on
  CRM** — a genuinely new access seam.
- **RBAC single owner = `accessControlService`** (ADR 0006; `host/accessControlService.ts`).
  ADR 0006 alt #1 explicitly **rejects a parallel `rbac`/roles feature**. Roles resolve
  from explicit `roles[]`, **never from org-chart position** (a stated security invariant,
  `accessControlService.ts:15-22`, RFC 0087 §B). → Territory visibility must **extend
  accessControl's enforcement**, not fork roles, and must **not** turn territory position
  into a role grant (see the reconciliation in §4.4).
- **Two org-charts already exist — both wrong owners for a rep hierarchy.** The agent
  roster (`host/rosterService.ts`, RFC 0086) and the agent org-chart
  (`host/orgChartService.ts`, RFC 0087) are **agents-only, tenant-scoped, and confer NO
  authority by design** (`orgChartService.ts:10-15`). A human sales `reportsTo` tree does
  **not** exist anywhere. → Reuse the **acyclic-tree validation pattern**
  (`hasReportsToCycle`, `orgChartService.ts:75`); do **not** reuse the store.
- **The `sharing` feature (ADR 0013) is the ACL precedent.** It stores
  `(resourceType, resourceId)` grants with per-type resolvers
  (`sharing/sharingService.ts:42-73`) over host-extension CRM/CMS/commerce resources and is
  classed **host-extension, non-normative, no RFC.** This is the architectural class
  territory-visibility belongs to.
- **Wiring contract** (worked from `crm/feature.ts:27-65`): a `BackendFeature` exports
  `{id, registerRoutes, toggleDefault, requiredPacks, surface}`, is **appended to
  `BACKEND_FEATURES` (`features/index.ts:125`)** — no edits to core route/nav — gates every
  route with `authorizeOrgScope(req, {toggleId,label}, scope)` (`features/featureRoute.ts:103`),
  and exposes a `ctx.features.<id>` surface via `surface.build(scope)`. Frontend registers a
  route module in `frontend/react/src/features/registry.ts`.

---

## 3. Decision

Introduce a new feature-package **`src/features/territories/`** (toggle `territories`,
default OFF, `bucketUnit: tenant`) that owns a **layered territory model** over the existing
CRM, an **assignment-rule engine**, a **quota/attainment** model with per-rep splits, and —
as its highest-value and most security-sensitive capability — **territory-scoped record
visibility** enforced by extending `accessControlService`. It exposes REST, a
`ctx.features.territories` workflow surface, a signed node pack, and a frontend admin +
planning UI. It **composes** CRM, accessControl, and the reporting service; it **shadows
nothing** (no parallel roles, no parallel org-chart, no CRM-entity columns).

### 3.1 Data model (new `crm:territory*` collections)

**Three layers, mirroring the Salesforce Type → Model → Territory shape** the deep-dive
found to be the durable industry pattern:

```
TerritoryType   { territoryTypeId, tenantId, orgId, name, priority }        // classification
                                                                            //   e.g. "Geographic", "Named-Account"

TerritoryModel  { modelId, tenantId, orgId, name,                           // an org arrangement / scenario
                  state: 'planning' | 'active' | 'archived',                //   ← lifecycle (§3.2)
                  createdBy, createdAt, activatedAt?, archivedAt? }

Territory       { territoryId, tenantId, orgId, modelId, territoryTypeId,
                  name,
                  parentTerritoryId: string | null,                        // parent-child hierarchy
                  managerSubjectId?: string,                               // an accessControl member (RFC 0048 subject)
                  memberSubjectIds: string[],                              // reps = accessControl members (NOT net-new people)
                  createdAt, updatedAt }

AssignmentRule  { ruleId, tenantId, orgId, modelId, territoryId,
                  target: 'company' | 'deal',
                  filter: FilterExpr,      // criteria on record fields incl. customFields, owner, amount, stage
                  priority: number }       // first-match-wins within a model

Assignment      { assignmentId, tenantId, orgId, modelId, territoryId,     // materialized result of a rule (or manual)
                  target, recordId, source: 'rule' | 'manual', ruleId?, at }

Quota           { quotaId, tenantId, orgId, modelId, territoryId,
                  period: 'YYYY-Qn' | 'YYYY-MM',
                  amount, currency,
                  repSplits?: { subjectId, amount }[] }                    // per-rep split within the territory
```

- **`memberSubjectIds` / `managerSubjectId` reference existing `accessControlService`
  org members** (RFC 0048 subjects) — territories do **not** invent a people store. This is
  the "no parallel architecture" rule ([[no-parallel-architecture]]) applied.
- **`parentTerritoryId` builds the hierarchy**, validated acyclic with the same
  pattern as `orgChartService.hasReportsToCycle`; a separate store (agent org-chart is the
  wrong owner).
- Every record carries `tenantId` + `orgId` and is IDOR-guarded on both (the CRM "CTI-1"
  invariant), stored as tenant-indexed `DurableCollection`s.

### 3.2 Model lifecycle — Planning → Active → Archived

Directly from the Salesforce model-state semantics the research verified:

- **`planning`** — a scenario. Territories, rules, and quotas can be edited freely and
  assignments can be *previewed* (dry-run: "if this model went active, rep X would see N
  accounts, territory Y's coverage = …") **without touching live access or forecasts.**
- **`active`** — **exactly one model per `(tenant, org)` may be active.** The active model
  alone drives (a) record visibility (§4.4) and (b) the territory forecast rollup (§4.3).
  Activation is an atomic swap (CAS on the current active model) that materializes
  assignments from the rules.
- **`archived`** — read-only history; retained for replay/audit.

> **Correction (grade-data pass, 2026-07-06).** The original lifecycle was **delete-free**
> (archive was terminal, nothing was ever purged). A data-integrity audit found two
> consequences: (a) archived models + all descendants (territories/rules/quotas/assignments)
> accumulate forever, and (b) archived models still count against `perOrgModels:100`, so a
> tenant that repeatedly plans→activates→archives hits a **hard model wall with no recovery
> path**. Added a **purge** transition: `DELETE …/models/:modelId` (`host:territories:manage`),
> gated by `assertModelPurgeable` (409 unless stored `archived` **and** not the pointer's
> model), with a **children-first cascade** so a mid-purge failure leaves the inert model
> retryable rather than stranding unreachable orphans. Deliberately **REST-only** (no workflow
> node — a destructive admin op is not automation-appropriate). Purge does not weaken the
> delete-free FK guarantee: only a *terminal, inert* model is removable, so live
> `territoryId → Territory` refs still cannot dangle. Two related data fixes shipped the same
> pass: `bumpAssignVersion` is now CAS-guarded (was a lost-update on the active pointer), and
> the workflow-surface activate path now logs materialize failures (parity with REST).
>
> **Update (follow-ups pass, 2026-07-06).** The one remaining Blocker — CRM deal/company
> deletion orphaning assignment rows — was closed by **ADR 0283** (#1350): a `host/
> crmRecordLifecycle.ts` seam (the predicted sibling of the §4.4 visibility resolver) that
> `territories/lifecycle.ts` registers a pruner into. The same pass also (a) gave all 7
> `crm:territory-*` collections read-side `validate` guards (`entities/rowGuards.ts`; lenient by
> design so a strict guard can't hide a valid row — `TERR-DATA-5`), and (b) surfaced the purge
> as a UI action (archived-only Delete → ConfirmDialog → destructive-count toast — `TERR-UX-8`).
> The territories data layer now has no open Blockers; see `docs/DATA-ASSESSMENT-territories.md`.

This lifecycle is what makes a re-org safe to model before it bites — the single most
requested capability the deep-dive surfaced.

---

## 4. How it composes the existing app (the four seams)

### 4.1 CRM (ADR 0008 / 0208–0213) — compose, don't fork
Territories reference CRM `companyId`/`dealId` in `Assignment` rows; assignment rules match
on the real `Deal`/`Company` fields (`deals.ts:31-54`, `companies.ts:15-30`) including
`customFields` and the previously-inert `owner`. **No column is added to any CRM entity.**

### 4.2 Assignment engine
`FilterExpr` reuses a small, safe predicate grammar (field · op · value, AND/OR) — the same
shape as existing CRM filters — evaluated server-side. Rules are `priority`-ordered,
first-match-wins per model. Re-evaluation is triggered on model activation and on a
CRM-write hook (deal/company create/update) for the active model, materializing `Assignment`
rows. Preview mode runs the same engine against a `planning` model and returns a diff.

### 4.3 Reporting (concept 4 + 6) — extend `reportService`, reuse the weighting math
Add a **territory dimension** to pipeline reporting: group assigned open deals by
`territoryId`, apply the *existing* `Σ amount × stage.probability/100` weighting
(`reportService.ts:35-40`), and **roll up the parent-child hierarchy**. Attainment =
weighted (and won) pipeline for a territory's assigned deals vs its `Quota.amount`; per-rep
attainment splits on `deal.owner ∈ repSplits`. This is additive — the stage-only report is
untouched.

### 4.4 Access control (the security-sensitive seam) — a new core CRM-visibility resolver seam
> **Amended 2026-07-05 after `/architect` review (findings #1, #2).** The original draft
> said "row-level filter inside CRM reads" and "extend accessControlService" — both
> imprecise. Corrected below: the owner is a **new core resolver seam**, modeled on the
> existing `host/subjectAccess.ts` seam (**ADR 0054 D5**); accessControl only contributes the
> new scopes. This is the load-bearing section — the mechanism must be exact.

**The reconciliation that keeps us compliant with ADR 0006:** territory position governs
**visibility (which rows)**, never **authority (which scopes)**. A subject still needs a
real role (`workspace:read`) to read CRM at all — resolved from `roles[]` exactly as today.
Territory membership only **narrows the row set** a `workspace:read` grant returns. Directly
mirroring the ADR 0054 D5 precedent (`subjectAccess`: *"READ gains a membership dimension;
WRITE stays org-scoped"*): **v1 narrows READ only — WRITE stays org-scoped** (any
`workspace:write` member may edit any org deal). Territory-scoped WRITE is a deliberate
later increment.

> **Correction (Wave 2, 2026-07-05).** Territory-scoped WRITE shipped after all. Rationale:
> writing a record you cannot see is incoherent, so WRITE-narrowing *reuses the READ
> resolver* — a mutation on an existing deal/company (`PATCH` / `DELETE` / `merge`, and the
> `ctx.features.crm.moveDealStage` verb) 404s unless the caller can SEE the record (the
> `callerCanSee` helper). **CREATE stays org-scoped** (no record to scope yet; assignment
> rules place the new record). Still not a new roles vocabulary — the same row-visibility
> resolver now gates writes too. Byte-unchanged when territories is off (resolver → allow-all).
> A *more-restrictive* deviation from the ADR-0054 precedent, recorded here rather than silently.
>
> **Adjacent-verb coverage (Wave 2 security review).** Beyond direct row mutations, the same
> visibility gate covers verbs that *reach* a deal/company: a linked `dealId`/`companyId` on a
> new activity/task/deal must be visible to the caller (uniform 404, closing an existence
> oracle + a write to an unseen record's timeline — `assertLinkedVisible` / `assertLinkVisible`),
> and `convertContact` no longer projects a *matched* (pre-existing) company/deal the viewer
> can't see. **Accepted as out of scope (documented, not gated):** task PATCH/DELETE/complete
> (tasks are org-scoped, carry no territory of their own); and system runs with no
> `actingUserId` bypass scoping by design (host-authoritatively stamped at run creation +
> `:fork` — a rep can't create an unattributed run), pinned by test.

> **Visibility rule (active model only):** a subject sees a company/deal iff they are a
> member of, or manage (ancestor of), a territory the record is assigned to — **or** they
> hold an org-wide override scope (`host:territories:view-all`, granted to admins). Managers
> see their whole subtree via `parentTerritoryId` descent. Fail-closed: no territory match +
> no override ⇒ not visible.

**Enforcement — a new CORE seam, not a CRM edit and not an accessControl responsibility.**
CRM records are not Subjects, so `subjectAccess` cannot be reused directly; we add an
analogous **core** seam:

```
host/crmRecordVisibility.ts
  setCrmVisibilityResolver(fn)                                   // registered by ONE feature
  resolveCrmVisibility(subject, orgId, record) → 'none' | 'read' // default resolver = allow-all ('read')
```

- CRM's `listDeals`/`listCompanies` (`crm/entities/{deals,companies}.ts`) call
  `resolveCrmVisibility` and drop `'none'` rows. **Dependency direction: `crm → core`,
  `territories → core`** — no cross-feature import. **Default resolver returns `'read'`, so
  with the `territories` toggle OFF the CRM surface is byte-for-byte unchanged.** This closes
  the bypass finding #1 — enforcement lives on the CRM surface reps actually use, not only on
  `/territories`.
- `territories` calls `setCrmVisibilityResolver` at boot; the resolver reads the **frozen
  active-model** assignment index. accessControl contributes **only** the new
  `host:territories:manage` / `host:territories:view-all` scopes + subject resolution — it
  gains **no** row-level-ACL responsibility (finding #2).
- **Replay/fork determinism (ADR 0099):** a `registerRunStartContributor`
  (`host/runStartContext.ts`) freezes the active-model id into `run.metadata.territoryModel`
  at run creation; the resolver reads that frozen id inside a run, verbatim on `:fork` — a
  forked run never re-resolves against a newer model.
- **Single-active-model invariant:** activation is a `DurableCollection.compareAndSwap` on
  the active-model pointer + post-write re-check (the `approvalService` A7 / accessControl
  ≥1-owner precedent) — two concurrent activations cannot both win.
- **Performance:** the resolver consults an **in-memory per-`(tenant,org)` assignment index**
  (record→territoryIds + subject→territories), refreshed on activation and the CRM-write
  hook — it **never scans** the `Assignment` collection per read (protects the connection
  budget).

This preserves ADR 0006's "authority-from-roles-never-position" invariant (position affects
data scope, roles affect capability) and is the same host-side, resolver-backed ACL *class*
as `sharing` (ADR 0013) and `subjectAccess` (ADR 0054) — not a new roles vocabulary.

> **Coverage — every CRM READ path, not just the list (deep-review finding, P4).** A
> list-only filter leaks via sibling endpoints on the same data. All record-returning READ
> paths pass the viewer and are filtered: `GET …/deals` + `…/companies` (lists), `…/export`
> (CSV — a scoped rep must not export the whole org), `…/reports/pipeline` (the report's
> `aging[]` lists dealId/title), single-record `GET …/deals|companies/:id` + `…/stage-history`
> (404 when out of scope — uniform, no existence disclosure), and the `ctx.features.crm`
> workflow surface (viewer = `scope.actingUserId`, re-stamped on `:fork` ⇒ replay-safe reads).
> **WRITE paths are never filtered** (org-scoped, ADR 0054). Known residual read side-channels
> (import-dedupe existence oracle; stale materialized assignment until re-sync) are bounded,
> same-org, and self-healing — recorded, not fixed in v1.
>
> **Deliberate semantics:** (1) **No active model ⇒ org-wide visibility** (the pre-feature
> default) — territory scoping is only in force while a model is active; to lock down, keep a
> model active. (2) The `territories` toggle MUST be **tenant-all-or-nothing** (never a
> `betaCohort` split) — it is a security filter, and per-caller enablement would fail-open for
> a non-cohort caller. The resolver self-gates on toggle state accordingly.

> **PRD-vs-architecture correction.** The plan said territories are "a record-sharing
> mechanism" (Salesforce's framing, where the territory model literally grants sharing).
> Ported verbatim that would collide with ADR 0006's invariant. Reshaped: territory is a
> **row-visibility filter layered under an existing role grant**, not a role/scope grant.
> Same user-visible outcome ("reps see only their territory"), compatible with our RBAC.

---

## 5. Evaluation matrix (Step 4)

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | New `src/features/territories/` (`service`/entities + `routes.ts` + `feature.ts` + `surface.ts`); appended to `BACKEND_FEATURES` (`features/index.ts:125`) and `FRONTEND_FEATURES`. Imports CRM + accessControl (features may use core + peer services via their exported seams); core imports nothing back. |
| 2 | **Toggle + admin UI** | Toggle `territories`, **default OFF**, `bucketUnit: 'tenant'` (shared B2B surface, ADR 0015), `category: 'Business Tools'`, `salt: 'territories'`. Managed in `FeatureTogglePanel`; backend-authoritative resolution. |
| 3 | **Workflow surface (ADR 0014)** | `surface: {id:'territories', build}` → `ctx.features.territories` behind the same toggle + RBAC. Reads: `listTerritories`, `getTerritory`, `previewModel`, `territoryReport`, `attainment`. Writes: `assignRecord`, `activateModel`, `setQuota`. `tenantId` from run scope (never node args — CTI-1); `orgId` node-supplied. Advertised at `/.well-known/openwop` only when wired. |
| 4 | **Node pack** | `feature.territories.nodes` (signed via the Ed25519 + SRI registry pipeline) — sensor `territory.record.assigned`, read `territory.attainment.read` / `territory.report.read`, write `territory.model.activate` / `territory.quota.set`. Declared in `requiredPacks`; toggle variants bind node refs to slots. |
| 5 | **AI-chat envelopes** | Adds `territories.previewModel` + `territories.attainment` envelope types routed to the surface (read-oriented, so an agent can answer "how's the West region tracking to quota?"). Schema handshake via the existing envelope registry. |
| 6 | **Agent pack** | `feature.territories.agents` — one **"Territory Planner"** persona (advisory: proposes rule/quota changes and reads attainment; **dispose stays human** per roster autonomy `review`). Drives through the **single existing chat** (ADR 0058/0073), scoped to the agent — **no new chat panel.** |
| 7 | **Public surface** | **None.** Territory data is internal admin; nothing added to `PUBLIC_PATH_PREFIXES`. |
| 8 | **RBAC + isolation (ADR 0006)** | Every mutating route `authorizeOrgScope(req, {toggleId:'territories', label:'Territories'}, 'workspace:write')`; reads `workspace:read`; model activation + `view-all` override gated by a management scope `host:territories:manage`. Tenant+org IDOR-guarded on every accessor; fail-closed. The visibility filter (§4.4) is itself fail-closed. |
| 9 | **Replay / fork safety** | Territory reads inside a run reflect the **active model at run time**; if a toggle variant ever influences a run, stamp `run.metadata.featureVariant` at creation and read verbatim on `:fork` (packs decoupled from toggle state). Assignment materialization is deterministic given a model snapshot. |
| 10 | **Frontend** | `territoriesClient.ts` + `/territories` admin (model list, hierarchy tree editor, rule builder, quota grid, attainment dashboard) + `routes.tsx` (`FrontendFeature`, `featureId:'territories'`); nav via the menu registry (`GROUP_ORDER`, Business Tools group); `ui/` cohesion + tokens + a11y (`/ux-review`, `DESIGN.md`). Reuses CRM report widgets. **No map** (concept 9 deferred). |

---

## 6. RFC gate verdict (Step 5) — **Host-extension, NO new wire RFC**

The refinement flagged that "territory-as-access-control may touch the wire." Running the
review to a verdict:

- **All surfaces are host-extension** under `/v1/host/openwop-app/territories/*` and filter
  **host-extension CRM resources** (`/v1/host/openwop-app/crm/*`). The OpenWOP wire
  (run events, capability flags, agent dispatch, protocol scopes) is untouched.
- **No new scope vocabulary.** Enforcement rides the **already-Accepted RFC 0049** protocol
  scopes (`workspace:read`/`workspace:write`); territory position is a row-level filter
  *within* an existing grant, plus one host-local management scope
  (`host:territories:manage`, the `host:`-prefixed class accessControl already owns).
- **Direct precedent:** `sharing` (ADR 0013) ships host-side per-record ACL + resolvers over
  the same CRM resources and is classed **non-normative, no RFC.** Territory visibility is
  the same architectural class.
- **No new capability advertised** at `/.well-known/openwop`; the workflow surface uses the
  existing feature-surface advertisement mechanism (ADR 0014).

**Verdict:** ships entirely as host work. The only conditions that *would* trip the gate —
a **new protocol scope**, a change to **run-level auth semantics**, or advertising a **new
wire capability** — are explicitly not required. If a future phase (e.g. cross-host
territory-scoped dispatch) needed any of those, *that* increment would gate on an Accepted
`openwop` RFC via `/prd`; v1 does not.

---

## 7. Phased plan

| Phase | Scope | Surface |
|---|---|---|
| **P1 — Model + hierarchy** | Types/Models/Territories collections; parent-child + acyclic validation; Planning/Active/Archived lifecycle + atomic activation (one active per org); REST + RBAC gating. | REST |
| **P2 — Assignment engine** | `FilterExpr` grammar; rule CRUD; materialization on activation + CRM-write hook; **preview/dry-run diff** against a planning model. | REST |
| **P3 — Quotas + attainment** | Per-territory `Quota` + per-rep `repSplits`; extend `reportService` with a territory dimension + hierarchy rollup, reusing the weighted-pipeline math; attainment dashboard data. | REST |
| **P4 — Territory-scoped visibility** | Extend accessControl enforcement: row-level filter on `listDeals`/`listCompanies`/territory reports from active-model assignments; `host:territories:view-all` admin override; fail-closed. **The security-sensitive phase — pair with `/code-review` + `/nfr`.** | CRM reads |
| **P5 — Core-app extension surface** | `ctx.features.territories` surface (ADR 0014); `feature.territories.nodes` signed pack; envelopes; `Territory Planner` agent pack driven through the existing chat; `/.well-known` advert. | Workflow/AI |
| **P6 — Frontend** | `/territories` admin + planning UI (hierarchy editor, rule builder, quota grid, attainment dashboard); nav registration; `ui/` + a11y. | SPA |

Deferred follow-on ADRs (recorded, not cut): **geographic maps** (needs a frontend map lib
decision — concept 9), **rep commissions** on deals (concept 5), **dealer/outlet + PRM**
(concepts 7/8).

---

## 8. Alternatives weighed

1. **Territory as a pure tag/reporting dimension (no visibility).** Simplest, fully
   host-internal, no new ACL. **Rejected for v1** per the product decision — it would leave
   the single most differentiating capability (safe re-org + "reps see only their turf")
   on the table. Retained as the P1–P3 substrate, so we can ship value before P4 lands.
2. **Make a territory an accessControl `Team`.** Teams are flat grant-groupings, not a
   parent-child hierarchy with assignment rules + quotas + lifecycle. Overloading Team
   would fork its semantics. **Rejected** — territories reference members, don't become them.
3. **Reuse the agent org-chart store for the hierarchy.** Agents-only, authority-forbidden,
   tenant-scoped-not-org-scoped (RFC 0087 §B). **Rejected** — wrong owner; reuse only the
   acyclic-validation pattern.
4. **A new `rbac`-style roles vocabulary for territory access.** Directly violates ADR 0006
   (single accessControl owner; authority-from-roles). **Rejected** — visibility is a
   row filter under an existing role, not a new role.
5. **Grant territory sharing exactly like Salesforce (position → sharing rule).** Ported
   verbatim it makes position confer capability. **Reshaped** (§4.4) to position→visibility,
   role→authority.

---

## 9. Open questions

- **Assignment conflict policy** beyond first-match-wins: should a record be assignable to
  **multiple** territories of *different* types (e.g. Geographic *and* Named-Account)
  simultaneously? Salesforce allows multi-type assignment. Proposed v1: one assignment per
  `(model, target-record, territoryType)`; revisit if named-account overlap is needed.
- **Visibility performance:** the row-level filter adds an active-model assignment lookup to
  every CRM list. Proposed: an in-memory per-`(tenant,org)` assignment index refreshed on
  activation/write. Validate against the connection-budget / rate-limit fan-out concern
  ([[db-connection-budget]]) before P4.
- **`deal.owner` trust:** per-rep quota splits key on the opaque `owner` subject id, which is
  today unvalidated. Should activation validate that split `subjectId`s are actual org
  members? Proposed: yes, warn-not-block in planning, enforce on activate.
- **Does an agent (workflow run) get territory-filtered reads?** Proposed: yes — a run
  reflects the running subject's territory visibility; an unattributed system run uses the
  `view-all` override. Confirm against replay expectations.

---

## 10. PRD-vs-architecture corrections (summary)

1. **"Territory is a record-sharing mechanism"** → reshaped to **row-visibility filter under
   an existing role grant** (not a role/scope grant), to honor ADR 0006's
   authority-from-roles invariant while delivering the same user outcome (§4.4).
2. **"Sales goals"** → named **`quotas`**; `goals` is a taken feature id + route + RFC 0097.
3. **Territory hierarchy** → **new org-scoped store reusing the acyclic-validation pattern**,
   not the agent org-chart (agents-only, authority-forbidden) nor an accessControl Team.
4. **Reps** → **references to existing accessControl members**, not a net-new people store.
5. **Maps ("dynamic sales maps")** → **deferred**; a territory here is rule-defined, not
   map-drawn (no frontend map lib today).

---

## 11. Implementation (PR #1312)

All six phases shipped, each `/architect`-checked before, `/code-review`d after (a
deep adversarial security review for P4), with review findings fixed before the next
phase. 15 backend territories tests + 33 CRM regression tests + the frontend build gate
are green.

| Phase | Scope | Review outcome |
|---|---|---|
| P1 | Type→Model→Territory + acyclic hierarchy + Planning/Active/Archived (single-active CAS) | HIGH fixed: "active" derived from the pointer (no stored-state drift) |
| P2 | Filter-based assignment engine + materialize + preview | 2 MEDIUM fixed: `customFields.__proto__` match-all escape; silent materialize error |
| P3 | Per-territory + per-rep quotas + attainment (weighted, rolled up) | MEDIUM fixed: rep-split rollup (byOwner merged through the hierarchy) |
| P4 | Territory-scoped CRM visibility via the core `crmRecordVisibility` seam | **CRITICAL + HIGH fixed**: CSV export, pipeline report, single-get, `ctx.features.crm` surface all leaked hidden records — every CRM read path now filtered |
| P5 | `ctx.features.territories` read surface + signed node/agent packs (advisory Territory Planner) | read-only surface; writes stay human-gated (ADR 0208 §2 stance) |
| P6 | Territories admin SPA (models, hierarchy, coverage preview, attainment + quotas) | ux-review: 2 HIGH fixed (confirm dialogs, infinite-skeleton error state) + double-submit guards + tabular numbers |

**Recorded follow-ons (not cut):** territory-scoped WRITE, per-viewer attainment
scoping, a rich drag/rule-builder editor, and the concepts deferred at authoring time
(geo maps, rep commissions, dealer/PRM).

---

## 12. Follow-on waves (post-merge hardening)

After the initial P1–P6 ship, the recorded follow-ons were worked in waves, each
`/architect`-checked before and `/code-review`d after (adversarial for the security ones),
fixes applied before moving on:

| Wave | Item | Outcome |
|---|---|---|
| 1 · A1 | Assignment index (perf) | Per-(tenant,org) cache keyed by (activeModel, durable `assignVersion`) + bounded + TTL. Review HIGH fixed: `visibleTerritoryIds` dropped a manager-who-is-also-a-member's subtree; + member-rolled leak + cache bounding. |
| 1 · A2 | Per-viewer attainment | A rep sees only their territories' attainment (manager: subtree; admin: org); no org-wide `unassigned` leak; member-only rows show `direct` not `rolled`. |
| 1 · A3 | run.metadata model freeze | **Closed — won't-do (architect gate, Wave B).** Replayed runs read RECORDED outputs, not live CRM re-queries, so the visibility filter's model-dependence never enters replay; and the viewer (`scope.actingUserId`) is already re-stamped on `:fork`. A new `BundleScope` field + contributor isn't warranted for a theoretical edge the recorded-output model already avoids. |
| 2 · A4 | Territory-scoped WRITE | Reuses the read resolver — mutations on an existing deal/company (PATCH/DELETE/merge/move + linked activity/task/deal-create) 404 out of scope. Review MEDIUMs fixed: `convertContact` match-oracle + linked-record oracle/unseen-timeline write. CREATE + org-scoped tasks + system runs are documented out-of-scope (§4.4). |
| 3 · A6 | Rule-builder UI | A planning model's assignment rules are now created from the UI (single-condition builder + readable rule list) — closes the v1 "rules are API-only" gap. |
| 3 · A5 | Territory WRITE nodes | **Shipped (Wave B).** Correcting the earlier "scope-bypass" worry: the surface CAN enforce the scope. `ctx.features.territories.activateModel` / `setQuota` resolve the RUN OWNER's (`scope.actingUserId`) effective access and require `host:territories:manage` / `workspace:write` respectively; a system run (no acting user) is denied fail-closed. Two `side-effectful` write nodes (`activate-model`, `set-quota`) at pack v1.1.0, kept OUT of the advisory agent's allowlist so they ride an approval-gated chain (ADR 0208 §2). Test: `territories-surface-writes.test.ts` (editor/system-run denied activate; owner allowed; viewer denied quota). |

**Wave 4 (net-new feature-packages) — separate ADRs, not this one:** rep **commissions**
(concept 5; extends quotas/attainment, reuses the `commerce/affiliate` accrual pattern),
**dealer/outlet + PRM** (concepts 7/8), and **dynamic geographic maps** (concept 9; gated on
a CSP-safe map-library decision — no external tile CDN). Each is its own
`/feature-refinement → /architect → /plan → build → review` cycle and its own PR.
