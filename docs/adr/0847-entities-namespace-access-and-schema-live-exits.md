# ADR 0847 — Entities: project-namespace access on every lane, and delivery that follows the schema

Status: implemented (2026-10-07, branch `feat/fl2-29-entities`; `/architect` pass before code, then grade-ux and grade-code — see the correction notes and the implementation record)

Feature loop round 2, row 29 (Entities, the headless content model). Extends ADR 0386
(entities), ADR 0407 (public delivery), ADR 0731 (session RBAC) and ADR 0795 (key-issuer
narrowing). Composes ADR 0054 D5 (project visibility: the `subjectAccess` seam), ADR 0839
D2 (`registerSubjectDependent`) and ADR 0832 (`orgScopeSubject`, narrow-only). No new
feature, toggle, pack, route or wire field. Host-extension only, so no RFC.

## Context

The row-29 `/grade-workflows` pass (`WORKFLOWS-ASSESSMENT.md` § Entities row 29,
`ENT2WF-*`) followed the entities data through all five lanes that reach it: the session
routes, the `owk_` API-key routes, the anonymous `public-entities` delivery, the workflow
surface (`ctx.features.entities`) and the two chat tools. Three holes were runtime-witnessed
RED on `origin/main` `c4d4dfa20` before any fix.

The store keys every type, taxonomy and relationship by a **namespace**:
`${tenantId}:${projectId}:${name}` (`entitiesService.ts:179`), where `projectId` is `''` for
the workspace root or an ADR 0046 project id. A project has its own read visibility
(ADR 0054 D5: `org` or `private`). Every entities lane checks only the tenant.

| # | Hole | Lanes | Evidence |
|---|---|---|---|
| H1 | A PRIVATE project's namespace is readable by any `workspace:read` member who is not a project member, and writable by a `workspace:write` member of a DIFFERENT org in the same workspace. `GET /types` with no `projectId` lists every namespace's types, private ones included. | routes, key, surface, chat tools | `common.ts:28-35` checks only that the project exists, and only on create. `entitiesService.ts:262-266`. `surface.ts:93-100`. `agentTools.ts:68,134`. `routes.ts:115-158`. |
| H2 | Deleting a project orphans its namespace. Types, rows, taxonomies, terms, relationships and the ref/term indexes survive. A `publicRead` type keeps being served anonymously for a project that no longer exists. | public delivery, all reads | Entities is not a `registerSubjectDependent('project', …)` registrant. Canvases, documents, priority lists and the team ledger are. |
| H3 | A schema change does not change what is served. `updateEntityType` rebuilds `fields` and never touches rows. Every read exit returns stored `values` verbatim. A REMOVED field's value keeps reaching anonymous readers, keys, runs and the model. A field whose kind changed serves the old-kind value. | every read exit | `entitiesService.ts:305-310` (no row work). `toPublicEntity` `:932-934`. `getEntity`, `listEntities`, `queryEntities`, `exportEntities`. `surface.ts:47`. `agentTools.ts:149`. |

H3 is the competitive gap as well as a leak. Every headless CMS benchmarked in
`docs/research/deep-research-cms.md` treats a removed field as gone from delivery. Contentful
first marks it "omitted from the API", then deletes it. Strapi and Sanity serve only the
fields the current schema declares. An admin removes a field precisely to stop publishing it.

Also found: `ENT2WF-4`. The chat tools check the toggle and the acting user but never
`workspace:read`, so they do not share the routes' predicate (a CLAUDE.md non-negotiable).
And `ENT2WF-5`. `EntityTypeRecord.status` claims "`published` gates … write nodes"
(`entitiesService.ts:62-63`). The surface writes draft types freely, and in-app authoring on
drafts is intended. The claim is wrong, not the code.

## Boundaries audit

- **Project visibility has ONE owner:** `resolveProjectAccess` / `levelFor`
  (`projectsService.ts:438-465`), exposed as `resolveSubjectAccess(tenant, {kind:'project'},
  caller)` (`host/subjectAccess.ts`). READ = `workspace:write` in the project's org, OR
  (`org`-visible AND `workspace:read` there), OR (`private` AND people-member). WRITE =
  `workspace:write` in the project's org. An absent caller is `'none'`. Entities composes it
  and never re-derives it (row 26's `listAccess.ts` precedent).
- **Project-delete cascade has ONE seam:** `registerSubjectDependent` (ADR 0839 D2). It runs
  BEFORE the project row is deleted and propagates failure.
- **Tenant-level authority stays where ADR 0731 put it:** `resolveTenantLevelScopes` +
  act-as `narrowToCaller` (`routes.ts:180-186`). This ADR adds a project narrowing on top. It
  never replaces the tenant check.
- **Façade rows are out of scope.** System types (`cms.page`, `crm.*`, `commerce.product`,
  tutorials, kicktodo, job-search, service-desk) always live in the ROOT namespace
  (`mintSystemType` → `typeKeyOf(tenant, undefined, …)`, `:634`). Their schemas are
  code-owned and every put re-validates the scalars. Neither decision changes a façade's
  read or write path. ADRs 0836/0837/0838 rely on `putSystemEntity`, `casSystemEntity`,
  `getSystemEntity` and `listSystemEntities`, and those are not touched.

## Decision

### D1 — One namespace-access rule, called by every lane

A new module `features/entities/namespaceAccess.ts` exports the rule:

```
namespaceAllows(tenantId, projectId, subject | undefined, need: 'read' | 'write'): Promise<boolean>
```

- `projectId` empty (the root namespace) → `true`. The root namespace is governed by the
  tenant-level tier the caller already passed. This ADR does not change it.
- `projectId` set → `resolveSubjectAccess(tenantId, projectSubject(projectId), subject)` must
  satisfy `need`. A missing or deleted project → `'none'`. An absent subject → `'none'`.
- `'admin'` (type/taxonomy/relationship authoring) requires the tenant-level
  `host:members:manage` the route already checks, AND `need: 'write'` on the project. Project
  membership never grants authoring.

Every lane calls it:

| Lane | Subject | Applied where |
|---|---|---|
| Session routes | `userId ?? principalId` (the ADR 0731 subject) | inside `requireEntitiesScope`, whenever a `projectId` is present, after the tenant-level check |
| API-key routes | `key.createdBy` (the ISSUER, the ADR 0795 posture: a key may not reach what its issuer cannot) | the same place, key branch |
| List routes (`GET /types`, `/taxonomies`, `/relationships`) with no `projectId` | as above | filter out rows whose namespace the caller cannot read |
| Workflow surface | `scope.actingUserId ?? scope.orgScopeSubject` | every verb. An actor ALSO needs the tenant-level `workspace:read` / `workspace:write` ("a run is limited to its starter's access"). An actorless run stays tenant-trusted in the root namespace (event-binding automation, the row-26 posture) and is refused in a project namespace. |
| Chat tools | `scope.actingUserId` (absent → fail empty, as today) | both tools: tenant-level `workspace:read` (closes `ENT2WF-4`) + the namespace rule, and `describe-type` lists only readable namespaces |
| Public delivery | — | refuses a project namespace whose project no longer exists (D2 removes the rows; this is the read-side guard for the window, and for any row that predates D2) |

A refused read is a 404, indistinguishable from absence. A refused write is a 404 when the
caller cannot read the namespace either, and a 403 when they can read but not write. This is
the project feature's own split.

**Terms stay in their namespace** *(review A2)*. A term id encodes
`tenant:project:taxonomy:slug`. Validation was tenant-wide (`validateTermIds`, `:428-442`), so
a root-namespace entity (possibly public) could carry a private project's term, publishing its
project id, taxonomy and slug, and term validation was an existence oracle. From now on a
term must belong to a taxonomy in the entity's own namespace (create, update, import), and a
`termId` query filter must name a term in the queried type's namespace.

**Subjects, precisely** *(review A3/A4/A5)*. Under act-as (`X-Act-As`), the rule must allow
BOTH the caller and the acting member (ADR 0797 narrowing: the acting member's subject comes
from `getMember`, same tenant). The surface and the chat tools take their tenant-level tier
from `resolveTenantLevelScopes` (the same resolver as the routes, so the ADR 0372
single-principal exit keeps anon sandboxes working). The narrowing subject is
`actingUserId ?? orgScopeSubject`. `requireEntitiesScope` derives `projectId` from
`projectOf(req)` on EVERY route, because taxonomy, term and relationship routes carry it in
the query or body without `opts.type`.

**Public delivery of a private project's public type** *(review A6)* stays allowed. A type
admin who holds write on the project opted in explicitly. `gatePublicType` refuses a project
namespace whose project no longer exists.

### D2 — Entities is a project dependent

`feature.ts` registers `registerSubjectDependent('project', 'entities', { count, purge })`.
`purge` calls a new `purgeEntityNamespace(tenantId, projectId)` in `entitiesService.ts`. It
deletes every row in each of the namespace's types (with indexes and counter), then the
types, relationships, taxonomies and terms. Restrict policies do not apply. Reference fields
resolve only inside one namespace (`referenceResolverFor`, `:419-425`), so nothing outside
the namespace can point in. The purge also strips the purged term ids from rows in OTHER
namespaces that carried them before A2's rule existed (found via `entity:term-idx`, CAS
update), so no dangling term id survives *(review A2)*. The purge is idempotent, so a retry
converges. `count` reports
types + rows, so the project's delete-preview (`GET /projects/:id/dependents`) shows what
will go.

### D3 — Delivery follows the schema (non-destructive)

One function, `liveValues(type, values)`, projects stored values through the type's CURRENT
`fields`. It drops a key the schema no longer declares. It also drops a value whose shape no
longer matches its field's current kind: number, boolean, `YYYY-MM-DD` date, enum ∈
options, or a string for string/reference/media. Overlays get the same treatment: only
current `localizable` string fields survive, and an empty overlay is dropped.

It is applied **inside the service functions that hand a user-type row to a caller**:
`getEntity`, `listEntities`, `queryEntities` (before filter and sort), `exportEntities`, and
the RETURN values of `createEntity` (including the idempotent re-create that returns the
prior row) and `updateEntity` *(review A1)*. Every exit (public delivery,
the content-section prerender resolvers, keys, session, surface, chat tools, BI's user-type
metrics) is downstream of those four, so it inherits the projection without a per-exit
copy. Guard at the exit, and here the service read IS the exit every lane shares.

**Storage is never rewritten by a schema change.** A removed field's value stays in the row
and stops being served. Re-adding the field (same key, compatible kind) brings it back. This
is the Contentful "omitted" stage made permanent. It is chosen over a destructive purge
because a schema edit is one click and data loss should not be. `updateEntity` keeps hidden
values in storage for the same reason: it merges onto the stored map, not onto the
projection. Export is a delivery exit, so it serves the live projection. A full raw dump is
not a feature this ADR adds.

System types skip the projection. Their schemas are code-owned, every put re-validates, and
the façades' read paths are out of scope (Boundaries).

### D4 — Correct the `status` claim (`ENT2WF-5`)

The `EntityTypeRecord.status` doc comment says what the code does. `published` gates the
API-key lane (the publish gate, `routes.ts:149-156`) and public delivery (`gatePublicType`).
Session authoring, workflows and chat read and write drafts.

### Residual, recorded not changed (`ENT2WF-6`)

A delete by a caller scoped to one type (an `entities:foo:write` key, a run) cascades or
set-nulls rows of other types that the type admin wired with a `cascade`/`set-null`
relationship. That is admin-declared policy, and the referrers live in the same namespace
the caller was admitted to. Refusing it would make a declared cascade depend on who
triggered it.

## Architect review (pre-code, 2026-10-07)

`/architect` (Track A) over the decision text, before any code. Each finding was checked
against the code, not the prose.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| A1 | **Blocker** | D3 named only the four READ functions. `createEntity` returns the raw `prior` on an idempotent re-create (`:528-531`), and `updateEntity` returns `next`, which merges hidden values (`:1035,1059`). POST, PATCH, the surface and the import response would still hand removed-field values to writers: keys, runs, the model. | D3 now covers every function that returns a user-type row, with a ratchet: no exported service function returns a raw user-type `EntityRecord`. |
| A2 | **Blocker** | Terms cross namespaces. `validateTermIds` is tenant-wide, and the term id encodes the private project id, taxonomy and slug. A public root-namespace entity could publish them. D2's purge would leave dangling ids on rows elsewhere. | Same-namespace term rule (D1) + purge strips referrers (D2). |
| A3 | **Blocker** | Act-as. D1's table named only the caller. ADR 0797 makes act-as the INTERSECTION, so a caller acting as a non-member would have read the private namespace through their own membership, or the reverse. | Both subjects must pass. |
| A4 | High | The surface and tools would have needed a tenant-level resolver. `resolveEffectiveAccess({subject, orgId})` lacks the ADR 0372 single-principal exit, so every anon-sandbox workflow would have lost entities. | Use `resolveTenantLevelScopes`, the routes' own resolver. |
| A5 | High | `requireEntitiesScope` sees a project only through `opts.type`. The taxonomy, term and relationship routes pass none, so the rule would never have fired there. | Derive from `projectOf(req)` on every route. |
| A6 | Medium | Public delivery of a `publicRead` type inside a private project was undecided. | Decided: allowed (explicit admin opt-in); a vanished project's namespace is refused. |
| A7 | Medium | Namespaces orphaned BEFORE D2 stay in storage. | After D1 every lane 404s them (missing project → `'none'`, public gate refuses). They are garbage until tenant teardown. Prod reach is unmeasured (gcloud auth expired), so no one-off sweep is proposed blind. |
| A8 | Low | `liveValues` cannot tell that a `reference` field was retargeted to another type. The value is still a string. | Residual. `planDelete`'s liveness check already ignores such markers. |
| A9 | Low | The `entity-written` webhook payload names a private namespace's `typeName` to tenant webhook subscribers. | Residual. The payload carries ids only and the subscription is admin-configured. |

Façade ripple was checked. Every system type lives in the root namespace (`:634`). D1 returns
`true` there, and D3 skips system types. `erasure.ts` reads and writes raw rows through its own
collection handle, so the projection cannot make erasure drop hidden values. `kernelAdapter`
consumers use the system-row API only. BI's user-type metrics go through `queryEntities` and
inherit the projection, which is intended.

## Alternatives weighed

- **Make project namespaces tenant-wide by design (document, don't gate).** Rejected. The
  project owns visibility, every other project-bound feature honours it (rows 24–27), and the
  namespace is reachable from runs and the model.
- **Destructive field removal (purge values on schema change).** Rejected for D3. It loses
  data on a one-click edit, it cannot be undone, and it would need a migration job over up to
  10k rows per type inside a request. The projection gives the same delivery guarantee with
  no data loss.
- **Project at each exit (`toPublicEntity`, surface, tools).** Rejected. Six copies of one
  rule is how this class keeps reopening (row 28's lesson). The service read is the shared
  exit.
- **Gate the actorless run on project namespaces as tenant-trusted.** Rejected. A project
  namespace has a visibility rule that nobody can be checked against, and fail-closed is the
  seam's own posture (`subjectAccess.ts`, ADR 0839 D1).

## User-visible behaviour changes (product decisions for the user)

1. A non-member viewer no longer sees a private project's entity types or rows. A member of
   another org can no longer write them.
2. Deleting a project deletes its entities namespace, and the delete preview counts it.
3. Removing a field from a type, or changing its kind, stops that field's stored values
   being served everywhere: public API, keys, export, workflows, chat. Re-adding it restores
   them.
4. A workflow started by a person can no longer read or write entities that person could
   not read or write in the app.

## Phased plan

| Phase | Scope |
|---|---|
| P1 | `namespaceAccess.ts` + routes (session + key + list filtering) + surface + chat tools; the D4 comment |
| P2 | `purgeEntityNamespace` + the project-dependent registration; public delivery refuses a vanished project |
| P3 | `liveValues` in the four service reads |
| P4 | Regression suite (the RED probe legs + every lane), sabotage witness per guard, lane ratchet (every surface verb and tool is classified) |
| P5 | grade-ux / grade-code over the result; UX fixes recorded in this ADR's correction notes |

## Open questions

- [ ] Should a type admin get a one-click "purge hidden values" action (Contentful's
  second stage)? Deferred. The UX pass decides whether the removal dialog says what happens
  to stored values.
- [ ] `orgScopeSubject` on an actorless run narrows the project rule. Confirm that no
  shipped binding (an `entity-written` trigger) depends on reaching a private namespace with
  no actor. None exist today (the grade found zero chains consuming the entities pack's
  project arg).

## RFC verdict

Host-extension only (`/v1/host/openwop-app/entities/*`, `public-entities/*`, the in-process
surface). No wire field, capability or event changes. No RFC.

## Correction notes (implementation, 2026-10-07)

- **Event-binding runs are not actorless.** D1 said an actorless run stays tenant-trusted in the
  root namespace and named "an `entity-written` binding" as the example. That premise is wrong.
  `hostEventDispatcher` stamps the binding's author as `orgScopeSubject`
  (`host/hostEventDispatcher.ts`, ADR 0832 D3), and the rule narrows to it. So a binding run reads
  and writes only what its author's tenant tier allows. Only a run with neither `actingUserId` nor
  `orgScopeSubject` is tenant-trusted (a raw webhook, a feature job that stamps no actor). This
  matches ADR 0832's narrow-only posture. It does change behaviour for a binding authored by a member
  without `workspace:write`.
- **The gate and the service read different namespaces (grade-code `ENT3CD-1`, a D1 bypass the ADR
  text did not foresee).**
  - Four authoring routes handed the service `body.projectId`, while the gate read `projectOf(req)`,
    which prefers the query string.
  - With an empty `?projectId=`, the gate saw the root while the type was created in the body's
    project.
  - Fixed: `projectOf` treats an empty value as absent, and every route passes the value the gate
    checked.
- **D3 also filters term ids (grade-code `ENT3CD-2`).** A row written before the same-namespace
  rule can still carry another namespace's term. `liveRow` drops it from every exit with a pure
  prefix check, because a term id encodes its namespace. The next save drops it from storage too.
- **The `/entities` page is workspace-root only (grade-code `ENT3CD-4`).** It listed every
  namespace's types and taxonomies but made only root-scoped calls, so editing a project type that
  shared a root type's name rewrote the root type. Project namespaces are reached through the API,
  the surface and the chat tools.
- **UX decisions made in the same PR.** These are product decisions, recorded here:
  - an Edit-fields mode, whose removal / kind-change / lost-enum-option confirm states D3's
    hide-not-delete rule;
  - a server-computed `viewer {canWrite, canManageTypes}` on `GET /types`, which hides every control
    the viewer cannot use;
  - a confirm before making a type public, and the public delivery address shown once it is public;
  - error-first states for every sub-read.

## Implementation record

| Decision | Where | Witness |
|---|---|---|
| D1 namespace rule | `features/entities/namespaceAccess.ts`; `routes.ts` (`requireEntitiesScope`, `requireNamespace`, list filters, `projectOf`); `surface.ts` (every verb); `agentTools.ts` (both tools); `publicRead.ts` (vanished project) | `test/adr0847-entities-namespace-and-schema-exits.test.ts` — session, key-issuer, act-as, sub-org, surface (person / system / no-write), chat tools, taxonomy routes, gate-vs-service |
| D1 terms in namespace | `entitiesService.ts` `validateTermIds`, `queryEntities`, `liveRow`; `taxonomyService.ts` `termNamespace` | same file, A2 legs (refusal, foreign termId query, legacy membership not served) |
| D2 project dependent | `feature.ts` registration; `entitiesService.ts` `countEntityNamespace` / `purgeEntityNamespace`; `taxonomyService.ts` namespace purge; projects delete-preview label | same file, D2 legs; `test/adr0839-projects-delete-dependents.test.ts` (dependent list) |
| D3 schema-live | `entitiesService.ts` `liveProjector` in the four reads + create/update returns | same file, D3 legs (public list + one, get/list/query/export, PATCH + idempotent create, surface + tool, re-add restores, overlays) |
| D4 claim | `entitiesService.ts` `EntityTypeRecord.status` comment | — |
| UX | `frontend/react/src/features/entities/{EntitiesPage,TaxonomyPanel,entitiesClient}.tsx`; `GET /types` `viewer` | `__tests__/entitiesPageUx.test.tsx` (12), backend viewer leg |

There are 22 backend guards and 8 UI guards, and each was sabotage-witnessed red with a named
assertion. The first sweep found one guard vacuous: the foreign-termId query leg passed without its
guard, because no row carried the term. The leg now seeds a legacy row, and it fails when the guard
is removed.

Residuals: `ENT2WF-6` (cascade across types by a type-scoped caller) and `ENT3CD-7..10` (reference/media
shape, purge-vs-writer race, one event per purged row, O(rows) preview), filed in
`CODEBASE-ASSESSMENT.md` § Entities row 29. Prod reach is unmeasured (gcloud auth expired). Namespaces
orphaned before D2 are now unreachable on every lane, but no sweep has removed them.

