# ADR 1160 — A canvas belongs to one workspace (org), and every lane checks it

Status: Accepted (2026-11-25, the user: "ADR, then build"). P0 implemented
(#6260); P1 in progress; see the phased plan.

A canvas gets an `orgId`, stamped when it is created. The shared read and write
predicates in `host/canvasSurface.ts` check the caller's access in THAT org, and
every lane that reads, writes, lists, deletes, shares, presents or runs against a
canvas goes through them. Host-extension only: no RFC (see "The wire").

## Context

A canvas row (`host/canvasSurface.ts:66-80`) is keyed by tenant and canvas id and
has no org. Routes authorize the PATH org (`authorizeOrgScope` on
`/orgs/:orgId`), and nothing ties that org to the canvas. A canvas with no
`ownerSubject` passes `canvasReadAllowed` and `canvasWriteAllowed`
unconditionally (`:297-326`, "the org gate is the whole rule"). So in a tenant
with two orgs, a member with `workspace:write` in org B can, through org B's
paths:

- list org A's canvases (Documents `canvas-sources`, `documents/routes.ts:110`);
- open, save, restore and delete them in every type's editor
  (`canvasEditorRoutes.ts` `loadCanvas`, `:215-238`, and verbs `:363-446`);
- delete them from Documents (`documents/routes.ts:135`);
- copy them into an org-B document (`documents/from-canvas`), comment on them,
  share them, present them and run agent tools against them.

CasaVoga, a white-label adopter, reported the list-and-delete half for its
mood-board studio canvases (CV-0215, amendment 26). A read on `32fa84dba`
confirmed the rest.

**This was ruled deliberate, twice, and then reopened.**

- ADR 0405 M8 (security scan): "canvases are tenant-scoped … the `:orgId` path
  segment is a routing artifact … If org-private canvases become a product
  requirement, that's a separate feature + ADR adding `orgId` + scoping".
- The 2026-07 code and data assessments: "`:orgId` is RBAC context, not a data
  filter".
- ADR 0886 OQ-1 reopened it as a gap with production data. On 2026-10-13 all 7
  production canvases were org-owned and one tenant had 2 orgs. It was handed to
  feature-loop row 99 (canvas chassis), which is still PENDING.

This is that ADR. Workspace-scoped canvases are now the requirement: an adopter
sells one tenant per firm with one org per workspace, and a studio board must not
be visible or deletable from another workspace. ADR 0886 OQ-5 (a user-owned deck
is writable by anyone with tenant write) is a different rule. It stays open here
(see "Not in this ADR").

## Decision

### D1 — `orgId` on the canvas, stamped at create

`Canvas` gains `orgId?: string`. The tenant-index marker projection (`:106`) and
`CanvasListRow` carry it, so a list filters without loading full rows.

- `createCanvasForTenant` and `ensureCanvasForTenant` take `orgId` as a NAMED
  argument that every caller must pass: a string, or `null` with a reason
  (`{ orgId: null, why: 'system:<reason>' }`). The type has no default, so a new
  create lane cannot forget it.
- **Lanes that know an org stamp it:**
  - blank create and from-artifact, from the path org;
  - the cad and slides imports, from the path org;
  - the agent-tool renders, from the resolved `gate.orgId`;
  - a feature binding, for example CasaVoga's `studioBinding`, which passes its
    org explicitly.
- **A project-owned canvas takes its project's org.** `assertOwnerResolves`
  already requires the project to be in the path org; it now also checks that
  `orgId` equals `project.orgId`.
- **Lanes with no org stamp `null` with a reason**, and the canvas stays
  tenant-shared, as every canvas is today:
  - the run lanes (`ctx.canvas.create`, the MCP create-project and render-design
    nodes), because `BundleScope` has no org;
  - the ui-plugin fixture and demo artifact;
  - the demo seeder.

  D6 covers how a run lane could gain an org.
> **Correction (P0, #6260):** the argument is optional in the TYPE, and
> `test/adr1160-canvas-create-org-ratchet.test.ts` makes it required at every
> call in `src/`. It requires `orgId` at each call, an `orgWhy: 'system:…'` with
> every `null`, and pins the calls per file. Requiring it in the type would have
> touched about 218 test call sites, because the backend `tsc` includes
> `test/`. Adopter features add their create lanes through `ratchetTables.json`
> (`adr1160.create`).

- **Idempotency keys gain the org.** `from-artifact:<artifactKey>`
  (`canvasFromArtifact.ts:72-74`) and `blank:<key>` (`canvasEditorRoutes.ts:290`)
  are tenant-wide today, so two orgs that materialize the same artifact get ONE
  canvas. The key becomes `<orgId>:` plus the old key. An org-less create keeps
  the old key.

### D2 — ONE read and ONE write predicate, decided in the canvas's org

`canvasReadAllowed(tenantId, canvas, caller)` and `canvasWriteAllowed` gain an
org rule, before the existing owner rule:

- `canvas.orgId` unset: unchanged. It is tenant-shared, and the owner rule
  decides.
- `canvas.orgId` set and `caller.preAuthorized`: allowed. System lanes, as today.
- `canvas.orgId` set and no subject: refused.
- Otherwise `resolveEffectiveAccess(tenantId, { subject, orgId: canvas.orgId })`
  must hold `workspace:read`, or `workspace:write` for writes. Then the existing
  owner rule applies.

The org rule is decided in the canvas's OWN org, never the path org. This is the
ADR 0886 D1 pattern: a write is decided where the thing lives. The result is
memoized per request on `(subject, orgId, need)`.

> **Correction (P1):** "no subject: refused" stands, but a lane with no person
> can say it acts for the tenant. A run fired by a schedule or webhook, or the
> app-builder surface's inbound sync, keeps the reach it had by passing
> `orgSystemLane: 'system:<reason>'` (`CanvasCaller`). It is spelled at the
> call site, so an OMITTED subject still fails closed. This is the
> `subjectAccess` rule for an omitted caller. Without it, every scheduled run
> against a canvas stamped after P0 would have broken.

**A path org that differs from the canvas's org is a uniform 404** on every
`/orgs/:orgId/…/canvases/:canvasId` route, even for a caller who belongs to both
orgs. Then the editor's `access` signal (computed in the path org,
`canvasEditorRoutes.ts:369`) and the canvas's real home cannot disagree, and a URL
never edits a canvas "through" another workspace. `loadCanvas` takes the path org
as a REQUIRED argument and checks it, so every editor verb and every
`extraRoutes` registrant gets it.

> **Addition (P1):** every editor link an agent tool or MCP node hands back
> names the org (`canvasEditorLink`, `?org=`). It uses the canvas's stamped org,
> or the lane's org for a tenant-shared canvas. Without it, a person in several
> orgs following an agent's link gets the editor's org picker, where a wrong
> pick is now a 404.

**Lists:** `listCanvasesForCaller(tenantId, caller, { orgId })` returns the
canvases whose `orgId` is the given org, plus tenant-shared ones (unset `orgId`)
that pass the owner rule. Documents `canvas-sources` passes the path org.

### D3 — every lane, with its treatment, held by a ratchet

The inventory below comes from a read of `origin/main` `32fa84dba`; file:line refs
are there. Each lane gets one treatment:

- **P (predicate):** it already goes through `canvasReadAllowed` /
  `canvasWriteAllowed` / `getCanvasForCaller` / `getCanvasForWriter` /
  `assertCanvasRunAccess`, so it inherits D2 with no code change beyond passing
  the org where one exists.
- **F (fix):** it bypasses or weakens the predicate today, and is changed.
- **S (system):** it stays tenant-wide on purpose, with a reason.

| Lane | Today | Treatment |
|---|---|---|
| Editor `loadCanvas` and every verb (GET, PATCH, DELETE, versions, restore, present-remote) and the app-builder, cad, slides, films and document-editor extras | `canvasReadAllowed`/`WriteAllowed` | **P**, plus the required path-org match (D2) |
| Documents `canvas-sources` | `listCanvasesForCaller` | **P**, with the path org passed |
| Documents DELETE canvas | `getCanvasForCaller` + `canvasWriteAllowed` | **P**, plus the path-org match |
| Documents `from-canvas` materialize | `getCanvasForCaller` | **P**, plus the path-org match: a canvas is materialized only into its own org |
| Documents PATCH `promotedCanvasId` | existence only | **F**: `getCanvasForCaller` plus the path-org match |
| campaign-studio `loadPlan` and `planLinks` | project-org check (the only canvas↔org check on main) | **P**. The project rule becomes the D2 rule |
| Agent tools: get-design and render for app-builder, cad, drawings, slides and campaign-studio; `conversationFocus` | `getCanvasForCaller` (+ write) | **P**. Render stamps `gate.orgId` on create (D1) |
| Run lanes: `ctx.canvas.read`/`write`, `ctx.features['app-builder']`, `dataBinding.applyBinding`, MCP nodes | `assertCanvasRunAccess` / `getCanvasForCaller` with `actingUserId` | **P**. The acting user is checked in the canvas's org. A run with no acting person is `preAuthorized` only where it is today |
| `ctx.canvas.invoke` | **no target check** (`canvasSurface.ts:919`) | **F**: load `targetCanvasId` and `assertCanvasRunAccess(…, 'read')` before dispatch |
| Collab ticket, claim-seed and WebSocket upgrade (`collabServer.ts:238/266/484`) | `collabCanvasReadable` (raw `resolveSubjectAccess`) | **F**: `canvasReadAllowed` / `canvasWriteAllowed`. The room's own persists stay S (authorized at join) |
| Present remote (`routes/presentRemote.ts:48`) | `assertOrgScope(claims.orgId)` + owner rule | **F**: also require `claims.orgId === canvas.orgId` when it is set (a token minted through another org's path is refused) |
| ui-plugin `artifact.read`/`write` (`routes/uiPlugins.ts:73-139`) | `canvasReadAllowed` / `WriteAllowed` | **P** |
| Sharing `canvasEntitlement` and the `app_builder_canvas` / `slides_canvas` resolvers (`sharingService.ts:180-262, 552-581`) | owner rule; the link's `orgId` is passed and ignored | **F**: the mint requires `link.orgId === canvas.orgId` when set; the public resolve refuses a link whose org no longer matches |
| Comments `canvas_document` and `canvas_slides` (`commentsService.ts:338-375`) | `subjectReadAllowed`; `_orgId` ignored | **F**: `canvasReadAllowed` plus the org match. This also closes WORKFLOWS-ASSESSMENT `CMWF-4` for these two types |
| app-builder sync webhook (`syncWebhook.ts`) | `getCanvasForCaller` with no subject | **S** (inbound integration). The binding's `orgId` must equal the canvas's when both are set |
| Retention (`canvasRetention.ts`), tenant data export (`dataExport.ts`, admin), demo seed and clear, project-dependent purge, `eraseSubjectCanvas` (DSAR), `purgeTenantHostExt`, `sweepExpiredCanvasIdem` | tenant-wide | **S**: each acts for the tenant, not a member |

**Ratchet:** `test/adr1160-canvas-org-lane-ratchet.test.ts` scans `src/` for every
call of:

- `getCanvasForTenant(`, `listCanvasesForTenant(`, `canvases.list(` and `canvases.get(`, outside `canvasSurface.ts`'s own predicates;
- `createCanvasForTenant(` and `ensureCanvasForTenant(`.

It pins, per file, the call count and the reviewed treatment (`P` / `F` /
`system:<reason>`). It is the read-and-create twin of
`adr0886-canvas-write-gate-ratchet`. A new raw read in a reviewed file changes the
count and fails until it is reviewed. A sabotage, adding a raw read beside a
reviewed one, must go red.

### D4 — existing canvases: stamp what is certain, never guess

A canvas written before this ADR has no `orgId` and stays tenant-shared until it
is stamped. Stamping is a production data write. The read-only re-measure comes
first, and the write needs the user's own go in the session that runs it.

- **A tenant with exactly one org:** stamp that org. No behaviour changes for
  anyone, because every member is in it.
- **A project-owned canvas:** stamp `project.orgId`. That is already the org its
  access is decided in.
- **A canvas a feature can place:** the feature claims it through
  `claimCanvasOrg(tenantId, canvasId, orgId, by)`. It is a CAS, it only sets an
  unset `orgId`, and it is audited with ids only. CasaVoga's `studioBinding`
  already records each studio canvas's org.
- **Everything else in a multi-org tenant stays tenant-shared**, which is today's
  behaviour. A later admin surface can place these rows. The creator's
  membership is NOT used to guess: a person in two orgs would place the canvas
  arbitrarily.

### D5 — the editor layout slots are a separate ADR

CasaVoga also asked for a left-rail slot for a canvas type's own section, and a
supported way to set the selected frame. Today it targets
`.cv-editor__palette` by class name and activates `cv-tab-<frameId>` by element
id. That is chassis UI with no security weight. It gets its own small ADR so it
never slows this one.

### D6 — run lanes and org: a follow-up, not a blocker

Runs carry no org (`BundleScope`), so a canvas a run creates is tenant-shared
(D1), and a run reads or writes an org-bound canvas only if its acting user has
access in that org (D2). Stamping run-created canvases needs a run-level org: the
conversation's or workflow's org, where one exists. That is OQ-2.

## The wire

None. Canvases, their routes and their predicates are host-extension
(`/host/openwop-app/*`). `orgId` is a host field on a host row. No run-event field,
capability or endpoint contract changes.

## Alternatives weighed

1. **Filter by the path org with no stored org.** This cannot work: the row has
   nothing to compare the path org to.
2. **Derive the org from `ownerSubject`.** Only `project` resolves to an org
   (`subjectOrgScope.ts:46`). An org-owned canvas has no owner, and that is every
   production canvas.
3. **One collection per org.** This would rewrite every key and the tenant index
   for a rule one field expresses. Retention, DSAR and the tenant purge would also
   have to fan out per org.
4. **Decide in the path org (no own-org rule) and filter lists.** A member of both
   orgs could then edit org A's canvas through org B's path, under org B's role,
   which may be broader. D2's own-org rule plus the path match closes both
   directions.

## Trade-offs

- Every canvas read pays one `resolveEffectiveAccess` per (subject, org, need),
  memoized per request. Lists pay one per distinct org, at most the tenant's org
  count.
- Legacy canvases in multi-org tenants stay shared until placed. That is today's
  exposure, bounded and visible; guessing would be worse.
- A link or presenter token minted through the wrong org stops working once the
  canvas is stamped. That is intended, and it is a 404, not a leak.

## Phased plan

| Phase | What | Gate |
|---|---|---|
| P0 | D1: the field, the required `orgId` argument on both create functions, stamping on every create lane, org-keyed idempotency. Enforcement does not change yet | tsc; a create-lane test per lane (stamped or `system:`); the D3 ratchet for creates |
| P1 | D2: predicates, `loadCanvas` path match, list filter. The **P** rows | adr1160 tests: org A's canvas is 404 through org B's list, GET, PATCH, DELETE and Documents delete; allowed in org A; a member of both still 404s through B's path; legacy unset rows unchanged; sabotages |
| P2 | The **F** rows: invoke, collab, present, sharing, comments, `promotedCanvasId`; the full D3 ratchet | a test per row; the ratchet sabotage |
| P3 | D4: `claimCanvasOrg`, then the read-only prod re-measure. The stamp (one-org tenants, project-owned) needs the user's go in the session that runs it | counts only, ids never; READ ONLY transaction |
| P4 | The layout-slot ADR (D5); the run-org follow-up (OQ-2) | separate ADRs |

## Implementation record

| Phase | Commit | Tests |
|---|---|---|
| P0 | #6260 (`8961fb54e`) | `src/host/__tests__/canvasOrgStamp.test.ts`, `test/adr1160-canvas-create-org-ratchet.test.ts` |
| P1 | (this PR) | `test/adr1160-p1-canvas-org-enforced.test.ts`; the five render-tool tests assert the `?org=` link |
| P2 | | |
| P3 | | |

## Open questions

1. ~~Build it?~~ Yes (the user, 2026-11-25): "ADR, then build".
2. OQ-2: how a run gets an org, so run-created canvases can be stamped (D6).
3. OQ-3: an admin surface to place legacy tenant-shared canvases in a multi-org
   tenant (D4).
4. The ui-plugin `demo-artifact` route (`features/ui-plugins/routes.ts:199`) has
   no scope check: any caller can ensure one fixed demo canvas in their own
   tenant. It is low-weight (fixed content, idempotent, own tenant), and it gets
   a scope check with P0's create-lane pass.

## Not in this ADR

- ADR 0886 OQ-5, the semantics of a `user`-owned canvas (writable by anyone with
  tenant write unless the caller is the owner). This ADR adds the org rule beside
  it and does not change it.
- Per-canvas sharing to specific members (ACLs). A canvas is in an org, or it is
  tenant-shared.
