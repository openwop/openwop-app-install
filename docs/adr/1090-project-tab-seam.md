# ADR 1090 — Feature-contributed project tabs

Status: Accepted (2026-11-10). P1 (D1–D3) is implemented in the PR that records it; D4 and the P2 items remain.

Extends [ADR 0046](0046-project-subject.md) (the project subject) and [ADR 0054](0054-collaborative-project.md) (project access). Follows the [ADR 0889](0889-agent-eval-suites-trajectories-trials.md) D8 precedent, `agentWorkspaceTabs`, and the [ADR 1031](1031-adopter-feature-seam.md) adopter seam. Frontend only, so no wire RFC is involved.

## Context

The project detail page (`features/projects/ProjectDetailPage.tsx`) is the home of a project: its overview, ledger, members, chat, board, memory, knowledge, workflows and schedules. Its tabs are a closed list (`type Tab`, line 45). Two features already needed a tab of their own:
- notebooks (Sources);
- podcasts (Podcast).

Each got one by editing the page, gated by a hand-written `useFeatureAccess` call (lines 79–89).

A feature that holds per-project data, such as a white-label adopter's project dashboard or a future first-party one, has no way to put it where the project is. It ships a separate route and links to it, so the project's home is split across two screens.

The agent workspace solved the same problem for agents with `agentWorkspaceTabs` (`features/registry.ts:138`). That page still picks each tab by feature id (`AgentWorkspacePage.tsx:79,103`), so it is a declaration, not yet a general seam.

## Decision

### D1. `FrontendFeature.projectTabs`

```ts
interface ProjectTab {
  /** Stable, unique across features; the `?tab=` value. Lowercase kebab. */
  key: string;
  /** Tab label, English fallback; `labelKey` resolves in `labelNamespace` (default: the feature id). */
  label: string;
  labelKey?: string;
  labelNamespace?: string;
  /** Sort position among contributed tabs (ascending; ties by key). Contributed tabs follow the host's. */
  order?: number;
  render: (p: { project: Project; canWrite: boolean }) => ReactNode;
}
```

`featureProjectTabs()` in the registry returns every feature's tabs, each stamped with its `featureId`, sorted by `order` then `key`.

### D2. The page merges them

- `ProjectDetailPage` appends the contributed tabs after its own.
- A tab shows only when `useFeatureVisible()(featureId)` is true, so the contributing feature's toggle gates it, and a distribution that excludes the feature drops it.
- `?tab=<key>` deep-links to a contributed tab. An unknown or hidden key falls back to Overview, as today.
- The charter-draft guard (PROJ-UX-2) applies to contributed tabs as well.

### D3. Guards

A contributed key that collides with a host tab, or with another feature's key, is a test failure over the shipped features (`features/__tests__/projectTabs.test.ts`), not a runtime check. The page also refuses to render a duplicate, keeping the first.

### D4. Notebooks and podcasts stay hand-wired in P1

Sources and Podcast keep their place and their `useFeatureAccess` checks for now. Moving them onto the seam means giving `notebooks` and `podcasts` a `FrontendFeature` of their own (their standalone routes were withdrawn under the ADR 0084 correction). That puts two more registry entries in the entry chunk, which runs close to its budget. P2 moves them once the entry has room, with no visible change.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `projects` (page) and `registry.ts` (field, accessor) |
| 2 | Toggle | None new; each tab follows its feature's toggle |
| 3–7 | Workflow, nodes, chat, agents, public | None: a presentation seam |
| 8 | RBAC | Unchanged: the page passes `canWrite` (project write access), and each tab's own reads keep their backend gates |
| 9 | Replay | None |
| 10 | Frontend | D1 to D3; the tab renders in the shared `TabPanel`; lazy content stays the contributor's concern (wrap in `Suspense`) |

## Phased plan

| Phase | Work |
|---|---|
| P1 | D1 to D3, with tests: merge order, toggle gating, deep link and fallback, the duplicate-key guard over the shipped features, the host tabs unchanged |
| P2 | Sources and Podcast move onto the seam (D4). A feature may name its tab the project's default for projects it recognises (`isHome?(project)`), so an adopter's dashboard can open first |

## Alternatives weighed

- **A route per feature, linked from the project.** This is today's workaround. The project's home is split, and the tabs bar no longer tells you what a project has.
- **A generic "extensions" tab hosting all feature panels.** One more click for everything, and no deep link per feature.

## Open questions

1. Should contributed tabs be able to declare a badge (a count, as Basecamp shows unread)? Left out of P1.

## Grades (2026-11-10, P1)

**UX — A.**
- Contributed tabs join the shared `Tabs` (roving focus, `aria-selected`, one `TabPanel`), so keyboard and screen-reader behaviour is the host's.
- They sit after the host's tabs in a stable order (`order`, then key).
- `?tab=` deep-links, and a hidden feature's link falls back to Overview, so it never opens an empty panel. A colliding key is dropped instead of shadowing a host tab.
- Fixed in grading: a tab with no `labelKey` rendered an empty label (`t('')`); it now uses its `label`.
- Open: `U1UX-1` (Nice-to-have) no badge or count on a tab (open question 1).
- Click-through: a contributed tab at 375 px wraps with the host tabs.

**Code — A.**
- The seam is typed: `ProjectTab` in `registry.ts`, with `Project` imported as a type only, so nothing reaches the entry chunk but the field and a sort.
- The contributed list is computed once at module load; visibility is filtered per render, memoised on the predicate.
- The host keys come from `TAB_LABEL_KEYS` (`HOST_TAB_KEYS`), which the shipped-features test imports rather than copies.
- Tests:
  - the page: order, deep link, a dropped collision, a hidden feature's fallback;
  - the guard over every shipped feature;
  - the existing project-page suites, unchanged (50 files).
- Build: `npm run build` passes every gate, entry 128.4 kB of 129 kB.
- Fixed in grading:
  - the de-duplication used a side effect inside `filter`; it is a loop now;
  - the guard test had its own copy of the host tab list, which would drift.
- Open: `U1C-1` (Improvement) the agent workspace still picks its tabs by feature id (`AgentWorkspacePage.tsx:79,103`). Move it to the same general merge.

**Workflows — not applicable, verified.** The change touches only `frontend/react/src` (`registry.ts`, `ProjectDetailPage.tsx`, two tests) and this ADR. Searching the diff for `registerWorkflow`, `builtinWorkflows`, `registerHostWorkflow`, `workflow-chain` and `WorkflowDefinition` finds nothing. The project's Workflows and Schedules tabs are untouched, so no chain, node or registration path changes.

**AI exchange — not applicable, verified.** The seam adds no prompt, agent tool, node, envelope or model call. The diff touches no `packs/` file and no `registerFeatureAgentTool`. Agent parity is each contributor's duty: a feature that adds a tab owns the read tools that let an agent see the same data, under the same access rule as the tab's reads. The tab is a view, not a data path. Recorded as the contract in D1 by this note.
