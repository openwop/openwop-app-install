# ADR 0010 — Notifications (migrate to feature architecture + upgrade)

**Status:** implemented (Phases 1–3 shipped — `src/features/notifications/`; PR #74). **Corrected 2026-06-11: the toggle was REMOVED — notifications is core platform infrastructure, not a per-tenant toggle (see § Correction).**
**Date:** 2026-06-09 (corrected 2026-06-11)
**Depends on:** ADR 0001 (feature-package architecture), ADR 0002 (Users),
ADR 0004 (Orgs), ADR 0006 (RBAC)
**Owner of the notification surface:** a NEW feature-package
`src/features/notifications/` wrapping the EXISTING subsystem.

---

## Correction (2026-06-11) — the toggle was removed; notifications is core

The original migration gave notifications a **default-ON `notifications` toggle**
that gated only the **read surface** (inbox / bell / SSE / preferences 404 when
off). But the **emit path was never gated** — run-failure (`executor.ts`) and
interrupt (`suspendManager.ts`) notifications are inserted into the store and
pushed via Web-Push **unconditionally**, regardless of the toggle. ADR 0010 §"Open
questions" flagged closing that gap as deferred work.

A review (2026-06-11) concluded the toggle was the wrong primitive: **run-lifecycle
notifications are platform infrastructure** (how the host tells you a run failed or
needs approval), not an optional, A/B-able product surface — and a half-gated state
(UI off, side effects on) is dishonest. **Decision: remove the `notifications`
toggle and make the surface always-on**, matching what the emit path already does.
The real, honest control is the **per-user preferences** (mute categories / quiet
hours / Web-Push opt-in), which the feature already owns (Phase 2). `notifications`
remains a `BackendFeature` for code organization but carries no `toggleDefault` and
no gate middleware; the header bell + `/inbox` nav always render. A stored
per-tenant `notifications` override from before this change is inert (the registry
no longer defines the toggle). This supersedes the "Emit gating when the toggle is
OFF" open question — there is no toggle to gate against.

---

## Context (boundaries audit first)

Unlike every prior ADR in this roadmap, this is a **migration, not a greenfield
build.** The app already ships a comprehensive, production-ready notifications
subsystem:

- In-app **inbox + bell + panel + page**, an **SSE live feed**, desktop (Web
  Notifications) toasts (`src/notifications/`, `frontend/.../notifications/`).
- **Web-Push (RFC 8030 / VAPID)** — real, env-gated (`OPENWOP_VAPID_*`);
  per-tenant multi-device `push_subscriptions` with 404/410 pruning
  (`src/notifications/webPush.ts`).
- An **email/SMS webhook** delivery stub (`src/messaging/notifyDeliverer.ts`).
- **Run-lifecycle emit hooks** — HITL interrupts, run failure, run completion
  emit notifications via a backend seam (`setNotificationBackend`) from the
  executor + suspend manager.
- Storage: `notifications` + `push_subscriptions` tables (sqlite + postgres),
  **tenant-scoped**. Routes under `/v1/host/sample/notifications[/push]/*`.

The single architectural defect: it is **core-bootstrapped** (`bootstrap/
notifications.ts` + core `ROUTE_MODULES` in `registerAllRoutes` + direct calls
in `index.ts`), **always-on**, and **NOT a `BackendFeature`** (ADR 0001). So a
superadmin can't toggle it per tenant, and it sits outside the feature-package
contract every other product surface now follows.

## Decision

**Lift the surface into `features/notifications/` and upgrade the one real gap —
without rewriting the working subsystem.** The migration is faithful: the same
tables, routes, web-push, emit seam, and UI keep working.

### Phase 1 — Migrate to the feature-package (no behavior change)

A `notifications` `BackendFeature` (toggle **default ON** — ADR 0001 §6 "seed
pre-existing surfaces as on"; do NOT regress current users; `bucketUnit:
tenant`). Its `registerRoutes`:
1. installs the emit backend + web-push (`ensureNotificationEmitterInstalled` +
   `configureWebPush`) — **moved off `index.ts` into the feature**, so the
   feature owns its infra;
2. **toggle-gates the surface** — a middleware on `/v1/host/sample/notifications`
   that 404s when the toggle is off for the caller (backend authority);
3. mounts the existing `registerNotificationRoutes` + `registerPushSubscription
   Routes`.

The two route modules are **removed from the core `ROUTE_MODULES` list** and the
two bootstrap calls from `index.ts`. The feature is appended to
`BACKEND_FEATURES`. **The emit seam stays:** core run-lifecycle remains the
trigger; the feature registers as the notification backend, so core stays
decoupled (it owns surface/storage/UI, not the run-event triggers). Net behavior
with the default-ON toggle is identical to today — the existing
`notifications.test.ts` keeps passing.

### Phase 2 — Upgrade: durable preferences

Today notification **preferences** (mute-by-type, quiet hours) live in the
browser's `localStorage` — per-device, lost on clear, invisible to the server.
Promote them to a **durable, server-backed, per-(tenant, user) store**
(`notifications:prefs`), with `GET`/`PUT /v1/host/sample/notifications/
preferences` (toggle + signed-in gated). The frontend reads/writes the server
instead of `localStorage`, so preferences are cross-device and durable.
(Server-side ENFORCEMENT — filtering emits / push by prefs — is the larger
follow-on; this phase makes preferences durable + authoritative storage.)

### Phase 3 — Frontend into the feature registry

Register `NotificationsPage` as a `FrontendFeature` route, nav-gated on the
`notifications` toggle; gate the header **bell** on `useFeatureAccess
('notifications')` (it hides when an admin turns the feature off); the
preferences panel reads/writes the new server API. The canonical `npm run build`
gate must pass.

## Architectural constraints honored

- **Faithful migration, not a rewrite:** the existing tables, routes, web-push,
  emit seam, and UI are preserved — the feature WRAPS them. `notifications.test.ts`
  stays green (the regression oracle).
- **Feature-package contract (ADR 0001):** a `BackendFeature` + `FrontendFeature`,
  toggle-gated, registered in the two registries — no core route/bootstrap edits
  remain for notifications.
- **Default ON (ADR 0001 §6):** a pre-existing surface is seeded on, so no
  deployment loses the bell on upgrade.
- **Emit decoupling preserved:** core emits via `setNotificationBackend`; the
  feature is the backend. Run-lifecycle never imports the feature.
- **Tenant scoping (CTI-1):** unchanged — notifications stay tenant-scoped; the
  toggle gate and prefs are tenant/user-scoped.

## Alternatives considered

1. **Rewrite notifications as a fresh org-scoped feature.** Rejected — the
   existing subsystem is production-ready (web-push, SSE, emit hooks, multi-device
   subscriptions). A rewrite risks regression for zero functional gain; the defect
   is purely architectural (not a feature-package), so wrap, don't rebuild.
2. **Leave the emit-backend install in `index.ts` (migrate only the routes).**
   Rejected — the roadmap calls for the feature to own its infra; moving the
   install into `registerRoutes` (still at boot, before any run) keeps the feature
   self-contained without changing timing.
3. **Make notifications org-scoped now.** Deferred — they're tenant/user-scoped
   today and that's a coherent model; org-routing is a follow-on, not part of the
   migration.
4. **Gate emits (not just the surface) on the toggle.** Deferred to the
   preferences-enforcement follow-on — Phase 1 gates the read surface; with the
   default-ON toggle, emit behavior is unchanged.

## Open questions

- [ ] **Server-side preference enforcement.** Filter emits / push delivery by the
  recipient's muted types + quiet hours (Phase 2 stores prefs durably; enforcing
  them at emit/send time is the next step).
- [ ] **Emit gating when the toggle is OFF.** Skip creating notifications for a
  tenant that disabled the feature (avoid accumulating unreadable records) — needs
  toggle resolution on the emit path; weigh against hot-path cost.
- [ ] **Real email/SMS providers.** The webhook stub stays; a real provider
  (SES/Twilio) is a follow-on.
