# ADR 0131 — The Collection-View Canon (one shared grid/list toggle)

- **Status:** Accepted — implemented (foundation + 12 pages shipped; the
  DataTable "grid-alongside-table" extension is in progress)
- **Date:** 2026-06-24
- **Scope:** `openwop-app` frontend (`frontend/react/`) — UI composition layer only.
- **Decision type:** Cross-cutting UI seam (a shared primitive + a page-level
  pattern). **Host-only — no wire/spec/schema/conformance/SDK impact**, so this is
  an ADR, not an RFC (CLAUDE.md: a spec change needs an RFC in `openwop`; this
  touches none of the protocol surface).
- **Codifies:** `DESIGN.md` §4.5 rule 11 + the §5.1 `<ViewToggle>`/`.list-view`
  rows, which remain the day-to-day style reference; this ADR is the decision
  record behind them.

## Context

Six-plus surfaces each listed homogeneous entities, and the first one to need a
"browse as cards vs scan as a dense list" switch — `/agents` — hand-rolled it:
an inline `action-bar` of two `.primary/.secondary` buttons wired to local
`'tiles' | 'list'` state, with the dense rows styled by agent-specific
`.roster-*` classes. As more pages wanted the same affordance, copy-pasting that
inline toggle (plus its state, its i18n, its persistence) into each one would
have produced N drifting implementations of the same control — the exact
fragmentation the shared `ui/` cohesion layer exists to prevent.

## Decision

There is **ONE** grid/list switch for collection pages: the shared
**`<ViewToggle>`** (`src/ui/ViewToggle.tsx`) — a `.segmented` control, sibling of
`<DensityToggle>` — paired with **`useViewMode('<surface>', fallback)`**, which
persists the choice per-surface in `localStorage` (`openwop:view:<surface>`).

- **Grid** = `.surface-card`s in a `.card-grid` (the discovery default).
- **List** = dense rows in a `.surface-card.list-view` of generic `.list-row*`
  (the fleet-scale view, §4.5 rule 6).
- Each feature supplies only its **Card** + **Row**, and both derive their chips
  + sub-line from **one shared helper**, so the two views can never diverge on
  data (the `primaryAction`/`subLine` precedent from `/agents`).
- The toggle lives right-aligned (`u-ml-auto`) at the end of the page's one
  `.filterbar` row (§4.5 rule 5).
- `.roster-row` is retained as the **agent-specialized instance** of `.list-row`
  (it adds an avatar status-ring + an autonomy column); generic collections use
  the neutral `.list-row*` family. Not a parallel system — a justified
  specialization with extra real cells.

## Alternatives weighed

| Option | Why rejected |
|---|---|
| **Per-page hand-rolled toggle** (the `/agents` original) | N drifting copies of one control + state + i18n + persistence; the fragmentation the `ui/` layer forbids. This is the violation that motivated the ADR. |
| **A single mega `<CollectionView items renderCard renderRow>`** | The cards genuinely differ per feature (agent: avatar + autonomy + board counts; document: status + kind; workforce: the `.wf-track` signature). One component would either bloat into a prop soup or force a lowest-common-denominator card. Sharing the *chrome* (toggle + filterbar + row CSS) while each feature owns its Card/Row is the right seam. |
| **Add a "card mode" to `<DataTable>`** | `<DataTable>` is the operate-table primitive (sortable columns, bulk-select, density). Folding a card renderer into it conflates two concerns and would drag every table into the card abstraction. Instead, DataTable pages get the grid *alongside* the table (below). |

## Scoping rule — which pages get what

Not every list is a grid/list collection. Classify, don't blanket-apply:

1. **Card-grid / bespoke-list collection pages** → full grid + list toggle.
   (Agents, Projects, Documents, Advisors, Strategy, Marketplace, Prompts,
   Workforces, Builder, Media, KB.)
2. **`DataTable` operate-surfaces** (Library, Keys, Runs, CRM, CSM, Users,
   Memory, Roster, Analytics) → the table **IS** the list view. They get Grid
   **alongside** the table — `<ViewToggle labels={{ list: 'Table' }}>` with
   `useViewMode(..., 'list')` so the **table stays the default** and Grid is
   purely additive. The canon **never replaces** a table. (An early sweep that
   replaced two tables — including a BYOK add-flow rewrite — was reverted for
   exactly this reason.)
3. **Editor nav-rails** (CMS, Email, Forms, Publishing, Sharing) → **excluded.**
   Their "list" is a master-detail picker feeding an editor, not a browsable
   collection; a card grid there is a weak fit and churns the editor layout.
4. **The 2×2 Matrix** (`/priority-matrix`) is a documented 3-way specialization:
   Matrix is unique to that page, so it owns a bespoke 3-segment `.segmented`
   control (reusing the same `openwop:view:<surface>` key scheme), not the
   2-value shared `<ViewToggle>`.

## Rollout (phase → PR)

| Phase | What landed | PR |
|---|---|---|
| 1 — Foundation + first wave | `<ViewToggle>` + `useViewMode` + generic `.list-view`/`.list-row*` CSS + DESIGN.md §4.5 rule 11; `/agents` refactored onto the primitive; grid/list on Projects, Documents, Advisors, Strategy, Priority-matrix | #721 |
| 2 — Priority-matrix namesake | the 2×2 impact×effort Matrix as a third view (axes derived from each criterion's `direction`) | #723 |
| 3 — Second wave | Marketplace, Prompts, Workforces, Builder, Media, KB | #726 |
| 4 — DataTable grid-alongside-table | `/library` (Grid alongside the artifact table); `/keys` optional follow-on | this PR |

## Consequences

- **Positive:** one control to learn + maintain; per-surface persistence for free;
  new collection pages are a Card + Row + three lines of wiring; no CSS churn
  (everything composes from `.card-grid`/`.list-row*`/`.filterbar`/chips).
- **Cost:** a feature must author two presentations of its entity; the shared
  helper discipline (one chip/sub-line source) is a convention, not enforced by
  the compiler — review catches divergence.
- **Guardrail:** reimplementing the toggle, the row chrome, or the persistence is
  a defect (§4.5 rule 11). Converting (replacing) a DataTable is out of scope —
  Grid goes *alongside* it.

## Correction note

The DataTable handling above is a deliberate refinement discovered in Phase 4:
the original rule-11 wording implied every collection page gets grid **and**
list. Operate-surfaces already have a superior "list" (the sortable table), so
for them the canon adds Grid *next to* the table rather than a `.list-row` list —
the table is the list. Recorded here rather than silently editing rule 11; rule
11 carries a one-line pointer to this ADR.
