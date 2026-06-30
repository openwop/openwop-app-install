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
| **Knowledge Base / RAG** — org-scoped document collections, ingest (pasted text or Media token) → chunk + embed, semantic search with citations | `kb` | OFF | `tenant` | — (plain on/off) | — (composes `core.openwop.rag` + host `db.vector`) | `/kb` (admin → "Access & data") + `/v1/host/openwop-app/kb/orgs/:orgId/*` · reuses the host vector store + deterministic embedder (ADR 0011) |
| **Sharing** — unguessable public share links to a specific resource (CMS page incl. drafts, KB collection) + social-card metadata | `sharing` | OFF | `tenant` | — (plain on/off) | — (composes CMS + KB via a resolver registry) | authed `/v1/host/openwop-app/sharing/orgs/:orgId/links` + **public** `/v1/host/openwop-app/shared/:token` (unauthed, token-credential, toggle-gated) · admin **Content** group `/sharing` (ADR 0013) |
| **Forms** — org-scoped form builder; public submit → CRM contact (through `crmService`); `ctx.features.forms` + node/agent packs | `forms` | OFF | `tenant` | — (plain on/off) | `feature.forms.*` | authed `/v1/host/openwop-app/forms/orgs/:orgId/forms` + **public** `/v1/host/openwop-app/public-forms/:formId` (unauthed, published-only, toggle-gated) · `/forms` (workspace) (ADR 0017) |
| **Consent & Compliance** — region-aware consent policy + the centralized `isAllowed` gate (Analytics/Email call it) + data-subject GDPR erasure (cascades to feature data) | `consent` | OFF | `tenant` | — (plain on/off) | `feature.consent.*` | authed `/v1/host/openwop-app/consent/orgs/:orgId/*` + **public** `/v1/host/openwop-app/public-consent/:orgId` (unauthed, toggle-gated) · `/consent` (workspace) (ADR 0020) |
| **Analytics** — public-surface measurement (page/event/conversion) via a consent-gated beacon + authed reporting (counts, sessions, top paths, UTM); `ctx.features.analytics` + node/agent packs | `analytics` | OFF | `tenant` | — (plain on/off) | `feature.analytics.*` | authed `/v1/host/openwop-app/analytics/orgs/:orgId/{summary,events}` + **public beacon** `/v1/host/openwop-app/public-analytics/:orgId/collect` (unauthed, toggle+consent-gated) · `/analytics` (workspace) (ADR 0018) |
| **Email Marketing** — templates + campaigns over CRM contacts (audience resolved live), marketing-consent-gated sends through a stub provider, per-campaign stats + send log; `ctx.features.email` + node/agent packs | `email` | OFF | `tenant` | — (plain on/off) | `feature.email.*` | authed `/v1/host/openwop-app/email/orgs/:orgId/{templates,campaigns}` (incl. `/campaigns/:id/send`) · `/email` (workspace) (ADR 0019) |
| **Assistant capability + Chief of Staff** — the assistant operating-rhythm (structured memory graph + perception/action loops + approvals) is now a **core, profile-activated capability** (ADR 0023 §Correction / ADR 0031): no longer fused to `roleKey 'chief-of-staff'` — any agent with `agentProfile.capabilities:['assistant']` activates it over the shared tenant work-graph. "Iris" (Chief of Staff) is the seeded default; it is the foundation of the **Enterprise Work-Twin suite** (see note below). | — (graduated off its toggle 2026-06-11 — always-on substrate) | ALWAYS ON | — | — | `feature.assistant.{nodes,agents}` | `/agents/<chief-of-staff>` + `/v1/host/openwop-app/assistant/*` (graph/loops/briefing routes; loops deploy-gated on Google OAuth) |
| **Collaboration / Comments** — threaded comments on CMS pages + KB collections (resolver registry — a new commentable type is one entry); add/reply notify over the existing tenant inbox (namespaced string types, no core-union edit); `ctx.features.comments` + node/agent packs (content-reviewer) | `comments` | OFF | `tenant` | — (plain on/off) | `feature.comments.*` | `/comments` (workspace) + authed `/v1/host/openwop-app/comments/orgs/:orgId/comments` (ADR 0021 — Phases 1–3 + extension surface; presence/cursors deferred) |
| **Per-agent knowledge & memory** — bind documents (cited, KB-backed via `kbService`) + private notes (recalled via the RFC-0004 memory namespace) to a specific agent; composed into the agent's dispatch retrieval each turn. Core `knowledge` capability activated per `agentProfile`; retrieval composed in the host route layer (no feature→core import). Curation gated by workspace:read/write + per-agent IDOR + ADR 0036 profile policy | — (graduated off its toggle 2026-06-16 — always-on, like `profiles` / Personal Memory) | ALWAYS ON | — | — | `feature.agent-knowledge.nodes` (read; no agent pack) | authed `/v1/host/openwop-app/agents/:id/knowledge/*` (view · retrieve · bindings · collections · documents · notes · memory-writable) + read-only `ctx.features.agent-knowledge` · "Agent Knowledge" panel on the agent detail page (ADR 0038) |
| **Personal Knowledge & Memory (digital twin)** — the human counterpart of Per-agent knowledge (ADR 0041/0042): a person trains their OWN profile toward a digital twin — personal **memories** (facts/notes, ADR 0041) AND bound **documents** (cited, ADR 0042). Reuses the SAME primitives agents use: subject memory (`host/subjectMemory.ts`, RFC 0004) under `user:<userId>` + the shared `resolveSubjectKnowledgeRetrieve` composition over `kbService` (ADR 0011). No new store; `Profile.knowledge` holds only references (collectionIds), never content (ADR 0005 boundary). Notes are DURABLE; self-service (caller curates only their own corpus); `retrieve` composes docs + notes into one corpus. | — (graduated off its toggle 2026-06-15 — always-on, like `profiles`) | ALWAYS ON | — | — | — (no pack; host-ext routes) | authed `/v1/host/openwop-app/profiles/me/{memory,knowledge}/*` (memory list/add/delete · knowledge view/bind/create/ingest/delete/retrieve) · "Memory" + "Knowledge" tabs on My Profile + per-agent "Memory" tab on the agent workspace (ADR 0041/0042) |
| **Projects** — a `kind:'project'` Subject (ADR 0046 / the ADR 0045 subject model, Phase 3): an org-scoped work container that OWNS the same surfaces an agent/person does — a kanban board (via the generic `ownerSubject`), memory (the `project:<id>` scope, free via `subjectMemory`), knowledge (cited documents over the generic `host/subjectKnowledge` binding, composed with project memory via the shared `resolveSubjectKnowledgeRetrieve`), schedules (cron jobs owned by `project:<id>` on the ONE scheduler via the generic `ownerSubject`), and assigned workflows. No cognition, no authority of its own (a person with `workspace:write` in the project's org acts on it). Proves a new subject kind is nearly free. | — (graduated off its toggle 2026-06-15 — always-on; access stays org-scoped) | ALWAYS ON | — | — | — (no pack; host-ext routes) | authed `/v1/host/openwop-app/projects/*` (CRUD · workflows · `:id/memory` · `:id/knowledge` · `:id/schedules`) · "Projects" workspace page (folder icon) + per-project board/memory/knowledge/workflows/schedules tabs (ADR 0046) |
| **Collaborative projects** — turns a `project` Subject (ADR 0046) into a place people **and** agents work together, COMPOSING existing systems (no parallel chat/auth/roster): a **charter** (`Project.charter` — goals/objectives/dates/status/health/milestones, additive), **descriptive membership** (`Project.members[]` — people + agents with a project-role *label*; authority stays org-scoped in `accessControl`, ADR 0045), **member-scoped visibility** (additive `Project.visibility: 'org'\|'private'` via a generalized `subjectAccess` seam — READ gains a membership dimension over every project-owned surface, WRITE stays org-scoped), and a **project group chat** bound to `project:<id>` (`ConversationMeta.ownerSubject`, ADR 0043) + the `@@` cohort convene (ADR 0040) with a moderator + turn-policy cadence (moderator-must-be-a-member, cohort cap 8). The project read projects **`canWrite`** (ADR 0063) so the FE pre-gates every write control (delete / charter / members / visibility / chat / workflows / memory / knowledge / schedules) — a read-only member sees a "read-only access" notice instead of affordances that 403; `requireProject('workspace:write')` stays the authority. | — (graduated off its toggle 2026-06-16 — always-on, rides the always-on `projects` surface) | ALWAYS ON | — | — | — (no pack; host-ext routes) | authed `/v1/host/openwop-app/projects/*` (charter · `:id/members` · `:id/chat`/convene) · per-project **Overview / Members / Chat** tabs (ADR 0054, Phases 1–4) |
| **Digital twin recall** — the authorization layer for an agent recalling its OWNER's corpus (ADR 0044, the architect's #2). A two-step model: an admin LINKS an agent to a person (`agentProfile.twin`); only that PERSON issues/revokes a consent GRANT (`TwinGrant`, host-owned `twinService`) for `memory`/`knowledge` scopes. First intra-tenant cross-principal read — opt-in per tenant. **Phase 1+2 (shipped):** link + grant + RBAC + audit, AND fenced cross-subject recall — a granted twin recalls its owner's memory/docs, composed via the host `twinRecallSurface` seam (`getActiveGrant` is the LIVE gate; no run-stamp — recall is a live read, so revocation is immediate everywhere). Owner content is **structurally** untrusted-fenced in dispatch (`borrowedRetrieve` → untrusted block, no trusted path). Fail-closed: no toggle/link/grant ⇒ no cross read; each recall audited. **Phase 3 (shipped):** the agent **"Twin of …"** affordance on `AgentProfilePanel` (link/unlink + per-scope grant/revoke when the viewer is the linked person) + the user's **"Who can recall my memory"** consent dashboard tab on My Profile (active grants + immediate revoke); both `twin-recall`-gated. | `twin-recall` | OFF | `tenant` | — (plain on/off) | — (no pack; host-ext routes) | authed admin `/v1/host/openwop-app/agents/:id/twin` (link/unlink/view) + self `/v1/host/openwop-app/profiles/me/twin-grants` (list/grant/revoke); recall composed in dispatch · `features/twin/*` UI (ADR 0044 Phase 1–3) |
| **Board of Advisors** — assemble councils of named advisor agents (digital-clone personas) + convene them together in one shared chat via `@@`: each advisor replies grounded in its OWN bound knowledge (ADR 0038, unchanged) and sees the others' turns (narrative-cast `[Name]:`), then a moderator synthesizes. Advisors are roster agents (persona = `agentProfile`, ADR 0031/0032); a new `AdvisoryBoard` grouping under `/advisors/*` — **not** `host.kanban`'s board. `private`/`shared` visibility + RBAC; simulated-persona disclaimer + living-individual ack gate. Composes the host multi-agent conversation scaffold + the assistant moderator (0023); host work riding Accepted RFC 0005/0002 §A8 (no blocking RFC). | `advisory-board` | OFF | `tenant` | — (plain on/off) | — (read-only `ctx.features.advisory-board` surface; signed node pack + `tmpl.advisors.*` seed deferred, logged in ADR 0040) | authed `/v1/host/openwop-app/advisors/*` (boards CRUD · convene · sessions) · "Board of Advisors" workspace page (ADR 0040, Phases 1–5) |
| **Documents & Templates** — versioned business-document store (SOW/PRD/RFP/Epic-Brief/board-agenda; markdown native, pdf/slides/sheet as Media tokens) + a template library that *binds* prompt-templates (RFC 0027/0028) to named kinds and validates output against a template-owned `outputSchema`; agentic `generate-from-template` (assemble in-route, generate in a run). Documents are a **Subject-owned surface** (`ownerSubject`: project/user/agent, ADR 0045/0046) — no soft tag, no parallel owner. Composes Media bytes (0007), KB ingest (0011), Sharing `document` resolver / approved-final-only (0013), Subject-Memory (0041). Artifact-types (RFC 0071/0075) not implemented here → `artifactTypeId` opaque, typed `artifact.created` deferred. | `documents` | OFF | `tenant` | — (plain on/off) | `feature.documents.{nodes,agents}` | authed `/v1/host/openwop-app/documents/orgs/:orgId/*` (documents · versions · templates · assemble · ingest-to-kb) + `ctx.features.documents` surface · "Documents" workspace page (ADR 0053, Phases 1/3/4) |
| **Priority Matrix** — capture ideas/requests into named priority lists, score them against a configurable weighted criteria set (1–10 slider weights; a Weighted-Scoring engine with WSJF/RICE/ICE/Value-Effort presets), rank them, and run a planning session that turns the top picks into a meeting agenda. **An idea IS a `host.kanban` card** (statuses = columns, `terminal` lanes + assignment via ADR 0049 — no parallel board); the feature owns only criteria sets + per-idea score overlays + planning sessions. Workspace-scoped by default; a `projectId` scopes a list to a project (board `ownerSubject`, ADR 0046). The agenda **composes Documents `board-agenda`** (ADR 0053) when enabled, inline markdown otherwise. Editing criteria/weights (or deleting a list) needs list-owner or org-admin authority. `ctx.features.priority-matrix` surface + `feature.priority-matrix.{nodes,agents}` packs (Prioritization Analyst, chat-drivable). Multi-voter scoring (ADR 0059) + cross-list Portfolio rollup (ADR 0060). | `priority-matrix` | OFF | `tenant` | — (plain on/off) | `feature.priority-matrix.{nodes,agents}` | authed `/v1/host/openwop-app/priority-matrix/*` (lists · ideas · scores · sessions · presets · portfolio) · "Priority Matrix" workspace page (ADR 0058/0059/0060) |
| **Marketplace** — browse + install signed feature packs (node/agent packs) from the registry + per-org reviews/ratings; listings are a computed projection (pack-dir scan + install markers + `featurePackRefs`), install delegates to `registryInstaller` (Ed25519 + SRI, signed-only) and is superadmin-gated (process-global mutation), reviews are the only new store (tenant+org IDOR-guarded); read-only `ctx.features.marketplace` (`listings`/`search`; install excluded by design) | `marketplace` | OFF | `tenant` | — (plain on/off) | `feature.marketplace.{nodes,agents}` (search node + read-only recommender) | authed `/v1/host/openwop-app/marketplace/*` (listings · install · org-scoped reviews) · "Marketplace" workspace page (ADR 0022) |
| **CMS content localization** — RFC 0103 localized content added INTO the existing CMS (ADR 0064): additive `Section.localizations` sparse per-locale overlays + a core-shared `host/i18n/` negotiator (`Accept-Language`→`Content-Language`, exact→family→base) + per-org `ContentLanguageSettings` + AI translate-from-base (managed provider, sanitized) + the normative public `GET /v1/content/*` projection (negotiates over the host-advertised `OPENWOP_I18N_LOCALES`; seeded es/pt-BR system-site overlays). Toggle OFF ⇒ CMS byte-identical. | `cms-localization` | OFF | `tenant` | — (plain on/off) | `feature.cms.{nodes,agents}` (`get-page`/`translate-section` + the localizer agent) | authed `/v1/host/openwop-app/cms/orgs/:orgId/*` (locale tabs via page PATCH · language settings · translate) + **public** `/v1/content/pages/:slug` (anon, published-only, `Vary`) + read-only `ctx.features.cms` · CMS admin locale editor (ADR 0064, Phases 1–3 + workflow surface) |
| **CMS editorial approval gate** — gate CMS publish on a real, audited, inbox-visible human approval (ADR 0066) by composing the host's run-independent approval queue (`host/approvalService.ts`, `kind:'content-publish'` — no new store, no run). ON ⇒ `submit` queues an approval in the shared ApprovalsInbox; the decide path (org `host:members:manage` + IDOR) transitions the page; direct `approve` defers to the inbox. OFF ⇒ editorial workflow byte-identical. | `cms-approval-gate` | OFF | `tenant` | — (plain on/off) | — (no pack; composes `approvalService` + cms routes) | authed CMS `/pages/:id/{submit,approve,reject}` + the shared `/v1/host/openwop-app/approvals/*` inbox (content-publish rows) (ADR 0066) |
| **AI Workflow Author** — author a workflow from a natural-language intent (ADR 0072): the brain the core xyflow builder lacked. Reads the **live node catalog** as a closed-world menu (typeIds + JSON Schemas; never invents a typeId), plans a connected acyclic node/edge DAG, and registers a schema-valid `WorkflowDefinition` through the **shared** validator + registry (the same path `POST /v1/host/openwop-app/workflows` uses — incl. the RFC 0022 §C gate) so it opens in the builder. Delivered as the **meta-workflow** `feature.workflow-author.nodes.{draft,validate,persist}` (draft→validate→persist, in-node repair loop) + the "Workflow Architect" agent + a thin `draft` route the "Create with AI" builder entry calls. Catalog builder, definition validator, closed-world check, and run dispatch are all **core, reusable** seams (`host/{nodeCatalogBuilder,workflowDefinitionValidation,runDispatch}.ts`); the meta-workflow is a feature **built-in** via the new `BackendFeature.builtinWorkflows` contract (hard-coded catalog, any feature can use it). >8KB-schema nodes excluded + logged. | — (graduated off its `workflow-author` toggle 2026-06-19 — **always-on**; rides the core builder surface) | ALWAYS ON | — | — | `feature.workflow-author.{nodes,agents}` | authed `/v1/host/openwop-app/workflow-author/{draft,catalog}` + read-only `ctx.features['workflow-author']` · "Create with AI" entry in the builder (ADR 0072) |
| **Strategic Planning** — an executive **strategy portfolio** (narrative rationale + OKR-compatible objectives/key-results + initiatives + planning horizon (quarter/half-year/annual/multi-year/custom) + owner/accountable-exec + status/confidence/risk) that is the **connective tissue** across Priority Matrix, Projects, and Board of Advisors. New `Strategy` entity (`DurableCollection`, tenant-scoped); **scope** `user`/`workspace`/`org` is a visibility modifier over a mandatory owning `orgId` (ADR 0079 §Correction — the app has no org-less shared entity). **Links are canonical on the Strategy** (`StrategyLink` → project/priority-list/priority-idea/advisory-board/document) and read **back** into consumers via RBAC-filtered projections — **no denormalized `strategyIds[]`, no `Project.charter` overload, not a reuse of `goals`** (judge-owned, RFC 0097). Cross-feature touch is **FE-composition** (Priority Matrix chips/align + Projects refs ride the existing context/links endpoints — zero PM/projects backend coupling, no feature cycle) and a **core resolver-registry seam** (`host/boardContextResolver.ts`) that snapshots a board's selected strategy context onto the boardroom conversation and injects it into each advisor's prompt. `DELETE` = soft-archive; identifier fields are not secret-scrubbed; `private` projects are member-scope-gated in context. **ADR 0080 enrichments:** a live **health rollup** (on-track/at-risk/off-track + signals) on the Portfolio + `GET /strategy/health`; a **Strategy Analyst** agent (audits alignment gaps, drafts board memos via a `board-update` Document — tool-allowlisted, **no strategy-mutation tool**, chat-drivable); create-form **templates** (OKR / annual-operating-plan / portfolio-bet / working-backwards). The `ctx.features.strategy` surface stays read-only. | `strategy` | OFF | `tenant` | — (plain on/off) | `feature.strategy.{nodes,agents}` (ADR 0080) | authed `/v1/host/openwop-app/strategy/*` (CRUD · `:id/links` · `/context` · `/health`) + `/advisors/boards/:id/strategy-context` preview + read-only `ctx.features.strategy` (list/get/context/health — shared strategies only) · "Strategy" workspace page + Priority Matrix/Projects/Board-of-Advisors integration (ADR 0079) + the Strategy Analyst agent + templates (ADR 0080) |
| **Insights & Drafting** — three domain agents (Financial actual-vs-plan variance from the data lake · Talent 9-box readiness from Workday · Communication in-voice recognition drafting — always a draft for approval) + built-in meta-workflows driven through the existing chat / builder / scheduler / triggers; results surface as run outputs + notifications, NO dashboard or parallel store (ADR 0082, rebuilt on the engine; supersedes the 0078/0081 dashboard) | `insights-suite` | OFF | `tenant` | — (plain on/off) | `feature.insights-suite.{nodes,agents}` | authed `/v1/host/openwop-app/insights-suite/config` (schedule + anniversary-trigger reconciliation only) + 3 built-in workflows surfaced through the existing runs / artifacts / chat / notification surfaces — no feature page (ADR 0082, supersedes 0081) |
| **Research Notebooks** — notebooks over a project Subject: sources (KB), notes (memory), grounded ask/search + a `summarize` workflow, with HITL-gated writes exposed as inbound MCP tools (ADR 0084/0087) | `notebooks` | OFF | `tenant` | — (plain on/off) | `feature.notebooks.nodes` · `feature.notebooks.agents` · `core.openwop.mcp` · `core.openwop.hitl` | `/notebooks` (workspace) + `/v1/host/openwop-app/notebooks/*` (ADR 0084/0087) |
| **Podcasts** — turn a research notebook into a multi-speaker narrated audio episode (1–4 voiced speakers) via an executor run (outline → transcript → RFC 0105 synthesize → mix); schedulable (ADR 0086) | `podcasts` | OFF | `tenant` | — (plain on/off) | `feature.podcasts.nodes` · `feature.podcasts.agents` | `/podcasts` (Podcast Studio, workspace) + `/v1/host/openwop-app/podcasts/*` (ADR 0086) |
| **Tool-output compaction** — compacts verbose JSON tool outputs at the typed tool-result boundary before they re-enter the model context, cutting BYOK token spend (deterministic, structure-preserving, replay-safe) (ADR 0099) | `tool-output-compaction` | OFF | `tenant` | — (plain on/off) | `feature.tool-output-compaction.nodes` | seams-only: `toolResultTransform` + `runStartContext` core seams + `ctx.features.tool-output-compaction.compact` mid-graph surface (no REST route; no FE page) (ADR 0099) |
| **Knowledge sync** — scheduled one-way diff-sync of an external drive folder (Google Drive / OneDrive, via a Connection) into a KB collection; content untrusted-fenced + SSRF-guarded egress (ADR 0107). Phase 2 manages sync sources; the scheduled sync run + UI are later phases | `knowledge-sync` | OFF | `tenant` | — (plain on/off) | — (no pack; composes Connections + `knowledgeSourceFetch` + scheduler + KB ingest) | authed `/v1/host/openwop-app/knowledge-sync/*` (sync-source CRUD + diff state) · "Knowledge sync" panel on the Knowledge Base page (ADR 0107) |
| **Conversation search** — full-text search across your conversations + messages, a read-only DERIVED lexical index over the existing ADR 0043 chat store (Postgres FTS + in-memory fallback, lazily rebuilt); results post-filtered through the participant-scoped visibility gate (no existence leak) (ADR 0112) | `conversation-search` | OFF | `user` | — (plain on/off) | — (no pack; composes the host `db.search` surface, RFC 0018) | authed `/v1/host/openwop-app/chat/search` (GET/POST `?q&type&role&limit`) · search box in the Conversations rail (ADR 0112) |
| **Code execution** — a sandboxed code interpreter that runs snippets in a pluggable EXTERNAL sandbox via the host `ctx.runSandboxedCode` adapter, behind an HITL approval, with results projected into the artifact workbench; honest-off (no adapter ⇒ `capability_not_provided`); a paid, high-blast-radius surface (ADR 0114) | `code-exec` | OFF | `tenant` | — (plain on/off) | `feature.code-exec.{nodes,agents}` (Code Interpreter persona) | host-extension only — no HTTP routes (the surface is the node pack + the `ctx.runSandboxedCode` seam); results open in the `ArtifactWorkbench`/Library, driven through the existing chat (ADR 0114) |
| **Prompt library** — a shareable, RBAC-gated, versioned catalog of prompts that REFERENCE the existing prompt store; org-scoped private/org/shared visibility, insertable into chat via `/prompt` (ADR 0116) | `prompts` | OFF | `tenant` | — (plain on/off) | — | `/prompts` (workspace) + `/v1/host/openwop-app/prompts/orgs/:orgId/entries/*` (ADR 0116) |
| **Usage analytics** — admin per-model token/cost rollup aggregating recorded provider usage; read-only data source for the usage dashboard (ADR 0118) | `usage-analytics` | OFF | `tenant` | — (plain on/off) | — | authed `/v1/host/openwop-app/usage/orgs/:orgId/rollup` · admin usage dashboard (ADR 0118) |
| **Conversation export** — export a conversation as markdown or JSON, a read-only render over the existing transcript (no new store); owner/participant-gated, with an import route over the same renderer (ADR 0119) | `chat-export` | OFF | `tenant` | — (plain on/off) | — (no pack; composes the chat store) | authed `/v1/host/openwop-app/chat-export/:sessionId?format=md\|json` + `/chat-export/import` · export affordance on the existing chat (ADR 0119) |
| **Chat memory auto-extraction** — opt-in, fail-closed extraction of durable facts from your chats into your personal subject-memory (`user:<id>`), fenced like a consent grant (ADR 0044); notes are tagged `[auto-extracted]` / untrusted with provenance and are reviewable & deletable (ADR 0120) | `memory-auto-extract` | OFF | `user` | — (plain on/off) | — (no pack; reuses subject-memory + the ADR 0044 grant model) | authed self `/v1/host/openwop-app/profiles/me/memory-extraction` (GET/PUT/DELETE grant) · extraction fires on conversation close; review UI on My Profile pending (ADR 0120) |
| **AI chat permission mode (safe / bypass)** — a **per-conversation** switch in the chat composer toolbar: **safe** (default) makes the agent ask before consequential tool actions (run code, write a file, send data off-host) via the existing capability-firewall approval card; **bypass** lets the agent act without asking (the user pre-authorizes), while deny/RBAC/budget/sandbox still bind. Composes the ADR 0135 firewall + interrupt ledger (no new HITL system); classifies code-exec `require-approval` so safe mode restores the "Run code?" gate; carried per-exchange ⇒ replay-deterministic (ADR 0150) | — (**core**, no toggle) | CORE | — | — | — (no pack; extends the capability-firewall) | **Safe / Bypass** switch in the composer toolbar (per chat, default safe); the approval card already exists (ADR 0150) |
| **AI conversation auto-titling** — name a chat by its TOPIC via a cheap, parallel, **in-language** LLM call **once on the first exchange** (≤5 words, `completion` method — no tool-calling, for free-tier reliability), written to the existing session title; fail-closed + fire-and-forget (never blocks the turn), never clobbers a manual rename (`titleSource`), degrades to the first-message placeholder on any failure. Host-extension / non-replay, reusing the ADR 0120 memory-extract seam + the managed/BYOK dispatch (ADR 0151) | `chat-autotitle` | **ON** | `user` | — (plain on/off) | — (no pack; reuses the chat-session title + managed dispatch) | the title is set silently on the existing chat (rail/tab) via a `conversation.titled` SSE event; toggle in FeatureTogglePanel (ADR 0151) |
| **Evals leaderboard** — admin model-quality ranking: per-model win-rate + Elo computed from the already-captured message feedback (ADR 0071), plus a head-to-head arena; no new chat (ADR 0123) | `evals` | OFF | `tenant` | — (plain on/off) | — (no pack; composes captured `MessageFeedback`) | authed `/v1/host/openwop-app/evals/orgs/:orgId/*` (leaderboard · arena/match · arena/rating) · "Model leaderboard" workspace nav page (ADR 0123) |
| **Scheduled agent chats** — bind an agent + cadence + prompt to a conversation; the recurring tick enqueues a chat-turn through the existing scheduler daemon (digests, monitors) (ADR 0125) | `scheduled-agent-chats` | OFF | `tenant` | — (plain on/off) | — | `/scheduled-chats` (workspace) + `/v1/host/openwop-app/scheduled-chats/orgs/:orgId/chats/*` (ADR 0125) |
| **Channels** — team **+ AI-agent** messaging inside the ONE chat (not a second system): topic rooms (public/private) where humans **and agent members** collaborate — membership + read-state, **live SSE message delivery**, public-channel **discovery + self-join**, and an `@agent` post that dispatches a `chat.turn` whose reply lands in-channel. Repositions the product from "a chatbot you use alone" to "a workspace where your team and your agents do work together," reusing the chat store + SSE seam + run engine rather than a parallel system (ADR 0126). | `channels` | OFF | `tenant` | — (plain on/off) | — (no pack; composes the conversation store + ADR 0088 SSE seam) | authed `/v1/host/openwop-app/channels/*` (CRUD · membership · `:id/messages` · `:id/stream` live SSE · `:id/join` · presence); **rail-integrated (ADR 0154, shipped — deployed 2026-06-27)** — channels render in the chat Conversations rail via the shared `ConversationView`, management is chat chrome (create / settings / browse-and-join dialogs), the standalone `/channels` page is retired; deck-parity in the multi-tab chat. v1 limits: signed-in only (CHN-3, no anon), local-host, text-only, no DMs/threads/reactions. |
| **Embeddable chat widget** — a domain-allowlisted, capability-token-gated public gateway over the existing embedded chat (ADR 0073 `EmbeddedConversation`, no second chat component); default-deny until provisioned + allowlisted, with a served vanilla-JS embed snippet (ADR 0127) | `chat-widget` | OFF | `tenant` | — (plain on/off) | — (no pack; composes `EmbeddedConversation`) | authed `/v1/host/openwop-app/chat-widget/orgs/:orgId/widgets` + **public** `/v1/host/openwop-app/public/widget/{config,message,embed.js}` (origin-gated, token-credential, toggle-gated) · "Widgets" admin page `/widgets` (ADR 0127) |
| **Interactive artifacts** — live HTML/React/Mermaid/chart artifacts in the EXISTING chat artifact workbench (ADR 0069), not a new surface; registers the artifact types so an emitted interactive artifact validates + persists, rendered CSP-sandboxed in the workbench (ADR 0128) | `interactive-artifacts` | OFF | `tenant` | — (plain on/off) | — (no pack; registers artifact types) | no HTTP routes (registers artifact TYPES) · renders in the existing chat `ArtifactWorkbench` (ADR 0128) |
| **Model router** — rule-based per-turn `{provider,model}` routing (cost/quality) in front of dispatch; OFF keeps the run's explicit model (ADR 0130) | `model-router` | OFF | `tenant` | — (plain on/off) | — | authed `/v1/host/openwop-app/model-router/orgs/:orgId/config` (rule editor in the BYOK/AI-config admin; standalone FE pending) (ADR 0130) |
| **Context economy** — host-internal token efficiency for per-iteration context assembly: Anthropic prompt caching (A2), tool-schema compaction (A3), chat-transcript char budget (A1), memory-injection char budget (A4), JSON-response gzip (A6). Governed by `OPENWOP_CONTEXT_ECONOMY*` env (master + per-lever), all default OFF; this toggle is **admin-visibility only** and does NOT gate dispatch (the dispatch layer is tenant-agnostic). No wire change (ADR 0148) | `context-economy` | OFF | `tenant` | — (plain on/off) | — (no pack; host env-config) | no HTTP routes; behavior lives in provider dispatch + chat context assembly, gated by env (ADR 0148) |

> Defaults are OFF — a superadmin turns a feature on (or to BETA, or on with a
> traffic split) per tenant from the admin screen.
>
> **Surfaces intentionally NOT in this toggle catalog** (always-on; no
> `toggleDefault`):
> - **Frontend UI-string i18n (app-chrome localization)** — react-i18next + an `Intl` format layer + per-feature catalogs + a `LanguageSwitcher`; **always-on core infra, no toggle** (like the design system). English ships byte-identical; a 2nd UI locale (pt-BR, native-reviewed) is gated by the declared-locale contract (`SUPPORTED_LOCALES`), not a toggle. One locale drives UI chrome + ADR 0064's `Accept-Language` content negotiation. See `docs/adr/0065-frontend-ui-string-i18n.md`.
> - **Notifications** (removed 2026-06-11) — **core platform infrastructure**:
>   run-failure/interrupt notifications emit unconditionally, so a toggle only hid
>   the UI while side effects flowed; the honest control is the per-user
>   **preferences** (mute / quiet-hours / Web-Push opt-in). **ADR 0050** adds
>   per-recipient targeting (`recipientUserId` — addressed vs tenant-broadcast +
>   per-user Web-Push), still core/always-on. See
>   `docs/adr/0010-notifications.md` § Correction + `docs/adr/0050-…`.
> - **Kanban boards + card assignment** (`host.kanban`, authed
>   `/v1/host/openwop-app/kanban/*`) — the board/card surface is core (no toggle).
>   **ADR 0049** adds assigning a card to a person/role: the card stays on its
>   board while the assignee gets an addressed notification (ADR 0050) + the card
>   on the **"Assigned to me"** rail — a collapsible leftmost column on their
>   personal board (correction #3; was a standalone `/my-work` page, which now
>   redirects to `/boards`); completion (`terminal` lane) + card-scoped RBAC.
>   Host-ext, no new RFC.
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
> - **AI-chat feature set graduated to always-on (ADR 0134, 2026-06-24).** Fourteen
>   chat features dropped their toggles and now serve unconditionally (the ADR
>   0010/0024 graduation recipe): `conversation-search`, `conversation-tools`,
>   `model-router`, `interactive-artifacts`, `prompts`, `chat-export`,
>   `memory-auto-extract`, `scheduled-agent-chats`, `task-deck`, `evals`, `kb`,
>   `channels`, `chat-widget`, `code-exec`. Their per-tenant overrides are retired at
>   boot (`RETIRED_TOGGLE_IDS`). Residual per-*surface* gates remain: `chat-widget`
>   stays default-deny until a widget is provisioned + origin-allowlisted; `code-exec`
>   stays honest-off without a sandbox adapter + HITL-gated; `memory-auto-extract`
>   stays per-user consent-gated; `channels` presence stays env-gated. See
>   `docs/adr/0134-graduate-chat-features-always-on.md`.
> - **Widgets** is the env-gated reference *example*
>   (`OPENWOP_EXAMPLE_WIDGETS_ENABLED`), not a product feature.
> - **Core AI-chat platform enhancements** — a run of recent work hardened the
>   ONE always-on chat (RFC 0005, `frontend/react/src/chat/`) in place rather than
>   adding toggles: run-read authz + a unified SSE channel (ADR 0088), chat-driven
>   agents run their tool loop (ADR 0089), provider-native web search (ADR 0101),
>   chat history persistence / restore / authorship (ADR 0102), agent Profile folded
>   into Instructions as Guardrails (ADR 0101) + per-tool `read/write` permission
>   enforcement (ADR 0102), KB reranking + hybrid (BM25 + dense) retrieval (ADR 0113),
>   image-generation node + chat projection (ADR 0115), conversation branching/forking
>   + multi-model compare (ADR 0117), shared public read-only conversation links
>   (ADR 0122), in-chat model/provider switch + capability-aware selector (ADR 0124),
>   KaTeX math + Mermaid diagram rendering (ADR 0129), and the shared collection-view
>   grid/list canon (ADR 0131). All are always-on core behavior — no toggle.
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
- **`OPENWOP_KB_OCR_ENABLED`** (default off) — ADR 0108. When `true`, uploaded/synced **images** are OCR'd into text via the
  managed multimodal provider (or the tenant's Default AI provider) for RAG. Off ⇒ images `415` like any un-tokenizable type.
  Bills provider tokens, so it's opt-in.
- **`OPENWOP_KB_TRANSCRIBE_ENABLED`** (default off) — ADR 0108/0111. When `true`, **audio** is transcribed into text for RAG
  (long recordings via the Gemini File API). Pre-flighted against the `mediaBudget('stt')` byte budget. Off ⇒ audio `415`.
  Requires a vision/audio-capable provider: either a multimodal managed provider OR a per-tenant **Default AI provider**
  configured on the BYOK `/keys` page (e.g. `gemini-3.1-flash-lite`); otherwise media ingest returns an honest `422`.
- **`OPENWOP_GOALS_ENABLED` / `OPENWOP_PORTABILITY_ENABLED` / `OPENWOP_PROPOSALS_ENABLED`**
  (default off) — RFC 0097 / 0098 / 0096 (ADR 0039). Three always-on host-sample
  **conformance-witness seams** whose routes serve unconditionally but whose advertised
  capability (`agents.goals` · `portability` · reviewable-learning proposals) is gated by
  these env vars for advertise/enforce parity: **Standing goals** (durable per-tenant goals
  CRUD + lifecycle, `/v1/host/openwop-app/goals`), **Portability** (workspace `export` / `import`
  with `?dryRun=` — openwop-app is the RFC 0098 `portability.import` graduation witness), and
  **Reviewable-learning proposals** (`/proposals` create · apply · reject). No dedicated FE
  page — these are backend protocol-witness surfaces, not product UI.

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
| **Access Hub — unified credentials & access console** — one `/access` tabbed console replacing eight scattered `Access & data` nav destinations. Two-axis: **concept** (Credentials: Keys·Connections·Voice·Endpoints / Identity & Access: Organizations·People·Roles·Capability-firewall) × **scope** (a `Workspace · Personal` pill; Personal retires the buried `/profile?tab=connections`). Voice + compat-endpoints promoted out of buried `/keys` cards into first-class tabs. Frontend-only IA: the hub **projects from the existing `FEATURES` nav manifest** (a `hubTab` annotation on `FeatureRoute` + reuse of the `resolveNav` gating — no second registry; `chrome/` is already the legal composition root) + a new shared `ui/Tabs` on `rovingTabs`. The pill is backed by a real `scope: 'workspace'|'personal'` prop added to `KeysPage` + `ConnectionsManager` (mapping to the BYOK `ws:`/`user:` tenant + a connections filter — a logged owner-component edit, not "just mounting"). **No backend, no service, no endpoint, no wire.** Per-project Sources stays in the project tab (pointer only). Old paths redirect → `/access?tab=…&scope=…` (structural nav collapse, since `resolveNav` can't negative-gate). | — (graduated always-on) | **ADR 0144** (implemented; **§Correction 2026-06-26: graduated to always-on, toggle retired** — the four subsumed entries dropped their standalone nav, backend toggle feature deleted; Connections/Users precedent). Frontend information-architecture only — **no new RFC**. |
| **Insights & Drafting** — Financial (variance vs plan from the data lake) + Talent (9-box readiness from Workday) + Communication (in-voice recognition draft from Workday milestones, never auto-send) agents + 3 built-in meta-workflows wired to REAL nodes (BigQuery, Workday, `core.ai.chatCompletion`, email-draft, notification-push). Driven through the existing chat / builder / scheduler / triggers; results surface as run outputs + notifications — **no dashboard, no parallel store** (ADR 0082 rebuilt it on the workflow engine, deleting the bespoke page + read model + demo seed). | `insights-suite` | OFF; bucket `tenant`; packs `feature.insights-suite.{nodes,agents}`. Prereqs ADR 0076/0077. **ADR 0082** (supersedes 0078/0081 dashboard parts). |
| **Enterprise data connectors** — BigQuery read-only connection pack (`bigquery.query`) + `email.draft`-to-mailbox node (MS Graph / Gmail drafts, never sends). Reusable platform packs. | — (packs, no toggle) | Extend Connections (ADR 0024/0037) + `core.openwop.integration`. ADR 0076 (Proposed). |
| **Data classification, PII log masking & retention sweep** — Public/Internal/Confidential-PII taxonomy + PII-field log masking + the retention sweep daemon (calls existing `subjectErasure` purge handlers). Horizontal governance. | — (core gov, env-gated daemon) | Extends Governance (ADR 0028) + `subjectErasure`. ADR 0077 (Proposed). |
| **Media-generation cost governance** — a per-org **budget** for the paid media path (STT transcription + multi-speaker TTS, ADR 0085/0086) + a **pre-flight cost estimate**. Bounds aggregate per-org media spend above the existing per-call caps (`MAX_SPEECH_CHARS` / 32 MiB decode), reusing the managed daily-cap accounting + `costEmitter`. Fails closed (`media_budget_exceeded`); managed tier always-capped, BYOK opt-in. Horizontal cost governance. | — (core cost-gov, env-gated) | Extends Governance (ADR 0077) + `aiProviders` speech path + managed-cap pattern. ADR 0106 (Proposed). |
| **Research Notebooks** — a NotebookLM-style research workspace (Sources \| Notes \| Chat) ported from `lfnovo/open-notebook` (product design only). **A notebook IS a `kind:'project'` Subject** (`facet:'notebook'`); sources = one org-scoped KB collection (ADR 0011), notes = `project:<id>` subject memory (ADR 0041), chat = the one chat primitive scoped to a **Research Analyst** agent (ADR 0043/0073 — no second panel), transformations = Documents/Templates runs (ADR 0053). Per-source **Full/Summary/Excluded** context level is a host-side retrieval filter (not a wire field). "Ask" + transformations are **workflow runs** (`ctx`-only, ADR 0011), never sync routes. | `notebooks` | OFF; bucket `tenant`; packs `feature.notebooks.{nodes,agents}`; `/v1/host/openwop-app/notebooks/*` + read-only `ctx.notebooks`. **ADR 0084** (implemented; **surfaced as a project "Sources" tab — correction 2026-06-22**, not a standalone page: any project gains sources via `POST …/notebooks/:id/ensure`; the `facet:'notebook'` guard is dropped). Host-ext, **no new RFC**. |
| **Audio/video source ingestion** — drop an audio/video file or YouTube URL as a notebook source; a `transcribe-source` node feeds bytes to a multimodal model via `ctx.callAI` audio part → transcript → KB document. Adds audio/video MIME types to the Media allowlist; the one code gap is `INPUT_MODALITIES` omitting `"audio"`. | — (extends `notebooks`) | No new toggle; plumbing always-on, upload surface gated by `notebooks`. **ADR 0085** (implemented — `INPUT_MODALITIES` now includes `audio` + `discovery` derives from it; transcribe/fetch-youtube/ingest nodes + the `notebooks.ingest-{audio,youtube}` workflows + `POST …/sources/{audio,youtube}` routes + the FE upload/paste affordance). **Rides Accepted RFC 0091** — no new RFC. |
| **Multi-speaker podcasts** — generate 1–4-speaker audio episodes (vs NotebookLM's fixed 2) from a notebook. EpisodeProfile + SpeakerProfile config + PodcastEpisode run record; pipeline = an executor run (outline → transcript → per-speaker TTS → mix → ordered clips); schedulable. | `podcasts` | OFF; bucket `tenant`; packs `feature.podcasts.{nodes,agents}`; `/v1/host/openwop-app/podcasts/*` + `ctx.features.podcasts`. **ADR 0086** (implemented — RFC 0105 Accepted + `ctx.callSpeechSynthesizer` wired for **MiniMax/OpenAI/Google** TTS, Anthropic has no TTS API; mix produces a single file for homogeneous codecs + the clip-playlist fallback). **Surfaced as a project "Podcast" tab — correction 2026-06-22**, not a standalone Studio (scoped to the project as content source). **Rides Accepted RFC 0105 + 0091** — no new RFC. |
| **Real-time voice session** — live full-duplex voice on the existing chat: streaming STT (`ctx.callTranscriber` → `Promise` resolving at `turn_commit`; interim / `speech_start` / `endpoint_candidate` / `turn_commit` as `voice.*` run-events on the durable log), the streaming TTS arm (`callSpeechSynthesizer({stream:true})` → `voice.synthesis_chunk` metadata-only), barge-in, and a `streamRef` live-audio handle. Rides the ONE chat (RFC 0005 / `EmbeddedChatPanel`) — **no new panel**; the streaming counterpart of ADR 0085 (audio-in) + ADR 0086 (TTS). | — (always-on host plumbing — **no toggle**, like ADR 0085) | advertises the full `aiProviders.realtimeVoice` (transcription/synthesis `streaming` + `turnDetection:semantic` + `bargeIn:supported`), derived from what's wired. **ADR 0109** (**implemented** — the G7 reference-host arm for RFC 0118, `Active`): `ctx.callTranscriber` (stub + real finite-audio transcription via managed `callAI` audio; live `streamRef` → honest `transcription_unsupported`, host-internal per §E), `callSpeechSynthesizer({stream:true})` → `voice.synthesis_chunk` metadata-only, and the `voice.barge_in → voice.cancelled` lifecycle (§F, no partial leak). **No node/agent packs** (ctx-method plumbing); **no new mic** — the chat's `ChatInput` MediaRecorder mic (RFC 0091 implicit transcription) is the voice UX. #683/#689/#691/#693/#694. Remaining = the steward Accept close-out. |
| **Live voice mode** — **full-duplex spoken** conversation on the existing chat: a live mic stream transcribes in real time (streaming STT), the committed `turn_commit` enters the RFC 0005 conversation as an ordinary turn, and the agent **speaks back** via the streaming-TTS arm with **barge-in** — surfaced as a voice mode on `EmbeddedChatPanel`/`ChatInput` (no new panel/mic) scoped to a voice agent persona. **Productizes the ADR 0109 plumbing** by wiring a **real streaming-STT path** for a live `streamRef` (today an honest `transcription_unsupported`, `aiProvidersHost.ts:344`); provider + transport are open questions (provider-agnostic `StreamingTranscriber`; transport host-internal per RFC 0118 §E). | `voice` | OFF; bucket `tenant`; pack `feature.voice.agents`. `src/features/voice/` + `/v1/host/openwop-app/voice/session/*` (host-ext session bootstrap). **ADR 0138 (implemented)**. Composes ADR 0109 (realtimeVoice seams) + 0085/0086 (audio-in/TTS) + 0073 (EmbeddedChatPanel) + 0024 (BYOK) + 0106 (cost-gov). Four §F continuous-ingress invariants (interim-not-durable / transcript-untrusted / bargein-no-partial-leak / streamref-tenant-bound). **Rides Accepted RFC 0118 (Active) — no new RFC** (live transport host-internal §E). |
| **Knowledge sync — drive → KB folder sync** — bind a connected cloud-drive folder to a KB collection on a cadence (15m / hourly / daily); a diff-sync run ingests new/changed files + prunes deleted (stable `sync:<source>:<file>` doc ids), driven by a cadence daemon + manual **Sync now** + pause/resume. Five providers: **Google Drive / OneDrive / SharePoint / Dropbox / Box** (OAuth via Connections, ADR 0024). Extracts every common document type (text / PDF / Word / PowerPoint / Excel / OpenDocument / RTF) through the single `kbService.extractTextFromBytes` owner; images & audio ride the **Media → text** capability below. A drill-in **folder picker** (browse subfolders) for Google/OneDrive/Dropbox/Box (SharePoint keeps raw-id entry); a per-source **include-media** toggle (`PATCH …/knowledge-sync/:id`). Synced content fenced **untrusted** (ADR 0027). | `knowledge-sync` | OFF; bucket `tenant`. `/v1/host/openwop-app/knowledge-sync/*` — REST + a cadence daemon (no node/agent pack). **ADR 0107** (implemented). SSRF-guarded credential-injecting egress (`brokeredFetch` + an un-credentialed `fetchGuardedBytes` for cross-host download URLs). Composes Connections (ADR 0024) + KB/RAG (ADR 0011). Host-extension — **no new RFC**. |
| **Media → text for RAG (OCR + transcription)** — image OCR + audio transcription ingested into ANY KB collection, via manual upload AND the 5-drive knowledge-sync (ADR 0107: Google Drive / OneDrive / SharePoint / Dropbox / Box). Routed through the host MANAGED multimodal provider; when managed isn't multimodal (the reference target is MiniMax, text-only), a per-tenant **Default AI provider** binding (BYOK, set on the `/keys` page) is used — `resolveHeadlessAi` is the single owner of "which provider does a headless op use", also adopted by `cms/translate`. Long-form audio (>~15 MiB) uploads via the **Gemini File API** (vs inline) with a generous deadline + the model's full output window, and the uploaded file is cleaned up post-transcription. LLM-vision only (tesseract removed). Content fenced **untrusted** (binary extraction is never human-reviewed). | — (env-gated — `OPENWOP_KB_OCR_ENABLED` / `OPENWOP_KB_TRANSCRIBE_ENABLED`, both **default OFF**; see *Env-gated operational flags*) | **ADR 0108** (image OCR + audio transcription, implemented), **ADR 0110** (headless AI provider default + BYOK fallback + the `/byok/ai-default` settings UI, implemented), **ADR 0111** (long-form audio via the File API, implemented). Replay-safe (non-recorded service path); SR-1 (provider key host-side only). **Rides Accepted RFC 0091** (multimodal `callAI`) — no new RFC. |
| **Notebooks as MCP tools** — expose notebook ops (list/get/search/ask + gated writes) to external AI clients (Claude Desktop, Cursor) as MCP tools. The inbound MCP server already exists (`routes/mcp.ts`, env-gated); net-new = the notebook expose-tool workflows + the RFC 0078 `/v1/tools` HTTP projection + Connections-based external-client auth. | — (rides `notebooks` + env `OPENWOP_MCP_SERVER_ENABLED`) | Each `tools/call` = a tenant-scoped run; inbound args untrusted; BYOK preserved via `sampling/createMessage`. **ADR 0087** (implemented — 6 READ tools + 2 HITL-gated WRITE tools (`notebook-add-source`/`-create-note`, OQ-1 resolved: `expose → core.hitl.approval-request → decision-gated write`) as `notebooks.mcp.*` workflows + `GET /v1/tools` RFC 0078 projection + `capabilities.toolCatalog`; gated on auth + the `notebooks` toggle, cross-tenant-invisible). **Rides Accepted RFC 0020 + 0078** — no new RFC. |
| **Planning knowledge base** — auto-index Strategy (ADR 0079/0080) and Priority Matrix (ADR 0058) into per-feature, per-org KB collections ("Strategy KB", "Priority Matrix KB"), kept **fresh on every CRUD** (sync best-effort `delete + re-ingest` by stable entity id; archive/delete ⇒ remove), so agents and Boards of Advisors can **retrieve** planning content. Composes `kbService` via per-feature `…KnowledgeService.ts` modules (the `projectKnowledgeService`/`profileKnowledgeService` precedent — no new vector store). Agents reference it through the existing per-agent binding (ADR 0038); boards via binding to advisor agents + a board "Shared knowledge" affordance. **CRITICAL RBAC:** user-private strategies are NOT indexed into the org collection. Backfill + content-hash guard + fail-open; non-run side-effect ⇒ replay-trivial. FE: synced badge + suppressed hand-edit on managed collections, "Indexed for agents"/"Private" cues, board section (all `ui/` primitives). | — (extends `strategy` + `priority-matrix`; no new toggle) | Always-on when `kb` + the feature toggle are enabled. **ADR 0100** (Proposed). Host-internal, **no new RFC** (rides ADR 0011 KB/RAG + RFC 0018 vector). |
| **Conversation full-text search** — FTS across the user's conversations + messages (today only KB-semantic + a title filter). Postgres `tsvector` over the message store first; read-only, owner/participant-scoped. | `conversation-search` | OFF; bucket `user`; `/v1/host/openwop-app/chat/search`. **ADR 0112** (Proposed, candidate B1). Host-ext, **no new RFC**. |
| **KB reranking + hybrid retrieval** — a BM25 lexical channel + dense cosine (RRF) + an optional reranker behind `resolveSubjectKnowledgeRetrieve`; default reranker deterministic, external-reranker result recorded in-run (replay invariant). | — (extends `kb`, no new toggle) | **ADR 0113** (Proposed, candidate B3 — **Critical**). Rides ADR 0011 + RFC 0018. Host-ext, **no new RFC**. |
| **Sandboxed code-execution node** — run model code in an isolated sandbox, HITL-gated, output → artifact workbench + streamed; recorded output read on `:fork`. | `code-exec` | OFF; bucket `tenant`; pack `feature.code-exec.nodes`. **ADR 0114** (Proposed, B4). RFC **evaluate** (a normative execution-artifact type/capability would need an RFC). |
| **Image generation in chat** — implement the advertised-but-unimplemented `callImageGenerator`; providers via Connections, output a Media token projected into chat, cost-governed by ADR 0106 (reuse, don't fork). | — (pack, no toggle) | pack `feature.image-gen.nodes`. **ADR 0115** (Proposed, B5). RFC **evaluate** (flipping `imageGeneration:supported:true` cross-host needs an Accepted RFC). |
| **Conversation branching + multi-model compare** — fork from any message (the `:fork` run op) + side-by-side compare (two `ConversationView`s). Core-chat. | — (core-chat, no toggle) | **ADR 0117** (Proposed, B7). Replay/fork-safety = `/architect`. Host-ext, **no new RFC**. |
| **LLM observability — OTel + per-turn tracing** — instrument run/dispatch (existing OTel infra), optional Langfuse, admin usage dashboard (folds audit + analytics); spans redact BYOK/PII. | `observability` | OFF; bucket `tenant`; OTel export env-gated. **ADR 0118** (Proposed, B8). Rides RFC 0026/0084. Host-ext, **no new RFC**. |
| **Local / OpenAI-compatible model provider** — Ollama/LM Studio/vLLM/compat endpoint via dispatch + BYOK, capability-probed. | — (provider config) | **ADR 0121** (Proposed, B12) — **BLOCKED on a NEW openwop RFC** (advertising the `compat`/local provider class in `aiProviders.supported[]` is a wire-honesty claim; `/prd` next). |
| **Shared public conversation links** — snapshot a conversation to a revocable read-only public link via the Sharing registry + content-trust taint; uniform 404, rate-limited, owner-only. | `chat-share` | OFF; bucket `tenant`; public surface. **ADR 0122** (Proposed, B13). Host-ext, **no new RFC**. |
| **Eval / feedback leaderboard** — turn captured `MessageFeedback` (the ADR 0071 Phase-5 consumer) + health-indexing into an admin model leaderboard (Elo/win-rate) + an optional A/B arena; admin-only. | `evals` | OFF; bucket `tenant`. **ADR 0123** (Proposed, B14). Rides RFC 0081. Host-ext, **no new RFC**. |
| **In-chat model/provider switch** — capability-gated switch from the composer; model already rides `run.inputs` (replay-safe). | — (core-chat) | **ADR 0124** (Proposed, B15). Rides RFC 0031. Host-ext, **no new RFC**. |
| **Recurring / scheduled agent chats** — RRULE/cron agent chat turns → conversation + run history; reuses the scheduler daemon (not a new job queue). | `scheduled-chats` | OFF; bucket `tenant`. **ADR 0125** (Proposed, B16). Composes ADR 0025/0089/0103. Host-ext, **no new RFC**. |
| **Team channels / real-time messaging** — topic channels w/ membership + read-state on the conversation primitive + SSE delivery; per-channel RBAC. Deferred in ADR 0043. | `channels` | OFF; bucket `tenant`. **ADR 0126** (Proposed, B18). RFC **evaluate** (local-host = none; presence/typing/receipts or cross-host = new RFC, RFC 0101 Parked precedent). |
| **Public embeddable chat widget** — a public, domain-allowlisted, rate-limited widget embedding the existing `ConversationView` behind a public gateway, scoped to a designated agent; does NOT reimplement chat. | `chat-widget` | OFF; bucket `tenant`; public route. **ADR 0127** (Proposed, B19). Host-ext, **no new RFC**. |
| **Interactive artifacts canvas** — register interactive artifact types (html/react/mermaid/chart) via the artifact-type registry + workbench, rendered in a strict CSP-sandboxed iframe; reuses the A2UI catalog discipline; folds chart artifacts. | — (extends the artifact workbench) | **ADR 0128** (Proposed). RFC **evaluate** (host-native type = none; normative cross-host type = new RFC). Security `/architect`+`/browser`. |
| **Chat math + diagram rendering** — KaTeX + sandboxed Mermaid in the chat markdown renderer (today `react-markdown`+`remark-gfm` only); client-side, sanitized. | — (core-chat FE) | **ADR 0129** (Proposed). Pure-FE, no wire. |
| **Rule-based per-turn model router** — route each turn among advertised providers by rules + optional LLM-classification w/ cooldown + fallback; routing decision stamped in `run.metadata` (replay invariant). | `model-router` | OFF; bucket `tenant`. **ADR 0130** (Proposed). Engine implemented (Phases 1–3c); **FE config UI (Phase 5) remaining**. Composes ADR 0110. Host-ext, **no new RFC**. |
| **Per-conversation capability scope + per-tool-call approval** — a per-conversation **narrowing** filter over the agent's permitted tools (ANDed into ADR 0102, never widens) + a per-tool **require-approval** flag that suspends the live loop with the existing HITL interrupt card (ADR 0089); the capabilities chipset reads the RFC 0078 tool catalog (write/exec default to approval-required). Effective scope stamped in `run.metadata`, read verbatim on `:fork`. Makes the chat an operator console without forking the authorization path. | `conversation-tools` | OFF; bucket `tenant`; `/v1/host/openwop-app/chat/sessions/:id/capability-scope`. **ADR 0132** (Proposed). Composes ADR 0102/0089/0075 + RFC 0064/0078 (Accepted). Host-ext, **no new RFC**. |
| **Run/task deck** — a **read-only projection** over runs + sub-runs (`subRunDispatcher`) bucketed `pending·running·blocked·delegated·completed·failed`; each card deep-links to the inspector / spawning turn / resume affordance; the **blocked** bucket reads the unified review (ADR 0068). One additive `run.metadata.parentRunId`/`delegatedBy` stamp groups children under parents — **no tasks table** ([[no-parallel-architecture]]). | `task-deck` | OFF; bucket `tenant`; `/v1/host/openwop-app/tasks`. **ADR 0133** (Proposed). Composes ADR 0068/0075/0083/0050. Host-ext, **no new RFC**. |
| **Capability Firewall** — composition-aware tool/data/action risk: a tenant rule set over RFC 0078 tool **classes** (safetyTier/egress) evaluated INSIDE `runChatToolLoop` against the *combination* of capabilities a run has exercised (e.g. read-drive **+** send-email ⇒ deny / require-approval). ANDs after the ADR 0132/0102 per-tool gates (narrows only); verdict rides the existing forbidden/approval seam; rule set stamped in `run.metadata`, capability-set rebuilt from recorded `agent.toolCalled` (replay-safe). The strongest novel bet — nothing else does combination risk. | `capability-firewall` | **always-on** (toggle retired 2026-06-24; ships **rule-less** — no friction until rules added); `/v1/host/openwop-app/capability-firewall/*`. **ADR 0135** (implemented). Composes ADR 0132/0102/0036/0075 + RFC 0078/0064. Host-ext, **no new RFC**. |
| **Intent Ledger** — a reviewable pre-flight **mission contract** (goal / allowed / forbidden / required approvals / success-criteria / expiry) drafted by an LLM extractor **only for complex/high-risk requests** (over-friction guard); **projects onto the ADR 0132 capability scope** so enforcement is reused (not a second gate), adds success-criteria + a relative-TTL expiry (`out_of_mandate`) + an authorized-vs-completed run summary. Resolved ledger stamped in `run.metadata`, read verbatim on `:fork`. | `intent-ledger` | **always-on** (toggle retired 2026-06-24; no-op until a user drafts a mission); `/v1/host/openwop-app/intent-ledger/*`. **ADR 0136** (implemented). Composes ADR 0132/0036/0075/0130/0135. Host-ext, **no new RFC**. |
| **Ambient Work Graph** — opt-in mining of completed runs into deterministic **run signatures** → clustering → recurrence → a `WorkflowSuggestion` ("done this N times — make it a workflow?"); accepting hands the candidate to the ADR 0072 workflow-author draft (closed-world + RFC 0022 §C gate). A read-only projection over the run store (no new run model; sweep on the existing scheduler daemon, no new queue). Privacy: opt-in + evidence drawer + dismiss/suppress; tenant-scoped (no cross-tenant mining). | `ambient-work-graph` | **always-on** (toggle retired 2026-06-24; background sweep still env-gated `OPENWOP_WORKGRAPH_SWEEP_ENABLED`); `/v1/host/openwop-app/work-graph/*`. **ADR 0137** (implemented). Composes ADR 0072/0133/0068/0050. Host-ext, **no new RFC**. |
| **Configurable Navigation Menu** — a **sparse overlay** over the declared `FEATURES` nav: move items between the main + admin menus, regroup them under headers, create/rename/remove custom headers, and show/hide feature-gated items. Two layers stack — a superadmin-edited **tenant default** ← each user's **personalization**. The feature-toggle system stays the hard gate (a disabled feature never appears; a newly-enabled one shows at its declared location until overridden). **Always-on items** (Chat/Agents/Inbox/Workflows — no `featureId`) are movable but never hideable. Nav sections are **collapsible**, remembered per-browser in a cookie. The admin **Menu settings** editor (`/menu-settings`) drives it; the resolver subsumes (not shadows) `navGroups`. | `navigation-settings` | **always-on** (no toggle — empty config == today's menu); `/v1/host/openwop-app/menu-config`. **ADR 0139** (implemented). Composes the feature-toggle access gate + `@dnd-kit` not required (control-based). Host-ext, **no new RFC**. |
| **Campaign Studio — Brand & Guardrails** — the marketing layer's foundation: a `Brand` entity (voice profile · formality 1–5 · tone registers · positioning · approved/banned phrases · per-channel voice rules) + a **compliance scorer** (deterministic banned-phrase/formality 60 % + LLM 40 %, 0–100) + a brand-voice resolver that injects rules into generation prompts. Governance maps to `accessControl` (RFC 0049); never forks the AI-envelope surface. First of the **Campaign Studio cluster** ([`docs/campaign-studio-prd.md`](docs/campaign-studio-prd.md)). | `brand` | OFF; bucket `tenant`; category `Marketing`; packs `feature.brand.{nodes,agents}` (`brand.compliance.check`, `brand.voice.resolve` + Brand Steward). **ADR 0155** (implemented — voice facet). **ADR 0170** (implemented + deployed 2026-06-29) extends this same feature to also own the **white-label app identity**: a reserved `brand:host-app` brand (in the `host-site` org) drives the app's logo/colors/fonts/favicon/title/theme at **runtime**, super-admin-edited via an Admin **Appearance** panel — and **graduates `brand` to always-on/core** (toggle removed; `workspace:*` RBAC on tenant brands stays). **ADR 0171** (Proposed) makes the Appearance editor a **generative theming system** — seed inputs → full light/dark OKLCH token set (contrast-guarded) + JSON import/export, replacing the 3-preset model. Composes ADR 0006/0011/0027/0007/0015/0052. Host-ext, **no new RFC**. |
| **Campaign Studio — Personas & Campaign Brief** — a marketing **`Persona`** (buyer stage · objections · pain points — a content-targeting abstraction, **distinct from a CRM contact**) + the **campaign brief** model/wizard + the **brief context assembler** (composes `kb` retrieval + brand + persona → one grounded prompt with `[src_N]` citations) + the **messaging kernel** generator + the asset-decision/setup gates. | `campaign-brief` | OFF; bucket `tenant`; category `Marketing`; packs `feature.campaign-brief.nodes` (`brief.validate`, `brief.kernel.generate`, gates). **ADR 0156** (Planned). Composes ADR 0155/0011/0008/0007. Host-ext, **no new RFC**. |
| **Campaign Studio — Channel Generation** — 5 grounded **channel generators** (landing → page-builder · ads · email → emits drafts INTO `email` (ADR 0019), no parallel send · creative briefs + AI mood-board over `media` · social), each `generate → quality-check → brand-compliance → approval` with **per-item refine**; the 5 channel **child workflow chain packs**, independently runnable AND dispatchable. | `campaign-channels` | OFF; bucket `tenant`; category `Marketing`; packs `feature.campaign-channels.{nodes,workflows}`. **ADR 0157** (Planned). Composes ADR 0156/0007/0009/0019/0012. Host-ext, **no new RFC**. |
| **Campaign Studio — Composable Orchestration** — the **parent workflow chain pack**: asset gates → kernel+approval → **parallel 5-channel fan-out** → merge → production-plan → consistency-check (≥80) → finalize → `MarketingCampaign`. The **Campaign Strategist** agent drives it through the ONE chat (ADR 0058/0073 — no new panel). Ships **sequential-fallback now; flips to parallel via one config line** once the host advertises `fanOutSupported`. | `campaign-studio` | OFF; bucket `tenant`; category `Marketing`; packs `feature.campaign-orchestration.{nodes,agents,workflows}` + artifact-type pack. **ADR 0158** (Planned) — **RFC-gated (P1.5)**: rides RFC 0013; the parallel upgrade needs **RFC 0118** (Draft) Accepted + wired. |
| **Campaign Studio — Live Connectors & Performance** — Google/Meta/LinkedIn Ads **RFC 0095 connection packs** + a daily-sync node (15-min cooldown, dedup, unified ad metrics) + CSV import (9 platform templates) + a performance store + KPI projection. Composes Connections (0024/0033/0037) + Analytics (0018); day-1 honesty matrix. | `campaign-connectors` | OFF; bucket `tenant`; category `Marketing`; packs `vendor.*.connections.{google,meta,linkedin}-ads` + `feature.campaign-connectors.nodes` (`ads.sync`, `ads.import.csv`). **ADR 0159** (Planned). **Rides Accepted RFC 0095 — no new RFC.** |
| **Campaign Studio — Campaign Intelligence** — KPI dashboard projection + a **budget recommendation engine** (heuristic ROAS-marginal + AI scenarios) + **forecasting** (creative fatigue/scaling/outcome) + **NL queries** via the Strategist agent (`budget.optimize`/`performance.forecast` tools, not a bespoke chatbox) + alert/digest rules over **Notifications**. | `campaign-intel` | OFF; bucket `tenant`; category `Marketing`; packs `feature.campaign-intel.nodes`. **ADR 0160** (Planned). Composes ADR 0158/0159/0018/0010. Host-ext, **no new RFC**. |

> **Strategic Planning** (ADR 0079) graduated to **Current features** above
> (Phases 1–6 shipped 2026-06-19). Node/agent packs + chat-drivability deferred
> (ADR 0058 pattern); cross-host strategy federation is the future wire-RFC case.

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
