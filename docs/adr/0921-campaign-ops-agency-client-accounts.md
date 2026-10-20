# ADR 0921 — Campaign ops: agency workspace and client accounts

Status: Accepted — P0 implemented (#5015); later phases pending

Program: agency campaign operations (ADRs 0921–0928). Source: the PRD
`/Users/david/dev/yc/AGENCY-CAMPAIGN-OPS-PRD.md` (2026-10-17), features **F1**
and the isolation half of **F18**. This is a net-new feature, not a MyndHyve port.

## Context

The product helps a marketing agency complete client-approved campaign changes.
One agency serves 5–30 retained clients. Each client has its own brand kit,
connections, assets and permissions. An operator working for client A must never
read or write client B's assets, connections or jobs, including through
workflows and agents. A wrong-client resource is rejected fail-closed.

The PRD asked the audit to settle one question: does this extend orgs/tenancy
(tenant = agency, org = client), or does it need a parent/child org hierarchy?

**Decision taken by the owner (2026-10-18): tenant = agency, org = client.**

## Boundaries audit (state on `origin/main` at `38bdc1699`)

Paths are under `backend/typescript/src/` unless they start with `docs/` or
`frontend/`.

**What exists and is reused:**

- **Workspace = tenant = root org.** ADR 0015 folded org and tenant into one and
  explicitly rejected a layer above orgs
  (`docs/adr/0015-workspace-as-tenant-b2b.md:82-100`, `:98`). A root org is the
  org whose `orgId === tenantId` (`host/accessControlService.ts:1301-1314`).
  Shared workspaces are `ws:<uuid>` (`:1243-1252`), created by
  `createWorkspace` (`:1331-1360`).
- **Orgs are flat.** `Organization` has no parent field
  (`host/accessControlService.ts:321-331`); "sub-org" in ADR 0815 only means an
  org whose id is not the tenant id (`docs/adr/0815-…md:219-220`).
- **Per-org roles resolve exactly.** `resolveEffectiveAccess` reads the
  `(subject, orgId)` row with no fallback from a client org to the root
  (`host/accessControlService.ts:1971-1978`). `assertOrgScope` checks org
  existence (404) then scope (403) (`:613-636`). `requireOrgScope` /
  `authorizeOrgScope` wrap it for routes (`features/featureRoute.ts:238-286`).
  Custom roles are per org and carry protocol scopes only (`:224`, `:387-396`).
- **Org-scoped stores already exist.** Media rows check tenant and org
  (`features/media/mediaService.ts:5, 143-144`); every campaign entity carries an
  `orgId` (e.g. `features/campaign-orchestration/types.ts:17`).
- **`ctx.features.*` has an org floor.** ADR 0832's `orgFloor`
  (`host/featureSurfaces.ts:182-204`) checks an `args.orgId` against the run's
  acting user.

**Gaps this feature must close for itself (the generic seams do NOT make client
isolation automatic):**

| Gap | Evidence | Consequence if ignored |
|---|---|---|
| G1 Runs carry no org | `BundleScope` has no `orgId` (`host/inMemorySurfaces.ts:243-310`); run access is tenant-only (`host/runAccess.ts:97-117`); `approverOrgId` is set only for single-org tenants (`routes/runs.ts:549-551`) | Any operator with `runs:read` sees every client's jobs |
| G2 Root membership is tenant-wide | Entering a `ws:` tenant needs a root row (`host/accessControlService.ts:1412-1447`); tenant-wide scopes are exactly the root row's (ADR 0815 D1b, `:2186-2187`) | A root `editor` can act on every client through tenant-scoped routes |
| G3 Org listing is unfiltered | `GET /orgs` returns `listOrgs(tenant)` with no membership filter (`routes/accessControl.ts:329-331, 411-413`) | Client names are visible to every operator |
| G4 Connection fallbacks cross clients | A workspace-scoped connection is usable by any run (`features/connections/connectionsService.ts:583-584, 630-634`); with no `orgId` the first org connection wins (`:582, 674, 707`) | A job for client A could write with client B's credential |
| G5 Org-floor residues | ADR 0832 S-A (absent `orgId` reads the tenant), S-I (record-id methods unchecked), S-W (membership only, a viewer's run can write), R8 (webhook runs trusted tenant-wide) (`docs/adr/0832-org-scope-seam-floor.md:275-320`) | A campaign-ops surface method that takes an id instead of an `orgId` is unguarded |

## Decision

### D1 — Agency = `ws:` workspace; client = org

An agency is a shared `ws:` workspace. Each retained client is a non-root org in
that workspace. The root org is the agency's own house account (its staff, its
billing, its default brand). **No hierarchy is added to `accessControl`.**

A **client account** is an org plus a campaign-ops record:

```ts
// features/campaign-ops/types.ts
interface ClientAccount {
  tenantId: string;            // the agency workspace (ws:…)
  orgId: string;               // the client org — the ONLY isolation key
  displayName: string;
  status: 'active' | 'paused' | 'archived';
  mode: 'preview' | 'live';    // ADR 0926 D3; new clients start in preview
  approvalPolicy: ApprovalPolicyRef; // ADR 0924 D4
  synthetic?: true;            // ADR 0927 D2 demo rows
  createdAt: string; createdBy: string; updatedAt: string;
}
```

Stored in `DurableCollection('campaign-ops:client')`, keyed `tenant::orgId`. One
record per org, created by an agency admin (`host:members:manage` on the root).
Archiving a client never deletes the org; it stops new jobs.

**The client's brand kit, connections and assets are the org's existing ones.**
Brand rides `features/brand` (org-scoped), connections ride
`features/connections` with `scope:'org'`, media rides `features/media`. Campaign
ops adds no second store for any of them.

### D2 — Role posture for agency staff

Recommended membership shape (documented in the onboarding flow, ADR 0926):

- **Agency owners/admins:** owner or admin on the root. They can see every client.
- **Operators:** a root row with the built-in `viewer` role (enough to enter the
  workspace) **plus** `editor` (or a custom role) on each client org they work.
- **Campaign ops never authorizes from the root row.** Every campaign-ops route
  is mounted under `/v1/host/openwop-app/campaign-ops/clients/:orgId/…` and goes
  through `authorizeOrgScope(req, 'campaign-ops', orgId, scope)`, so the exact
  client row decides (`features/featureRoute.ts:279-286`). This makes G2
  harmless for campaign-ops surfaces: a root viewer with no client-B row gets 403
  on client B. Agency admins pass because `resolveEffectiveAccess` treats
  `host:members:manage` holders on the root as org admins — **to be verified in
  P0** (open question Q1); if it does not, the cross-client view uses an explicit
  root-admin check instead.

### D3 — Every campaign-ops row and job is client-bound

- Every campaign-ops entity (asset, request, change set, job, step, observation)
  carries `orgId` and is keyed `tenant::orgId::…`. A read by id loads the row and
  compares `row.orgId === path orgId` before anything else; a mismatch is the
  same uniform 404 as a missing row. This closes G5's S-I shape for this feature:
  **no campaign-ops surface method takes a bare record id.**
- **Jobs stamp the client on the run (closes G1 for campaign-ops).** A campaign-ops
  run is started only by the service, with `run.metadata['openwop-app.campaignOps']
  = { orgId, changeSetId, changeSetHash }` (host metadata, a reserved key the
  client cannot set, following `routes/runs.ts:2014`). The operator never reads a
  campaign-ops job through `/v1/runs` lists; the inbox (ADR 0926) reads jobs
  through campaign-ops routes, which are org-gated.
- **Every `ctx.features.campaignOps.*` method requires `orgId`** and re-checks
  the run's stamped `orgId` equals it. A run whose stamp disagrees with the
  argument is refused `wrong_client` before any read. This closes S-A for this
  surface and is stronger than the ADR 0832 floor (it binds the run, not only the
  actor).
- **Writes need a write scope on the client** (`workspace:write` on the org), not
  membership (closes S-W for this surface).
- **Webhook and actorless runs cannot start or advance a job** (closes R8 for this
  surface): the service requires an acting user or a campaign-ops approval
  resolution as the cause.

### D4 — Connections are pinned, never resolved by fallback

An asset that needs a credential stores `connectionId`, and the destination adapter
(ADR 0922) resolves it with `{connectionId, orgId}` through the broker's exact-pin
path. A pinned connection whose `orgId` differs from the asset's is refused
`wrong_client_connection`. Campaign ops **never** calls the broker without both
values, so G4's fallbacks are unreachable from this feature. Workspace-scoped
(`orgId`-less) connections are refused for campaign-ops assets. (The v1
destinations in ADR 0922 are in-app and need no credential; this rule governs the
first external one.)

### D5 — Client switcher and cross-client view

- **Switcher:** `GET …/campaign-ops/clients` returns only the client orgs where
  the caller has a row (or all, for agency admins). This is campaign-ops' own
  filtered list, so G3 does not leak through campaign ops. G3 itself is a
  pre-existing `accessControl` gap; it is logged as a separate follow-up row, not
  fixed here (fixing `listOrgs` changes every consumer's behaviour and needs its
  own review).
- **Cross-client view:** the operator inbox (ADR 0926) aggregates across the
  clients the caller can see, by fanning out per client through the same gated
  reads. No tenant-wide query exists.
- The frontend uses the existing `ui/useOrgSelection.ts` selector, filtered to
  client accounts, not a new context.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | New `features/campaign-ops/` (service, `routes.ts`, `feature.ts`, `surface.ts`), appended to `BACKEND_FEATURES` / `FRONTEND_FEATURES`. Core is not edited; the run-metadata key is registered through the existing reserved-key list. |
| 2 | Toggle | `campaign-ops`, default **OFF**, `bucketUnit: 'tenant'`, `dependsOn: ['cms']`, `recommends: ['email', 'brand']`. Includable in a future `distributions/myndhyve.json` and in the `marketing` bundle in `distributions/bundles.json`. |
| 3 | Workflow surface | `ctx.features.campaignOps` (ops listed in ADRs 0922–0925); every op takes `orgId` and checks the run stamp (D3). |
| 4 | Node pack | `feature.campaign-ops.nodes` (ADRs 0923, 0925). |
| 5 | Envelopes | None. Model output reaches durable state only through the closed-schema proposal validator (ADR 0923). |
| 6 | Agent pack | The change planner joins the existing `vendor.openwop-app.campaign-studio.agents` (ADR 0923). |
| 7 | Public surface | Only the client approver portal (ADR 0924). |
| 8 | RBAC | D2/D3: exact client row, write scope for writes, fail-closed 404 on wrong client. |
| 9 | Replay / fork | A `:fork` of a campaign-ops run re-executes no write: write nodes are `role:"side-effect"` with a ledger (ADR 0925). Toggle state is not read at replay. |
| 10 | Frontend | `features/campaign-ops/` page as a tab of the `/campaign-studio` hub (`frontend/react/src/features/campaigns/routes.tsx:26`), nav through the hub's manifest; no new top-level group. |

## RFC verdict

**Host extension, no RFC.** All routes are under `/v1/host/openwop-app/campaign-ops/*`;
the run stamp is a host-namespaced metadata key; no capability is advertised.

## Phased plan

| Phase | Scope | Demo slice? |
|---|---|---|
| **P0** | `campaign-ops` feature package + toggle; `ClientAccount` store and CRUD; `…/clients` list filtered to the caller; org-bound row keys and the uniform-404 loader; the run stamp; the `ctx.features.campaignOps` org binding helper with a `wrong_client` witness test | **Yes** (one client is enough; the witness uses two) |
| P1 | Pinned-connection rule (D4) wired through ADR 0922's adapter seam; witness: a client-B connection id on a client-A asset is refused | With the first credentialed destination |
| P2 | Cross-client inbox aggregation (with ADR 0926); agency-admin visibility verified (Q1) | No |
| P3 | Follow-up row for G3 (`listOrgs` membership filter), handed to the accessControl owner | No |

## Alternatives weighed

- **Parent/child org hierarchy.** Truer to "agency owns clients" and gives a
  cross-client role for free, but reverses ADR 0015 D-level reasoning, touches
  every org check in the app, and needs its own architecture pass. Rejected for
  v1 by the owner.
- **One workspace per client.** Strongest isolation for free, but no agency
  layer: no shared staff, no cross-client view, billing per client. Fights the
  "one agency account" requirement.
- **Rely on the generic floors (ADR 0832) alone.** Rejected: G1, G4 and G5 are
  documented residues, and the PRD's acceptance criterion is a hard zero.

## PRD-vs-architecture corrections

1. The PRD says "each client has its own brand kit, connections, assets and
   permissions". These are the org's existing brand, connections, media and
   roles. Campaign ops adds a thin `ClientAccount` record, not a second store for
   any of them.
2. The PRD's "client switcher" is campaign ops' own filtered list, not a change
   to the app-wide org list (G3 is logged, not silently changed).
3. "Including through workflows and agents" is met by the run stamp plus the
   per-call `orgId` re-check (D3), because the generic run model is tenant-scoped.

## Owner decisions recorded after acceptance (2026-10-18)

> Added by ADR 0933's docs pass, not part of the original decision.

- **MyndHyve agents, memories and prompts are archived, not migrated.**
  Campaign ops starts fresh.
- **Shared memory, if it is ever added, is per client org, never per agency**,
  to preserve the isolation D3 enforces. This already binds ADR 0933 D7: the
  claim check reads only the client org's knowledge collection.

## Open questions

- [ ] **Q1** Does `resolveEffectiveAccess` grant a root admin authority on a
      client org with no row? The audit read exact-row resolution
      (`host/accessControlService.ts:1971-1978`), which suggests not. If not, the
      cross-client view needs an explicit root-admin branch. Verify in P0 with a
      test before writing D2's admin path.
- [ ] **Q2** Should archiving a client also revoke its open approver tokens
      (ADR 0924)? Proposed: yes.
- [ ] **Q3** G3 (`listOrgs` unfiltered) is app-wide. Who owns the follow-up?
      Proposed: a TODO row against `accessControl`.
- [ ] No `/architect` pass has been run on this ADR. It was drafted against the
      architect checklist; run the review before Accepted.

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | #5015 (`feat(campaign-ops): client accounts, asset registry, CMS page adapter`) | `backend/typescript/test/campaign-ops-clients-assets.test.ts` |
