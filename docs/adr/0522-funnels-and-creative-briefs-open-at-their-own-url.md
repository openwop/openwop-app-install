# ADR 0522 — Funnels and Creative Briefs open at their own URL

Status: implemented

**Date:** 2026-08-03
**Depends on:** ADR 0294 (Funnels), ADR 0336 (creative briefs / deep-link spine),
ADR 0519 (the reference implementation), ADR 0520, ADR 0510 (page archetypes).
**RFC gate:** host UI only — **no RFC**. No wire change; the one new client call
(`getFunnel`) hits a backend route that already existed.

## Context

These are the **last two** confirmed surfaces in
`docs/steward/COLLECTION-CANON-SWEEP.md` — the two that are genuinely full-page
(the sweep's mid-flight correction established that KB, Media and Publishing are
real rails, which take a narrower fix). Both held their open entity in a query
param with `onClick` cells and delete on the cell.

They arrived at the same defect from opposite directions, which is worth
recording because it shows the defect is not a single sloppy page:

- **Funnels** was the classic stacked master–detail: a `<DataTable>` of funnels
  with the step editor, analytics, and A/B experiments rendered *below* it,
  keyed off `?funnel=`. Its list presentation was already fine — `<DataTable>`
  is the documented rule-11 operate-surface exception.
- **Creative Briefs** was already well built: `<ViewToggle>`, card/list cells,
  designed states, and a real single-entity read (`getBrief`) with the URL as the
  source of truth. It swapped the whole page to a detail component. Everything
  was right except **which** URL: `?brief=` instead of a path.

## Decision

Both take the ADR 0519 shape, sized to what each actually needed.

### Funnels — a full split

- **`/funnels`** keeps its `<DataTable>` (rule 11's table exception). The name
  cell is now a real `<Link>`; creating a funnel navigates to it.
- **`/funnels/:funnelId`** (`archetype: 'detail'`, new `FunnelDetailPage`) owns
  the step editor + routing rules, per-step analytics with rebuild, the A/B
  experiment panel, the live URLs, and Delete.
- New `getFunnel` client call over the existing `GET …/funnels/:funnelId`, so the
  editor loads standalone.
- **The CMS page list moved with the editor** — it is the step picker's data, and
  the table never needed it. Its `pagesFailed` honesty flag moved intact.

**Lifecycle (publish / unpublish / archive) deliberately STAYS on the table
row.** Those are operate-surface actions taken while scanning, which is what the
`<DataTable>` lane is for. Only **delete** moved: rule 12 is about *destructive*
actions, and it now sits beside the name that says which funnel is about to go.

### Creative Briefs — a lane change, not a rebuild

- `?brief=` → **`/creative-briefs/:briefId`**, with the **same component serving
  both routes** (the Tutorials precedent) so back-navigation keeps the list's
  filters and view mode.
- `BriefCard` / `BriefRow` became real `<Link>`s and lost their delete buttons;
  `BriefDetail` gained an `onDelete` in its action bar.
- Nothing else changed. The existing single-read, designed states, and ViewToggle
  were already correct — the fix was two prop signatures and a route.

## Alternatives weighed

- **A separate `CreativeBriefDetailPage` component.** Rejected: `BriefDetail`
  already exists as a full-page component inside the file, and splitting the
  module would have meant exporting it plus duplicating the org/access/orgs
  plumbing for no behavioural gain.
- **Moving funnel lifecycle to the detail page too.** Rejected above — it would
  make the table read-only for the actions its shape exists to support.
- **Keeping `?funnel=` as a legacy alias.** Nothing links it (grepped), so there
  is no compatibility debt to carry.

## Trade-offs accepted

- **`FunnelsPage` lost ~190 lines to a new 300-line detail page.** The list page
  is now genuinely a list page; the editor's state (steps, stats, experiments)
  no longer loads for someone who only wanted to scan the table.
- **One extra request** on each detail page, for the ADR 0519 reason: a detail
  surface must not depend on a list it cannot assume exists.
- **`BriefLifecycle.test.tsx` needed a `<Routes>` harness** — it opened the
  detail via `?brief=`. That is the test correctly following the behaviour
  change, not a regression.

## Implementation record

| Phase | What | Where |
| --- | --- | --- |
| 1 | `getFunnel` client call | `features/funnels/funnelsClient.ts` |
| 2 | Funnel detail page (editor + stats + experiments + delete) | `features/funnels/FunnelDetailPage.tsx` (new) |
| 3 | Funnels table: `<Link>` name cell, delete off the row, editor removed, create navigates | `features/funnels/FunnelsPage.tsx` |
| 4 | `/funnels/:funnelId` route | `features/funnels/routes.tsx` |
| 5 | Briefs: path lane, `<Link>` cells, delete → `BriefDetail` | `features/creative-briefs/CreativeBriefsPage.tsx` |
| 6 | `/creative-briefs/:briefId` route | `features/creative-briefs/routes.tsx` |
| 7 | i18n × 4 locales (funnels) | `features/funnels/i18n/*` |
| 8 | Test harness follows the route change | `creative-briefs/__tests__/BriefLifecycle.test.tsx` |

Gates: `npm run build` green, `npm run lint` clean, funnels + creative-briefs
suites green.

## What this closes

With these two, **all 7 confirmed surfaces from the sweep are done** (4 full-page
splits: Forms, Email, Funnels, Creative Briefs; 3 rails given the narrower
rule-12 fix: KB, Media, Publishing). The class is now held closed by
`src/__tests__/collectionCellsAreLinks.test.ts`, which fails on the signature all
seven were found by.
