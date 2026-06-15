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
| 0017 | Forms (public builder → CRM contact) | `forms` | 0006, 0008, 0012 | `feature.forms.*` | 🟢 Done (Phases 1–3) | Forms |
| 0018 | Analytics (public-surface measurement) | `analytics` | 0006, 0012, 0020 | `feature.analytics.*` | 🟢 Done (Phase 1 + FE) | Analytics |
| 0019 | Email Marketing (campaigns over CRM) | `email` | 0006, 0008, 0020 | `feature.email.*` | 🟢 Done (Phases 1–2 + FE) | Email Marketing |
| 0020 | Consent & Compliance (enforcement gate) | `consent` | 0006 | `feature.consent.*` | 🟢 Done (Phases 1–3) | Consent & Compliance |
| 0021 | Collaboration / Comments    | `comments` | 0006, 0009, 0010, 0011 | `feature.comments.*` | 🟢 Done (Phases 1–3 + extension surface) | Collaboration & Presence |
| 0022 | Marketplace (browse + install packs) | `marketplace` | 0001, 0006 | `feature.marketplace.*` (composes signed registry) | 🔵 Planned (ADR Proposed) | Marketplace |
| 0024 | Connections — generic per-user/org credential broker (Google/Slack/ServiceNow/Zoom) for the existing MCP/HTTP/integration nodes | `connections` (graduated always-on, §Correction) | 0002, 0003, 0006, 0015 | — (composes core node packs; reuses BYOK + RFC 0076/0079) | 🟢 Done (Phases A–D + §4 integration adapters: HTTP injection · Slack · email · SMS · push · MCP) | (host capability — net-new) |
| 0025 | User/Agent orchestration symmetry — auto-provisioned personal boards + polymorphic board owner; approvals via heartbeat/Notifications | (folds under `profiles`) | 0005, 0015, RFC 0086/0052 | — (generalizes `host.kanban`) | 🟡 In Progress (Phase 1 done — board owner + auto-provision) | (foundational — net-new) |
| 0023 | Executive Assistant / Chief-of-Staff — memory graph + scheduled perception/action loops + prioritization, **RAG via `kb`**. §Correction (2026-06-13): the capability is **decoupled from `roleKey`** → core, `agentProfile`-activated (ADR 0031); foundation of the 10-twin suite | `assistant` | 0024, 0025, 0014, 0001, 0015, 0006 | `feature.assistant.{nodes,agents}` (thin — graph/logic only) | 🟢 Done (graph + packs + prioritization + FE + capability decouple; loops deploy-gated) | (new product — not a MyndHyve port) |
| 0030 | Outbound MCP client — per-user-authed external MCP tool calls (`ctx.mcp.{invokeTool,readResource,listTools}`); the consuming half of RFC 0020 | — (host capability) | 0024, 0027, 0028 | — (composes `core.openwop.mcp`; reuses RFC 0093/0079) | 🟢 Done (Phase 1 + 2a SSE/Streamable-HTTP; Phase 2b `subscribe-resource` deferred) | (host capability — net-new) |
| 0031 | **Rich `agentProfile` host-ext + seed-all-properties** — config params, permissions, HITL, escalation, channels, admin controls, risk/compliance, `requiredConnections`, metrics, `capabilities`, 4→3 autonomy map; `GET/PUT /v1/host/openwop-app/agents/:id/profile` + view/edit UI | — (host-ext, non-normative) | 0023, 0024, 0025 | — | 🟢 Done | Enterprise Work-Twin suite |
| 0032 | **Work-twin persona reconciliation** — seed ONLY the 10 canonical twins; retire the legacy 5 (guarded migration); reuse Iris as the Chief-of-Staff twin; per-twin owner bindings (crm/csm/kb/…) | — (demo seed) | 0023, 0031, 0016, 0008, 0011 | composes the `tmpl.*` template pack | 🟢 Done | Enterprise Work-Twin suite |
| 0033 | **Work-twin connector reachability + day-1 honesty matrix** — `requiredConnections` activation gating (fail-closed / `supported:false`); RFC 0095 connection packs (m365/jira/salesforce/notion/workday); google/slack via brokered HTTP correction | — (host) | 0024, 0030, 0031 | RFC 0095 connection packs | 🟢 Done (day-1; external-event triggers + async A2A deferred = RFC-gated) | Enterprise Work-Twin suite |

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

> 🟢 **CMS / Media / Publishing went always-on (ADR 0027, 2026-06-11).** The three
> content features (0007 / 0009 / 0012) dropped their toggles (retired from the
> catalog like Notifications) and moved from the workspace Sidebar to the admin-tier
> **Content** group. They now power a **public CMS-driven front page** at `/` for
> anonymous visitors (rendered above `AppGate`). Publishing's per-tenant "site
> online" toggle is gone — the CMS editorial `published` status is the sole public
> gate (Sharing covers private/draft). Toggle ids in the Overview table above are
> retained for historical reference.
>
> 🟢 **Super-admin-editable homepage (ADR 0027, 2026-06-12).** The homepage is the
> host-level **system site** — a normal CMS page in a RESERVED org `host-site`
> under a reserved tenant `host:site` (a `host:` prefix no real principal can hold),
> seeded + served at `/` and **ON by default** (`OPENWOP_FRONTPAGE_DEFAULT_ENABLED=false`
> to opt a fork out). A super admin edits it at **Admin → Content → "Front page"**
> via the `requireSuperadmin`-gated `/v1/host/openwop-app/site-page` — host authority, so
> it's editable regardless of any tenant, without touching `requireOrgScope`.
> Mirrors MyndHyve's global admin-owned `cms_pages/home`. See
> `docs/adr/0027-cms-front-page-and-always-on-content.md`.

## Post-"day 1" follow-ups (proposed ADRs)

"Day 1" of the Enterprise Work-Twin suite (ADRs 0031/0032/0033) shipped: all 10
twins seeded, the rich `agentProfile`, the core/profile-activated assistant
capability, the pinned `tmpl.*` workflow-template pack, and `requiredConnections`
activation gating — twins run at **draft/recommend** over wired surfaces. The items
below were explicitly **deferred** during that work and are tracked here as
**proposed ADRs** to execute next. (RFC-gated rows cannot be done by an ADR alone —
they need an upstream OpenWOP RFC in `../openwop/RFCS/` first; see
[CLAUDE.md](CLAUDE.md) § "A spec change needs an RFC".)

| ADR | Scope | Deps | Status | Source of deferral |
|---|---|---|---|---|
| 0034 | **External-event trigger ingestion** — wire `webhook` / `email` / `form` sources → run through the RFC 0083 trigger bridge (today only **cron + Kanban card moves** dispatch runs). Lets twins fire on "new case / document uploaded / stage change / NPS drop" instead of only schedules. | RFC 0083, RFC 0099, ADR 0033 | 🟢 Done (ADR 0034; rides RFC 0099 `Active` — `TriggerEvent` envelope + `POST /v1/trigger-subscriptions` + `triggerBridge.ingestion`, SSRF/redaction/replay-safe) | ADR 0033 §Deferrals |
| 0035 | **Async / durable A2A tasks** — durable `A2ATaskState` persistence (via `DurableCollection`) on the existing A2A server: `message/send` persists the projected Task; `tasks/get` returns live state after disconnect; `tasks/resubscribe` re-attaches (read-only); `tasks/pushNotificationConfig/set` registers an SSRF-guarded push firing on the four terminal/blocking transitions. The `a2a` capability slot (RFC 0100 §1) advertises `durableTasks/streaming/push` **only when wired** (`OPENWOP_A2A_DURABLE_TASKS`); the synchronous round-trip is unchanged with it off. | RFC 0100 (Active), RFC 0093, RFC 0076, ADR 0033 | 🟢 Done (ADR 0035 — gating RFC 0100 now Active; persistence + resubscribe + push wired; long-running run-backed projection seam in place, deterministic-dispatch-terminal in the reference) | ADR 0033 §Deferrals |
| 0036 | **`agentProfile` policy enforcement** — enforce `permissions.never` + `hitl` + the `autonomous-within-policy` `withinPolicyActions` allowlist via a pure resolver (`host/agentPolicyResolver.ts`) composed at the heartbeat pick + assistant action enqueue, most-restrictive-wins with ADR 0033 readiness gating. (`permissions.read/write` positive allowlists remain advisory pending a per-tool-call `toolHooks` follow-on.) | ADR 0031, ADR 0028 | 🟢 Done (ADR 0036) | ADR 0031 §Open questions |
| 0037 | **Connector framework + remaining provider reach** — `connectorInvoker` is now a real broker-delegating impl (was a throw-on-use stub): resolves the acting user's provider Connection through the Connections broker + brokered egress, pins to the provider's `apiHosts`, fails closed when unconfigured; `host.connectors` advertised `supported:true` + resolvable as a pack peerDependency; ServiceNow `apiHosts` added. Per-provider packs still need **no ADR each**. Named-operation connector descriptors deferred. | ADR 0033, ADR 0024, RFC 0095 | 🟢 Done (framework wired; per-provider reach deploy-gated; descriptor catalog deferred) | ADR 0033 matrix (deploy-gated rows) |
| 0038 | **Per-agent knowledge & memory** (toggle `agent-knowledge`, OFF, bucket `tenant`) — user-curated per-agent RAG: bind KB collections (cited docs) + private notes (auto-recalled); composed into dispatch retrieval; core `knowledge` capability activated per `agentProfile`. **Composes** kb (0011) + per-agent memory (RFC 0004) + agentProfile (0031) — a net-new per-agent store is FORBIDDEN (no-parallel-architecture). | ADR 0011, ADR 0031, ADR 0036 | 🟢 Done (ADR 0038 implemented — feature package + capability + dispatch composition + FE panel + route tests; host work, rides RFC 0004/0080/0018, **no new RFC**) | net-new (per-agent memory PRD; not a deferral) |
| 0040 | **Board of Advisors** (toggle `advisory-board`, OFF, bucket `tenant`) — user-assembled councils of named digital-clone advisor agents, summoned together in one shared chat via `@@`; advisors address the user + each other by name, build on/challenge each other, then a moderator synthesizes. **Composes** roster + `agentProfile` persona (0031/0032), per-advisor RAG (0038, unchanged), the host multi-agent conversation seam (`conversationExchange`/`agentPromptScaffold`), the assistant moderator (0023), Sharing/RBAC (0013/0024/0006). New `AdvisoryBoard` entity under `/advisors/*` — explicitly **not** `host.kanban`'s board. Persona = `agentProfile`; capabilities stay core (David's law). | ADR 0031, ADR 0032, ADR 0038, ADR 0023, ADR 0025, ADR 0013 | 🟢 Done (Phases 1–5 — feature package + `@@` broadcast convene + per-advisor RAG + moderator synthesis + likeness governance + `ctx.features` surface + FE council chat + 8 route/orchestration tests; **phased RFC gate**: MVP rides Accepted RFC 0005/0002 §A8 as host-ext, **no blocking RFC**; non-blocking companion **RFC 0101** (Parked) upstreams normative multi-party — Phase 6 deferred. Node pack + chat envelope + `tmpl.advisors.*` seed deferred, logged in ADR.) | net-new (board-of-advisors PRD; not a deferral) |

> **Per-twin product enhancements** (each twin's "Future Enhancements" in
> `~/Downloads/new_agents.md` — board-packet assembly, predictive renewal scoring,
> autonomous low-risk IT remediation, etc.) and the **platform future-state**
> (ABAC, per-tool ephemeral tokens, a simulation/eval harness, ALM ring
> deployments) are product-roadmap depth, not day-1 blockers. Group them under a
> later ADR cluster when prioritized; they compose the same seams (no parallel
> systems).

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
| 7 — Growth & platform depth | 0017, 0018, 0019, 0020, 0021, 0022 | 0017 (Forms) ∥ 0018 (Analytics) — need only shipped surfaces; 0019 (Email) needs 0008 (CRM); 0020 (Consent) is authored alongside but **gates** 0018 + 0019; 0021 (Comments) ∥ 0022 (Marketplace) — independent depth tracks, each composing already-shipped infra. Detail in `docs/adr/0017`–`0022`. |

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
> always-on at `/v1/host/openwop-app/orgs`. The initial org-as-tenant feature collided
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
**Status:** 🟢 Done (Phases 1–5 shipped) · **MyndHyve §:** Production Intelligence (Team Profiles)

Self-service per-user profile data. Parallelizable with Orgs — only needs Users.

**Scope (port from MyndHyve "Team Profiles" / "My Profile")**
- [x] Profile CRUD — display name, avatar, contact, bio
- [x] Self-service rule — a user edits their own profile; admins get read views
- [x] Profile completeness scoring (weighted by field importance)
- [x] Avatar + portfolio via Media-asset tokens (Phase 2); skills + peer endorsements (Phase 3)

**Notes / decisions for the ADR**
- MyndHyve enforces self-service via Firestore rules; here it's a backend-authority
  check in `routes.ts` (`resolveOne` + owner check). Confirm the owner predicate.

---

### ADR-0006 — Roles & Permissions (RBAC) — extends `accessControl`
**Owner:** `accessControlService` (RFC 0049 roles→scopes) · **Depends on:** ADR-0003, ADR-0004
**Status:** 🟢 Done (Phases 1–3 implemented) · See `docs/adr/0006-rbac.md`

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

**Phase 3 (done, wire)** — enforces RFC-0049 scopes on the protocol
runs/artifacts surface + the `authorization/decide` seam, advertising
`capabilities.authorization` ONLY when conformance passes (no false oracle).
Gated on the deploy-time flag `OPENWOP_AUTHORIZATION_ENFORCEMENT` (default **off**);
turn it on where every caller is provisioned as an `accessControl` member. ADR
0015 added the wildcard-bearer escape hatch that makes enabling it safe alongside
operator-key / conformance callers — so flipping the demo on is a config decision,
not further implementation (see TODO § "enforcement posture").

---

### ADR-0007 — Media Library
**Toggle:** `media` · **Depends on:** ADR-0004, ADR-0006 · **Pack:** `packs.openwop.dev/feature.media`
**Status:** 🟢 Done (Phases 1–3 shipped) · **MyndHyve §:** Page Builder (Media) + Feature Architecture

Org-scoped asset store. Pulled out of CMS because it's the one hard upstream
dependency CMS/Page Builder need, and is reusable on its own.

**Scope (port from MyndHyve "Media Library")**
- [x] Asset upload / organize / search, org-scoped collections (+ per-org capacity caps, IDOR-guarded)
- [x] Usage tracking; storage adapter (demo-grade in-memory/blob `ctx.storage.blob`;
      real-backend swap is a one-file change)
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
**Status:** 🟢 Done (Phases 1–4 shipped) · **MyndHyve §:** CMS System + Page Builder

The content surface. MyndHyve treats CMS and Page Builder as an intended
co-dependent pair that ships together, so they're one ADR here. Needs Media for
assets and RBAC for editorial access.

**Scope (port from MyndHyve "CMS System" + "Page Builder", phased)**
- [x] Page model + section-based editor (5 core section types: hero, richText, image, cta, columns)
- [x] Page Builder — section CRUD, schema-driven forms, preview
- [x] Media integration (consumes ADR-0007)
- [x] Content versioning + editorial workflow (draft → in_review → published; version snapshots)
- [x] RBAC-gated CMS access (consumes ADR-0006)
- [x] Routing — slug generation, redirects
- [ ] (Defer) localization, personalization/A-B, search providers, comment moderation → follow-on ADRs
      (publishing/SEO shipped separately as ADR-0012)

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
- An **email/SMS webhook** delivery stub (`/v1/host/openwop-app/messaging/notify`).
- **Run-lifecycle emit hooks** — interrupts (approval/clarification), run failure,
  run completion emit notifications via a backend seam (`setNotificationBackend`).
- Storage: `notifications` + `push_subscriptions` tables (sqlite + postgres),
  **tenant-scoped**; routes under `/v1/host/openwop-app/notifications[/push]/*`.
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
- [x] A **PUBLIC, unauthenticated** surface `/v1/host/openwop-app/public/:orgId/*`
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
      **PUBLIC** `GET /v1/host/openwop-app/shared/:token[/card]` (unauthed — the token
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
- **Connectors & Integrations, Messaging Gateway** — product surfaces beyond the
  current core; candidates for a Batch 3, not cut permanently.
- **Accessibility audit infra** — MyndHyve lists it as a CMS dep, but it's cut to a
  minimal CMS v1; revisit if CMS needs it.
- **Production Intelligence completion** (Vendor Directory + `ProductionPlanService`)
  — ADR 0005 ported only Team Profiles; the rest is a future ADR.
- **Anything under MyndHyve § "Sunset / Do-Not-Use"** — never ported.

> **Promoted out of the cuts (now sequenced — Tier 7 / ADRs 0017–0022):**
> Notifications → **0010**, Knowledge Base/RAG → **0011**, Forms → **0017**,
> **Analytics → 0018**, **Email Marketing → 0019**, **Consent & Compliance → 0020**,
> **Collaboration/Comments → 0021**, Marketplace → **0022**.

## Maintenance

- **Owner:** [PLACEHOLDER: assign]
- **Update cadence:** as each ADR lands — move its row's status, and on completion
  promote the feature into [`FEATURES.md`](FEATURES.md) § "Current features" (keep
  the toggle id stable) and mark the ADR `implemented`.
- **Source conflict:** when MyndHyve's FEATURES.md and this app's reality disagree,
  the openwop-app architecture wins — this is a *port*, not a clone.
