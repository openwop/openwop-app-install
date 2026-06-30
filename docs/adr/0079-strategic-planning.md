# ADR 0079 — Strategic Planning (executive strategy portfolio + cross-feature connective tissue)

**Status:** implemented (Phases 1–6 — see § Implementation ledger)
**Date:** 2026-06-19
**Toggle:** `strategy` — a toggle-gated **feature-package** under
`backend/typescript/src/features/strategy/` (net-new product surface, ADR 0001).
Default **OFF**, `bucketUnit: 'tenant'` (a shared B2B planning surface, ADR 0015),
`salt: 'strategy'`, category `Business Tools`.
**Product name / nav:** "Strategy" (nav label) · "Strategic Planning" (page title).
**Capability:** no new `AgentCapabilityId`; no wire capability. Advertises a read-only
`ctx.features.strategy` surface at `/.well-known/openwop` (auto, via the feature's
`surface` declaration — ADR 0014).
**Depends on / composes:**
ADR 0001 (feature-package), ADR 0006 (RBAC — `workspace:read|write` + a config-authority
predicate), ADR 0015 (workspace = tenant — scoping), ADR 0014 (`ctx.<feature>` surface),
ADR 0046 (`project` Subject — link target + status/health projection), ADR 0058/0059/0060
(Priority Matrix — link target + ranked-idea chip projection), ADR 0040 (Board of
Advisors — strategy context refs into the advisor prompt scaffold), ADR 0053 (Documents —
future board-memo generation, deferred).
**Surface:** host-internal, under `/v1/host/openwop-app/strategy/*` (route prefix audited
clean). **No public/unauthenticated surface.**
**RFC gate:** **NO new RFC.** Host-extension only — no wire field, event type, capability
flag, or normative MUST. Links existing host entities and advertises only a host-extension
`ctx.features.strategy` surface. A future cross-*host* strategy-federation phase (Later
Enhancements) would be the genuine wire-RFC case; it is explicitly out of scope here.

---

## Why this exists

The plan (`Strategy Feature Plan`, 2026-06-19):

> Add a Strategy feature that lets executive leadership define, manage, and communicate
> company strategy through structured strategic goals, OKRs, initiatives, planning themes,
> and board-ready decision context. The feature should become connective tissue across
> executive strategic planning, Priority Matrix prioritization, project execution, and
> Board of Advisors decision-making. Strategies must support variable planning horizons
> (quarter / half-year / annual / multi-year / custom) and be scopeable to a user,
> workspace, or organization.

The research lesson the data model honors: executive strategy is **broader than OKRs** —
it carries narrative rationale, portfolio/capital-allocation awareness, and risk/confidence,
and boards increasingly evaluate *execution*, not just strategy approval. So Strategy is
an **executive strategy portfolio with OKR-compatible structure plus linked execution and
governance context**, not a pure OKR tool and not a pure roadmap.

## Goal

Create / manage / communicate company strategy → structured objectives, key results,
initiatives, horizons, owners, status/confidence/risk, and narrative rationale → linked to
projects, Priority Matrix ideas/lists, and advisory boards → projected as a compact,
RBAC-bounded **strategy context packet** for board/advisor and project/priority surfaces.

---

## Boundaries audit (what already exists — reuse, do not fork)

`Explore` sweep over `backend/typescript/src` (2026-06-19):

- **Route namespace is clean.** No registrant under `/v1/host/openwop-app/strategy/*`
  (`grep` for `strategy` in `features/index.ts`, `registry.ts`, route files → only an
  unrelated comment at `routes/discovery.ts:710`). Prefix is free.
- **`goals` is NOT the model and must not be reused.** `features/goals/types.ts:12-66` —
  the existing `goals` surface models RFC-0097 **standing objectives with judge-owned
  completion verdicts** (terminal `satisfied`/`escalated`/`bound-exceeded` are read-only
  to the client), execution bounds (loop/runtime/cost caps), and a continuation mode. That
  is *repeatable autonomous work with external verification* — declarative executive
  strategy is the opposite (user-authored, never judge-verified, no execution bounds, no
  loop). Strategy may **link** to a runtime goal later, but it must not mutate goal
  semantics or become a second runtime-goal system. (See § "Goals naming collision".)
- **Priority Matrix already owns ideas + ranking.** `priority-matrix/priorityMatrixService.ts:333`
  — `RankedIdea { card, status, scores, computedPriority, rank, voterCount?, myScores? }`,
  built in `listRankedIdeas()` (`:343`); `surface.ts:30` maps it for workflow callers. The
  strategic-alignment chip is a **projection into this existing shape**, not a new ranking
  store. An idea is a `host.kanban` card (ADR 0049/0058) — strategy links key on
  `(listId, cardId)`.
- **Projects already own execution containers.** `projects/projectsService.ts:52` —
  `Project { id, tenantId, orgId, name, workflows[], charter?, members?, visibility?, … }`;
  the REST projection is the `view()` closure at `projects/routes.ts:96` gated by
  `requireProject(req, scope)` → `resolveProjectAccess()` (`projectsService.ts:209`).
  Projects are **always-on Subjects** (ADR 0046/0054). Strategy links point at `projectId`;
  Strategy must **not** overload `Project.charter` with strategy fields.
- **Board of Advisors already owns the convene + prompt scaffold.**
  `advisory-board/types.ts:30` — `AdvisoryBoard { boardId, tenantId, orgId, advisors[],
  visibility, personaKind, … }`; `service.ts:82` `projectBoard()` is the REST projection;
  the advisor prompt is assembled in `host/agentPromptScaffold.ts:40` `composeAgentSystemPrompt()`.
  The strategy context packet is injected through a **new optional scaffold field**, not a
  parallel advisor pipeline.
- **Established wiring to reuse verbatim:** `BackendFeature` + `BACKEND_FEATURES`
  (`features/index.ts`), `toggleDefault` (priority-matrix `feature.ts` shape),
  `requireFeatureEnabled` / `authorizeOrgScope` / `tenantOf` (`features/featureRoute.ts`),
  the `surface: { id, build }` seam (`host/featureSurfaces.ts`), `DurableCollection`
  (the storage primitive used by `priorityMatrixService`/`advisory-board/service`),
  `FrontendFeature` + `FRONTEND_FEATURES` (`frontend/react/src/features/registry.ts`),
  the `FeatureNav` menu-registry entry (`chrome/featureTypes.ts`), the `src/i18n/`
  per-feature catalog convention (ADR 0065).

## Decision

A single feature-package `strategy` that **owns only what is new** — the strategy entity
(narrative + OKR structure + initiatives + horizon + governance fields + links) — and
**projects into** the three existing surfaces it connects (Priority Matrix, Projects, Board
of Advisors) without forking their stores. Links are **canonical on the Strategy**; every
consuming surface reads them back through an RBAC-filtered projection helper. Strategy
never writes into project/priority/board data.

### Data model

```
Strategy                              // the executive planning record (DurableCollection, keyed by id, tenant-scoped)
  id, tenantId                        // tenantId = workspace, ALWAYS present (ADR 0015)
  orgId?: string                      // present ⇔ scope.kind === 'org'
  scope: StrategyScope                // 'user' | 'workspace' | 'org' (see correction note)
  title: string
  summary?, rationale?: string        // narrative — the "why" the research calls for
  planningHorizon: 'quarter' | 'half-year' | 'annual' | 'multi-year' | 'custom'
  period: { label: string; startDate?: string; endDate?: string }
  ownerUserId?, accountableExecutive?: string
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
  confidence?: 'high' | 'medium' | 'low'
  risk?: 'low' | 'medium' | 'high'
  objectives: StrategyObjective[]     // { id, title, keyResults: StrategyKeyResult[] }
  initiatives: StrategyInitiative[]   // { id, title, ownerUserId?, status?, linkedProjectIds? }
  links: StrategyLink[]               // canonical alignment edges (see below)
  createdBy, createdAt, updatedAt

StrategyKeyResult  { id, title, target?, current?, unit?, status? }

StrategyLink =                        // edges point OUT at existing entities; never duplicate their data
  | { kind: 'project';       projectId }
  | { kind: 'priority-list'; listId }
  | { kind: 'priority-idea'; listId, cardId }
  | { kind: 'advisory-board'; boardId }
  | { kind: 'document';      documentId }   // composes ADR 0053 when `documents` enabled

StrategyContextPacket                 // PROJECTION assembled at read/convene time — never stored
  strategies: Array<{ id, title, scope, horizon, period, status, confidence?, risk?,
                      owner?, summary?, rationale?,
                      objectives[], initiatives[],
                      linkedProjects: { id, name, status?, health? }[],     // resolved live, RBAC-filtered
                      linkedPriorities: { listId, cardId?, title, computedPriority?, rank? }[] }>
```

#### Correction note — `StrategyScope` (PRD vs this app's tenancy)

The PRD modeled scope as a union that embeds the identity in each variant:
`{kind:'user'; userId}` / `{kind:'workspace'; tenantId}` / `{kind:'org'; orgId}`. Under
ADR 0015 (workspace = tenant) **every** record already carries `tenantId`, and `createdBy`
is always the author, so the embedded `userId`/`tenantId` are redundant and invite drift.
This ADR narrows the variant to carry only what the scope adds:

```
type StrategyScope =
  | { kind: 'user' }                  // private to createdBy within the tenant
  | { kind: 'workspace' }             // visible to the whole workspace/tenant
  | { kind: 'org'; orgId: string }    // visible to one org within the tenant
```

`user` ⇒ owner-private (creator only). `workspace` ⇒ all tenant members with
`workspace:read`. `org` ⇒ `orgId` carried + gated on org membership. This keeps `tenantId`
the single source of workspace identity and aligns org-scope auth with `accessControl`
(the org/member/role owner) exactly as Priority Matrix and Projects do.

##### §Correction (2026-06-19, /architect pre-Phase-1) — `orgId` is mandatory; `scope` is a visibility modifier

The pre-implementation `/architect` pass found the "`orgId` present iff `scope==='org'`"
shape above **fights the app's grain**: `resolveEffectiveAccess(tenant, {subject, orgId})`
resolves authority **per (subject, org)** — there is no tenant-wide membership primitive —
and *every* existing shared business entity carries a **mandatory `orgId`** that all RBAC
keys on (`PriorityList` and `Project` both `requireString(body.orgId, 'orgId')` on create;
`priority-matrix/routes.ts:184`, `projects/routes.ts:143`). A scope variant with no org
cannot be RBAC'd or IDOR-guarded consistently. So the implemented shape is:

```
interface Strategy { …; orgId: string; scope: StrategyScope; … }   // orgId ALWAYS present (owning org)
type StrategyScope = 'user' | 'workspace' | 'org';                  // a visibility MODIFIER, not an owner
```

- `org` (default) — standard org RBAC: `workspace:read` / `workspace:write` in `orgId`.
- `user` — owner-private: only `createdBy` reads/writes; org membership does **not** grant
  access (still tenant/org-keyed for IDOR).
- `workspace` — broader **read** (any caller with `workspace:read` in *any* org of the
  tenant); **write** still requires `workspace:write` in the owning `orgId` (visibility ≠
  write-authority — the ADR 0045/0054 invariant). This reuses `hasOrgScope` /
  `requireListConfigAuthority` verbatim and keeps `orgId` the IDOR anchor.

#### Why links are canonical on the Strategy (and read back, not denormalized)

Alignment is stored **once**, on `Strategy.links`. Consuming surfaces obtain their chips
through projection helpers the Strategy service exposes — `listStrategyRefsForProject`,
`listStrategyRefsForPriorityIdea(listId, cardId)`, `listStrategyRefsForPriorityList(listId)`
— each of which filters to the strategies the caller can read. This avoids a denormalized
`strategyIds[]` on `IdeaScore`/`Project`/`AdvisoryBoard` that would drift on
delete/archive. MVP resolves with a readable-strategy scan + link filter; a cached reverse
index (`entity → strategyIds`) is deferred and added only if the scan shows up in latency
(§ open questions).

### RBAC (ADR 0006, fail-closed)

Every route is gated on `requireFeatureEnabled(req, 'strategy', 'Strategy')` first, then:

| Scope | Read | Write |
|---|---|---|
| `user` | `createdBy === caller` | `createdBy === caller` |
| `workspace` | `workspace:read` in tenant | `workspace:write` in tenant |
| `org` | `workspace:read` in `orgId` (via `authorizeOrgScope`) | `workspace:write` in `orgId` |

- **Config-sensitive ops** — change `scope`, change `ownerUserId`, archive, or hard-delete —
  require **creator OR `host:org:manage`** (the same elevated predicate Priority Matrix uses
  for criteria/weights and list deletion).
- **Cross-entity links** — creating a `StrategyLink` requires **read** access to the link
  target *and* **write** access to the strategy; context/projection resolution **silently
  omits** any unreadable linked entity (no existence leak — uniform with the project/board
  IDOR posture).
- **Tenant + org IDOR-guarded** on every read/write; no cross-tenant or cross-org reach.

### Delete = archive by default (resolves the PRD's open `DELETE` policy)

User story #10 ("archive obsolete strategy records *without destroying historical
context*") settles it: `DELETE /strategy/:id` performs a **soft archive** (`status:
'archived'`) for shared (`workspace`/`org`) strategies; a **hard delete** is permitted only
to the creator (or `host:org:manage`) and only for `user`-scoped drafts, mirroring the
"don't destroy shared history" posture. Archived strategies are excluded from default list
results and from context packets unless explicitly requested.

### Routes (`/v1/host/openwop-app/strategy/*`, audited clean)

```
GET    /strategy                 list readable strategies (filters: scope, orgId, horizon, status, linked entity)
POST   /strategy                 create
GET    /strategy/:id             get one
PATCH  /strategy/:id             update (config-sensitive fields gated above)
DELETE /strategy/:id             archive (or hard-delete per policy above)
PUT    /strategy/:id/links       replace/upsert links (read-target + write-strategy gated)
GET    /strategy/context         resolve a compact StrategyContextPacket for a consumer
                                 ?projectId= | ?priorityListId=[&cardId=] | ?boardId=
```

`GET /strategy/context` resolves **live** and RBAC-filters every linked entity it embeds.

### Workflow surface (ADR 0014) — read-only `ctx.features.strategy`

Declared via `surface: { id: 'strategy', build: buildStrategySurface }`, auto-advertised at
`/.well-known/openwop`, behind the same toggle + RBAC. **Read-only** methods:
`listStrategies(filter)`, `getStrategy(id)`, `getStrategyContext(consumerRef)`. No write
ops on the workflow surface day-1 (strategy authoring stays a human/admin act; an authoring
agent arrives via the deferred agent pack, ADR 0058 chat-drivability pattern).

### Replay / fork safety

Strategy is **declarative data**, not a run variant — nothing here stamps
`run.metadata.featureVariant`. The one replay-sensitive seam is the **board context packet**:
when an advisory board convenes, the strategy packet is resolved **live** (MVP). If advisor
sessions become replay-sensitive (a forked run must see the strategy *as it was*), snapshot
the resolved packet into the advisory session metadata at convene time and read it verbatim
on `:fork` — flagged as an open question, not built in MVP. Live-resolve means revocation
(losing read access to a linked entity) takes effect immediately everywhere, which is the
safer default.

### Frontend

`frontend/react/src/features/strategy/` — `strategyClient.ts`, `StrategyPage.tsx`,
`routes.tsx` (`FrontendFeature`, `featureId: 'strategy'`, nav group `Workspace`,
`Strategy` label, `tier: 'workspace'`), `i18n/en.ts` + `i18n/pt-BR.ts` (ADR 0065 per-feature
catalog; pt-BR native-reviewed, the user is the pt-BR NS-1 reviewer). Dense operational
style, not a marketing page. Tabs: **Portfolio** (all strategies by horizon/status/
risk/confidence/owner/scope) · **Strategy** (detail editor: objectives/KRs/initiatives/
rationale) · **Alignment** (linked projects/priorities/documents/boards) · **Board context**
(preview of the packet advisors will receive). Reuse `ui/Field`, `Notice`, `StateCard`,
`PageHeader`, chip/card tokens, `ui/icons` (no emoji-as-icon). No raw hex / no undefined
`var(--token)` (the `check-css-tokens` / `check-tsx-color-literals` gates).

### Public surface

**None.** Strategy is an internal planning surface; no entry in `PUBLIC_PATH_PREFIXES`.

## Cross-feature integration (projections, not forks)

| Surface | Type touched | Seam | What changes |
|---|---|---|---|
| **Priority Matrix** | *(no backend type touched — see §Correction)* | `GET /strategy/context` + `PUT /strategy/:id/links` (existing) | FE adds strategy chips on ranked rows + an "Align to strategy" control. **Alignment does not change the numeric score** — Priority Matrix already has a strategic-alignment *criterion* in its weighted preset; links explain context, scores stay explicit user input. |
| **Projects** | `Project` view (`projects/routes.ts:96`) | the `view()` projection closure | add optional `strategyIds?`/`strategyRefs?` projected from `listStrategyRefsForProject`; FE adds a small "Strategy" section on the Project Overview tab. Project write authority unchanged (a project has no authority of its own — ADR 0045/0063). **No new strategy fields on `Project.charter`.** |
| **Board of Advisors** | `AdvisoryBoard` (`advisory-board/types.ts:30`) + `AgentPromptScaffoldInput` (`host/agentPromptScaffold.ts:40`) | `projectBoard()` + `composeAgentSystemPrompt()` | add `contextRefs?: AdvisoryContextRef[]` to the board (**preferred over `strategyIds[]`** — ages better as context kinds grow); on convene, resolve refs live (RBAC-filtered) into a compact strategy block inserted into the scaffold via a new optional `strategyContext?` field. Prompt guidance: present as user/company planning context advisors may critique but must not invent; reference strategy labels/IDs; must not override the living-persona safeguards. |

`AdvisoryContextRef = { kind:'strategy'; strategyId } | { kind:'project'; projectId } |
{ kind:'priority-list'; listId } | { kind:'priority-idea'; listId, cardId }`.

#### §Correction (2026-06-19, /architect pre-Phase-3) — Priority Matrix alignment is FE-composition, no backend coupling

The original Priority Matrix row proposed projecting `linkedStrategyIds` inside
`priorityMatrixService.listRankedIdeas` by importing the strategy service. The
pre-Phase-3 `/architect` pass rejected that: **`strategyService.ts` already imports
`priorityMatrixService.ts`** (`getList`/`listRankedIdeas`, Phase 1 context resolution), so a
`priorityMatrixService → strategyService` back-import would close a **feature import cycle**.
Phase 3 therefore does **zero** priority-matrix backend change (`RankedIdea`/`surface.ts`
untouched) and composes on the **frontend** instead:

- **Chips** — the Priority Matrix list view fetches `GET /strategy/context?priorityListId=X`
  **once per list** and maps each strategy's resolved `linkedPriorities[].cardId` back onto
  the idea rows (RBAC already omits unreadable strategies). Toggle off ⇒ the context 404s ⇒
  chips/align control hidden (graceful; priority-matrix unaffected).
- **Align control** — a strategy-**owned** embeddable component (`StrategyAlignment.tsx`:
  `StrategyChips` + `AlignToStrategyButton`) that priority-matrix imports and renders in the
  idea row, driving the existing `strategyClient` (`listStrategies` + `getStrategy` +
  `replaceLinks`, adding a `{kind:'priority-idea', listId, cardId}` link). The import edge stays
  one-directional (`priority-matrix → strategy`), matching the established FE cross-feature
  pattern (`comments→cms/kb`, `profiles→twin/connections`, `site→cms`). A 403 from aligning to
  a read-only strategy surfaces a clean notice (writability isn't exposed client-side — MVP).

#### §Correction (2026-06-19, /architect pre-Phase-5) — advisor injection via a core resolver seam + `ConversationMeta` snapshot

The advisor system prompt is assembled **live per-turn in CORE** (`conversationExchange.ts`
→ `agentPromptScaffold.composeAgentSystemPrompt`), and **core MUST NOT import a feature**, so
strategy context reaches the prompt as **data**, not a core→feature call. Decided design:

- **`ConversationMeta.strategyContext?: string`** is the snapshot home (NOT `run.metadata`) —
  the board binding (`boardId`) already lives on `ConversationMeta`, and the strategy block
  shares its lifecycle: resolved **once** when the board group is formed (`markAsBoardGroup`),
  stable for the boardroom's life. This makes the prompt replay-stable within the conversation
  and means live strategy edits don't mutate an in-flight boardroom (good product behavior).
- **Core resolver-registry seam** `host/boardContextResolver.ts` (mirrors the ADR 0075
  `approverResolution` precedent): `registerBoardContextResolver(fn)` + `resolveBoardContext`.
  Core calls the registered fn at board-group creation and stamps the result — no core→feature
  import. **advisory-board registers** the resolver (board → `contextRefs` → strategy refs via
  `strategyService`, RBAC-filtered by the **convener**). Feature edge `advisory-board → strategy`
  is one-directional (cycle-free — strategy never imports advisory-board).
- `composeAgentSystemPrompt` gains an optional `strategyContext?: string`, injected after the
  persona block; `conversationExchange` loads `ConversationMeta` and passes `meta.strategyContext`.
- Cross-run `:fork` re-snapshot stays the ADR-scoped deferral (Open Q2).

## Phased plan

| Phase | Scope | Acceptance |
|---|---|---|
| **1 — backend model + REST** | `features/strategy/` (service over `DurableCollection`, `routes.ts`, `feature.ts` + toggle, `types.ts`); register in `BACKEND_FEATURES`. | Strategy CRUD behind toggle; scope/RBAC tests; cross-tenant/org IDOR tests green. |
| **2 — frontend surface** | `strategyClient.ts` + `StrategyPage` (Portfolio + detail editor) + `routes.tsx` + en/pt-BR catalogs; register in `FRONTEND_FEATURES`. | `/strategy` renders gated; create/edit/list flows; `npm run build` (canonical gate) green. |
| **3 — Priority Matrix alignment** | `listStrategyRefsForPriority*` helpers; project `linkedStrategyIds` into ranked-idea response + surface; align-to-strategy UI + portfolio filter. | ideas alignable; chips render; unreadable strategies omitted. |
| **4 — Projects alignment** | project `view()` projects strategy refs; strategy detail shows linked projects with status/health. | project page shows linked-strategy context; strategy page shows project status/health. |
| **5 — Board of Advisors context** | `contextRefs[]` on `AdvisoryBoard`; context picker in board setup; live packet resolution into the prompt scaffold + a convene-preview. | board setup includes strategies; advisor preview includes selected strategies; RBAC failures omit/reject safely. |
| **6 — workflow surface (+ deferred packs)** | read-only `ctx.features.strategy` (`list`/`get`/`context`); advertised at `/.well-known/openwop`. Node/agent packs **deferred**. | well-known advertises the host-ext surface only when implemented; no wire-capability claim. |

### Deferred (logged, not dropped — these are part of the feature's definition)

- **Node pack** `feature.strategy.nodes` (list/get/link/context-generation) — deferred to
  after the product surface stabilizes; `requiredPacks: []` at MVP.
- **Agent pack** `feature.strategy.agents` (a **Strategy Analyst** that audits alignment
  gaps and drafts board context) — deferred; chat-drivability then follows the ADR 0058
  pattern (agent pack + node pack scoped to the agent, driven through the existing chat —
  **no new chat panel, no envelope seam**, per CLAUDE.md "reuse, never recreate").
- **AI-chat envelopes** — **none** MVP (no `strategy.create` envelope; authoring stays
  human/admin; the future agent pack drives writes through the existing chat).
- **Board-memo generation** via Documents (`board update` template, ADR 0053), **strategy
  health rollups** from linked project/priority movement, **multi-year strategy trees**,
  **change history / approval workflow**, **strategy templates** (OKR / annual operating
  plan / portfolio bet / working-backwards / board update), and **cross-host strategy
  federation** (the genuine wire-RFC case) — all Later Enhancements.

## Alternatives weighed

1. **Reuse the `goals` feature as the strategy model.** Rejected — `goals` is judge-owned,
   execution-bounded runtime work (RFC 0097); folding declarative executive strategy into
   it would either corrupt goal-completion semantics or create a confusing dual-mode store.
   Strategy *links* to goals later instead.
2. **Denormalize `strategyIds[]` onto `IdeaScore`/`Project`/`AdvisoryBoard`.** Rejected for
   MVP — two write paths drift on archive/delete; canonical-on-Strategy + read-back keeps
   one owner. Revisited only if the projection scan shows latency (cached reverse index).
3. **`strategyIds[]` directly on `AdvisoryBoard`** (vs `contextRefs[]`). Rejected — the
   board will accumulate context kinds (project, priority idea, …); a typed `contextRefs[]`
   union ages better and matches the resolver-registry instinct. (PRD's own preference.)
4. **A bespoke "strategy chat / talk-to-AI" panel.** Rejected hard (CLAUDE.md) — drive AI
   for strategy through the **one** existing chat via the deferred agent + node packs.
5. **Snapshot board strategy context at convene (replay-safe) in MVP.** Deferred —
   live-resolve is simpler and makes revocation immediate; snapshot added only if advisor
   sessions become replay-sensitive.

## Open questions

1. **Projection scan vs cached reverse index.** MVP scans readable strategies and filters
   links per consumer request. At what list/idea fan-out does this need a cached
   `entity → strategyIds` index (and the rate-limit fan-out caution in CLAUDE.md)?
2. **Board context replay.** Confirm whether advisory sessions are replay-sensitive enough
   to require snapshotting the resolved packet into session metadata (vs the live-read MVP).
3. **`accountableExecutive` shape.** Free-text label vs a `user:`/person-Subject reference
   (ADR 0047). MVP: free text; promote to a reference if it needs RBAC/notification.
4. **Initiative ↔ runtime goal bridge.** When an initiative needs autonomous monitoring,
   the explicit link to a `goals` record (not a re-model) — design the link kind when the
   first such need lands.
5. **Strategy templates / health rollups** — deferred; revisit after the portfolio view has
   real usage to shape the rollup math honestly (no invented normalization, per ADR 0060).

## RFC gate (verdict)

**Host-extension — NO new RFC.** Everything lives under `/v1/host/openwop-app/strategy/*`,
links existing host entities, and advertises only the non-normative `ctx.features.strategy`
surface. No run-event field, capability flag, event type, endpoint contract, or normative
`MUST` touches the OpenWOP wire. The Board-of-Advisors context injection rides the same
**Accepted RFC 0005/0002 §A8** seam Board of Advisors itself rides (ADR 0040) — host work,
no blocking RFC. The only future phase that would need an RFC in `../openwop/` is
**cross-host strategy federation** (Later Enhancements), which is out of scope here and
would be authored via `/prd` before/with that work.

## Implementation ledger

Implemented across 6 phases on `feat/strategy-adr-0079` (2026-06-19). Each phase ran a
pre-implementation `/architect` pass and a post-implementation `/code-review` (+ `/ux-review`
for the FE phases); findings folded into the commit.

| Phase | What shipped | Tests | Key /architect finding folded in |
|---|---|---|---|
| 1 — backend model + REST + RBAC | `features/strategy/` (types · service over `DurableCollection` · routes · feature/toggle); CRUD · `PUT /:id/links` · `GET /context`; soft-archive | `strategy-route.test.ts` (8) | §Correction: `orgId` mandatory, `scope` is a visibility modifier (the app has no org-less shared entity) |
| 2 — frontend surface | `/strategy` page (Portfolio + detail editor: Overview/Objectives/Initiatives/Alignment), `strategyClient`, en/pt-BR | FE `npm run build` gate | toggle-off deep-link → clean not-enabled state; fixed 2 non-existent utility classes (/ux-review) |
| 3 — Priority Matrix alignment | `StrategyAlignment` (strategy-owned embeddable) + chips/align control in the PM table | +1 context contract test | **FE-composition, zero PM backend coupling** — avoids a `priorityMatrix→strategy` feature cycle. **Fix:** ids no longer secret-scrubbed (`reqId`/`optId`) — `cleanString` redacted a uuid-shaped card id, silently breaking every link |
| 4 — Projects alignment | `ProjectStrategyChips` on the Project Overview; project status/health in the strategy Alignment tab | +1 private-project test | **Fix:** context no longer leaks `private` projects (ADR 0054) — gate on `resolveProjectAccess`, not org-read |
| 5 — Board of Advisors context | `AdvisoryBoard.contextRefs` + preview endpoint; a **core board-context resolver seam** (`host/boardContextResolver.ts`) + `composeAgentSystemPrompt` `strategyContext` + `ConversationMeta` snapshot + `@@`-summon stamp | scaffold unit + advisory route tests (4) | core can't import a feature → resolver-registry seam (ADR 0075 pattern) + snapshot on `ConversationMeta` (replay-stable) |
| 6 — workflow surface | read-only `ctx.features.strategy` (list/get/context), auto-advertised at `/.well-known/openwop` | `strategy-surface.test.ts` (3) | tenant-trusted run surface MUST exclude `user`-scoped private drafts (no subject to authorize a creator-only read) |

Backend full suite green (2079); FE canonical gate green. Host-extension throughout — **no new RFC**.
