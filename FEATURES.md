# FEATURES.md — openwop-app

The catalog of product features in this app, and how the feature-toggle +
multivariant-testing system that gates them works. Each feature is a
self-contained package (its own routes, UI, data, and packs) that plugs into the
base app and is turned on/off — or split across weighted variants — at runtime.

> **Design of record:** [`docs/adr/0001-feature-first-package-architecture.md`](docs/adr/0001-feature-first-package-architecture.md).
> **Contributor conventions:** see [`CLAUDE.md`](CLAUDE.md) — the agent/onboarding
> guide for this repo. It records the ADR change-tracking convention (how
> architectural decisions like this one are written down and kept current) and
> the two-surface deploy recipe. Read it before making structural changes; this
> FEATURES.md is the *what*, CLAUDE.md is the *how-we-work*.

---

## How the feature-toggle system works

### States — ON / OFF / BETA

Every feature is gated by a toggle with one of three states:

- **OFF** — the feature is unavailable. Its backend routes 404, its nav entry is
  hidden, and its page shows a "not enabled" state.
- **ON** — the feature is available to 100% of eligible callers.
- **BETA** — available **and rendered with a "Beta" badge** in the nav (Sidebar,
  admin rail, ⌘K). Two modes (2026-06-09, per maintainer — matches the myndhyve
  reference):
  - **Open beta (default):** a BETA toggle with **no `betaCohort`** is enabled for
    everyone, just badged. This is what "flip it to Beta" does out of the box.
  - **Closed beta:** set a non-empty `betaCohort` (tenant/user ids) to narrow it —
    eligible ids get it (badged); everyone else sees it as off.

  BETA answers *"who may see it,"* which is orthogonal to variant splitting (*"how
  eligible traffic is divided"*) — so a feature can be BETA **and** A/B-tested.

### Backend is the authority

Toggle and variant resolution runs **server-side** from the authenticated
principal — never trusted from the client. A toggle gates backend routes and
pack/agent activation, which a client cannot be allowed to assert. The frontend
receives a read-only resolved-assignments map and uses it only to render (which
page/nav to show, which variant UI to mount).

### Scope — per-tenant-overridable global

Each toggle carries a **global default** plus optional **per-tenant overrides**.
Resolution order: a tenant override (if present) → the global default.

### Multivariant traffic-splitting

A toggle may carry weighted **variants** instead of a plain on/off:

- `on`, no variants → a single variant at 100% (the simple case).
- `on`, `variants: [{A, 50}, {B, 50}]` → a 50/50 split.
- N variants with integer weights that **MUST sum to exactly 100** (e.g.
  `A:60 / B:30 / C:10`), validated server-side and in the admin UI.

**Sticky bucketing** assigns a caller to a variant deterministically:

```
unitId  = bucketUnit === 'tenant' ? tenantId : (userId ?? tenantId)
bucket  = hash(unitId + ':' + toggleId + ':' + salt) % 10000   // 0..9999
       → first variant whose cumulative weight band contains the bucket
```

- **`bucketUnit`** is per-toggle: `user` (fine-grained, the default) or `tenant`
  (whole-account — every user in a tenant gets the same variant; the right
  choice for shared B2B surfaces like CRM/CSM).
- **`salt`** is per-toggle so a user isn't correlated across experiments.
- **`% 10000`** buckets keep 50/50, small allocations, and 1%→5%→50% ramps
  accurate.
- Assignment is stable without persistence — the same inputs always yield the
  same variant.

### Variant → behavior bindings (admin-administered)

A variant may carry **bindings** that select behavior (e.g. which agent / node /
prompt a workflow dispatches). The candidate set is declared by the feature; an
admin wires each variant to a binding **dynamically** from the Feature-toggles
admin screen — no redeploy.

### Replay-safe variant stamps

When a variant influences a **run**, the resolved variant + bindings are
**stamped into `run.metadata.featureVariant` at run creation** and read back
**verbatim on replay/fork** — never recomputed. (`run.metadata` is copied by
`POST /v1/runs/{runId}:fork`; the RFC 0056 annotation surface is *not*, so it
would be the wrong home.) This is why a run that used a feature still replays
correctly even after the feature is later toggled off. **Pack presence is
likewise decoupled from toggle state** — an installable feature's packs stay
loaded regardless of on/off, so historical runs always resolve their nodes.

### The admin screen

Superadmins manage toggles at **Admin → Feature toggles** (`/feature-toggles`):
the ON/OFF/BETA control, the randomization unit, and a per-toggle variant editor
(weights with live sum-to-100 validation). The superadmin gate **fails closed** —
a tenant must be listed in `OPENWOP_SUPERADMIN_TENANTS` (or call with the admin
bearer key); `OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true` opens it for local dev only.

### Where it lives (code)

| Concern | Path |
|---|---|
| Toggle types / bucketing / registry / service / validation | `backend/typescript/src/host/featureToggles/` |
| Toggle + assignments routes | `backend/typescript/src/routes/featureToggles.ts` |
| Backend feature contract + registry | `backend/typescript/src/features/` |
| FE access hook + provider | `frontend/react/src/featureToggles/FeatureAccessContext.tsx` |
| FE admin screen | `frontend/react/src/featureToggles/FeatureTogglePanel.tsx` |
| FE feature registry | `frontend/react/src/features/registry.ts` |

---

## Current features

| Feature | Toggle id | Default | Bucket unit | Variants | Packs | Surface |
|---|---|---|---|---|---|---|
| **CRM** — contacts + contact triage | `crm` | OFF | `tenant` | `basic` / `enriched` (50/50), bound to the triage nodes | `feature.crm.nodes` | `/crm` (workspace) + `/v1/host/sample/crm/*` |
| **CSM** — customer-success accounts + health | `csm` | OFF | `tenant` | — (plain on/off) | — | `/csm` (workspace) + `/v1/host/sample/csm/*` |
| **Users & Authentication** — durable accounts, lifecycle, email/password + enterprise SSO (SAML/SCIM) | `users` | OFF | `tenant` | — (plain on/off) | — (SSO packs land with later ADR 0002 phases) | `/users` (workspace) + `/v1/host/sample/users/*` · identity foundation (ADR 0002/0003) |
| **Org invitations** — email-token invites to join an org as a member (orgs/members/roles owned by the `accessControl` surface, RFC 0049) | `orgs` | OFF | `tenant` | — (plain on/off) | — | `/v1/host/sample/orgs/:id/invites` + `/orgs/invitations/accept` (ADR 0004, reconciled) |
| **Widgets** — reference host-extension vertical slice | `widgets` | OFF | `user` | — | — | `/v1/host/sample/widgets` (env-gated; example only) |
| **Notifications** — in-app inbox + bell, SSE live feed, Web-Push (VAPID), durable per-(tenant,user) preferences | `notifications` | **ON** | `tenant` | — (plain on/off) | — | `/inbox` + header bell (workspace) + `/v1/host/sample/notifications/*` · migrated into the feature architecture (ADR 0010) |
| **Knowledge Base / RAG** — org-scoped document collections, ingest (pasted text or Media token) → chunk + embed, semantic search with citations | `kb` | OFF | `tenant` | — (plain on/off) | — (composes `core.openwop.rag` + host `db.vector`) | `/kb` (workspace) + `/v1/host/sample/kb/orgs/:orgId/*` · reuses the host vector store + deterministic embedder (ADR 0011) |
| **Publishing & SEO** — publish CMS pages to a public site with per-page SEO (meta + Open Graph), sitemap.xml, robots.txt, RSS | `publishing` | OFF | `tenant` | — (plain on/off) | — (composes CMS + Media) | authed `/v1/host/sample/publishing/*` + **public** `/v1/host/sample/public/:orgId/*` (unauthed, org-addressed, toggle-gated) · `/publishing` (workspace) (ADR 0012) |
| **Sharing** — unguessable public share links to a specific resource (CMS page incl. drafts, KB collection) + social-card metadata | `sharing` | OFF | `tenant` | — (plain on/off) | — (composes CMS + KB via a resolver registry) | authed `/v1/host/sample/sharing/orgs/:orgId/links` + **public** `/v1/host/sample/shared/:token` (unauthed, token-credential, toggle-gated) · `/sharing` (workspace) (ADR 0013) |

> Defaults are OFF — a superadmin turns a feature on (or to BETA, or on with a
> traffic split) per tenant from the admin screen. The one exception is
> **`notifications`, default ON**: it is a pre-existing surface migrated into the
> feature architecture (ADR 0010 §6 / ADR 0001 §6 — "seed pre-existing surfaces
> as on"), so no deployment loses the bell on upgrade. A superadmin can still
> turn it OFF per tenant, which 404s the whole surface and hides the bell + nav.

### Env-gated operational flags (not feature-toggles)

Some behavior is gated by a deploy-time env var rather than the per-tenant
toggle system:

- **`OPENWOP_AUTHORIZATION_ENFORCEMENT`** (default off) — RFC 0049 / ADR 0006
  Phase 3. When `true`, the host enforces membership-derived RBAC scopes on the
  protocol runs/artifacts surface (`runs:create` / `runs:read` / `runs:cancel` /
  `artifacts:read`), serves the `POST /v1/host/sample/authorization/decide` seam,
  and advertises `capabilities.authorization.supported: true`. **Off (default):
  no protocol-surface enforcement, the seam 404s, and the capability advertises
  `supported: false`** — every caller authenticated by Bearer/OIDC but without an
  `accessControl` membership is unaffected. Only enable it where the caller
  population is provisioned as `accessControl` members; otherwise legitimate
  callers (incl. wildcard/conformance principals) fail closed with `403 forbidden`.
  Management routes under `/v1/host/sample/orgs/*` enforce their `host:*` scopes
  unconditionally regardless of this flag.

---

## Adding a feature

A new feature is wired by **appending** to the registries — no edits to core
route/nav code (see ADR 0001 §2.2, §4 for the worked CRM example).

1. **Backend** — create `backend/typescript/src/features/<id>/`:
   - `<id>Service.ts` — domain logic (durable store, tenant-scoped).
   - `routes.ts` — routes under `/v1/host/sample/<id>/*`, each gated by
     `resolveOne('<id>', subject).enabled` (backend authority).
   - `feature.ts` — a `BackendFeature` with `id`, `registerRoutes`, a
     `toggleDefault` (status `off`, category, `bucketUnit`, `salt`, optional
     `variants`/`betaCohort`), and any `requiredPacks`.
   - Append it to `BACKEND_FEATURES` in `src/features/index.ts`.
2. **Packs (optional)** — ship `feature.<id>.*` packs under `packs/`; they
   dev-mount via the `feature.` prefix and install through the existing signed
   registry pipeline. Declare them in `requiredPacks`.
3. **Frontend** — create `frontend/react/src/features/<id>/`:
   - `<id>Client.ts`, the page component, and `routes.tsx` exporting a
     `FrontendFeature` (route + nav entry carrying `featureId: '<id>'` so the
     nav hides while the toggle is off, and shows a Beta badge while it's beta).
   - The nav entry is the **menu registry record**: `group` is the menu
     **category**, `order` is the **position** within it (lower = earlier; omit to
     append after the ordered items). Category sequence is declared once in
     `GROUP_ORDER` (`src/chrome/features.tsx`). The Sidebar, admin rail, and ⌘K all
     derive from this — render code owns no menu data.
   - Append it to `FRONTEND_FEATURES` in `src/features/registry.ts`.
4. **Verify** — `npm run build` (frontend, runs the token/CSS gates) +
   `npm test` (backend). Add the feature to the **Current features** table above.
5. **Replay-safety** — if a variant affects a run, stamp it into
   `run.metadata.featureVariant` at creation (see CRM's triage handler).

> **⚠ Spec changes require an RFC — this app is a conformant host, not a fork of
> the protocol.** If a feature needs anything on the OpenWOP **wire** — a new
> run-event field, capability flag, event type, endpoint contract, auth/scale
> profile, or a normative `MUST` — that change MUST be raised as a new **RFC in
> the `openwop` project** (`../openwop/RFCS/`, from `0000-template.md`) and reach
> at least `Accepted` *before/with* the host implementation. Do **not** invent
> wire shape here. Features that ride on **already-Accepted** RFCs need no new RFC
> — e.g. enterprise SSO (ADR 0002) implements the existing `openwop-auth-saml` /
> `openwop-auth-scim` profiles from **RFC 0050**, so it is host work, not a spec
> change. Host-extension surfaces under `/v1/host/sample/*` (like every feature
> here) are non-normative and never touch the wire, so they never need an RFC.

---

## Future features (placeholder)

Planned/candidate features land here first, then move up to **Current features**
once shipped. Keep the toggle id stable across the move.

| Feature | Proposed toggle id | Notes |
|---|---|---|
| _(none yet)_ | | Add a row when a feature is proposed. |

<!-- Template row:
| **<Name>** — <one-line> | `<id>` | OFF by default; bucketUnit `<user|tenant>`; variants `<…>`; packs `<feature.<id>.*|—>`. |
-->
