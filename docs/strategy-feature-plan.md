# Strategy Feature Plan

**Status:** Planning  
**Date:** 2026-06-19  
**Tentative feature id:** `strategy`  
**Tentative product name:** Strategy  
**Page title:** Strategic Planning  
**Lane verdict:** Implementation-only host feature. No OpenWOP RFC is needed if Strategy stays under `/v1/host/openwop-app/strategy/*`, links existing host entities, and advertises only a host-extension `ctx.features.strategy` surface. An RFC is only needed if a later phase adds normative wire fields, event types, capability flags, or cross-host strategy semantics.

## Goal

Add a Strategy feature that lets executive leadership define, manage, and communicate company strategy through structured strategic goals, OKRs, initiatives, planning themes, and board-ready decision context.

The feature should become connective tissue across:

- executive strategic planning;
- Priority Matrix prioritization;
- project execution;
- Board of Advisors decision-making.

Strategies must support variable planning time boxes, including quarterly, half-year, annual, multi-year, and custom horizons. They must be scopeable to a user, workspace, or organization.

## Research Summary

Large-company planning patterns are converging on a few practical mechanisms.

### Strategy is broader than OKRs

Microsoft Viva Goals frames OKRs as a way to connect teams to strategic priorities, timelines, initiatives, check-ins, dashboards, and progress tracking. It also supports organization-configured time periods, including annual, quarterly, monthly, and custom periods.

Sources:

- [Introduction to Microsoft Viva Goals](https://learn.microsoft.com/en-us/viva/goals/intro-to-ms-viva-goals)
- [Manage OKR time periods in Viva Goals](https://learn.microsoft.com/en-us/viva/goals/managing-okr-time-periods)
- [Understanding views in Viva Goals](https://learn.microsoft.com/en-us/viva/goals/understanding-views)

### Executive strategy needs narrative rationale

Amazon's Working Backwards mechanism uses written artifacts to clarify customer value, business outcomes, scope, risks, and stakeholder alignment before execution. The useful lesson for this app is not to copy PR/FAQ verbatim, but to preserve structured rationale alongside goals and initiatives so advisors and executives understand why something matters.

Sources:

- [An insider look at Amazon's culture and processes](https://www.aboutamazon.com/news/workplace/an-insider-look-at-amazons-culture-and-processes)
- [AWS Prescriptive Guidance: Start with why](https://docs.aws.amazon.com/prescriptive-guidance/latest/strategy-product-development/start-with-why.html)

### Top-company strategy is portfolio and capital-allocation aware

Public materials from Microsoft, Walmart, Amazon, Alphabet, and JPMorgan describe strategy through long-horizon investment themes, operating leverage, customer experience, technology and AI, growth, risk, and capital allocation. A Strategy feature should therefore model strategic intent, linked execution, and risk/confidence, not just a list of objectives.

Sources:

- [Microsoft 2024 Annual Report](https://www.microsoft.com/investor/reports/ar24/index.html)
- [Walmart 2025 Investment Community Meeting](https://corporate.walmart.com/news/2025/04/09/walmart-showcases-business-strategy-focused-on-driving-growth-and-shareholder-value)
- [Amazon CEO Andy Jassy's 2025 Letter to Shareholders](https://www.aboutamazon.com/news/company-news/amazon-ceo-andy-jassy-2025-letter-to-shareholders)
- [JPMorgan Chase 2025 Annual Report CEO Letter](https://www.jpmorganchase.com/ir/annual-report/2025/ar-ceo-letters)

### Boards increasingly care about execution, not just strategy approval

NACD reports that boards are increasing focus on strategy execution, C-suite dialogue, strategic updates, technology transformation, and risk. Deloitte similarly frames boards as more active participants in strategic risk oversight. Board context in this app should therefore include the strategy, execution links, risks, confidence, and open decisions.

Sources:

- [NACD: Boards Prioritize Strategic Execution, Technology and People](https://www.nacdonline.org/about/newsroom/press-release/press-release/boards-prioritize-strategic-execution-technology-people-2026/)
- [NACD: Boards Shift Their Focus to Execution](https://www.nacdonline.org/all-governance/governance-resources/governance-research/outlook-and-challenges/2026-governance-outlook/boards-shift-their-focus-to-execution/)
- [Deloitte: Board's Expanding Role in Strategic Risk Oversight](https://www.deloitte.com/us/en/services/audit-assurance/blogs/accounting-finance/board-risk-oversights.html)

## Product Recommendation

Use **Strategy** as the nav label and **Strategic Planning** as the page title.

Do not reuse the existing backend `goals` feature as the primary data model. The current `goals` surface is RFC/runtime-oriented: bounded standing goals with judge-owned completion. Strategy should be an executive planning feature that may link to runtime goals later, but it should not mutate the existing goal semantics.

The Strategy feature should combine:

- strategic narratives;
- objectives and key results;
- initiatives;
- time horizons;
- owners and accountable executives;
- status, confidence, and risk;
- links to projects, priorities, advisory boards, documents, and eventually decisions;
- board-ready context packets.

A pure OKR tool would be too narrow. A pure roadmap would miss governance, rationale, and board context. The right model is an executive strategy portfolio with OKR-compatible structure.

## Existing App Surfaces To Compose

The implementation should follow the app's feature-first package architecture.

- Feature packages are registered through `backend/typescript/src/features/index.ts` and `frontend/react/src/features/registry.ts`.
- Priority Matrix already models weighted prioritization and uses `host.kanban` cards as ideas.
- Projects are always-on `project` Subjects with charters, health, members, board, memory, knowledge, workflows, schedules, and chat.
- Board of Advisors stores advisory cohorts and resolves boards into chat/advisor context.
- Existing `goals` is a runtime standing-goal surface and should remain separate.

Relevant design records:

- `docs/adr/0001-feature-first-package-architecture.md`
- `docs/adr/0040-board-of-advisors.md`
- `docs/adr/0046-project-subject.md`
- `docs/adr/0058-priority-matrix.md`
- `docs/adr/0059-priority-matrix-multi-voter.md`
- `docs/adr/0060-priority-matrix-portfolio.md`

## Core User Stories

1. As an executive, I can create an org-level strategy for a planning period so leadership has a shared strategic frame.
2. As a workspace lead, I can create workspace-scoped strategic goals so teams can align work without needing org-wide authority.
3. As an individual leader, I can keep a private user-scoped strategy draft before sharing it more broadly.
4. As an executive, I can define objectives, key results, initiatives, owner, status, risk, and confidence for a strategy.
5. As a portfolio planner, I can link projects to strategies so execution is visible from the strategic plan.
6. As a prioritization user, I can align Priority Matrix ideas to strategies so rank and rationale reflect company direction.
7. As a Board of Advisors user, I can include selected strategies in the board setup so advisors evaluate decisions with strategic context.
8. As an advisor or moderator, I can reference relevant strategies, priorities, and projects in recommendations.
9. As a viewer, I can see which priorities and projects support a given strategy.
10. As an admin or owner, I can archive obsolete strategy records without destroying historical context.

## Product Workflows

### Create Strategy

1. User opens Strategy.
2. User selects scope: user, workspace, or organization.
3. User selects planning horizon: quarter, half-year, annual, multi-year, or custom.
4. User enters title, summary, rationale, owner/accountable executive, status, confidence, and risk.
5. User adds objectives, key results, and initiatives.
6. User links related projects, Priority Matrix lists/items, and advisory boards.

### Align Priority Item To Strategy

1. User opens Priority Matrix.
2. User selects a list and idea/card.
3. User opens an "Align to strategy" control.
4. User selects one or more readable strategies.
5. Priority Matrix shows strategy chips in the ranked table and idea detail.
6. Strategy detail shows the aligned idea under Priority Alignment.

### Link Project To Strategy

1. User opens a project overview.
2. User selects one or more strategies.
3. Project overview shows strategy chips and strategic rationale.
4. Strategy detail shows the project with status/health from the project charter.

### Add Strategy Context To Board of Advisors

1. User opens Board of Advisors setup.
2. User selects advisors as today.
3. User selects strategies, projects, and priority items as context.
4. Backend resolves selected context subject to RBAC.
5. Board/advisor prompt receives a compact strategy context packet.
6. Advisor output can reference strategy, priority, and project context.

## Data Model

```ts
type StrategyScope =
  | { kind: 'user'; userId: string }
  | { kind: 'workspace'; tenantId: string }
  | { kind: 'org'; orgId: string };

type PlanningHorizon = 'quarter' | 'half-year' | 'annual' | 'multi-year' | 'custom';

type StrategyStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
type StrategyConfidence = 'high' | 'medium' | 'low';
type StrategyRisk = 'low' | 'medium' | 'high';

interface Strategy {
  id: string;
  tenantId: string;
  orgId?: string;
  scope: StrategyScope;
  title: string;
  summary?: string;
  rationale?: string;
  planningHorizon: PlanningHorizon;
  period: { label: string; startDate?: string; endDate?: string };
  ownerUserId?: string;
  accountableExecutive?: string;
  status: StrategyStatus;
  confidence?: StrategyConfidence;
  risk?: StrategyRisk;
  objectives: StrategyObjective[];
  initiatives: StrategyInitiative[];
  links: StrategyLink[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface StrategyObjective {
  id: string;
  title: string;
  keyResults: StrategyKeyResult[];
}

interface StrategyKeyResult {
  id: string;
  title: string;
  target?: string;
  current?: string;
  unit?: string;
  status?: StrategyStatus;
}

interface StrategyInitiative {
  id: string;
  title: string;
  ownerUserId?: string;
  status?: StrategyStatus;
  linkedProjectIds?: string[];
}

type StrategyLink =
  | { kind: 'project'; projectId: string }
  | { kind: 'priority-list'; listId: string }
  | { kind: 'priority-idea'; listId: string; cardId: string }
  | { kind: 'advisory-board'; boardId: string }
  | { kind: 'document'; documentId: string };
```

### Relationship Rules

- A Strategy belongs to one tenant/workspace.
- Org-scoped strategies also carry an `orgId`.
- User-scoped strategies are private to the creator unless later promoted or copied.
- Strategy links point at existing entities; they do not duplicate project, priority, or board data.
- Strategy context packets are projections assembled at read/convene time.
- Later replay-sensitive board/advisor sessions may snapshot resolved strategy context, but MVP can resolve live context.

## Backend Plan

Add a backend feature package:

```text
backend/typescript/src/features/strategy/
  feature.ts
  routes.ts
  strategyService.ts
  surface.ts
  types.ts
```

Register in:

- `backend/typescript/src/features/index.ts`

Feature metadata:

- `id: 'strategy'`
- toggle default: OFF
- bucket unit: `tenant`
- category: `Business Tools`
- no required packs in MVP
- optional read-only `ctx.features.strategy` surface

### Routes

Base path:

```text
/v1/host/openwop-app/strategy
```

Routes:

- `GET /strategy` — list readable strategies, optionally filtered by scope, org, horizon, status, linked entity.
- `POST /strategy` — create a strategy.
- `GET /strategy/:id` — get a strategy.
- `PATCH /strategy/:id` — update a strategy.
- `DELETE /strategy/:id` — archive or delete, depending on final policy.
- `PUT /strategy/:id/links` — replace or upsert links.
- `GET /strategy/context` — resolve compact strategy context for board/advisor/project/priority use.

Possible context query examples:

```text
GET /strategy/context?projectId=project-123
GET /strategy/context?priorityListId=list-123
GET /strategy/context?priorityListId=list-123&cardId=card-456
GET /strategy/context?boardId=host:advisory:founders
```

### RBAC

Use the same fail-closed posture as Priority Matrix and Projects.

- User scope:
  - read/write: creator/current user only.
- Workspace scope:
  - read: workspace member with `workspace:read`.
  - write: `workspace:write`.
- Org scope:
  - read: `workspace:read` in the strategy's org.
  - write: `workspace:write` in the strategy's org.
- Config-sensitive changes:
  - changing scope, owner, archival status, or deleting should require creator or `host:org:manage`.
- Cross-entity links:
  - creating a link requires read access to the target and write access to the strategy.
  - context resolution must silently omit unreadable linked entities.

## Frontend Plan

Add a frontend feature package:

```text
frontend/react/src/features/strategy/
  StrategyPage.tsx
  strategyClient.ts
  routes.tsx
  i18n/en.ts
  i18n/pt-BR.ts
```

Register in:

- `frontend/react/src/features/registry.ts`

Route:

- `/strategy`

Navigation:

- label: `Strategy`
- tier: workspace
- feature id: `strategy`

### UI Structure

Use the existing dense operational app style. Avoid a marketing-style strategy page.

Recommended page tabs:

- **Portfolio** — all strategies by horizon, status, risk, confidence, owner, scope.
- **Strategy** — detail editor for objectives, key results, initiatives, rationale.
- **Alignment** — linked projects, priority lists/items, documents, advisory boards.
- **Board context** — preview of the compact packet advisors will receive.

Primary controls:

- segmented control for horizon;
- select for scope;
- chips for status, confidence, risk;
- compact tables for linked projects and priorities;
- icon buttons using existing UI icon exports;
- field components from `ui/Field`;
- `Notice`, `StateCard`, `PageHeader`, and existing chip/card tokens.

## Priority Matrix Integration

MVP should store alignment once in Strategy links, then project alignment into Priority Matrix responses.

Backend:

- Extend Priority Matrix ranked idea projection to include readable linked strategy summaries.
- Add helper from Strategy service:
  - `listStrategyRefsForPriorityIdea(tenantId, listId, cardId, authCtx)`
  - `listStrategyRefsForPriorityList(tenantId, listId, authCtx)`
- Avoid storing duplicated strategy IDs on `IdeaScore` unless performance requires a cached projection later.

Frontend:

- Add strategy chips to ranked idea rows.
- Add an "Align to strategy" selector in the idea/detail controls.
- Allow filtering the portfolio view by strategy.
- Keep scoring criteria separate from strategy alignment. Strategy alignment explains why an idea matters; it should not automatically override the numeric score unless the criteria set includes a strategic-alignment criterion.

## Projects Integration

Projects remain the execution container. Do not overload `Project.charter` with strategy fields.

Backend:

- Strategy links can point to `projectId`.
- Strategy context should include linked project status/health when available.
- Project detail routes do not need to own strategy data; they can call Strategy service projection helpers.

Frontend:

- Add strategy chips or a small Strategy section on the Project Overview tab.
- Strategy detail shows linked projects with project status, health, and owner/member context.
- Keep project write authority unchanged: a project has no authority of its own; people act through org RBAC.

## Board of Advisors Integration

Board setup should support selected context refs:

```ts
type AdvisoryContextRef =
  | { kind: 'strategy'; strategyId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'priority-list'; listId: string }
  | { kind: 'priority-idea'; listId: string; cardId: string };
```

MVP options:

1. Add `contextRefs?: AdvisoryContextRef[]` to `AdvisoryBoard`.
2. Or add `strategyIds?: string[]`, `projectIds?: string[]`, and `priorityRefs?: ...`.

Prefer `contextRefs[]` because it will age better as more context types are added.

Backend:

- On board create/update, validate selected refs are readable by the caller.
- On board convene or context preview, resolve refs live subject to RBAC.
- Include a compact strategy context block in advisor prompt assembly.
- If later replay sensitivity matters, snapshot resolved context into advisory session metadata.

Frontend:

- Extend Board of Advisors setup after advisor selection with context pickers.
- Let the user add Strategies alongside Priority Matrix and Projects.
- Show selected context chips on board cards.
- Add a context preview to reduce surprise before convening a board.

## Strategy Context Packet

Advisor context should be compact, explicit, and bounded.

Suggested projection:

```ts
interface StrategyContextPacket {
  strategies: Array<{
    id: string;
    title: string;
    scope: StrategyScope;
    horizon: PlanningHorizon;
    period: { label: string; startDate?: string; endDate?: string };
    status: StrategyStatus;
    confidence?: StrategyConfidence;
    risk?: StrategyRisk;
    owner?: string;
    summary?: string;
    rationale?: string;
    objectives: Array<{
      title: string;
      keyResults: Array<{ title: string; target?: string; current?: string; status?: StrategyStatus }>;
    }>;
    initiatives: Array<{ title: string; status?: StrategyStatus; linkedProjectIds?: string[] }>;
    linkedProjects: Array<{ id: string; name: string; status?: string; health?: string }>;
    linkedPriorities: Array<{ listId: string; cardId?: string; title: string; computedPriority?: number; rank?: number }>;
  }>;
}
```

Prompt guidance:

- Present strategy context as user/company-provided planning context.
- Advisors may critique, challenge, or use it, but should not invent missing strategy facts.
- Advisors should reference strategy labels or IDs when making recommendations.
- Strategy context should not override living-persona safeguards in Board of Advisors.

## MVP Scope

Ship:

- Strategy CRUD with user/workspace/org scope.
- Objectives, key results, initiatives, horizon, owner, status, confidence, risk, and rationale.
- Links to projects, priority lists, priority ideas, and advisory boards.
- Strategy chips and filters in Priority Matrix.
- Strategy context picker in Board of Advisors setup.
- Read-only `ctx.features.strategy` surface: list/get/context packet.
- Route/service tests for RBAC, IDOR, create/update, linking, and context resolution.
- Frontend tests for key rendering and disabled/access states where practical.
- ADR `0076-strategic-planning.md`.

## Later Enhancements

- Strategy health rollups from linked project completion and Priority Matrix movement.
- Multi-year strategy trees with parent/child themes.
- Board-ready strategy memo generation via Documents.
- Change history and approval workflow for strategy changes.
- Strategy templates:
  - OKR
  - annual operating plan
  - portfolio bet
  - working-backwards narrative
  - board update
- Agent pack: `feature.strategy.agents`, including a Strategy Analyst that audits alignment gaps and drafts board context.
- Node pack: `feature.strategy.nodes` for list/get/link/context generation.
- Cross-workspace or cross-host strategy federation, which would require a separate RFC if it touches OpenWOP wire behavior.

## Risks And Open Questions

### Goals naming collision

There is an existing `goals` backend feature with protocol/runtime semantics. Strategy must not silently become a second runtime goal system or mutate judge-owned goal completion rules. If an executive objective later needs runtime monitoring, link Strategy to `goals` explicitly.

### Scope complexity

User/workspace/org scope must be visible in the UI and enforced server-side. Avoid "soft tags" that look scoped but do not affect authorization.

### Board context replay

MVP can resolve selected strategy context live. If advisor sessions become replay-sensitive, snapshot selected strategy context into advisory session metadata.

### Priority alignment ownership

Store alignment once in Strategy links and project it into Priority Matrix. Add cached projections only if needed for performance.

### Strategy scoring semantics

Alignment should not automatically change Priority Matrix scores. The existing Priority Matrix already has a strategic-alignment criterion in the weighted preset; users can score against it. Strategy links explain context; scores remain explicit user input.

### Toggle posture

Default OFF, like Priority Matrix and Advisory Board. This is a substantial business tool and should be tenant/workspace-admin enabled.

### ADR requirement

An ADR is required because this is a cross-cutting feature connecting strategy, projects, priorities, and advisors. No protocol RFC is required unless the feature becomes cross-host normative.

## Implementation Phases

### Phase 1: ADR and backend model

- Add `docs/adr/0076-strategic-planning.md`.
- Add Strategy backend feature package.
- Add Strategy service, types, collection, validation, and route tests.
- Register backend feature and toggle.

Acceptance:

- Strategy CRUD works behind toggle.
- Scope/RBAC tests pass.
- Cross-tenant/org IDOR tests pass.

### Phase 2: Frontend Strategy surface

- Add Strategy route, client, page, i18n.
- Implement portfolio and detail editing views.
- Register frontend feature.

Acceptance:

- `/strategy` renders gated page.
- Create/edit/list flows work.
- Frontend canonical build passes.

### Phase 3: Priority Matrix alignment

- Add strategy-link helpers.
- Project linked strategy refs into Priority Matrix list/idea responses.
- Add align-to-strategy UI.

Acceptance:

- Priority ideas can be aligned to strategies.
- Ranked table shows strategy chips.
- Unreadable strategies are omitted.

### Phase 4: Projects alignment

- Show linked strategy refs on project overview.
- Show linked projects in strategy detail.

Acceptance:

- Project page shows linked strategy context.
- Strategy page shows project status/health summary.

### Phase 5: Board of Advisors context

- Add board context refs or strategy IDs.
- Add context picker to board setup.
- Resolve strategy context packet for board/advisor use.

Acceptance:

- Board setup can include strategies.
- Advisor context preview includes selected strategies.
- RBAC failures omit or reject context safely.

### Phase 6: Workflow surface and optional packs

- Add read-only `ctx.features.strategy`.
- Consider node/agent packs after the product surface is stable.

Acceptance:

- `/.well-known/openwop` advertises the host-extension surface only when implemented.
- No wire-level capability claim is made.

## Verification Plan

Backend:

```sh
( cd backend/typescript && npm test )
```

Frontend:

```sh
( cd frontend/react && npm run build )
```

Targeted tests to add:

- `backend/typescript/test/strategy-route.test.ts`
- `backend/typescript/test/strategy-context.test.ts`
- Priority Matrix alignment route/service tests.
- Advisory Board strategy context tests.
- Frontend Strategy page smoke/render tests if the current test setup supports it.

## Files Likely Affected

Backend:

- `backend/typescript/src/features/index.ts`
- `backend/typescript/src/features/strategy/*`
- `backend/typescript/src/features/priority-matrix/*`
- `backend/typescript/src/features/advisory-board/*`
- `backend/typescript/src/features/projects/*`
- `backend/typescript/test/*`

Frontend:

- `frontend/react/src/features/registry.ts`
- `frontend/react/src/features/strategy/*`
- `frontend/react/src/features/priority-matrix/*`
- `frontend/react/src/features/advisory-board/*`
- `frontend/react/src/features/projects/*`
- `frontend/react/src/styles/global.css` only if existing utility classes are insufficient.

Docs:

- `FEATURES.md`
- `CHANGELOG.md`
- `docs/adr/0076-strategic-planning.md`
- this file, if the plan changes during implementation.
