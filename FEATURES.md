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
| **CRM** (full port) — contacts, companies, deals, tasks, activities + pipelines/stages; contact-triage nodes | `crm` | OFF | `tenant` | `basic` / `enriched` (50/50), bound to the triage nodes | `feature.crm.nodes` | `/crm` (workspace) + `/v1/host/openwop-app/crm/contacts/*` + org-scoped `/crm/orgs/:orgId/*` (ADR 0008) |
| **CSM** — customer-success accounts + health score | `csm` | OFF | `tenant` | — (plain on/off) | — | `/csm` (workspace) + `/v1/host/openwop-app/csm/accounts/*` (ADR 0016) |
| **Users & Authentication** — durable accounts, lifecycle, email/password, MFA (TOTP), enterprise SSO (SAML 2.0 ACS + SCIM provisioning) | — (graduated off its toggle 2026-06-11, § Correction in `features/users/feature.ts` — permanent admin surface, always on) | ALWAYS ON | — | — | — | `/users` (admin · Access & data) + `/v1/host/openwop-app/users/*` (incl. `/users/mfa/*`) + SSO seam `/v1/host/openwop-app/auth/{saml/validate,scim/provision}` · identity foundation (ADR 0002/0003) |
| **Org invitations** — email-token invites to join an org as a member (orgs/members/roles owned by the `accessControl` surface, RFC 0049) | `orgs` | OFF | `tenant` | — (plain on/off) | — | `/v1/host/openwop-app/orgs/:id/invites` + `/orgs/invitations/accept` (ADR 0004, reconciled) |
| **User Profiles** — self-service per-user profile (avatar/portfolio via Media tokens, skills + peer endorsements, weighted completeness) + agent **pinning** (ADR 0023) + the per-user board/activity surfaces | — (graduated off its toggle 2026-06-12, § Correction in `features/profiles/feature.ts` — permanent substrate, always on: pinning + per-user surfaces ride on it) | ALWAYS ON | — | — | — | `/profile` + `/team` (workspace) + `/v1/host/openwop-app/profiles/*` (ADR 0005) |
| **Knowledge Base / RAG** — org-scoped document collections, ingest (pasted text or Media token) → chunk + embed, semantic search with citations | `kb` | OFF | `tenant` | — (plain on/off) | — (composes `core.openwop.rag` + host `db.vector`) | `/kb` (workspace) + `/v1/host/openwop-app/kb/orgs/:orgId/*` · reuses the host vector store + deterministic embedder (ADR 0011) |
| **Sharing** — unguessable public share links to a specific resource (CMS page incl. drafts, KB collection) + social-card metadata | `sharing` | OFF | `tenant` | — (plain on/off) | — (composes CMS + KB via a resolver registry) | authed `/v1/host/openwop-app/sharing/orgs/:orgId/links` + **public** `/v1/host/openwop-app/shared/:token` (unauthed, token-credential, toggle-gated) · admin **Content** group `/sharing` (ADR 0013) |
| **Forms** — org-scoped form builder; public submit → CRM contact (through `crmService`); `ctx.features.forms` + node/agent packs | `forms` | OFF | `tenant` | — (plain on/off) | `feature.forms.*` | authed `/v1/host/openwop-app/forms/orgs/:orgId/forms` + **public** `/v1/host/openwop-app/public-forms/:formId` (unauthed, published-only, toggle-gated) · `/forms` (workspace) (ADR 0017) |
| **Consent & Compliance** — region-aware consent policy + the centralized `isAllowed` gate (Analytics/Email call it) + data-subject GDPR erasure (cascades to feature data) | `consent` | OFF | `tenant` | — (plain on/off) | `feature.consent.*` | authed `/v1/host/openwop-app/consent/orgs/:orgId/*` + **public** `/v1/host/openwop-app/public-consent/:orgId` (unauthed, toggle-gated) · `/consent` (workspace) (ADR 0020) |
| **Analytics** — public-surface measurement (page/event/conversion) via a consent-gated beacon + authed reporting (counts, sessions, top paths, UTM); `ctx.features.analytics` + node/agent packs | `analytics` | OFF | `tenant` | — (plain on/off) | `feature.analytics.*` | authed `/v1/host/openwop-app/analytics/orgs/:orgId/{summary,events}` + **public beacon** `/v1/host/openwop-app/public-analytics/:orgId/collect` (unauthed, toggle+consent-gated) · `/analytics` (workspace) (ADR 0018) |
| **Email Marketing** — templates + campaigns over CRM contacts (audience resolved live), marketing-consent-gated sends through a stub provider, per-campaign stats + send log; `ctx.features.email` + node/agent packs | `email` | OFF | `tenant` | — (plain on/off) | `feature.email.*` | authed `/v1/host/openwop-app/email/orgs/:orgId/{templates,campaigns}` (incl. `/campaigns/:id/send`) · `/email` (workspace) (ADR 0019) |
| **Assistant capability + Chief of Staff** — the assistant operating-rhythm (structured memory graph + perception/action loops + approvals) is now a **core, profile-activated capability** (ADR 0023 §Correction / ADR 0031): no longer fused to `roleKey 'chief-of-staff'` — any agent with `agentProfile.capabilities:['assistant']` activates it over the shared tenant work-graph. "Iris" (Chief of Staff) is the seeded default; it is the foundation of the **Enterprise Work-Twin suite** (see note below). | — (graduated off its toggle 2026-06-11 — always-on substrate) | ALWAYS ON | — | — | `feature.assistant.{nodes,agents}` | `/agents/<chief-of-staff>` + `/v1/host/openwop-app/assistant/*` (graph/loops/briefing routes; loops deploy-gated on Google OAuth) |
| **Collaboration / Comments** — threaded comments on CMS pages + KB collections (resolver registry — a new commentable type is one entry); add/reply notify over the existing tenant inbox (namespaced string types, no core-union edit); `ctx.features.comments` + node/agent packs (content-reviewer) | `comments` | OFF | `tenant` | — (plain on/off) | `feature.comments.*` | `/comments` (workspace) + authed `/v1/host/openwop-app/comments/orgs/:orgId/comments` (ADR 0021 — Phases 1–3 + extension surface; presence/cursors deferred) |
| **Per-agent knowledge & memory** — bind documents (cited, KB-backed via `kbService`) + private notes (recalled via the RFC-0004 memory namespace) to a specific agent; composed into the agent's dispatch retrieval each turn. Core `knowledge` capability activated per `agentProfile`; retrieval composed in the host route layer (no feature→core import). Curation gated by workspace:read/write + per-agent IDOR + ADR 0036 profile policy | `agent-knowledge` | OFF | `tenant` | — (plain on/off) | `feature.agent-knowledge.nodes` (read; no agent pack) | authed `/v1/host/openwop-app/agents/:id/knowledge/*` (view · retrieve · bindings · collections · documents · notes · memory-writable) + read-only `ctx.features.agent-knowledge` · "Agent Knowledge" panel on the agent detail page (ADR 0038) |
| **Board of Advisors** — assemble councils of named advisor agents (digital-clone personas) + convene them together in one shared chat via `@@`: each advisor replies grounded in its OWN bound knowledge (ADR 0038, unchanged) and sees the others' turns (narrative-cast `[Name]:`), then a moderator synthesizes. Advisors are roster agents (persona = `agentProfile`, ADR 0031/0032); a new `AdvisoryBoard` grouping under `/advisors/*` — **not** `host.kanban`'s board. `private`/`shared` visibility + RBAC; simulated-persona disclaimer + living-individual ack gate. Composes the host multi-agent conversation scaffold + the assistant moderator (0023); host work riding Accepted RFC 0005/0002 §A8 (no blocking RFC). | `advisory-board` | OFF | `tenant` | — (plain on/off) | — (read-only `ctx.features.advisory-board` surface; signed node pack + `tmpl.advisors.*` seed deferred, logged in ADR 0040) | authed `/v1/host/openwop-app/advisors/*` (boards CRUD · convene · sessions) · "Board of Advisors" workspace page (ADR 0040, Phases 1–5) |

> Defaults are OFF — a superadmin turns a feature on (or to BETA, or on with a
> traffic split) per tenant from the admin screen.
>
> **Surfaces intentionally NOT in this toggle catalog** (always-on; no
> `toggleDefault`):
> - **Notifications** (removed 2026-06-11) — **core platform infrastructure**:
>   run-failure/interrupt notifications emit unconditionally, so a toggle only hid
>   the UI while side effects flowed; the honest control is the per-user
>   **preferences** (mute / quiet-hours / Web-Push opt-in). See
>   `docs/adr/0010-notifications.md` § Correction.
> - **CMS + Page Builder** (`/cms`), **Media Library** (`/media`), **Publishing &
>   SEO** (authed `/v1/host/openwop-app/publishing/*` + **public**
>   `/v1/host/openwop-app/public/:orgId/*`) — made always-on 2026-06-11 (**ADR 0027**):
>   core content tooling that powers the **public CMS-driven front page** at `/`.
>   Their routes keep org-scoped RBAC (`requireOrgScope`); only the toggle gate is
>   gone. Their nav moved from the main Sidebar to the admin-tier **Content** group.
>   For Publishing, the per-tenant "site online" toggle is gone: the CMS editorial
>   **`published` status is now the sole public gate** (Sharing covers
>   private/draft access). A previously-saved per-tenant override for these ids is
>   retired at boot (`RETIRED_TOGGLE_IDS`).
> - **Connections** (removed 2026-06-11) graduated off its toggle to a **permanent
>   admin surface** — the generic per-user/per-org credential broker (Google/Slack/
>   ServiceNow/Zoom: provider-manifest registry + api_key/bearer + OAuth2 consent +
>   most-specific resolver, secrets via the BYOK KMS envelope, injected into the
>   existing MCP/HTTP/integration nodes) now lives in **Admin → Access & data** and
>   serves unconditionally. See `docs/adr/0024-connections-credential-broker.md`
>   § Correction.
> - **Widgets** is the env-gated reference *example*
>   (`OPENWOP_EXAMPLE_WIDGETS_ENABLED`), not a product feature.
>
> All remain `BackendFeature`s for code organization; none registers a
> `toggleDefault`.
>
> **The public front page** (ADR 0027): **ON by default**, and **editable by the
> super admin** regardless of any org. The homepage is the host-level **system
> site** page — a normal CMS page in a RESERVED org `host-site` under a reserved
> tenant `host:site` (a `host:` prefix no real principal can hold), seeded with a
> default marketing page and served at `/` to anonymous visitors via the public
> Publishing API. A super admin edits it at **Admin → Content → "Front page"**
> (`/front-page`) — enable/disable + the shared section editor (`SectionsEditor`) —
> through the `requireSuperadmin`-gated `GET/PUT /v1/host/openwop-app/site-page`, which
> drives `cmsService` on the reserved org by HOST authority (it bypasses
> `requireOrgScope` for that one org only; every real tenant's isolation is
> untouched). The anonymous SPA reads `GET /v1/host/openwop-app/public-site-config`
> (unauthed; `{ enabled, orgId:'host-site', slug:'home' }`) and renders the
> published page via the shared `SectionRenderer`. Signed-in visitors still get the
> app (Chat) at `/`. A fork that wants `/` to be the app by default sets
> `OPENWOP_FRONTPAGE_DEFAULT_ENABLED=false`. Superadmin gate fails closed
> (`OPENWOP_SUPERADMIN_TENANTS`). Mirrors MyndHyve's global admin-owned homepage.

**Two architecture notes (recent work):**

- **`tenant` = workspace (ADR 0015).** A `tenant`-bucketed toggle now scopes to the
  caller's **active workspace** — a personal workspace for a solo/anon user, or a
  shared B2B workspace many members join (with `owner`/`admin`/`editor`/`viewer`
  roles). Bucketing + per-scope overrides are unchanged; only the noun moved
  (tenant → workspace). See `docs/adr/0015-workspace-as-tenant-b2b.md`.
- **Some product features also expose a workflow surface (ADR 0014).** CRM and KB
  (among others — assistant/comments/forms/consent/csm/email/analytics) are
  `FeatureModule`s: beyond their REST + UI faces they register a typed
  `ctx.<feature>` workflow surface (sharing the *same* toggle + RBAC guards),
  advertised at `/.well-known/openwop`, so workflow nodes can read/write feature
  data. The toggle gates all faces at once. (Corrected 2026-06-11 per ADR 0027:
  **CMS and Media declare no `ctx` surface** — they are plain `BackendFeature`s,
  so making them always-on does not touch any capability advertisement.) See
  `docs/adr/0014-feature-workflow-surfaces.md`.

### Enterprise Work-Twin agent suite (2026-06-13)

A seeded portfolio of **ten role-based "work twins"** ships in the demo (replacing
the five earlier demo personas), all riding the existing roster/agent/workflow/
schedule/connection seams — not a parallel system (ADR 0031/0032/0033):

- **The ten twins** (`host/seed-data/exampleAgents.json`): Chief of Staff (Iris),
  Executive Operations, Sales Execution (binds `crm`), Customer Success (binds
  `csm`), Finance Close, IT Service Desk, Internal Communications (binds `cms`/
  `kb`), Recruiting Coordinator, People Operations, Contract & Procurement. Each is
  a real roster agent with a system prompt, workflow portfolio, schedules, board,
  and autonomy. Seeded idempotently through the existing `seedDemoAgents` path; the
  legacy 5 personas are retired with guarded migration.
- **`agentProfile`** (ADR 0031) — a non-normative host-extension at
  `GET/PUT /v1/host/openwop-app/agents/:id/profile` (+ view/edit UI) carrying every
  enterprise property the thin `UserAgentRecord` could not: config parameters,
  permissions, HITL requirements, escalation, channels, admin controls,
  risk/compliance, `requiredConnections`, metrics, the 4-level→3-level autonomy
  mapping, and `capabilities` (the core-capability activation flag).
- **Shared workflow-template pack** (`host/workflowTemplates.ts`) — 44 pinned,
  reusable `tmpl.*` workflow definitions across 11 categories (meeting-ops,
  reporting, intake/triage, scheduling, approvals, knowledge, people, finance,
  commercial, IT, comms), composed by the twins via `core.subWorkflow`. Every
  side-effecting flow is `core.approvalGate`-gated (draft/recommend day-1).
- **Connector reachability** (ADR 0033) — day-1 honesty: twins run at
  draft/recommend over wired surfaces (internal features + google/slack via
  brokered HTTP / the outbound MCP client). External write integrations are
  **deploy-gated** behind a configured Connection via `requiredConnections`
  activation gating (fail-closed, advertised `supported:false` until configured).
  New RFC 0095 connection packs added: `microsoft365`, `jira`, `salesforce`,
  `notion`, `workday` (under `examples/connection-packs/`). External-event triggers
  and async A2A are deferred (RFC-gated, out of day-1 scope).

### Env-gated operational flags (not feature-toggles)

Some behavior is gated by a deploy-time env var rather than the per-tenant
toggle system:

- **`OPENWOP_AUTHORIZATION_ENFORCEMENT`** (default off) — RFC 0049 / ADR 0006
  Phase 3. When `true`, the host enforces membership-derived RBAC scopes on the
  protocol runs/artifacts surface (`runs:create` / `runs:read` / `runs:cancel` /
  `artifacts:read`), serves the `POST /v1/host/openwop-app/authorization/decide` seam,
  and advertises `capabilities.authorization.supported: true`. **Off (default):
  no protocol-surface enforcement, the seam 404s, and the capability advertises
  `supported: false`** — every caller authenticated by Bearer/OIDC but without an
  `accessControl` membership is unaffected. Only enable it where the caller
  population is provisioned as `accessControl` members; otherwise legitimate
  callers (incl. wildcard/conformance principals) fail closed with `403 forbidden`.
  Management routes under `/v1/host/openwop-app/orgs/*` enforce their `host:*` scopes
  unconditionally regardless of this flag.

---

## Adding a feature

A new feature is wired by **appending** to the registries — no edits to core
route/nav code (see ADR 0001 §2.2, §4 for the worked CRM example).

> **Every feature MUST have a related ADR.** Before (or with) the code, author an
> Architecture Decision Record under [`docs/adr/`](docs/adr/) named
> `NNNN-<kebab-slug>.md` (zero-padded, sequential — the set runs `0001`–`0016`
> today), opening with a `Status:` line (`Proposed` → `Accepted` → `implemented`).
> The ADR is the recorded decision behind the toggle: the **Current features** table
> above cites each feature's ADR, and [`ROADMAP.md`](ROADMAP.md) tracks the
> per-feature ADR plan. A feature-package with no ADR is the exact drift this repo
> guards against (it's why CSM later needed the retroactive ADR 0016). See
> `CLAUDE.md` § "Tracking architectural changes" for what goes in one — and note a
> change that touches the **wire** additionally needs an RFC in `openwop`, not just
> an ADR here.

0. **ADR** — add `docs/adr/NNNN-<slug>.md` (Status `Proposed`/`Accepted`); mark it
   `implemented` once the phases below ship. Author auth/RBAC/wire-touching ADRs
   with the `/architect` skill.
1. **Backend** — create `backend/typescript/src/features/<id>/`:
   - `<id>Service.ts` — domain logic (durable store, tenant-scoped).
   - `routes.ts` — routes under `/v1/host/openwop-app/<id>/*`, each gated by
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
   `npm test` (backend). Add the feature to the **Current features** table above
   (cite its ADR), and mark the ADR `implemented` (phase ledger).
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
> change. Host-extension surfaces under `/v1/host/openwop-app/*` (like every feature
> here) are non-normative and never touch the wire, so they never need an RFC.

---

## Future features (placeholder)

Planned/candidate features land here first, then move up to **Current features**
once shipped. Keep the toggle id stable across the move.

| Feature | Proposed toggle id | Notes |
|---|---|---|
| **Marketplace** — browse + install signed feature packs (node/agent packs) + reviews/ratings | `marketplace` | OFF; bucketUnit `tenant`; ADR 0022. Composes the signed pack registry (Ed25519 + SRI); reviews are the only new store. |

> **Board of Advisors** (ADR 0040) graduated to **Current features** above
> (Phases 1–5 shipped 2026-06-14). Phase 6 (normative cross-host multi-party) is
> deferred, gated on RFC 0101 (Parked).

> Each batch feature also ships a **node pack + agent pack** and a `ctx.<feature>`
> **workflow surface** (ADR 0014) behind the same toggle — see each ADR's
> "Core-app extension surface" section. ADRs 0017–0022 are authored (Status:
> Proposed); they move to **Current features** as their phases land.

<!-- Template row:
| **<Name>** — <one-line> | `<id>` | OFF by default; bucketUnit `<user|tenant>`; variants `<…>`; packs `<feature.<id>.*|—>`. |
-->

### How this roadmap is populated — porting MyndHyve

This app's feature roadmap is being **populated by porting the MyndHyve product
catalog** (`/Users/david/dev/myndhyve/FEATURES.md`) into openwop-app, sequenced in
[`ROADMAP.md`](ROADMAP.md). The identity → authorization → content → CRM stack
(ADRs 0002–0016) is the first wave. **Every ported feature uses the MyndHyve
implementation as a _baseline reference_ — never a copy.** MyndHyve is a Firebase
monolith (Firestore stores, Cloud Functions, canvas-type machinery); here each
feature is rebuilt as a self-contained, toggle-gated **host-extension
feature-package** per [ADR 0001](docs/adr/0001-feature-first-package-architecture.md):
backend `src/features/<id>/` (routes under `/v1/host/openwop-app/<id>/*`, gated by
`resolveOne('<id>', subject).enabled`) + frontend `src/features/<id>/`, appended to
`BACKEND_FEATURES` / `FRONTEND_FEATURES`, a `tenant`-bucketed toggle that scopes to
the active workspace (ADR 0015), and — where workflow nodes need feature data — a
typed `ctx.<feature>` workflow surface behind the *same* toggle + RBAC guards
(ADR 0014). **It is a port, not a clone:** where MyndHyve's implementation has a
known wart (it lists several under § "Surprising / risky" dependencies), we take the
*capability* as the baseline and correct the *shape* to our architecture.

#### Next high-value batch — the Growth & Engagement loop (ADRs 0017–0020)

With the public surface now live (Publishing 0012, Sharing 0013) on top of CRM (0008)
and CMS (0009), the highest-value next batch closes the **capture → measure → engage →
govern** loop on that surface. All four already exist as discrete `src/features/`
modules in MyndHyve (clean baselines), all compose surfaces we just shipped, and none
require MyndHyve's canvas-type / workflow-engine machinery (deliberately out of scope).

- **Forms** (`forms`, ADR 0017) — _MyndHyve §"Forms"._
  **Baseline:** the live submission API `functions/src/formApi.ts` (rate-limited,
  honeypot, flat submissions) + the (orphaned in MyndHyve) builder under
  `src/canvas-types/campaign-studio/forms` (`FormStepManager` / `EnhancedFormBuilder`,
  `ConditionalLogicEngine`, `ValidationEngine`) + `src/core/entities/components/forms`.
  **Our architecture:** a `forms` feature-package owning form definitions + submissions
  (tenant/workspace-scoped), a **public** submit endpoint (same unauthed,
  toggle-gated pattern as Publishing/Sharing), and form→contact creation that routes
  **through the `crmService` API** — *not* the direct contacts-collection write
  MyndHyve flags as a risky coupling. Multi-step + conditional logic ported as the
  builder matures; v1 ships single-step + validation.

- **Analytics** (`analytics`, ADR 0018) — _MyndHyve §"Analytics"._
  **Baseline:** `src/features/analytics/{AnalyticsService,ABTestingService,WebVitalsService}.ts`
  + `src/features/tracking/clickIdCapture.ts` (fbclid/gclid/ttclid/li_fat_id) +
  `functions/src/conversions-api/` (server-side Meta / TikTok / Google Offline).
  **Our architecture:** an `analytics` feature ingesting page/event hits from the
  **public published-page surface** (composes Publishing 0012) with UTM + click-id
  capture and conversion events. **Reuse, don't rebuild, A/B:** experiment splitting is
  already the host's sticky-bucketing variant engine — Analytics only *reports* on it
  rather than re-porting `ABTestingService`. Conversions API runs behind the host's
  egress/SSRF policy with BYOK provider tokens.

- **Email Marketing** (`email`, ADR 0019) — _MyndHyve §"Email Marketing"._
  **Baseline:** `src/features/email-marketing/` — `MultiProviderCoordinator`, the 7
  client `adapters/`, `envelope/` + `services/` + `stores/`.
  **Our architecture:** an `email` feature owning campaigns + templates targeting CRM
  contacts (composes CRM 0008), with a **provider-adapter seam** behind an honest
  capability gate — ship a console/stub adapter first (mirroring Notifications' existing
  email-webhook stub) and advertise a provider only when its credentials are configured.
  No Cloud Functions; the CRM↔email event bridge is deferred (MyndHyve marks it Partial).

- **Consent & Compliance** (`consent`, ADR 0020) — _MyndHyve §"Consent & Compliance"._
  **Baseline:** `src/features/consent/{ConsentManager,ConsentEnforcer}.ts` (region-aware,
  3 categories: necessary / analytics / marketing).
  **Our architecture:** a `consent` feature whose enforcement **gates** the Analytics
  tracking + marketing-email surfaces above — the legal companion that becomes necessary
  the moment Forms and Analytics touch public visitors. Composes the other three rather
  than standing alone; webhook-signature / unsubscribe primitives already exist host-side.

> **Sequencing:** 0017 (Forms) ∥ 0018 (Analytics) — both only need shipped surfaces
> (CRM / Publishing). 0019 (Email) needs CRM. 0020 (Consent) is authored alongside but
> lands last, since it gates 0018 + 0019. Author each ADR with `/architect` (every one
> touches the public surface, RBAC, or egress) **before** the implementation, then add
> the row to **Current features** and mark the ADR `implemented` per the lifecycle above.

> **Beyond this batch** (noted, not sequenced): **Collaboration & Presence** (comments
> on CMS pages / KB collections — higher-infra, was a deliberate CMS-v1 cut),
> **Connectors & Integrations**, **Messaging Gateway**, **Marketplace**, and the
> **Production Intelligence** completion (Vendor Directory + ProductionPlanService — ADR
> 0005 ported only Team Profiles). **Billing / E-Commerce** stay explicitly cut
> ([ROADMAP.md](ROADMAP.md) § "Out of scope"). Update ROADMAP.md's Overview table when
> this batch is accepted so the two docs stay in lockstep.
