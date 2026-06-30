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
| 0022 | Marketplace (browse + install packs) | `marketplace` | 0001, 0006 | `feature.marketplace.*` (composes signed registry) | 🟢 Done (Phases 1–4 + ADR 0014 surface — listings projection + superadmin-gated install delegating to `registryInstaller` + reviews/ratings store + `ctx.features.marketplace` + signed node/agent packs + FE page + 18 route tests) | Marketplace |
| 0024 | Connections — generic per-user/org credential broker (Google/Slack/ServiceNow/Zoom) for the existing MCP/HTTP/integration nodes | `connections` (graduated always-on, §Correction) | 0002, 0003, 0006, 0015 | — (composes core node packs; reuses BYOK + RFC 0076/0079) | 🟢 Done (Phases A–D + §4 integration adapters: HTTP injection · Slack · email · SMS · push · MCP) | (host capability — net-new) |
| 0025 | User/Agent orchestration symmetry — auto-provisioned personal boards + polymorphic board owner; approvals via heartbeat/Notifications | (folds under `profiles`) | 0005, 0015, RFC 0086/0052 | — (generalizes `host.kanban`) | 🟡 In Progress (Phase 1 done — board owner + auto-provision) | (foundational — net-new) |
| 0023 | Executive Assistant / Chief-of-Staff — memory graph + scheduled perception/action loops + prioritization, **RAG via `kb`**. §Correction (2026-06-13): the capability is **decoupled from `roleKey`** → core, `agentProfile`-activated (ADR 0031); foundation of the 10-twin suite | `assistant` | 0024, 0025, 0014, 0001, 0015, 0006 | `feature.assistant.{nodes,agents}` (thin — graph/logic only) | 🟢 Done (graph + packs + prioritization + FE + capability decouple; loops deploy-gated) | (new product — not a MyndHyve port) |
| 0030 | Outbound MCP client — per-user-authed external MCP tool calls (`ctx.mcp.{invokeTool,readResource,listTools}`); the consuming half of RFC 0020 | — (host capability) | 0024, 0027, 0028 | — (composes `core.openwop.mcp`; reuses RFC 0093/0079) | 🟢 Done (Phase 1 + 2a SSE/Streamable-HTTP; Phase 2b `subscribe-resource` deferred) | (host capability — net-new) |
| 0031 | **Rich `agentProfile` host-ext + seed-all-properties** — config params, permissions, HITL, escalation, channels, admin controls, risk/compliance, `requiredConnections`, metrics, `capabilities`, 4→3 autonomy map; `GET/PUT /v1/host/openwop-app/agents/:id/profile` + view/edit UI | — (host-ext, non-normative) | 0023, 0024, 0025 | — | 🟢 Done | Enterprise Work-Twin suite |
| 0032 | **Work-twin persona reconciliation** — seed ONLY the 10 canonical twins; retire the legacy 5 (guarded migration); reuse Iris as the Chief-of-Staff twin; per-twin owner bindings (crm/csm/kb/…) | — (demo seed) | 0023, 0031, 0016, 0008, 0011 | composes the `tmpl.*` template pack | 🟢 Done | Enterprise Work-Twin suite |
| 0033 | **Work-twin connector reachability + day-1 honesty matrix** — `requiredConnections` activation gating (fail-closed / `supported:false`); RFC 0095 connection packs (m365/jira/salesforce/notion/workday); google/slack via brokered HTTP correction | — (host) | 0024, 0030, 0031 | RFC 0095 connection packs | 🟢 Done (day-1; external-event triggers + async A2A deferred = RFC-gated) | Enterprise Work-Twin suite |
| 0144 | **Access Hub — unified credentials & access console** — collapses the eight scattered `Access & data` nav entries into one `/access` tabbed console (Credentials: Keys·Connections·Voice·Endpoints / Identity: Orgs·People·Roles·Capability-firewall) with a **Workspace·Personal** scope pill (retires `/profile?tab=connections`). Frontend-only IA: the hub **projects from the existing `FEATURES` nav manifest** (a `hubTab` annotation + reuse of `resolveNav` gating — no second registry) + a new shared `ui/Tabs`; the pill is backed by a real `scope` prop on `KeysPage`/`ConnectionsManager` (BYOK `ws:`/`user:` tenant). No backend, no service, no wire. Per-project Sources stays in the project tab (pointer only). **§Correction 2026-06-26: graduated to always-on, toggle retired** (Connections/Users precedent) — the four subsumed entries dropped their standalone nav; backend toggle feature deleted. | — (graduated always-on) | 0001, 0006, 0015, 0024 | — (frontend shell; no pack) | 🟢 Done (graduated 2026-06-26) | (host IA — net-new) |

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
| 0038 | **Per-agent knowledge & memory** (**always-on** — graduated off its `agent-knowledge` toggle 2026-06-16, like `profiles` / Personal Memory) — user-curated per-agent RAG: bind KB collections (cited docs) + private notes (auto-recalled); composed into dispatch retrieval; core `knowledge` capability activated per `agentProfile`. **Composes** kb (0011) + per-agent memory (RFC 0004) + agentProfile (0031) — a net-new per-agent store is FORBIDDEN (no-parallel-architecture). | ADR 0011, ADR 0031, ADR 0036 | 🟢 Done (ADR 0038 implemented — feature package + capability + dispatch composition + FE panel + route tests; toggle retired → always-on 2026-06-16; host work, rides RFC 0004/0080/0018, **no new RFC**) | net-new (per-agent memory PRD; not a deferral) |
| 0041 | **Subject memory — agents + humans (digital twin)** (Personal Memory **always-on**; agent surface rides `agent-knowledge`) — generalizes per-agent memory (0038) to a subject-keyed primitive (`host/subjectMemory.ts`) serving agents (`agent:<id>`) AND humans (`user:<id>`); `agentMemoryAdapter` becomes a back-compat shim (no-fork). A person trains their OWN profile with personal memories toward a digital twin. Curated notes made DURABLE (DurableCollection source of truth + recall index). Visible Memory tabs on the agent workspace + My Profile. No new store, no `Profile` schema change (memory referenced by userId). | ADR 0038, ADR 0005, ADR 0031 | 🟢 Done (ADR 0041 implemented — subject seam + shim + durable notes + profile-memory feature + shared MemoryBrowser + agent/profile Memory tabs + unit/route tests incl. durability + cascade cleanup; Personal Memory graduated to always-on 2026-06-15; host work, rides RFC 0004/0048/0080, **no new RFC**) | net-new (digital-twin memory request; not a deferral) |
| 0042 | **Human knowledge binding (digital twin, #1)** (rides the always-on Personal Knowledge & Memory surface) — a person binds cited **documents** to their own profile, not just notes. Generalizes the agent retrieval composition to `resolveSubjectKnowledgeRetrieve` (agent path a thin wrapper, no-fork); adds `Profile.knowledge` (a reference, never content) + a self-service knowledge service over `kbService`; `retrieve` composes bound docs + personal notes into ONE twin corpus. | ADR 0041, ADR 0038, ADR 0011, ADR 0005 | 🟢 Done (ADR 0042 implemented — generalized composition + `Profile.knowledge` + profile-knowledge service/routes + "Knowledge" tab on My Profile + route test (docs+notes one corpus) + agent suites unchanged; host work, rides RFC 0011/0018/0004, **no new RFC**) | net-new (architect #1 follow-on to 0041) |
| 0044 | **Digital twin — cross-subject recall (#2)** (toggle `twin-recall`, OFF, bucket `tenant`) — a twin agent recalls its owner's `user:<id>` corpus under a **user-issued, revocable consent grant**. The first intra-tenant cross-principal read: LINK (`agentProfile.twin`, admin) ≠ GRANT (`TwinGrant`, only the linked user). §4 replay decided privacy-first (live-recheck on fork). Phase 1 = link + grant + RBAC + audit (no recall); Phase 2 = fenced additive recall via `resolveSubjectKnowledgeRetrieve`; Phase 3 = UI. | ADR 0041, ADR 0042, ADR 0038, ADR 0031, ADR 0006 | 🟢 Done (Phases 1–3) (host `twinService` + `twin` feature/toggle + `agentProfile.twin` + cascade cleanup; **Phase 2**: structural `borrowedRetrieve` fence + `twinRecallSurface` seam + live grant gate + per-recall audit + tests. §4 corrected — NO run-stamp (recall is a live read; revocation immediate everywhere). Phase 3 UI shipped — ProfileTwinGrantsTab + AgentTwinPanel). Host-only, rides RFC 0004; **no new RFC** (re-confirmed at Phase 2). | net-new (architect #2 follow-on to 0041) |
| 0045 | **The Subject model — unify agents, people, projects** (foundational refactor; no toggle) — name the owner abstraction (`Subject {kind, id}`) the codebase already reinvented 3× (`BoardOwner`, `MemorySubject`, the schedule owner XOR). A Subject OWNS work surfaces (board/workflows/schedules/memory/knowledge); cognition is a `capabilities[]` axis (not the base — folds `AgentCapabilityId`); authority stays `person`-only in `accessControl` (the hard boundary). Reframes "agent with `type[]`" → `Subject` + split `kind` (is) from `capabilities` (does). Phase 1–2 = name + re-key surfaces (this ADR, no migration); Phase 3 = `project` (ADR 0046); Phase 4 = person-as-subject (ADR 0047, security gate); Phase 5 = cognition/advisor as capability (ADR 0048, **AgentRef wire-gate**). | ADR 0041, ADR 0042, ADR 0044, ADR 0025, ADR 0006, ADR 0031 | 🟢 Done — all 5 phases (P1 `host/subject.ts` canonical `Subject`+`subjectScope`, `MemorySubject` folded; P2 `listBoardsForSubject`/`listJobsForSubject` canonical owner queries; P3 `project` kind **ADR 0046** — board via generic `ownerSubject`, memory free; P4 person-as-subject **ADR 0047** — recognition + security pass, `personSubject`/`rosterSubject` projections + authority invariant; P5 cognition/advisor capabilities **ADR 0048** — `AgentCapabilityId` widened, kind↔capability orthogonality). No migration, behavior-identical, replay-safe. **`AgentRef` wire-gate RESOLVED: no — subjects only own surfaces, runs stay agent-attributed ⇒ host-only, no RFC.** | net-new (subject-unification proposal; the logical endpoint of 0041/0042/0044) |
| 0040 | **Board of Advisors** (toggle `advisory-board`, OFF, bucket `tenant`) — user-assembled councils of named digital-clone advisor agents, summoned together in one shared chat via `@@`; advisors address the user + each other by name, build on/challenge each other, then a moderator synthesizes. **Composes** roster + `agentProfile` persona (0031/0032), per-advisor RAG (0038, unchanged), the host multi-agent conversation seam (`conversationExchange`/`agentPromptScaffold`), the assistant moderator (0023), Sharing/RBAC (0013/0024/0006). New `AdvisoryBoard` entity under `/advisors/*` — explicitly **not** `host.kanban`'s board. Persona = `agentProfile`; capabilities stay core (David's law). | ADR 0031, ADR 0032, ADR 0038, ADR 0023, ADR 0025, ADR 0013 | 🟢 Done (Phases 1–5 — feature package + `@@` broadcast convene + per-advisor RAG + moderator synthesis + likeness governance + `ctx.features` surface + FE council chat + 8 route/orchestration tests; **phased RFC gate**: MVP rides Accepted RFC 0005/0002 §A8 as host-ext, **no blocking RFC**; non-blocking companion **RFC 0101** (Parked) upstreams normative multi-party — Phase 6 deferred. Node pack (`feature.advisory-board.nodes`), `@@`-handle chat envelope, and `advisorAgents` seed all shipped.) | net-new (board-of-advisors PRD; not a deferral) |
| 0049 | **Kanban card assignment to people** — assign a card to a person (or address a role); the card stays on its origin board while an addressed notification (ADR 0050) reaches the assignee's inbox and the card surfaces on the **"Assigned to me"** rail — a collapsible leftmost column on the assignee's personal board (correction #3, 2026-06-16; was a standalone `/my-work` page) — a derived view over the same records (completion/moves sync both ways, no copies). `KanbanColumn.terminal` + `completedAt` model completion (with a legacy done-name fallback); assignment confers **card-scoped** access (move/complete) without origin-board membership; assignee MUST be in-tenant (fail-closed). Extends the **core `host.kanban`** surface (no toggle) + composes Notifications. | ADR 0050, ADR 0025, ADR 0010, ADR 0006, ADR 0015 | 🟢 Done (Phases 1–6 + 6.1 — model + surface emit/withdraw + completion + mirror + card-scoped RBAC + FE "Assigned to me" personal-board rail / AssigneeControl / claim; service + HTTP-route tests; host-ext, **no new RFC**) | net-new (kanban-assignment request; not a deferral) |
| 0050 | **Per-recipient notification targeting** — `NotificationRecord.recipientUserId`: set = **addressed** (private to one user + tenant broadcasts), absent = **broadcast** (tenant-wide, unchanged). Inbox list/stream/mark-all-read honor a recipient filter + per-row privacy; Web-Push gains `push_subscriptions.user_id` so addressed pushes hit only the recipient's devices. Additive (sqlite mig 26/27, postgres mig 23/24); `recipientRole` deferred. Prerequisite for ADR 0049. Extends **core Notifications** (ADR 0010). | ADR 0010, ADR 0015, ADR 0006 | 🟢 Done (Phases 1–2; FE minimal — inbox server-filtered. Host-ext, **no new RFC**) | net-new (prerequisite for ADR 0049) |
| 0052 | **Versioned app releases + built-in migrations** (release engineering; no toggle) — move the demo/white-label app from the rolling `whitelabel` tag to **immutable `vX.Y.Z` releases** with a customer-applyable upgrade path. Decouples the **app SemVer** from the existing forward-only **schema counter** (`__schema_version`), which it composes (no fork, ADR 0001 §1.5); adds an app-version SSoT surfaced at `/readiness`, an `__app_meta` applied-version record, a boot-time **app-migration** runner (idempotent, forward-only), a Keep-a-Changelog `CHANGELOG.md` + "Upgrading from" operator contract, and a GitLab-style **required-stop** escape hatch (off by default). Reworks + renames `/publish-whitelabel` → **`/cut-app-release`** (semver compute, lockstep bump, notes gen, migration-integrity gate, versioned bundle + `latest` alias). Distinct from the spec-corpus `/release`. | the migration runner, `publish-whitelabel`, ADR 0001, ADR 0003/0010 (migration precedents) | 🟢 Done (Phases 1–5 — version SSoT + `/readiness` + `__app_meta` record + app-migration runner + `CHANGELOG`/`releases.json` + `/cut-app-release` skill + integrity/bump scripts + DEPLOY upgrade contract; tests green; **companion `publish-release.yml` change lands in `openwop-app-install`**; host-ext, **no new RFC**) | net-new (versioned-release request; not a deferral) |
| 0058 | **Priority Matrix** (toggle `priority-matrix`, OFF, bucket `tenant`) — capture **ideas/requests** into freely-named **priority lists**, score them against a **configurable weighted criteria set** (1–10 slider weights; Weighted-Scoring engine + WSJF/RICE/ICE/Value-Effort presets), rank, and run a **planning session** that turns a selection into a meeting agenda. **An idea IS a `host.kanban` card** (statuses = free-form columns, `terminal` lanes, assignment — ADR 0049 reused, no parallel board); the feature owns only the **criteria sets + per-idea scores + planning sessions**. **Workspace-scoped by default; a `projectId` scopes it to a project** (board `ownerSubject` = project, ADR 0046). The agenda **composes Documents' `board-agenda`** (ADR 0053, generate-in-run) with an inline-markdown fallback when `documents` is OFF. Config-authority (criteria/weights) gated above plain `workspace:write`. Pack slug `feature.priority-matrix.{nodes,agents}`. | ADR 0001, 0006, 0014, 0015, 0046, 0049, 0053 | 🟢 Done (Phases 1–4 — feature package + scoring engine + `ctx.features` surface + **node/agent packs** (Prioritization Analyst, chat-drivable) + FE page + 18 tests (cross-org · Documents-compose · pack); per-list org-scoped RBAC; host-ext, **no new RFC**) | net-new (priority-matrix / corporate-strategy-board PRD; not a deferral) |
| 0059 | **Priority Matrix — multi-voter scoring** (extends `priority-matrix`; no new toggle) — a list opts into `votingMode: 'multi-voter'` (default `single`) + `voteAggregation: 'mean'\|'median'`: each member casts an independent per-criterion `IdeaVote`, ideas rank by the aggregate (one member can't overwrite another). Switching mode is config-authority gated; single-mode lists are unchanged (no migration; separate `IdeaVote` store). | ADR 0058, 0006 | 🟢 Done (votingMode/voteAggregation + `IdeaVote` + mean/median aggregation + branched score/rank + FE vote grid/votes-column + 3 route tests; host-ext, **no new RFC**) | net-new (ADR 0058 §open-question follow-on; caller-greenlit) |
| 0060 | **Priority Matrix — cross-list portfolio rollup** (extends `priority-matrix`; no new toggle) — a read-only workspace **Portfolio** view that merges + ranks ideas across every priority list the caller can read (`GET /portfolio`, per-org readability filter; `ctx.features.priority-matrix.listPortfolio`). Each row shows source list + in-list rank + scoring model (priorities aren't strictly comparable across lists — surfaced honestly, no invented normalization). **Intra-host only**; cross-*host* federation stays parked (the genuine wire-RFC case). | ADR 0058, 0006, 0015 | 🟢 Done (buildPortfolio + `GET /portfolio` + surface + FE Portfolio table + 3 route tests; host-ext, **no new RFC**) | net-new (ADR 0058 §open-question follow-on; caller-greenlit) |
| 0061 | **Priority Matrix — app↔app federated portfolio** (extends `priority-matrix`; no new toggle) — **Option A** cross-host: a per-tenant registry of peer openwop-app origins + `GET /portfolio/federated` merges the local portfolio with each peer's `/portfolio`, tagging each item with its `source`. Peer config is **non-secret** (bearer = deploy-time env secret); egress is **SSRF-guarded** (reuses the webhook egress guard); peer mgmt is **superadmin-gated**; a failing peer is **fail-soft**. Both ends run THIS host ⇒ non-normative host-extension route, no RFC. Cross-*vendor* (Option B / normative prioritization capability) stays parked. | ADR 0058, 0060, 0024, 0006 | 🟢 Done (federationService peer store + SSRF-guarded fetch + buildFederatedPortfolio + peer CRUD/`/portfolio/federated` routes + FE federated toggle/source-column/peers-admin + 5 unit+route tests; host-ext, **no new RFC**) | net-new (ADR 0058/0060 follow-on; caller-greenlit Option A) |
| 0053 | **Documents & Templates** (toggle `documents`, OFF, bucket `tenant`) — versioned, provenance-stamped **business-document** instances (SOW/PRD/RFP/Epic-Brief/board-agenda; `markdown` native + `pdf`/`slides`/`sheet` as Media tokens) + a **template library** that *binds* the prompt-template (RFC 0027/0028, implemented) engine to named kinds, validating output against a template-owned `outputSchema`; agentic `generateFromTemplate` (assemble in-route, generate in-run per the KB §Correction lesson). **Documents are a Subject-owned surface** — `ownerSubject` (`project`/`user`/`agent`, ADR 0045/0046) over the generic owner + `subjectOrgScope` seams (no soft tag, no parallel owner). **Composes** Media bytes (0007), KB ingest (0011), Sharing (0013), Subject-Memory (0041). Artifact-types (RFC 0071/0075) are **not** implemented in this host → `artifactTypeId` opaque tag, typed `artifact.created` deferred to a future host artifact-type registry. Pack slug `feature.documents.*`. | ADR 0001, 0007, 0011, 0013, 0014, 0015, 0041, 0045, 0046 | 🟢 Done (Phases 1, 3, 4 — feature package + `ctx.features.documents` surface + `feature.documents.{nodes,agents}` packs + Sharing `document` resolver + KB-ingest compose + FE page + 5 route tests; Phase 2 markdown-only, rendering deferred; artifact-types deferred). Host work, **no new RFC** | net-new (documents/templates PRD; not a deferral) |
| 0054 | **Collaborative project** (**always-on** — graduated off its `project-collab` toggle 2026-06-16, rides the always-on `projects` surface) — turn the `project` Subject (ADR 0046) into a place people **and** agents work together, by COMPOSING existing systems (no parallel chat/auth/roster): a **charter** (`Project.charter` — goals/objectives/dates/status/health/milestones, additive), **descriptive membership** (`Project.members[]` — people `user:<id>` + agents `agent:<rosterId>` with a project-role *label*; authority stays org-scoped in `accessControl`, ADR 0045's "no authority of its own"), and a **project group chat** bound to `project:<id>` via a generic `ConversationMeta.ownerSubject` (generalizes the advisory `boardId` bind) + the ADR 0040 `@@` cohort convene for the project's agents. **Member-scoped visibility (DECIDED 2026-06-16 via /architect):** additive `Project.visibility: 'org'\|'private'` (default `'org'` — no migration); READ gains a membership dimension via a generalized `subjectAccess` seam (`subjectOrgScope` → `subjectAccess`) gating every project-owned surface (board/memory/knowledge/schedules/chat); WRITE stays org-scoped (visibility ≠ authority, ADR 0045 intact). Extends `features/projects`; pack slug **none** day-1 (collaboration surface, not AI-authoring). | ADR 0046, 0045, 0043, 0040, 0006, 0001 | ✅ Implemented (Phase 1 charter → 2 membership+visibility+`subjectAccess` → 3 group chat → 4 convene cadence: shared `host/turnPolicy.ts` + the advisory `planBoardroomTurns` primitive, moderator-must-be-a-member, cohort cap 8, D6). Toggle retired → always-on 2026-06-16 (§ Correction). Host-ext, **no new RFC** | net-new (collaborative-projects plan; extends the project subject) |
| 0064 | **CMS content localization** (extends `cms`; toggle `cms-localization`, **OFF**, bucket `tenant`) — add **RFC 0103 (Accepted)** localized content INTO the existing CMS rather than a second store: an additive `Section.localizations` sparse per-locale overlay map, a **core-shared** `host/i18n/` helper (`negotiateLocale` + byte-identical `resolveSection` exact→family→base), `Accept-Language`→`Content-Language` negotiation on the published `by-slug`/front-page read (`Vary`), per-org `ContentLanguageSettings` (`baseLocale ∉ supportedLocales`), and honest `capabilities.i18n` advertisement (derived from authored locales; `capabilities.content` deferred). Locale writes ride the existing page PATCH (embedded sections). §F: published-only, tenant/org IDOR, `Content-Language` not logged. Toggle OFF ⇒ CMS byte-identical. Phases: 1 backend · 2 editor locale-tabs + settings panel · 3 (later) BYOK AI-translate + normative `/v1/content/*` projection + `ctx.content`/packs. Host-ext, **no new RFC** (rides Accepted RFC 0103). | ADR 0009, 0027, 0004, 0006, 0001, 0007 | 🟢 Done — **Phases 1–3 implemented** (`host/i18n` + `Section.localizations` + per-org settings + negotiated by-slug/public read + `capabilities.i18n` + `cms-localization` toggle + editor locale-tabs/settings panel + **AI translate-from-base** (managed provider, sanitized) + **normative `GET /v1/content/*` projection + `capabilities.content`** [Open Q1 resolved: system-site projection]). backend tsc clean + full suite green; FE build green. **Phase-3 workflow surface ALSO shipped** (PR #428): `ctx.features.cms` read surface + `feature.cms.nodes` (`get-page`/`translate-section`) + `feature.cms.agents.localizer` (the chat-drivable path — no separate envelope seam, ADR 0058); public `/v1/content/*` now negotiates over the host-advertised set (`OPENWOP_I18N_LOCALES`) + seeded es/pt-BR system-site overlays; en-route fix to the always-on feature-surface gate (ADR 0014 correction). ADR 0064 `implemented`. Host-ext, **no new RFC** | net-new (RFC 0103 Accepted; MyndHyve CMS localization baseline) |
| 0065 | **Frontend UI-string i18n (app-chrome localization)** (**core infra — no toggle, no pack**) — react-i18next + an `Intl` format layer + per-feature catalogs (each `src/features/<id>/` owns its strings) + a `LanguageSwitcher`; a `check-i18n` build gate (key-parity + formatting-ban + cross-locale parity). One active-locale store drives the UI chrome AND the `Accept-Language` ADR 0064 negotiates content against (behavior-preserving default `navigator.language`). English ships byte-identical; pt-BR (re-derived + native-reviewed) is a fast-follow gated by the declared-locale contract, not a toggle. Frontend-only, **no new RFC** (rides Accepted RFC 0103 `i18n.md`). | ADR 0065 · composes 0064 / RFC 0103, 0001, 0027 | ✅ Implemented (Phases 1–4 — `src/i18n/` + `check-i18n` gate + 50 ns/4270 keys + `LanguageSwitcher`; #419/#421. **pt-BR native-reviewed + promoted to `SUPPORTED_LOCALES` 2026-06-18** — switcher live + auto-negotiated; only an RTL-locale exercise is deferred until an RTL locale ships. Host-ext, **no new RFC**) | net-new (frontend UI i18n; closed PR #410 conventions + pt-BR catalog as reference/seed) |
| 0066 | **CMS interrupt-backed editorial approval** (extends `cms`; toggle `cms-approval-gate`, **OFF**, bucket `tenant`) — close the ADR 0009 deferred "interrupt-backed approval" gate by composing the host's **run-independent approval queue** (`host/approvalService.ts`, a `kind:'content-publish'` variant per the ADR 0025 §4 "no new approval store" precedent), NOT the run-scoped `core.approvalGate` (which would force CMS publish to become a workflow run). Toggle ON ⇒ `submit` creates a `PendingApproval` surfaced in the existing ApprovalsInbox; the decide path (`host:members:manage` + org IDOR) calls `transitionPage` approve/reject. No run ⇒ no replay/fork surface. Toggle OFF ⇒ CMS byte-identical. Phases: 1 queue variant + toggle · 2 CMS wiring + authz · 3 inbox row + editor state. Host-ext, **no new RFC**. | ADR 0009, 0025, 0006, 0001 | 🟢 Done — **all 3 phases implemented** (2026-06-18): `content-publish` approval variant + `cms-approval-gate` toggle + content-approval handler (org RBAC + IDOR) + toggle-gated submit/approve + inbox card group; backend tsc clean + full suite green; FE build green; `cms-approval-gate.test.ts` (5 cases). ADR 0066 `implemented`. | net-new (closes ADR 0009 follow-on) |
| 0072 | **AI workflow authoring (the workflow-builder brain)** (**always-on** — toggle retired 2026-06-19; rides the core builder surface) — the authoring brain the existing core builder (`frontend/react/src/builder/`) lacked: from a natural-language automation intent it reads the **live node catalog** (`GET /v1/host/openwop-app/node-catalog`) as its closed-world menu of legal `typeId`s + JSON Schemas, plans a connected acyclic node/edge DAG, and **emits the canonical `WorkflowDefinition`** (`executor/types.ts`), persisting it through the **existing validated** `POST /v1/host/openwop-app/workflows` route (same RFC 0022 §C `core.dispatch`/`core.subWorkflow` gate) so it opens in the xyflow canvas. Delivered as a **meta-workflow node pack** (`workflow-author.{draft,validate,persist}`, `draft→validate→persist` with an in-node repair loop) fronted by a thin `POST /v1/host/openwop-app/workflow-author/draft` route the "Create with AI" builder entry calls. Shared extractions (one source): `host/nodeCatalogBuilder.ts` + `host/workflowDefinitionValidation.ts`. **Hard invariants:** closed-world typeIds (never invent — would `unknown_typeid` at run), schema-conformant config + port wiring, capability-gate honesty, schema-too-large (>8KB) nodes excluded + logged. §Correction (2026-06-19): graduated **always-on** (toggle removed); the meta-workflow is now a feature **built-in** via the new reusable `BackendFeature.builtinWorkflows` seam (hard-coded catalog source A, not the in-memory registry); closed-world check + run dispatch lifted to core (`host/nodeCatalogBuilder.ts`, `host/runDispatch.ts`). Host-ext, **no new RFC**. | ADR 0001, 0014, 0006, 0015 | 🟢 Done — **all 4 phases + always-on/core-seam follow-ups** (2026-06-18/19): feature package + `feature.workflow-author.{nodes,agents}` packs + `ctx.features['workflow-author']` surface + `draft`/`catalog` routes + FE "Create with AI" entry (en/pt-BR) + demo seed + eval harness + `builtinWorkflows` seam; validator/catalog/dispatch shared with core routes; backend full suite green (2017) + FE build green. ADR 0072 `implemented`. | net-new (workflow-builder meta-workflow plan; not a deferral) |
| 0078 | **Insights & Drafting Agent Suite** (toggle `insights-suite`, **OFF**, bucket `tenant`; packs `feature.insights-suite.{nodes,agents}`) — assembles the scheduler (0052), triggers (0034), agent runtime (RFC 0070), KB "voice" exemplars (0011), the quorum **red-team** gate (0070), notifications (0050), PDF render (0057), and the `EmbeddedChatPanel` embed (0073) into one principal-scoped surface: a **Financial** (variance vs plan), **Communication** ("in-voice" draft, never auto-send), and **Talent** (9-box readiness) agent + scheduled/triggered meta-workflows + a dashboard. Composes, never forks. **Hard prereqs:** ADR 0076 (connectors), 0077 (governance). Host-ext, **no new RFC** (the "Verify Source" query-provenance is the one conditional RFC trigger). | ADR 0001, 0006, 0015, 0052, 0034, 0070, 0072, 0073, 0011, 0050, 0057 | 🔵 Proposed (ADR 0078) | net-new (supplied product brief) |
| 0076 | **Enterprise data connectors — BigQuery (read-only) + email-draft node** (packs; no toggle — extend Connections 0024/0037 + the `core.openwop.integration` node pack) — a BigQuery read-only connection pack (`bigquery.query`, SQL + `asOf` recorded in node-output provenance) + an `email.draft`-to-mailbox node (MS Graph / Gmail drafts — creates a draft, never sends). Reusable beyond the suite. Host-ext, **no new RFC** (credentials stay off the wire). | ADR 0024, 0037, 0030 | 🔵 Proposed (ADR 0076) | net-new (supplied product brief §System Context / User Flows) |
| 0077 | **Data classification, PII log masking & retention sweep** (core governance extension; env-gated daemon, no toggle) — a Public/Internal/Confidential-PII taxonomy + PII-field log masking (extends the secret scrub, not a replacement) + the **retention sweep daemon** the governance `retention` config always implied (calls the existing `subjectErasure` per-feature purge handlers — tombstoned + audited; time-based complement to on-demand GDPR erasure). Horizontal platform safety. Host-internal, **no new RFC**. | ADR 0028, 0020 | 🔵 Proposed (ADR 0077) | net-new (supplied product brief §Data Model / Threat Model / Compliance) |
| 0079 | **Strategic Planning** (toggle `strategy`, **OFF**, bucket `tenant`, category `Business Tools`) — an executive **strategy portfolio** (narrative rationale + OKR-compatible objectives/key-results + initiatives + horizon `quarter\|half-year\|annual\|multi-year\|custom` + owner/accountable-exec + status/confidence/risk) that is the **connective tissue** across Priority Matrix, Projects, and Board of Advisors. New `Strategy` entity (`DurableCollection`, tenant-scoped) under `/v1/host/openwop-app/strategy/*` (prefix audited clean); **scope** `user\|workspace\|org` (corrected to carry only `kind` + `orgId`, since `tenantId`/`createdBy` are always present — ADR 0015). **Links are canonical on the Strategy** (`StrategyLink` → project / priority-list / priority-idea / advisory-board / document) and read back via RBAC-filtered projection helpers — **no denormalized `strategyIds[]`** on consumer stores, **no overload of `Project.charter`**, **no reuse of `goals`** (judge-owned/execution-bounded, RFC 0097). Cross-feature touch = **projections, not forks**: `linkedStrategyIds` into `RankedIdea` (alignment ≠ score), strategy refs into the project `view()`, and `contextRefs[]` on `AdvisoryBoard` resolved **live** into the advisor prompt scaffold. `DELETE` = **soft archive** (story #10). Read-only `ctx.features.strategy` (`list`/`get`/`context`). Node/agent packs + chat-drivability **deferred** (ADR 0058 pattern; no bespoke chat panel). Host-ext, **no new RFC**. | ADR 0001, 0006, 0014, 0015, 0040, 0046, 0058 | 🟢 Done (ADR 0079 `implemented`, Phases 1–6 — feature package + CRUD/links/context + RBAC (orgId-mandatory scope §Correction) + FE portfolio/editor + Priority Matrix chips/align (**FE-composition, no PM backend coupling** — avoids a feature cycle) + Projects refs + Board-of-Advisors context via a **core resolver-registry seam** (`host/boardContextResolver.ts`) + `ctx.features.strategy` (read-only, user-drafts excluded). 16+ strategy/advisory/surface tests; backend suite 2079 green. Fixes: identifier secret-scrub, private-project context leak. Cross-host federation = the future wire-RFC case, out of scope) | net-new (Strategy Feature Plan, 2026-06-19; not a deferral) |
| 0080 | **Strategy Analyst + enrichment** (extends `strategy`; **no new toggle** — rides ADR 0079's) — the AI-driven follow-ons: (A) a live **health rollup** (`on-track`/`at-risk`/`off-track` + component signals) from a strategy's linked project health/milestones + priority rank, on the Portfolio + `GET /strategy/health`; (B) the `feature.strategy.nodes` pack (list/get/context/get-health read + a `create-board-memo` write that persists to **Documents**, never Strategy) + a new open-vocab `board-update` Documents kind; (C) the `feature.strategy.agents` **Strategy Analyst** (audits alignment gaps, drafts board memos; tool-allowlisted to its nodes, **no strategy-mutation tool**; chat-drivable, ADR 0058); (E) create-form **templates** (OKR / annual-operating-plan / portfolio-bet / working-backwards). The `ctx.features.strategy` surface stays **read-only**. | ADR 0079, 0053, 0058, 0046, 0054, 0001, 0006 · RFC 0003, 0076 | 🟢 Done (ADR 0080 `implemented`, Phases A–E — health rollup + getHealth surface + node pack (5 nodes) + Strategy Analyst agent + 4 templates; 17 strategy-health/nodes/agent tests; backend suite 2153 green. Read-only-strategy invariant held — agent writes Documents only. Host-ext, **no new RFC**) | net-new (ADR 0079 §Later Enhancements; caller-greenlit) |
| 0099 | **Tool-output compaction** (toggle `tool-output-compaction`, **OFF**, bucket `tenant`) — cut BYOK token spend on verbose tool outputs in the agent tool loop. A pure, deterministic, zero-dependency JSON compactor applied at the **typed tool-result boundary** (the host tool executor's `{content, isError}` return + the provider `tool_result` construction — `dispatchAnthropicTools.ts:176` + siblings + `agentDispatch.ts:823`; the point a string is *known* to be tool output, covering chat + pack-nodes + manifest dispatch. Two earlier seam picks were rejected across three `/architect` passes — a single `agentDispatch.ts:823` line (misses chat/workflow) and the AI-adapter message array (type-blind: `AiCallMessage.role`=user|assistant|system)), registered via the inversion seam (core never imports the feature): **structure-preserving** (minify + drop structurally-empty `""`/`null`/`[]`/`{}`, ~−52 % on a sparse payload — not byte-lossless, present-vs-absent caveat) globally; **lossy** array-elision (`[…head, {_elided:N}, …tail]`, ~−95 %) **per-agent opt-in only** via `agentProfile.compaction` (ADR 0031). Non-JSON untouched; fail-open to identity (never breaks a run). **Rejects installing `chopratejas/headroom`** — its npm package is a no-op client to a stateful Python+Rust daemon (`localhost:8787` + local CCR cache + license/sync/beacon) hostile to stateless Cloud Run + BYOK. **Replay/fork:** tool content is *not* a recorded event (`agentDispatch.ts:815-822`), so no wire field is touched; the compaction decision is resolved **once at run-start** and stamped into `run.metadata` (the `trustBoundary` precedent, `executor/types.ts:176-177`), read verbatim on `:fork` so a run replays with the compaction it was born with (runless `/agents/:id/dispatch` has no replay surface). Optional Phase-3 `feature.tool-output-compaction.nodes.compact` explicit node + `ctx.features` stats. | ADR 0001, 0014, 0015, 0031, 0006 | 🟢 Done (ADR 0099 — implemented) | net-new (headroom evaluation, 2026-06-20 — build-our-own verdict) |
| 0084 | **Research Notebooks** (toggle `notebooks`, **OFF**, bucket `tenant`, category `Business Tools`) — a NotebookLM-style research workspace (Sources \| Notes \| Chat three-panel) **ported from `lfnovo/open-notebook`** (product design only; its Python/LangGraph/SurrealDB code is not portable). The boundaries audit overturns the PRD's five-new-stores premise: **a notebook IS a `kind:'project'` Subject** (`facet:'notebook'`, additive field — ADR 0046/0054), **sources = one org-scoped KB collection** per notebook (`collectionId=notebook:<id>`, ADR 0011 ingest→embed→retrieve-with-citations), **notes = `project:<id>` subject memory** (ADR 0041), **chat = the one chat primitive** scoped to a **Research Analyst** agent via `EmbeddedChatPanel` (ADR 0043/0073 — no second panel), **transformations = Documents/Templates runs** (ADR 0053). Per-source **Full/Summary/Excluded** context level is a **host-side retrieval filter, not a wire field** (no RFC). "Ask" = a multi-query `ctx.kb.search`→synthesize agent turn (chat-drivability = agent+nodes, ADR 0058). **`ctx`-only correction:** transformations + Ask are **workflow runs**, never sync routes (ADR 0011). `ctx.notebooks` read surface + `feature.notebooks.{nodes,agents}`. Host-ext, **no new RFC** (rides KB/RAG + RFC 0005 chat + RFC 0018 vector). | ADR 0001, 0006, 0011, 0041, 0042, 0043, 0046, 0053, 0054, 0072, 0073 | 🔵 Proposed (ADR 0084) | net-new (open-notebook port, 2026-06-20) |
| 0085 | **Audio/video source ingestion + transcription** (extends `notebooks`; **no new toggle** — plumbing always-on, upload surface gated by `notebooks`) — drop an audio/video file (or a YouTube URL) as a notebook source. **The one missing piece is a constant:** `INPUT_MODALITIES` omits `"audio"` while the gate (`aiProvidersHost.ts:229`) + part-mapping (`:225`) already handle it — so advertise `aiProviders.input.modalities:[…,"audio"]` (de-duping the hardcoded `discovery.ts:463` literal) and a `notebooks.transcribe-source` node feeds bytes to a multimodal model via **`ctx.callAI` audio part** → transcript → KB document. Adds audio/video MIME types to the Media allowlist (`host/allowedUploadMime.ts:12-21`). YouTube = caption fetch via `ctx.http.safeFetch` (RFC 0076), STT-via-0091 fallback. **Rides Accepted RFC 0091 — no new RFC** (a dedicated `ctx.callTranscriber` w/ diarization/timestamps is the one future path that would need its own RFC). | ADR 0007, 0011, 0024, 0084 · RFC 0091, 0076 | 🟢 Implemented (ADR 0085 — `audio` modality + derived discovery, transcribe/youtube/ingest nodes, ingest-audio/youtube workflows, upload routes + FE) | net-new (open-notebook port, 2026-06-20) |
| 0086 | **Multi-speaker podcasts** (toggle `podcasts`, **OFF**, bucket `tenant`, category `Business Tools`) — generate **1–4-speaker** audio episodes (the differentiator vs NotebookLM's fixed 2) from a notebook's sources/notes. **EpisodeProfile** (outline+transcript models, 3–20 segments, language, briefing → a speaker profile) + **SpeakerProfile** (1–4 speakers w/ voiceId/backstory/personality) config + a **PodcastEpisode** run-tracking record. Pipeline = an **executor run** (NOT a new job queue): select content → outline → transcript → **per-speaker TTS** → mix → MP3 to Media. Schedulable ("weekly digest podcast" ≈ free). `feature.podcasts.{nodes,agents}` (a Podcast Producer agent). **⚠ BLOCKED on new RFC 0105 (speech-synthesis adapter `ctx.callSpeechSynthesizer`)** — the port's one genuine wire gap (the wire has image-gen, RFC 0091 audio-in, but no TTS). | ADR 0001, 0006, 0007, 0024, 0053, 0084 · **RFC 0105 (Accepted — `ctx.callSpeechSynthesizer` wired)** | 🟢 Implemented (ADR 0086 — feature-package + `ctx.features.podcasts` surface + 5-node pipeline + Studio UI; v1 mix = ordered clip list) | net-new (open-notebook port, 2026-06-20) |
| 0109 | **Real-time voice session** (always-on host plumbing — **no toggle**, like ADR 0085) — live full-duplex voice on the existing chat: streaming STT (`ctx.callTranscriber` → `Promise<{finalText,…}>` at `turn_commit`, with interim / `speech_start` / `endpoint_candidate` / `turn_commit` as **`voice.*` run-events** on the durable log), the **streaming arm** of `ctx.callSpeechSynthesizer` (`stream:true` → `voice.synthesis_chunk` metadata-only events), barge-in, and a **`streamRef`** live-audio handle (`streamRef → mediaRef` finalize seam reusing ADR 0085 → 0007). **Rides the ONE chat** (RFC 0005 / `EmbeddedChatPanel`, ADR 0073 — no new panel); the **streaming counterpart** of ADR 0085 (audio-in) + the streaming arm on ADR 0086's TTS — exactly the dedicated `ctx.callTranscriber` ADR 0085's row foresaw. The **G7 reference-host arm for RFC 0118**. Host-impl reqs **C1** (Promise + `voice.*` single taxonomy, replay-safe per `replay.md` — the `callAI(stream:true)` emit-to-log idiom) + **C2** (clause-sized chunks < 256 KiB inline cap + per-session budget, RFC 0055); four **§F** live-ingress invariants. Advertises `aiProviders.realtimeVoice` DERIVED from what's wired (ADR 0085 advertise+accept-in-lockstep — honest under `OPENWOP_REQUIRE_BEHAVIOR`). | ADR 0001, 0005, 0007, 0024, 0073, 0085, 0086, 0106 · **RFC 0118 (Active — §B/§C amended openwop#745; this is its G7 host arm)** | 🟢 Implemented (ADR 0109 — P1 stub + P2 real finite-audio transcription #689 · P3 streaming synthesis #691 · P4 barge-in lifecycle #693 · ADR `implemented`/P5-finding #694. Advertises the FULL `aiProviders.realtimeVoice` surface (transcription/synthesis `streaming` + `turnDetection:semantic` + `bargeIn:supported`); every `voice.*` type exercised non-vacuously via the call-transcriber / call-speech-synthesizer(stream) / voice/barge-in seams. **Live `streamRef` streaming is host-internal per RFC 0118 §E** (a live streamRef → honest `transcription_unsupported`); **P5 mic UX already ships** in `ChatInput` (RFC 0091), so no duplicate built. Remaining = the steward Accept close-out → RFC 0118 `Active → Accepted`) | net-new (real-time-voice research + RFC 0118, 2026-06-23) |
| 0138 | **Live voice mode** (toggle `voice`, **OFF**, bucket `tenant`) — productizes the ADR 0109 real-time-voice arm into a **full-duplex spoken** experience on the ONE chat: a `src/features/voice/` package wiring a **real streaming-STT path** for a live `streamRef` (flips the honest `transcription_unsupported`, `aiProvidersHost.ts:344`), the full-duplex turn loop (committed `turn_commit` → conversation turn → **streaming-TTS spoken reply** + barge-in), and a **voice affordance on `EmbeddedChatPanel`** (no new panel/mic — ADR 0073/0058) scoped to a `feature.voice.agents` persona. Provider-agnostic `StreamingTranscriber` + transport-behind-`streamRef` (both **open questions** per the 2026-06-24 product decision). §F continuous-ingress invariants + the ADR 0106 per-session budget. Makes the existing `aiProviders.realtimeVoice` advertisement non-vacuous on the **live** path (no advertisement change). | ADR 0001, 0005, 0014, 0024, 0058, 0073, 0085, 0086, 0106, 0109 · **RFC 0118 (Active — live transport host-internal per §E)** | 🟢 Done (ADR 0138 — implemented) | net-new (real-time-voice productization, 2026-06-24) |
| 0106 | **Media-generation cost governance** (core cost-governance extension; env-gated, **no toggle**) — a per-org **budget** for the paid media path (STT transcription via `ctx.callAI` audio + TTS via `ctx.callSpeechSynthesizer`, ADR 0085/0086) plus a **pre-flight cost estimate**, closing grade-code **MEDIA-7** ("no per-org transcription/TTS cost guard"). Today only a *per-call* cap exists (`MAX_SPEECH_CHARS`, the 32 MiB decode cap) + the managed-tier *LLM* daily cap — neither bounds aggregate per-org media spend. **Composes, never forks:** the managed daily-cap accounting pattern (`getManagedUsage`/`dailyTokenCap`), the `costEmitter` seam, the ADR 0077 governance admin route. Unit = TTS chars + STT decoded-bytes, daily-UTC roll-up; cap check fails-closed (`media_budget_exceeded`); estimate rejects an over-budget request synchronously at enqueue. Managed tier = always-on operator backstop; BYOK = opt-in per-org. **Host-internal, no new RFC.** | ADR 0077, 0085, 0086, 0024 | 🟢 Implemented (ADR 0106 Phases 1–3 — media_provider_usage store + mediaBudget module + TTS in-dispatch budget (429) + STT route pre-flight + superadmin read-only readout; editable per-org override deferred) | net-new (grade-code MEDIA-7, 2026-06-22) |
| 0087 | **Notebooks as MCP tools** (inbound MCP server; rides `notebooks` toggle + env gate `OPENWOP_MCP_SERVER_ENABLED`) — expose notebook ops (list/get/search/**ask**/list-notes + gated writes) to external AI clients (Claude Desktop, Cursor) as MCP tools, so a user operates their research from their own AI client. **The inbound MCP server already exists in this app** — `routes/mcp.ts` (`POST …/mcp`, env-gated), `mcpServerRouter.ts`, declarative scan of the 8 `core.openwop.mcp.*` nodes, honest `capabilities.mcp.serverMount` (`discovery.ts:1090`). Net-new = the notebook **expose-tool** workflows (read-first), the **RFC 0078 `/v1/tools` `ToolDescriptor`** HTTP projection (only an in-process one exists), Connections-based external-client auth (the `mcp-anonymous` fallback MUST NOT reach org data), and the registry tenant-scoping fix (`mcpServerRegistry.ts:14-23`). Each `tools/call` = an org-scoped run; inbound args **untrusted**; `sampling/createMessage` preserves the client's BYOK. **Rides Accepted RFC 0020 + 0078 — no new RFC.** | ADR 0024, 0030, 0084 · RFC 0020, 0078 | 🟢 Implemented (ADR 0087 — 6 READ + 2 HITL-gated WRITE tools (OQ-1 resolved) via `notebooks.mcp.*` workflows; `GET /v1/tools` RFC 0078 projection + `capabilities.toolCatalog`; auth + `notebooks`-toggle gate, tenant-scoped; MCP registry now scans builtin workflows) | net-new (open-notebook port, 2026-06-20) |
| 0100 | **Planning knowledge base** (extends `strategy` + `priority-matrix`; **NO new toggle** — always-on when `kb` + the feature toggle are enabled) — auto-index Strategy (0079/0080) and Priority Matrix (0058) into per-feature, per-org **KB collections** ("Strategy KB", "Priority Matrix KB"), kept fresh on **every CRUD** via a synchronous best-effort side-effect after the durable write (`delete + re-ingest` by stable entity id; archive/delete ⇒ remove). Agents reference it through the **existing** per-agent binding (`agentProfile.knowledge.collectionIds`, ADR 0038); **Boards of Advisors** via binding the collection to the advisor agents + a board-level "Shared knowledge" affordance (RAG needs a per-turn query — a static `kind:'kb-collection'` context-ref was rejected). **Composes, doesn't fork:** per-feature `…KnowledgeService.ts` modules calling `kbService` (the `projectKnowledgeService`/`profileKnowledgeService` precedent — 5 features already feed KB); no new vector store/embedder. **CRITICAL RBAC:** visibility-scope = collection-scope — **user-private strategies are NOT indexed** into the org collection. Backfill for pre-existing rows; content-hash guard skips no-op re-embed; fail-open (a KB error never breaks the CRUD). Non-run side-effect ⇒ replay-trivial. FE: a `managed`-collection synced badge + suppressed hand-edit, "Indexed for agents"/"Private" cues, the board section — all `ui/` primitives. Host-ext, **no new RFC** (rides ADR 0011 KB/RAG + RFC 0018 vector). | ADR 0011, 0038, 0040, 0058, 0079, 0080, 0006, 0015 | 🟢 Done — **all 5 phases implemented** (2026-06-21): strategy + priority-matrix indexers + kbService managed/upsert extensions + content-hash guard + backfill reindex routes + FE managed-collection transparency + board "Shared knowledge" affordance. ADR 0100 `implemented`. | net-new (planning-RAG request, 2026-06-21 — `/architect`+`/ux-review` resolved) |
| 0112 | **Conversation full-text search** (toggle `conversation-search`, OFF, bucket `user`) — FTS across the user's conversations + messages (today only KB-semantic + a title filter). Postgres `tsvector` over the ADR 0043/0102 message store first (Meilisearch a future swap); read-only `/v1/host/openwop-app/chat/search`, owner/participant-scoped. | ADR 0043, 0102, 0006 | 🔵 Planned (ADR 0112 — competitive-analysis candidate B1) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0113 | **KB reranking + hybrid retrieval** (extends `kb`; **no new toggle**) — a BM25 lexical channel fused with dense cosine (RRF) + an optional reranker stage behind `resolveSubjectKnowledgeRetrieve` (ADR 0042); default reranker deterministic, external-reranker result recorded in-run to preserve the deterministic-embedder replay invariant (`/architect` open Q). | ADR 0011, 0042 · RFC 0018 | 🔵 Planned (ADR 0113 — candidate B3, **Critical**) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0114 | **Sandboxed code-execution node** (toggle `code-exec`, OFF, bucket `tenant`; pack `feature.code-exec.nodes`) — run model-generated code in an isolated sandbox (the `delegateProvider` shim shape), HITL-gated (ADR 0051), output projected into the artifact workbench (ADR 0069/0055) + streamed (ADR 0079); recorded output read on `:fork` (no re-exec). | ADR 0055, 0069, 0079, 0051, 0058 | 🔵 Planned (ADR 0114 — candidate B4; RFC **evaluate** — a normative execution-artifact type/capability would need an RFC) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0115 | **Image-generation node** (pack `feature.image-gen.nodes`) — implement the already-advertised-but-unimplemented `callImageGenerator` (`discovery.ts:471` `imageGeneration:supported:false`); providers via Connections (ADR 0024), output a Media token projected into chat (ADR 0069/0083/0007), cost-governed by ADR 0106 (reuse, don't fork). | ADR 0007, 0024, 0069, 0083, 0106 | 🔵 Planned (ADR 0115 — candidate B5; RFC **evaluate** — flipping `imageGeneration:supported:true` cross-host needs an Accepted RFC) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0116 | **Prompt library** (toggle `prompts`, OFF, bucket `tenant`) — shareable, RBAC-gated, versioned prompt templates, `/`-insertable in the composer with variable substitution; composes the existing prompt-template engine (ADR 0053 / RFC 0028/0029) + Sharing (ADR 0013). | ADR 0053, 0013, 0006 · RFC 0028/0029 | 🟢 Done (ADR 0116 — all phases: catalog + render + shareable + FE (merged into the prompt-library UI) + `ctx.features.prompts`) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0117 | **Conversation branching + multi-model compare** (core-chat; **no toggle/pack/ctx**, like ADR 0102) — fork a conversation from any message (mapping to the existing `:fork` run op) + a side-by-side compare mode (two `ConversationView`s, ADR 0073); replay/fork-safety of the branched message-tree is the central `/architect` concern. | ADR 0043, 0067, 0073, 0102 | 🔵 Planned (ADR 0117 — candidate B7) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0118 | **LLM observability — OpenTelemetry + per-turn tracing** (toggle `observability` for the dashboard, OFF, bucket `tenant`; OTel export env-gated) — instrument the run/dispatch path (the existing `observability/tracer.ts` infra), optional Langfuse sink, an admin usage dashboard (folds audit + analytics); spans redact BYOK/PII (ADR 0067/0077). | ADR 0029, 0088, 0067, 0077 · RFC 0026/0084 | 🔵 Planned (ADR 0118 — candidate B8) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0119 | **Conversation export + import** (markdown / JSON) — render the persisted transcript (ADR 0102/0043) to markdown/JSON, optionally a Document (ADR 0053)/Media (ADR 0007); import builds conversations via the existing open path; owner/participant-scoped. | ADR 0102, 0043, 0053, 0007, 0006 | 🟢 Done (ADR 0119 — all phases: renderer + export/import routes + as-Document + FE export/import in the chat deck) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0120 | **Chat memory auto-extraction** (toggle `memory-extraction`, OFF, bucket `user`) — an opt-in LLM pass extracts durable facts from chat into `subjectMemory` (RFC 0004/ADR 0041), consent-fenced like twin-recall (ADR 0044), opt-out + valid-key/limit guard; versioned + audited. | ADR 0041, 0044 · RFC 0004/0048 | 🟢 Done (ADR 0120 — extraction pipeline + the consent toggle & MemoryBrowser review UI) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0121 | **Local / OpenAI-compatible model provider** (provider config; **BLOCKED on a new openwop RFC**) — add a local/compat endpoint (Ollama/LM Studio/vLLM/base-URL) to dispatch (ADR 0067) + BYOK (ADR 0024), capability-probed; advertising the `compat`/local provider class in `aiProviders.supported[]` is a wire-honesty claim → **needs a new RFC ≥ Accepted FIRST** (`/prd`). | ADR 0067, 0024, 0110 · **new RFC required** | 🔵 Planned — **RFC-gated** (ADR 0121 — candidate B12; `/prd` next) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0122 | **Shared public conversation links** (toggle `chat-share`, OFF, bucket `tenant`) — snapshot a conversation to a revocable read-only public link via the Sharing resolver-registry (ADR 0013) + content-trust taint (ADR 0027) + `PUBLIC_PATH_PREFIXES`; tenant from the resource, uniform 404, rate-limited; owner-only mint/revoke. | ADR 0013, 0027, 0043, 0006 | 🔵 Planned (ADR 0122 — candidate B13) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0150 | **AI chat permission mode (safe / bypass)** (**core-chat — NO toggle**, like ADR 0102/0117; **per-conversation** switch in the composer toolbar, **default `safe`**) — generalize the recurring "Run code?" HITL into a per-chat user-controlled mode: **safe** honors the capability-firewall's `require-approval` (the existing `interrupt.approval` card); **bypass** treats `require-approval`→`allow` (the user pre-authorizes via the toolbar), while `deny`/RBAC/budget/sandbox still bind. **Composes** the ADR 0135 firewall + ledger + interrupt primitive — NO new HITL system. Carried **per-exchange** (like `model`/`webSearch`, ADR 0101/0124) ⇒ replay-deterministic. Classifies code-exec (+ file-write, egress) `require-approval` so safe mode **restores the code-exec gate dropped on the builtin tool path (#957)**. | ADR 0135, 0114, 0146, 0101, 0124, 0067 · RFC 0005 (Accepted) | 🔵 Planned (ADR 0150 — generalizes the code-exec HITL) | net-new (permission-mode request, 2026-06-27) |
| 0151 | **AI conversation auto-titling** (toggle `chat-autotitle`, **ON**, bucket `user`) — replace the FE `firstMessage.slice(0,60)` with a cheap, parallel, **in-language** LLM title call **once on the FIRST exchange** (LibreChat `immediate` + `completion` method — no tool-calling, for free-tier reliability), written to the existing `chat_sessions.title` + emitted as a non-normative `conversation.titled` host event; host-extension / **non-replay**, reusing the ADR 0120 memory-extract fire-and-forget seam + the managed/BYOK dispatch. Title-once (never auto-retitle), fail-closed, **never clobbers a manual rename** (`titleSource`), degrades to the first-message placeholder on any failure — also repairs the `messages.length===0` substring regression. | ADR 0043, 0102, 0120, 0130, 0067 · RFC 0005 (Accepted) | 🔵 Planned (ADR 0151 — LLM session-naming) | net-new (LLM session-naming deep-dive, 2026-06-27) |
| 0123 | **Eval / feedback leaderboard** (toggle `evals`, OFF, bucket `tenant`) — turn captured `MessageFeedback` (the ADR 0071 Phase-5 consumer) + health-indexing (ADR 0029) into an admin model-quality leaderboard (Elo/win-rate) + an optional A/B arena; admin-only, read-only aggregation. | ADR 0071, 0029 · RFC 0081 | 🔵 Planned (ADR 0123 — candidate B14) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0124 | **In-chat model/provider switch** (core-chat; small) — switch model/provider from the composer, capability-gated (`modelCapabilityProbe`/`Gate`); model already rides `run.inputs` (stamped → replay-safe). | ADR 0067 · RFC 0031 | 🔵 Planned (ADR 0124 — candidate B15) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0125 | **Recurring / scheduled agent chats** (toggle `scheduled-chats`, OFF, bucket `tenant`) — RRULE/cron-triggered agent chat turns → a conversation + run history; reuses the scheduler daemon's `claimIdempotency` fire-once (NOT a new job queue — the ADR 0107 Phase-3b lesson) + ADR 0089. | ADR 0025, 0089, 0103 | 🔵 Planned (ADR 0125 — candidate B16) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0126 | **Team channels / real-time messaging** (toggle `channels`, OFF, bucket `tenant`) — topic channels w/ membership + read-state on the conversation primitive (ADR 0043 group) + the SSE delivery seam (ADR 0088) + targeting (ADR 0050); per-channel RBAC. Deferred in ADR 0043. | ADR 0043, 0088, 0050, 0006 | 🔵 Planned (ADR 0126 — candidate B18; RFC **evaluate** — v1 local-host = no RFC; presence/typing/receipts or cross-host = new RFC, RFC 0101 Parked precedent). **⚪ Extend — ADR 0154** (Proposed): channels INTO the unified chat surface — rail section + shared `ConversationView`, retire the standalone `/channels` page, agents-in-channels (`@agent`→`chat.turn`); completes ADR 0126 §2/§4, supersedes ADR 0145 §4; no RFC | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0127 | **Public embeddable chat widget** (toggle `chat-widget`, OFF, bucket `tenant`) — a public, domain-allowlisted, rate-limited widget embedding the existing `ConversationView`/`EmbeddedConversation` (ADR 0073) behind a public gateway (ADR 0013 + `PUBLIC_PATH_PREFIXES`), scoped to a designated agent (ADR 0024/0058); does NOT reimplement chat. | ADR 0073, 0013, 0024, 0058 | 🔵 Planned (ADR 0127 — candidate B19) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0128 | **Interactive artifacts canvas** (extends the artifact workbench) — register interactive artifact types (html/react/mermaid/chart) via the host artifact-type registry (ADR 0055) + workbench (ADR 0069/0083), rendered in a strict CSP-sandboxed iframe (no same-origin, network-off); reuses the A2UI host-pinned-catalog discipline (ADR 0051). Folds inline chart artifacts. | ADR 0055, 0069, 0083, 0051 | 🔵 Planned (ADR 0128 — candidate; RFC **evaluate** — host-native artifact type = no RFC, normative cross-host type = new RFC; security `/architect`+`/browser`) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0129 | **Chat math + diagram rendering** (core-chat FE) — add KaTeX (`remark-math`/`rehype-katex`) + sandboxed Mermaid to the chat markdown renderer (`MessageRenderer.tsx` — today `react-markdown`+`remark-gfm` only); client-side render of existing turn text, sanitized. | ADR 0079 (renderer) | 🔵 Planned (ADR 0129 — candidate; pure-FE, no wire) | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0130 | **Rule-based per-turn model router** (toggle `model-router`, OFF, bucket `tenant`) — route each turn among already-advertised providers by rules (token/message/attachment + optional LLM-classification) w/ sticky cooldown + fallback (composes ADR 0110 default); the routing decision is stamped in `run.metadata` at creation, read verbatim on `:fork` (the ADR 0031 nondeterminism invariant). | ADR 0067, 0110, 0031 | 🔵 Planned (ADR 0130 — candidate) — engine implemented (Phases 1–3c); **FE config UI (Phase 5) is the remaining gap** | net-new (AI-chat competitive analysis, 2026-06-23) |
| 0132 | **Per-conversation capability scope + per-tool-call approval** (toggle `conversation-tools`, OFF, bucket `tenant`) — a per-conversation **narrowing** filter over the agent's permitted tools (ANDed into ADR 0102, never widens) + a per-tool **require-approval** flag that suspends the live loop with the existing HITL interrupt card (ADR 0089); driven by the RFC 0078 tool catalog; effective scope stamped in `run.metadata`, read verbatim on `:fork`. | ADR 0102, 0089, 0075, 0031; RFC 0064/0078 | 🟢 Done (ADR 0132 — all 5 phases, 2026-06-24) | net-new (third-party competitive analysis `compare.md`, 2026-06-24 — its #1 catch) |
| 0133 | **Run/task deck** (toggle `task-deck`, OFF, bucket `tenant`) — a **read-only projection** over runs + sub-runs (`subRunDispatcher`) bucketed `pending·running·blocked·delegated·completed·failed`; the **blocked** bucket reads the unified review (ADR 0068); one additive `run.metadata.parentRunId`/`delegatedBy` stamp groups children under parents. No tasks table ([[no-parallel-architecture]]). | ADR 0068, 0075, 0083, 0050, 0031 | 🟢 Done (ADR 0133 — all 4 phases, 2026-06-24; `ctx.tasks` deferred) | net-new (third-party competitive analysis `compare.md`, 2026-06-24) |
| 0135 | **Capability Firewall** (toggle `capability-firewall`, OFF, bucket `tenant`) — composition-aware risk: a tenant rule set over RFC 0078 tool **classes** (safetyTier/egress) evaluated INSIDE `runChatToolLoop` against the *combination* of capabilities a run has exercised (read-drive + send-email ⇒ deny/approve). ANDs after ADR 0132/0102; verdict rides the existing forbidden/approval seam; rule set stamped in `run.metadata`. | ADR 0132, 0102, 0036, 0075, 0031; RFC 0078/0064 | 🟢 Implemented (ADR 0135) | net-new (innovation strategy `openwop_ai_chat_innovation_strategy.md`, 2026-06-24 — strongest novel bet) |
| 0136 | **Intent Ledger** (toggle `intent-ledger`, OFF, bucket `tenant`) — a reviewable pre-flight mission contract (goal / allowed / forbidden / approvals / success-criteria / expiry) drafted only for complex/high-risk requests; **projects onto the ADR 0132 capability scope** (enforcement reused, not rebuilt) + adds success-criteria + a relative-TTL expiry + an authorized-vs-completed run summary. Resolved ledger stamped in `run.metadata`. | ADR 0132, 0036, 0075, 0130, 0135, 0031 | 🟢 Implemented (ADR 0136) | net-new (innovation strategy, 2026-06-24) |
| 0137 | **Ambient Work Graph** (toggle `ambient-work-graph`, OFF, bucket `tenant`) — opt-in mining of completed runs into deterministic **run signatures** → clustering → recurrence → a `WorkflowSuggestion`; accepting hands the candidate to the ADR 0072 workflow-author draft. Read-only projection over the run store (no new run model, no new queue — sweep on the scheduler daemon). Privacy: opt-in + evidence drawer + dismiss. | ADR 0072, 0133, 0068, 0050 | 🟢 Implemented (ADR 0137) | net-new (innovation strategy, 2026-06-24) |
| 0155 | **Campaign Studio — Brand & Guardrails** (toggle `brand`, OFF, bucket `tenant`, category `Marketing`) — the **net-new marketing layer's foundation**: a `Brand` entity (voice profile · formality 1–5 · tone registers · positioning · approved/banned phrases · per-channel voice rules) + a **compliance scorer** (deterministic banned-phrase/formality 60 % + LLM 40 %, 0–100) + a brand-voice resolver that injects rules into generation prompts. **Composes, never forks:** brand governance maps to `accessControl` (RFC 0049); voice rules feed the existing AI-envelope surface. Packs `feature.brand.{nodes,agents}` (`brand.compliance.check`, `brand.voice.resolve` + a Brand Steward agent). First of the **0155–0160 Campaign Studio cluster** ([`docs/campaign-studio-prd.md`](docs/campaign-studio-prd.md)). Host-ext, **no new RFC**. | ADR 0001, 0006, 0011 | 🟢 Done (ADR 0155 `implemented`, Phases 1–4 — `Brand` entity + CRUD/IDOR routes · pure compliance scorer + voice resolver · `feature.brand.{nodes,agents}` (compliance-check blends deterministic 60 % + LLM 40 %, Brand Steward) + `ctx.features.brand` · `/brand` FE page; 25 backend tests + FE build green) | net-new (Campaign Studio port — CS-006 Brand Guardrails) |
| 0156 | **Campaign Studio — Personas & Campaign Brief** (toggle `campaign-brief`, OFF, bucket `tenant`, category `Marketing`) — a marketing **`Persona`** (buyer stage · objections · pain points — a *content-targeting* abstraction, **distinct from a CRM contact**, composes `crm` segments for real people) + the **campaign brief** model/wizard + the **brief context assembler** (composes `kb` retrieval + brand + persona into one grounded prompt with `[src_N]` citation passthrough) + the **messaging kernel** generator (`{headline,supportingStatement,proofPoints,CTAs,tone,channelTones,sourceDocIds}`) + the asset-decision/setup gates (brand/persona/kb/media) and brief-creation gate. Packs `feature.campaign-brief.nodes` (`brief.validate`, `brief.kernel.generate`, the gates). Host-ext, **no new RFC**. | ADR 0155, 0011, 0008, 0007 | 🟢 Done (ADR 0156 `implemented`, Phases 1–4 — `Persona` + `CampaignBrief` entities/CRUD/validate · pure brief context assembler · `feature.campaign-brief.{nodes,agents}` (grounded `generate-kernel` composing brand voice + `kb.rag` + `ctx.callAI`, Brief Strategist) + `ctx.features['campaign-brief']` · `/campaign-brief` FE page; 16 backend tests + FE build green) | net-new (Campaign Studio port — CS-001/003/004 KB+Builder+Kernel) |
| 0157 | **Campaign Studio — Channel Generation** (toggle `campaign-channels`, OFF, bucket `tenant`, category `Marketing`) — the 5 grounded **channel generators** (landing page → page-builder · ad variants · email sequence → **emits drafts INTO `email` (ADR 0019), no parallel send** · creative briefs + AI **media-selection/mood-board** matcher over `media` · social posts), each `generate → content.quality.check → brand.compliance.check → approval` with **per-item refine** (`itemsFrom`); the 5 **channel child workflow chain packs**, independently runnable AND dispatchable. Packs `feature.campaign-channels.{nodes,workflows}`. Host-ext, **no new RFC**. | ADR 0156, 0007, 0009, 0019, 0012 | 🟢 Done (ADR 0157 `implemented`, Phases 1–2 — one parameterized `generate` node (5 channel shapes, kernel+voice+`kb.rag` grounded, bundles quality+compliance) + `content-quality-check` + Channel Generator agent · 5 `campaign-studio.channel.*` child workflows via `builtinWorkflows` (per-item refine) + `campaign-channel.*` artifact-type pack; 10 tests + boot-registration green) | net-new (Campaign Studio port — CS-004/005 Content+Creative-Brief) |
| 0158 | **Campaign Studio — Composable Orchestration** (toggle `campaign-orchestration`, OFF, bucket `tenant`, category `Marketing`) — the **parent workflow chain pack** (`campaign-studio.campaign-orchestration`): asset-decision gates → kernel + approval → **parallel 5-channel fan-out** → merge → production-plan (skippable) → consistency-check (vs kernel, ≥80) → finalize → `MarketingCampaign`. The **Campaign Strategist** agent pack drives it through the ONE chat (deep-link/`EmbeddedChatPanel`, ADR 0058/0073 — no new panel). Channel skip = orchestrator chooses which `nextWorkerIds` to dispatch from `enabledChannels`. Artifact-type pack for kernel/drafts/plan/report. **Ships sequential-fallback NOW; flips to parallel via one config line once the host advertises `fanOutSupported`.** Packs `feature.campaign-orchestration.{nodes,agents,workflows}`. | ADR 0157, RFC 0013 · **RFC 0118 (Draft — parallel fan-out; sequential fallback until Accepted+wired)** | 🟢 Done — **sequential ships; parallel RFC-gated (P1.5)** (ADR 0158 `implemented`, Phases 1–3 — `MarketingCampaign` entity/finalize-upsert · `campaign-studio.campaign-orchestration` builtinWorkflow (validate→kernel→approve→5× sequential `core.subWorkflow`→consistency→finalize, briefId-keyed) · Campaign Strategist agent · `marketing-campaign`/`consistency-report` artifact types · `/campaigns` FE page; 26 tests + FE build green. Host validates `fanOutPolicy='parallel'` as unsupported → confirms the RFC 0118 gap) | net-new (Campaign Studio port — CS-008 composable workflow) |
| 0159 | **Campaign Studio — Live Connectors & Performance** (toggle `campaign-connectors`, OFF, bucket `tenant`, category `Marketing`) — Google/Meta/LinkedIn Ads **RFC 0095 connection packs** + a daily-**sync node** (15-min cooldown, dedup `platform\|campaign\|adSet\|date`, unified metrics spend/impr/clicks/conv/revenue → ctr/cpc/cvr/cpa/roas) + **CSV import** (column-mapping wizard, 9 platform templates, validation, computed fields) + a campaign **performance store** + KPI projection. Composes Connections (0024/0033/0037) + Analytics (0018); **day-1 honesty matrix** (advertise `supported:false` until brokered). Packs `vendor.*.connections.{google,meta,linkedin}-ads` + `feature.campaign-connectors.nodes` (`ads.sync`, `ads.import.csv`). Host-ext, **rides RFC 0095 — no new RFC**. | ADR 0024, 0033, 0037, 0018, 0158 | 🟢 Done (ADR 0159 `implemented`, Phases 1–3 — performance store (dedup natural-key) + pure CSV import (parse/map/validate/compute) + KPI projection · Google/Meta/LinkedIn Ads RFC 0095 connection packs + `import-csv`/`sync` (honest-off) nodes · `/campaign-performance` FE; 6 tests + connection-packs 8/8 + FE build green) | net-new (Campaign Studio port — CS-007/009 Intelligence-data+Live-connectors) |
| 0160 | **Campaign Studio — Campaign Intelligence** (toggle `campaign-intel`, OFF, bucket `tenant`, category `Marketing`) — KPI dashboard projection + **budget recommendation engine** (heuristic ROAS-marginal + AI scenarios) + **forecasting** (creative fatigue / scaling / outcome) + **NL queries** via the Strategist agent (`budget.optimize`/`performance.forecast` tools — not a bespoke analytics chatbox) + alert/digest rules over **Notifications (ADR 0010)**. Composes performance store (0159) + Analytics (0018). Packs `feature.campaign-intel.nodes`. Host-ext, **no new RFC**. | ADR 0158, 0159, 0018, 0010 | 🟢 Done (ADR 0160 `implemented`, Phases 1–2 — pure budget optimizer (marginal-ROAS reallocation) + forecaster (creative-fatigue + outcome projection) · `feature.campaign-intel.nodes` (`budget-optimize` w/ optional AI narrative, `forecast`) + Campaign Intelligence Analyst agent (NL queries) · `/campaign-intelligence` FE; 7 tests + FE build green. Scheduled alert/digest = follow-on) | net-new (Campaign Studio port — CS-007/010 Budget+Predictive) |
| 0149 | **Real-Work Workflow Library** — 20 substantive, multi-step `WorkflowDefinition`s (exec/CoS daily briefing & meeting prep, marketing campaign launch & ad-optimization loop, onboarding/offboarding, invoice→AP & close, account brief/renewal/RFP, incident triage) composing **existing primitives only**: `core.trigger.*` + the RFC 0052 scheduler daemon, shipped feature node packs (`feature.crm/kb/cms/email/forms/analytics.nodes`), `core.openwop.integration.*` outbound, RFC 0095 connection packs, `core.subWorkflow`/parallel edges/`core.approvalGate`. Pinned sibling pack to the ADR 0032 template catalog (NOT a new surface — [[build-on-orchestration-not-parallel-surfaces]]); demo-mode degrades to `mock-ai`+seed. Phase 1 lighthouse set (Lead Triage, Account Brief, Renewal Digest, RFP Assembly) needs **zero new connectors**; only Google/Meta Ads (#6) are net-new providers. **§Correction 2026-06-27:** the proper home is a **workflow(-chain) pack loader (RFC 0013)** — peer to node/agent/connection packs — which this host does not yet implement; an initial parallel pinned `lib.*` catalog + route was reverted. Landed: 3 connection packs (Google/Meta Ads, NetSuite). **Next:** architect the workflow-pack loader, then ship the 20 workflows as a signed workflow pack. | ADR 0032, 0058, 0133, 0010, 0137; RFC 0013/0052/0095 | 🟡 In progress (ADR 0149 — connection packs landed; workflow-pack loader is the next step, 2026-06-27) | net-new (real-work corpus vs. MyndHyve, 2026-06-27) |
| 0170 | **Brand — app identity + marketing brands** (toggle `brand` **graduates to always-on/core**; was OFF / bucket `tenant` / `Marketing`) — extends ADR 0155's `Brand` with a visual-**identity** facet so ONE feature owns both the **white-label app identity** (a reserved `brand:host-app` brand **in the existing `host-site` org** drives logo/colors/fonts/favicon/title/theme at **runtime**, super-admin-edited via an Admin **Appearance** panel, served pre-auth on `/public-brand`, applied by injecting `:root` CSS vars — no rebuild) **and** tenant **marketing brands** (unchanged) — the CMS-owns-homepage pattern (ADR 0027). Build-time `VITE_BRAND_*` becomes the boot **seed**; clay-ramp made accent-derived; FOUC solved by serve-time `index.html` inlining. Host-ext, **no new RFC**. | ADR 0155, 0027, 0007, 0006, 0015, 0052 | 🟢 Done (ADR 0170 `implemented` Phases 1–7 + **deployed** 2026-06-29, #1016; Phase 8 asset-upload deferred) | net-new (white-label brand at runtime, 2026-06-29) |
| 0171 | **Customizable token-based theming** (extends ADR 0170; same `brand` feature) — replaces the single-accent + 3-preset identity with a **2-tier OKLCH-generative** system: store a small input set (accent/neutral seeds + typography + radius/density + contrast level) in `Brand.identity` and **generate the full light+dark token set deterministically** (hybrid: perceptual OKLCH ramp for brand fidelity + a contrast-solve on on-colors for guaranteed WCAG-AA; ports MyndHyve's `deriveDarkMode` AA-bump). Presets become named seed-sets; full per-token override + JSON import/export as the advanced tier. Reuses ADR 0170's `:root` `setProperty` injection. Two-tier editor (no-code + advanced) with live light/dark preview + inline contrast warnings. Functional/category colors stay semantic (DESIGN.md §3). Host-ext, **no new RFC**. | ADR 0170, 0007, DESIGN.md | 🟢 Done (ADR 0171 `implemented` Phases A–E, 2026-06-30 — generator + token tiers + input model + two-tier editor + contrast validation; FE build green, 22 theme tests) | net-new (customizable theming, 2026-06-30) |

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
