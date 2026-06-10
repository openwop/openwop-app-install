# ROADMAP.md — openwop-app feature port

The sequenced plan for porting key product capabilities from the **MyndHyve**
platform into openwop-app, as toggle-gated feature packages.

> **Source of truth for the port:** `/Users/david/dev/myndhyve/FEATURES.md`
> (§ references below point at its sections).
> **Target architecture:** every feature here is a self-contained package per
> [`docs/adr/0001-feature-first-package-architecture.md`](docs/adr/0001-feature-first-package-architecture.md)
> — backend `src/features/<id>/`, frontend `src/features/<id>/`, `feature.<id>.*`
> packs, gated by a server-authoritative toggle (see [`FEATURES.md`](FEATURES.md)
> § "How the feature-toggle system works").
> **How to read this:** the Overview table is the contract; the Build sequence
> shows what unblocks what; each ADR block carries the per-feature detail.

## Conventions for this roadmap

- **ADR number** — each feature gets its own Architecture Decision Record under
  `docs/adr/NNNN-<slug>.md`, authored **before/with** the implementation per
  CLAUDE.md § "Tracking architectural changes". Numbers are sequential and
  zero-padded; `0001` is taken (feature-first architecture), so this port starts
  at **0002**. Author each with the `/architect` skill — every feature here
  touches auth, RBAC, or replay/fork safety, which is exactly when an ADR matters.
- **Toggle id** — stable kebab id used by the feature-toggle registry; survives
  the move from this roadmap → `FEATURES.md` § "Current features".
- **Pack slug** — the `feature.<id>.*` pack(s) published to **`packs.openwop.dev`**
  (signed: SHA-256 SRI + Ed25519 over `pack.json` per the registry pipeline).
  Pack presence is decoupled from toggle state, so historical runs always resolve
  their nodes (FEATURES.md § "Replay-safe variant stamps").
- **Status legend:** 🔵 Planned · 🟡 In Progress · 🟢 Done · ⚪ Exists (extend)

## Per-feature workflow (applied to every ADR below — do NOT execute yet)

Each feature, when its turn comes, follows the same lifecycle. This roadmap only
*plans* the sequence; nothing here ships until its ADR is accepted.

1. **Author the ADR** (`docs/adr/NNNN-<slug>.md`, Status: Proposed) — decision,
   alternatives, phased plan, open questions. Use `/architect`.
2. **Build the package** — backend `src/features/<id>/` (service + routes gated by
   `resolveOne('<id>', subject).enabled`) + frontend `src/features/<id>/`, appended
   to `BACKEND_FEATURES` / `FRONTEND_FEATURES` (no edits to core route/nav code).
3. **Ship its packs** — `feature.<id>.*` under `packs/`, declared in `requiredPacks`,
   then **published to `packs.openwop.dev`** through the signed registry pipeline.
4. **Document it** — add a row to **this repo's** [`FEATURES.md`](FEATURES.md)
   § "Current features"; mark the ADR `implemented` (phase→commit/test table).
5. **Verify** — `( cd frontend/react && npm run build )` + `( cd backend/typescript && npm test )`.

---

## Overview

| ADR  | Feature                     | Toggle id  | Depends on        | Pack slug                | Status      | MyndHyve § |
|------|-----------------------------|------------|-------------------|--------------------------|-------------|------------|
| 0002 | Users & Authentication      | `users`    | —                 | `feature.users.*`        | 🟢 Done     | Authentication & Identity |
| 0003 | Canonical identity + session binding | — (core auth) | 0002     | — (core auth)            | 🟢 Done     | (refines 0002; RFC 0048 owner) |
| 0004 | Org invitations (orgs/roles → accessControl) | `orgs` | 0002, 0003 | —           | 🟢 Done     | Workspaces & Teams (via accessControl) |
| 0005 | User Profiles               | `profiles` | 0002              | `feature.profiles.*`     | 🟢 Done (full parity) | Production Intelligence (Team Profiles) |
| 0006 | Roles & Permissions (RBAC) — extends `accessControl` (RFC 0049) | — (core) | 0003, 0004 | — | 🟢 Done (Phases 1–3) | Enterprise (RBAC), Admin Panel |
| 0007 | Media Library               | `media`    | 0004, 0006        | `feature.media.*`        | 🟢 Done     | Page Builder (Media), Feature Architecture |
| 0008 | CRM (full port)             | `crm`      | 0004, 0006        | `feature.crm.*`          | 🟢 Done (extended) | CRM System |
| 0009 | CMS + Page Builder          | `cms`      | 0004, 0006, 0007  | `feature.cms.*`          | 🟢 Done     | CMS System, Page Builder |
| 0010 | Notifications (migrate + upgrade) | `notifications` | 0002, 0004, 0006 | `feature.notifications.*` | 🟢 Done (Phases 1–3) | Notifications |
| 0011 | Knowledge Base / RAG        | `kb`       | 0004, 0006, 0007  | `feature.kb.*`           | 🟢 Done (Phases 1–3) | Knowledge Base (RAG) |
| 0012 | Publishing & SEO            | `publishing` | 0004, 0006, 0007, 0009 | `feature.publishing.*` | 🟢 Done (Phases 1–3) | Publishing & SEO |
| 0013 | Sharing (public links)      | `sharing`  | 0004, 0006, 0009, 0011 | `feature.sharing.*`      | 🟢 Done (Phases 1–3) | Sharing |

> **ADR-0003 (Canonical identity & session binding) was inserted** as a
> foundational refinement of ADR-0002 — it makes `User.userId` the one subject
> identity, binds the session on login, and stamps a stable opaque `user:<userId>`
> run owner (RFC 0048). It shifted the product-feature ADR numbers +1; RBAC (0006)
> now depends on it (roles bind to the canonical subject). See
> `docs/adr/0003-canonical-user-identity-session-binding.md`.

> ⚪ **CRM already exists** as a *basic* toggle-gated feature (`crm`, contacts +
> contact triage, `feature.crm.nodes`; see FEATURES.md § "Current features").
> ADR-0008 **extends** it to the full MyndHyve CRM surface — it does not create a
> new toggle. Keep the `crm` id stable.

> ⚪ **Notifications already exist** — a comprehensive, production-ready subsystem
> (in-app inbox + bell, SSE live feed, Web-Push/VAPID, an email-webhook stub, and
> run-lifecycle emit hooks). But it is **core-bootstrapped** (`src/bootstrap/
> notifications.ts` + `src/notifications/` + core route modules), **always-on**,
> and **tenant-scoped** — it is NOT in the feature-package architecture (ADR 0001).
> ADR-0010 **migrates** it into `features/notifications/` (a `BackendFeature`,
> toggle-gated) and **upgrades** it (durable preferences) — it does not rewrite the
> working surface/storage/UI. A migration, not a greenfield build.

## Build sequence

```
0002 Users ─ 0003 Canonical identity ─┬─ 0004 Orgs ─ 0006 RBAC ─┬─ 0007 Media ─┬─ 0009 CMS + Page Builder
                                       │                         │              └─ 0011 Knowledge Base / RAG
                                       └─ 0005 Profiles          ├─ 0008 CRM
                                                                 └─ 0010 Notifications (migrate existing)

(RBAC + Orgs gate every product surface; Media feeds both CMS and the KB.)
```

| Tier | ADRs | Can build in parallel once deps land |
|------|------|--------------------------------------|
| 1 — Identity foundation | 0002, 0003 | 0003 (canonical identity) lands with/after 0002 |
| 2 — Identity build-out  | 0004, 0005 | 0004 ∥ 0005 (both only need 0002) |
| 3 — Authorization       | 0006 | needs 0003 (canonical subject) + 0004 |
| 4 — Shared services     | 0007 | needs 0004 + 0006 |
| 5 — Product surfaces    | 0008, 0009 | 0008 (CRM) ∥ 0009 (CMS); 0009 also needs 0007 |
| 6 — Post-core extensions | 0010, 0011, 0012, 0013 | 0010 (Notifications, migrate existing) ∥ 0011 (KB/RAG); 0011 needs 0007 (Media); 0012 (Publishing & SEO) needs 0009 (CMS) + 0007 (Media OG images); 0013 (Sharing) needs 0009 (CMS) + 0011 (KB) — the resources it links to |

### Why this order (from MyndHyve's dependency graph)

MyndHyve's FEATURES.md § "Feature Dependencies" resolves into Foundation →
Platform Services → Product Surfaces. The same layering drives this port:

- **Identity before everything.** In MyndHyve, *Auth & Identity* (~15 dependents)
  and *Workspaces* underpin RBAC, billing, admin, and every product surface.
  openwop-app today only resolves a principal from the authenticated subject +
  `tenantId` (superadmin via `OPENWOP_SUPERADMIN_TENANTS`); there is no real user /
  org / profile management. So 0002–0005 are genuinely foundational here, not
  cosmetic.
- **Canonical identity before authorization.** ADR-0003 makes `User.userId` the
  one subject; RBAC (0006) binds roles to that subject, so it must land first
  (otherwise roles fragment per auth method — see the ADR-0003 `/architect`
  findings) → 0006 depends on 0003.
- **RBAC needs the canonical subject + Orgs.** MyndHyve permissions are
  org/workspace-scoped (owner/admin/editor/viewer); RBAC can't resolve a role
  without a stable subject and a tenant to scope it to → 0006 depends on 0003 + 0004.
- **CRM needs Orgs + RBAC.** MyndHyve CRM keys off persistence + role/audit; in
  this app CRM data is already `bucketUnit: 'tenant'`-scoped, so it must sit on top
  of formal Orgs + RBAC → 0008 depends on 0004 + 0006.
- **CMS needs Media (+ Orgs + RBAC).** MyndHyve § "Feature Dependencies": *CMS
  requires Page Builder, Media, Publishing, Collaboration, Enterprise(RBAC)*; *CMS
  ⇄ Page Builder* is an intended co-dependent pair that ships together. We bundle
  Page Builder into the CMS ADR and pull Media out as its own prerequisite (0007),
  because Media is independently useful and is the one hard upstream dep → 0009
  depends on 0004 + 0006 + 0007.

---

## Features

### ADR-0002 — Users & Authentication
**Toggle:** `users` · **Depends on:** none · **Pack:** `packs.openwop.dev/feature.users`
**Status:** 🟢 Done (Phases 1–5 shipped) · **MyndHyve §:** Authentication & Identity

The identity foundation. Today the app derives a principal from the authenticated
subject + `tenantId` with no first-class user records; this introduces durable,
tenant-scoped user accounts and the account lifecycle everything else authorizes
against.

**Scope (port from MyndHyve "Authentication & Identity")**
- [ ] User accounts — durable user records, account lifecycle (create/disable/enable)
- [ ] Email/password auth + password reset + email verification
- [ ] Session management — auth-state persistence, re-auth for sensitive ops
- [ ] (Defer) Google OAuth, break-glass/TOTP MFA → note as follow-on, not v1

**Notes / decisions for the ADR**
- Reconcile with the existing superadmin gate (`OPENWOP_SUPERADMIN_TENANTS`) — does
  a `users` row supersede or complement env-listed admins?
- Replay/fork safety: a run references its creating principal — confirm that survives
  `:fork` (mirror the `run.metadata` decision from ADR 0001).

---

### ADR-0003 — Canonical user identity & session binding
**Toggle:** — (core auth, not a feature pack) · **Depends on:** ADR-0002 · **Pack:** — (core)
**Status:** 🟢 Done (Phases 1–3 shipped; Phase 4 with ADR-0006) · **Refines:** ADR-0002

The foundational refinement that closes ADR-0002's identity seam: `User.userId` is
the ONE canonical subject. The session binds to it on login; the principal stamped
on runs is a stable, opaque `user:<userId>` (RFC 0048 — non-PII, fork-stable owner).
This unblocks RBAC (0006) — roles bind to the canonical subject. See
`docs/adr/0003-canonical-user-identity-session-binding.md`.

---

### ADR-0004 — Organizations (reconciled → org invitations)
**Toggle:** `orgs` · **Depends on:** ADR-0002, ADR-0003 · **Status:** 🟢 Done (reconciled)

> **Reconciled.** A route-test harness found the app already had a full
> Organizations / members / **roles** surface (`accessControl`, RFC 0049),
> always-on at `/v1/host/sample/orgs`. The initial org-as-tenant feature collided
> with and duplicated it. Per the `/architect` options review (option B),
> **accessControl is the single owner of orgs/members/roles**, and the `orgs`
> feature was reduced to the one additive thing it lacked: **email-token
> invitations** that delegate to accessControl (`createMember` with the invited
> RFC-0049 role, bound to `User.userId`). The org-as-tenant model, membership
> tier, active-org switch, and personal-org were removed. See
> `docs/adr/0004-organizations.md` § Correction.

**Shipped**
- [x] Email-token invitations (create / list / revoke / accept), 7-day expiry,
      single-use, email-ownership-gated, replacing stale tokens.
- [x] Delegation to `accessControl` (orgs/members) + RFC-0049 scope authz.
- [x] Route-test harness proving the end-to-end onboarding flow over HTTP.

**Owned by accessControl (not this feature)**
- Org CRUD, members, teams, groups, roles → `accessControlService` (RFC 0049).

**Deferred to ADR-0006 (RBAC) / ADR-0003 Phase 4**
- Multi-principal-tenant "workspace switch"; wiring RFC-0049 scopes onto the
  protocol runs/artifacts surface; explicit owner-member seeding.

**Notes / decisions for the ADR**
- Map MyndHyve's "personal workspace per user" concept — does every user get a
  default personal org?

---

### ADR-0005 — User Profiles
**Toggle:** `profiles` · **Depends on:** ADR-0002 · **Pack:** `packs.openwop.dev/feature.profiles`
**Status:** 🔵 Planned · **MyndHyve §:** Production Intelligence (Team Profiles)

Self-service per-user profile data. Parallelizable with Orgs — only needs Users.

**Scope (port from MyndHyve "Team Profiles" / "My Profile")**
- [ ] Profile CRUD — display name, avatar, contact, bio
- [ ] Self-service rule — a user edits their own profile; admins get read views
- [ ] Profile completeness scoring (weighted by field importance)
- [ ] (Defer) capability/skills/portfolio fields (MyndHyve Production Intelligence)
      until there's a consumer for them

**Notes / decisions for the ADR**
- MyndHyve enforces self-service via Firestore rules; here it's a backend-authority
  check in `routes.ts` (`resolveOne` + owner check). Confirm the owner predicate.

---

### ADR-0006 — Roles & Permissions (RBAC) — extends `accessControl`
**Owner:** `accessControlService` (RFC 0049 roles→scopes) · **Depends on:** ADR-0003, ADR-0004
**Status:** 🟡 Phases 1–2 done · See `docs/adr/0006-rbac.md`

> **Not a new feature.** A boundaries audit found `accessControl` already owns
> orgs / members / **roles** (RFC 0049 scopes, fail-closed). ADR-0006 **completes**
> it: subject = `User.userId`; authority membership-derived; advertise
> `capabilities.authorization` only when it's honestly enforced on the wire.

**Phase 1 (done)** — explicit, `userId`-bound owner member seeded at org creation
(removes the `tenant==principal` implicit-owner gap accessControl flagged;
composes with ADR-0004's userId-bound invited members). Additive + back-compat.

**Phase 2 (done)** — authority is the caller's own subject scoped to the org
(membership-derived); the implicit tenant-owner is gone (an authenticated
non-member gets zero scopes); two users in one tenant get distinct authority.
Create-org bootstraps on `requireAuthenticated`.

**Phase 3 (deferred, wire)** — enforce RFC-0049 scopes on the protocol
runs/artifacts surface + the `authorization/decide` seam, then advertise
`capabilities.authorization` ONLY when conformance passes (no false oracle).

---

### ADR-0007 — Media Library
**Toggle:** `media` · **Depends on:** ADR-0004, ADR-0006 · **Pack:** `packs.openwop.dev/feature.media`
**Status:** 🔵 Planned · **MyndHyve §:** Page Builder (Media) + Feature Architecture

Org-scoped asset store. Pulled out of CMS because it's the one hard upstream
dependency CMS/Page Builder need, and is reusable on its own.

**Scope (port from MyndHyve "Media Library")**
- [ ] Asset upload / organize / search, org-scoped collections
- [ ] Usage tracking; storage adapter (start with the demo-grade in-memory/blob
      surface `ctx.storage.blob`, with the real-backend swap as a one-file change)
- [ ] (Defer) image optimization (srcset/WebP/AVIF), Knowledge-Base indexing co-dep

**Notes / decisions for the ADR**
- MyndHyve has a *Media ⇄ Knowledge Base* co-dependency. Cut that here: Media ships
  standalone; KB is out of scope for this roadmap.

---

### ADR-0008 — CRM (full port) ⚪ extends existing feature
**Toggle:** `crm` (existing) · **Depends on:** ADR-0004, ADR-0006 · **Pack:** `packs.openwop.dev/feature.crm`
**Status:** ⚪ Exists (basic) → extend · **MyndHyve §:** CRM System

CRM already ships as a *basic* feature (contacts + contact triage, `basic`/`enriched`
variants, `feature.crm.nodes`). This ADR grows it toward the full MyndHyve CRM
surface, now sitting on formal Orgs + RBAC instead of bare tenant scoping.

**Scope (port from MyndHyve "CRM System", incrementally)**
- [ ] Entities beyond Contacts — Companies, Deals, Tasks, Activities (phase the rest)
- [ ] Pipeline management — custom stages, probability
- [ ] Custom fields per entity
- [ ] CSV/JSON import — column mapping, validation, dedup
- [ ] RBAC gating on every CRM route (consumes ADR-0006)
- [ ] (Defer) lead scoring, sequences, e-commerce-coupled entities, email event-bridge
- [ ] Preserve the existing replay-safe variant stamp (`run.metadata.featureVariant`)

**Notes / decisions for the ADR**
- MyndHyve "CRM hard-depends on E-Commerce types" — a *surprising/risky* edge. Do
  **not** inherit it: keep CRM entities self-contained so CRM ships without commerce.
- Keep `bucketUnit: 'tenant'` (CRM is a shared B2B surface).

---

### ADR-0009 — CMS + Page Builder
**Toggle:** `cms` · **Depends on:** ADR-0004, ADR-0006, ADR-0007 · **Pack:** `packs.openwop.dev/feature.cms`
**Status:** 🔵 Planned · **MyndHyve §:** CMS System + Page Builder

The content surface. MyndHyve treats CMS and Page Builder as an intended
co-dependent pair that ships together, so they're one ADR here. Needs Media for
assets and RBAC for editorial access.

**Scope (port from MyndHyve "CMS System" + "Page Builder", phased)**
- [ ] Page model + section-based editor (start with a core section set, not all 28)
- [ ] Page Builder — section CRUD, schema-driven forms, responsive preview
- [ ] Media integration (consumes ADR-0007)
- [ ] Content versioning + editorial workflow (approval gate — reuse `core.hitl.approval-request`)
- [ ] RBAC-gated CMS access (consumes ADR-0006)
- [ ] Routing — slug generation, redirects
- [ ] (Defer) localization, personalization/A-B, search providers, publishing/SEO,
      comment moderation → follow-on ADRs

**Notes / decisions for the ADR**
- MyndHyve's CMS workflow gate is unconditional (publish blocked unless stage is
  approved/published). Decide whether to port that always-on gate or make it a
  toggle variant from day one.
- Editorial approval is a natural fit for the existing OpenWOP interrupt mechanism
  (`approval` kind) rather than a bespoke gate.

---

### ADR-0010 — Notifications (migrate existing → feature architecture + upgrade)
**Toggle:** `notifications` · **Depends on:** ADR-0002, ADR-0004, ADR-0006 · **Pack:** `packs.openwop.dev/feature.notifications`
**Status:** 🟢 Done (Phases 1–3, PR #74) · **MyndHyve §:** Notifications · ⚪ **Exists (core-wired) → migrated**

Unlike every prior ADR, this is a **migration**, not a greenfield build. The app
already ships a comprehensive notifications subsystem — it just isn't in the
feature-package architecture (ADR 0001). The job is to lift it into `features/`
and upgrade the gaps, **without regressing the working surface**.

**What exists today (preserve):**
- In-app **inbox + bell + unread badge**, a notification **panel/drawer**, an
  inbox page, an approvals inbox, an SSE **live feed**, desktop (Web Notifications)
  toasts.
- **Web-Push (RFC 8030 / VAPID)** — real, env-gated (`OPENWOP_VAPID_*`); per-tenant
  multi-device `push_subscriptions`; 404/410 pruning.
- An **email/SMS webhook** delivery stub (`/v1/host/sample/messaging/notify`).
- **Run-lifecycle emit hooks** — interrupts (approval/clarification), run failure,
  run completion emit notifications via a backend seam (`setNotificationBackend`).
- Storage: `notifications` + `push_subscriptions` tables (sqlite + postgres),
  **tenant-scoped**; routes under `/v1/host/sample/notifications[/push]/*`.
- It is **core-bootstrapped** (`src/bootstrap/notifications.ts`, `src/notifications/`,
  core route modules in `registerAllRoutes`) and **always-on** — NOT a `BackendFeature`.

**Scope (migrate, then upgrade)**
- [ ] **Migrate** to `features/notifications/`: a `BackendFeature` manifest, its
      route registration moved off the core list into the feature, appended to
      `BACKEND_FEATURES` + `FRONTEND_FEATURES`. A `notifications` toggle, **default
      ON** (existing surface — ADR 0001 §6 "seed pre-existing surfaces as on"; do
      not regress current users).
- [ ] **Keep the emit seam.** Core run-lifecycle stays the trigger; the feature
      registers as the notification backend (`setNotificationBackend`) so core stays
      decoupled — the feature owns surface/storage/UI, not the run-event triggers.
- [ ] **Upgrade — durable preferences.** Per-(tenant, user) notification
      preferences (mute-by-type, quiet hours) are **localStorage-only** today;
      promote to a durable, server-backed store with a real preferences API/UI.
- [ ] (Defer) real email/SMS providers (keep the webhook stub), digests/batching,
      org-scoped routing (notifications stay tenant/user-scoped for v1).

**Notes / decisions for the ADR**
- **Migration constraint (the load-bearing one):** the existing tables, routes,
  and frontend must keep working — the feature WRAPS them; this is not a rewrite.
  Confirm the toggle defaults ON so existing deployments don't lose the bell.
- The Web-Push availability stays advertised via the existing
  `/notifications/push/config` (honest: enabled only when VAPID is set).
- Decide the toggle bucket: `tenant` (a shared surface, like the other features).

---

### ADR-0011 — Knowledge Base / RAG
**Toggle:** `kb` · **Depends on:** ADR-0004, ADR-0006, ADR-0007 · **Pack:** `packs.openwop.dev/feature.kb`
**Status:** 🟢 Done (Phases 1–3) · **MyndHyve §:** Knowledge Base (RAG)

The Media⇄Knowledge-Base pairing MyndHyve has — **cut from ADR-0007 on purpose**
(Media shipped standalone), now sequenced because Media (the source-document
store) exists. Org-scoped, RBAC-gated, a feature-package from the start.

**Scope (port from MyndHyve "Knowledge Base")**
- [ ] Org-scoped **knowledge collections** of documents; a source is a
      **Media-Library asset token** (consumes ADR-0007) or pasted text.
- [ ] **Ingest** — chunk + embed documents into a vector index (reuse the host's
      existing `host.db.vector` brute-force-cosine surface + embeddings provider;
      do NOT reinvent the store).
- [ ] **Retrieval** — semantic search over a collection (top-k with scores).
- [ ] **RAG query** — retrieve → augment → optional grounded answer via the host's
      AI-provider surface (BYOK), returning citations to the source chunks.
- [ ] RBAC: read/search = `workspace:read`; ingest/manage/delete = `workspace:write`.
- [ ] (Defer) re-ranking, hybrid (keyword+vector) search, incremental re-index,
      multi-modal sources, a citations-UI polish pass.

**Notes / decisions for the ADR**
- **Reuse the host vector/embedding surfaces** (`ctx.db.vector` /
  `inMemorySurfaces`) — the demo-grade store is the swap point, same pattern as
  Media's storage adapter. Don't build a parallel vector store.
- **Embeddings need a provider (BYOK).** Gate ingestion on a configured embeddings
  provider; degrade gracefully (clear error) when absent — honest capability.
- **Source = Media tokens** ties KB to ADR-0007; a KB doc references a media asset
  rather than re-storing bytes (the same boundary CMS sections use).
- The MyndHyve RAG co-deps (search providers, re-rankers) are deferred — start with
  the in-host vector floor.

---

### ADR-0012 — Publishing & SEO
**Toggle:** `publishing` · **Depends on:** ADR-0004, ADR-0006, ADR-0007, ADR-0009 · **Pack:** `packs.openwop.dev/feature.publishing`
**Status:** 🟢 Done (Phases 1–3) · **MyndHyve §:** Publishing & SEO

Sequenced after a re-evaluation of the MyndHyve catalog (2026-06-09): it was *not*
in the explicit cuts, and MyndHyve's own dependency graph lists **Publishing & SEO
as a requirement of the CMS** — the shipped ADR-0009 CMS could publish a page but
only org members could read it (no public web surface). Publishing completes that
value chain.

**Scope (composes CMS, does not modify it)**
- [x] A `publishing` feature-package owning per-page **SEO metadata** (meta + Open
      Graph + canonical + noindex; OG image = a Media token) in its own store keyed
      by pageId — so ADR-0009 needs no migration and the two stay independently
      toggleable.
- [x] A **PUBLIC, unauthenticated** surface `/v1/host/sample/public/:orgId/*`
      (page-by-slug, `sitemap.xml`, `robots.txt`, `feed.rss`): org→tenant via
      `getOrg`, gated on the org-tenant's `publishing` toggle (off = site offline),
      served **published-only**, `noindex` honored. One justified core edit — the
      `PUBLIC_PATH_PREFIXES` allowlist entry (same pattern as the media serve route).
- [x] Frontend `PublishingPage` (nav-gated): published pages + their public URLs +
      a per-page SEO editor.

**Notes / decisions**
- **Compose, don't modify** — Publishing READS `cmsService` + `getOrg` + Media
  tokens; CMS (0009) is untouched.
- **Deferred** (open questions): server-side HTML render with inline `<head>`
  OG/JSON-LD + critical-CSS (needs a section→HTML renderer); custom domains / SSL /
  static export; a `site` entity for multi-site-per-org slug scoping.

---

### ADR-0013 — Sharing (public links)
**Toggle:** `sharing` · **Depends on:** ADR-0004, ADR-0006, ADR-0009, ADR-0011 · **Pack:** `packs.openwop.dev/feature.sharing`
**Status:** 🟢 Done (Phases 1–3) · **MyndHyve §:** Sharing

The natural pair to ADR-0012: where Publishing serves an org's **published**
pages at a stable org-addressed URL, Sharing mints an **unguessable capability
link to a SPECIFIC resource** — including ones the public surface won't serve (a
**draft** page for stakeholder review, a knowledge collection shared read-only).

**Scope (composes CMS + KB; does not copy resource data)**
- [x] A `sharing` feature owning `ShareLink` records (token + `(resourceType,
      resourceId)` ref + label/expiry/revoke). A link stores a REFERENCE; a
      **resolver** for the type loads a read-only projection at resolve time, so
      edits/revocation/deletion reflect live.
- [x] A **pluggable resolver registry** — v1 ships `cms_page` (composes
      `cmsService`) + `kb_collection` (composes `kbService`); a new type is one
      map entry, no routing change (the altitude flagged in the 0012 review).
- [x] Authed mint/list/revoke (`authorizeOrgScope` — write/read) +
      **PUBLIC** `GET /v1/host/sample/shared/:token[/card]` (unauthed — the token
      IS the credential; tenant from the link; gated on the link-tenant's
      `sharing` toggle; uniform 404 on missing/revoked/expired/feature-off/gone).
- [x] Frontend `SharingPage` — resource picker → mint (label + expiry) → active
      links with copyable public URLs + revoke.

**Notes / decisions**
- **Extracted `publicBaseUrl`** into the shared `featureRoute` helpers (used by
  0012 + 0013) — the reusable public-origin policy the 0012 review called for.
- **Deferred** (open questions): QR codes + server-rendered social-card images
  (zero-dep host — no hand-rolled QR); snapshot/immutable shares; per-link access
  controls (password/view caps/audit); public search over a shared KB collection.

---

## Out of scope for this roadmap (explicit cuts)

To keep the port honest, these MyndHyve capabilities are **deliberately not**
sequenced here. They're noted so a future ADR can pick them up, not silently dropped:

- **Billing / Subscriptions, E-Commerce** — CRM is decoupled from commerce on purpose.
- **Email Marketing, Analytics, Connectors, Messaging Gateway** — product surfaces
  beyond the requested core. (Notifications was promoted to **ADR-0010**; Knowledge
  Base / RAG to **ADR-0011** — both are now sequenced above, not cut.)
- **Collaboration & Presence, Accessibility audit infra** — MyndHyve lists these as
  CMS deps, but they're cut to a minimal CMS v1; revisit if CMS needs them.
- **Anything under MyndHyve § "Sunset / Do-Not-Use"** — never ported.

## Maintenance

- **Owner:** [PLACEHOLDER: assign]
- **Update cadence:** as each ADR lands — move its row's status, and on completion
  promote the feature into [`FEATURES.md`](FEATURES.md) § "Current features" (keep
  the toggle id stable) and mark the ADR `implemented`.
- **Source conflict:** when MyndHyve's FEATURES.md and this app's reality disagree,
  the openwop-app architecture wins — this is a *port*, not a clone.
