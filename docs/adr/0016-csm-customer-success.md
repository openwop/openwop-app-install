# ADR 0016 — Customer Success Management (CSM)

**Status:** implemented (retroactive — documents a feature that shipped 2026-06-08 before its ADR existed); **extended 2026-06-10** with the core-app extension surface (see § Correction).
**Date:** 2026-06-10 (retroactive record; extended same day)
**Depends on:** ADR 0001 (feature-first package architecture), ADR 0014 (feature workflow surfaces — the extension). Tenant scoping per ADR 0015 (tenant = workspace).
**Surface:** `/v1/host/sample/csm/*` + `ctx.features.csm` (host-extension, NON-NORMATIVE — no RFC).
**Toggle:** `csm` · category `Business Tools` · default OFF · `bucketUnit: 'tenant'` · no variants · ~~no packs~~ ships `feature.csm.{nodes,agents}` (corrected 2026-06-10).

> **Why this ADR exists.** The `csm` feature shipped as a `BackendFeature` +
> `FrontendFeature` (2026-06-08) without an accompanying ADR — the only Current
> feature that lacked one (surfaced by the 2026-06-10 ROADMAP/FEATURES
> reconciliation). Per `CLAUDE.md` § "Tracking architectural changes", a
> feature-package is a recorded decision. This ADR closes that gap retroactively;
> it documents the decision as built, not a new change.

---

## Context

After the CRM full port (ADR 0008), the app needed a second, deliberately
**minimal** Business-Tools feature to (a) cover the post-sale customer-success
surface MyndHyve has, and (b) serve as the canonical *smallest* worked example of
the ADR 0001 feature-package contract — a feature with **no packs and no
variants**, proving the contract isn't pack-coupled.

CRM (ADR 0008) already owns the *pre*-sale surface (contacts → companies → deals
→ pipelines). Customer success is a distinct lifecycle concern — health of
*existing* accounts — so it is a separate feature, not another CRM entity (single
responsibility; the two compose at the UI layer, not in one store).

## Decision

**A standalone `csm` feature-package owning one entity: the customer-success
`Account` with a 0–100 `healthScore`.**

- **Model** (`src/features/csm/accountsService.ts`):
  `Account { accountId, tenantId, name, healthScore /* 0..100 */, createdAt, updatedAt }`.
- **Surface** (`routes.ts`): tenant-scoped CRUD —
  `GET/POST /v1/host/sample/csm/accounts`, `GET/PATCH/DELETE /…/accounts/:id`,
  each gated by `resolveOne('csm', subject).enabled` (backend authority) and
  scoped to the caller's active workspace (`tenantId`).
- **Toggle** (`feature.ts`): plain on/off, default OFF, `bucketUnit: 'tenant'`,
  category `Business Tools`. **No `requiredPacks`, no `variants`** — the minimal
  shape of the contract.
- **Frontend** (`frontend/react/src/features/csm/`): `CsmPage.tsx` +
  `csmClient.ts` + a `routes.tsx` nav entry carrying `featureId: 'csm'` (nav hides
  while the toggle is off), at `/csm`.
- **Tests:** `test/csm-feature.test.ts` pins the model, store key, route paths,
  and toggle gating.

### What we explicitly do NOT do (yet)

- **No org-member RBAC scoping.** Accounts are workspace-scoped (`tenantId`), not
  org-member-RBAC-scoped like CRM's org entities (`/crm/orgs/:orgId/*`). For the
  single-workspace demo that is sufficient; the B2B case is an open question below.
- **No automated health scoring.** `healthScore` is a stored, manually-set field —
  not derived from usage/signals. A scoring pipeline is deferred.
- **No packs / no workflow surface.** Unlike CRM/CMS/KB/Media (ADR 0014
  `FeatureModule`s), CSM ships only its REST + UI faces. It can grow a
  `ctx.csm` surface later without touching the contract.
  > **Corrected 2026-06-10:** this gap is now closed — see § Correction. The
  > extension was purely additive (no change to the REST/UI faces or the pinned
  > `csm-feature.test.ts` contract), exactly as predicted here.

## Correction — core-app extension surface (2026-06-10)

A `/feature`-skill **audit** flagged that CSM shipped REST + UI + toggle but lacked
the "core-app extension surface" that ADRs 0017–0022 now mandate (a `ctx.<feature>`
workflow surface + node/agent packs), and was tenant-scoped + toggle-only. A
`/architect` options pass resolved the design. **This section records the decision
as built; it does not rewrite the original (the reasoning trail is the point).**

**Scoping decision: KEEP tenant-scoped (do NOT migrate to org-scoped + RBAC).**
The dominant force is preserving the pinned ADR-0016 contract + the CRM-contacts
precedent (ADR 0008 deliberately kept the tenant-wide rolodex tenant-scoped while
org-scoping *new* entities). A "tenant-wide customer-success book" is a legitimate,
precedented scope (post-ADR-0015, tenant = workspace → a per-workspace account
list). The audit's "no RBAC" finding is **N/A, not a defect**: this app has no
tenant-level RBAC scope — authority is org-membership-derived — so a tenant-wide
surface correctly uses toggle + tenant-isolation, exactly as CRM-contacts does.
Org-scoping (`/csm/orgs/:orgId/*` + `workspace:read/write`) remains a **future
migration ADR**, warranted only if a consumer needs accounts partitioned per-org
within a workspace.

**Hardening (the one real security fix):** the workflow surface + nodes use a NEW
tenant-guarded read `getAccountForTenant(tenantId, accountId)` — the unguarded
`getAccount(accountId)` (route-only) is deliberately NOT surfaced, so a node cannot
probe another workspace's accounts (CTI-1). Mirrors `crm/surface.ts`.

**What shipped (all behind the same `csm` toggle):**
- **`ctx.features.csm` workflow surface** (`surface.ts`, ADR 0014) — a thin
  read/health adapter over `accountsService`: `listAccounts` / `getAccount` (read,
  tenant-guarded, internal columns projected out) + `setHealth` (tenant-guarded,
  idempotent-by-id update). Advertised at `/.well-known/openwop`.
- **`feature.csm.nodes`** — `health-read` (at-risk accounts / one by id) and
  `health-set` (update an existing account's score; **idempotent by `accountId`**,
  update-only — node-driven create is rejected as non-deterministic, so fork/replay
  never duplicates). Both `role: action` (recorded → replay reads the result).
- **`feature.csm.agents`** — `health-insights`, a `RESEARCH` agent tool-allowlisted
  to `feature.csm.nodes.health-read` **only** (read-only — it reports at-risk
  accounts + save-plays, it never mutates health).

**Replay / RFC / boundaries:** no wire change (all `/v1/host/sample/*` +
`ctx.features.*`, riding ADR 0014's already-accepted agent/manifestRuntime RFCs) →
no RFC. Idempotent-by-id write → replay-safe, no `run.metadata` stamp (no variant).
No collision — `csm` namespace + `feature.csm.*` pack names free; `accountsService`
stays the single owner of accounts; the surface is a thin read adapter (no second
store).

**Honest scope:** `healthScore` is still a stored field, not derived from activity;
the agent *reports* on it and cannot fabricate a cause. Deriving health from real
signals needs a CRM cross-link (`ctx.features.crm`) and stays a follow-on (below).

## Architectural constraints honored

- **Feature-first (ADR 0001):** self-contained `src/features/csm/`, wired only by
  appending to `BACKEND_FEATURES` / `FRONTEND_FEATURES` — no edits to core
  route/nav code.
- **Backend authority:** every route gates on the server-resolved toggle; the nav
  entry only *hides* the link, it is not the access control.
- **Tenant isolation (RFC 0048 §D / ADR 0015):** every read/write is scoped to the
  active workspace; no cross-workspace leakage.
- **No wire change:** host-extension under `/v1/host/sample/*`; non-normative; no
  RFC required (per `CLAUDE.md` governance).

## Alternatives considered

1. **Make CSM another CRM entity** (a `crm` "account" type). Rejected: conflates
   pre-sale pipeline with post-sale health, couples two lifecycles in one store,
   and bloats the CRM contract ADR 0008 froze. Separate feature = single
   responsibility + independent toggling.
2. **Org-scope CSM from day one** (mirror CRM's `/orgs/:orgId/*` + RBAC). Rejected
   for the initial cut: the minimal tenant-scoped shape is the more valuable
   reference example, and the demo has no multi-member CSM requirement yet. Left as
   an open question for when a B2B consumer appears.
3. **Skip the ADR** (it's "just a small feature"). Rejected: that is exactly the
   ADR-0004 drift this repo guards against — every feature-package is a recorded
   decision, regardless of size.

## Open questions

- [x] **Workflow surface (ADR 0014):** **Done 2026-06-10** — `ctx.features.csm` +
  `feature.csm.{nodes,agents}` (see § Correction).
- [~] **Org/RBAC scoping:** **Decided 2026-06-10 (/architect): keep tenant-scoped**
  (mirrors the CRM-contacts rolodex; no tenant-level RBAC exists to consume). A move
  to org-member-scoped accounts (`/csm/orgs/:orgId/*`, `workspace:read`/`write`) is a
  future migration ADR, only if a per-org-partition consumer lands.
- [ ] **Health-score automation:** derive `healthScore` from signals
  (usage/activity/renewal) instead of a manual field. (The `health-insights` agent
  *reports* on the stored score today; deriving it needs a signal source.)
- [ ] **CRM ↔ CSM linkage:** associate a CSM `Account` with a CRM `Company`/`Deal`
  (via `ctx.features.crm`) so the pre-sale and post-sale records reference one
  customer — the prerequisite for real health automation above.

## Implementation record

| Aspect | Evidence |
|---|---|
| Backend | `src/features/csm/{accountsService.ts,routes.ts,feature.ts}` (Account CRUD, tenant-scoped, toggle-gated) |
| Extension surface (2026-06-10) | `src/features/csm/surface.ts` (`ctx.features.csm`) + `packs/feature.csm.nodes/` (health-read / health-set) + `packs/feature.csm.agents/` (health-insights); `getAccountForTenant` / `setAccountHealthForTenant` tenant-guarded service reads |
| Frontend | `frontend/react/src/features/csm/{CsmPage.tsx,csmClient.ts,routes.tsx}` (nav-gated `/csm`) |
| Registries | appended to `BACKEND_FEATURES` (`src/features/index.ts`) + `FRONTEND_FEATURES` (`src/features/registry.ts`) |
| Toggle | `csm` registered via `feature.ts` `toggleDefault` (OFF, `tenant`, no variants/packs) |
| Tests | `test/csm-feature.test.ts` |
| Catalog | `FEATURES.md` § "Current features" (CSM row) |
