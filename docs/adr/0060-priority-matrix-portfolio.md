# ADR 0060 — Priority Matrix: intra-host cross-list portfolio rollup

**Status:** implemented (this conversation)
**Date:** 2026-06-16
**Toggle:** none new — extends the existing **`priority-matrix`** feature (ADR 0058). The
portfolio is a read-only view gated by the same toggle + RBAC.
**Depends on / composes:** ADR 0058 (Priority Matrix), ADR 0006 (RBAC — `workspace:read`,
per-org readability filter), ADR 0015 (workspace = tenant).
**Surface:** host-internal, under the existing `/v1/host/openwop-app/priority-matrix/*`.
**RFC gate:** **NO new RFC.** A WORKSPACE-internal aggregation across the caller's own lists
touches no wire. (Only *cross-HOST* portfolio federation — aggregating across different
OpenWOP hosts — would be wire-touching and RFC-gated; that stays parked, ADR 0058.)

## Why this exists

ADR 0058 §Open-questions parked "portfolio / cross-list rollup" as the RFC-gated wire case.
On revisiting (this conversation, 2026-06-16) the caller split it: aggregating ideas across
the **multiple priority lists within one workspace** into a single ranked view is purely
host-internal — a portfolio leader wants one "what are our top priorities across every
initiative list?" view without opening each list. Only federating across *separate hosts*
needs the wire. This ADR ships the host-internal half.

## Decision

A read-only **portfolio** read that merges the ranked ideas of every priority list the
caller can read in a workspace (optionally one org) into a single, descending-by-priority
list, each item carrying its **source list**, its **in-list rank**, and the list's
**scoring model** so the view is honest about comparability.

- **`listPortfolio(tenantId, { orgId?, topN? })`** → `{ items: PortfolioItem[]; lists: PortfolioListRef[] }`.
  - `items` = every idea across the in-scope lists, each as
    `{ listId, listName, votingMode, scoringModel, cardId, title, status, computedPriority, inListRank }`,
    sorted by `computedPriority` descending, sliced to `topN` (default 20, max 200).
  - `lists` = the lists that contributed `{ listId, name, scoringModel, ideaCount }` — so the
    UI can show what was aggregated.
- **Route:** `GET /v1/host/openwop-app/priority-matrix/portfolio?orgId=&topN=` — toggle +
  `workspace:read`; same **per-org readability filter** as `GET /lists` (a list in an org the
  caller can't read is excluded — no cross-org leak), and an optional `orgId` narrows to one org.
- **Surface:** `ctx.features.priority-matrix.listPortfolio` (read), so a workflow/agent can
  read the portfolio. Toggle-gated at the seam.
- **Honesty about comparability (the load-bearing caveat):** priorities are **not strictly
  comparable across lists with different criteria/scoring**. A `weighted-sum` list yields a
  normalized 1–10; a `ratio` list (WSJF/RICE) yields an unbounded ratio. The portfolio sorts
  by raw `computedPriority` and **surfaces each item's source list + scoring model + in-list
  rank** so the reader sees the apples-vs-oranges rather than trusting a false global number.
  The UI states this; we deliberately do NOT invent a cross-list normalization that would be
  arbitrary. (A future opt-in normalization is an open question below.)

## Phased plan

- **Phase 1 — backend:** `listPortfolio` in `priorityMatrixService.ts` (reuses
  `listRankedIdeas` per list); the `GET /portfolio` route with the per-org readability filter;
  the `listPortfolio` surface method. Tests.
- **Phase 2 — frontend:** a **Portfolio** section at the top of the Priority Matrix page — a
  `<DataTable>` of the workspace top-N (rank · idea · list · scoring model · status · priority),
  with a top-N control and the comparability caveat as muted text. Read-only.

## Alternatives weighed

- **Invent a cross-list normalization** (percentile, or priority ÷ list-max) so a single
  global score is "comparable" → rejected for v1: any normalization is an opinion that can
  mislead (a #1 in a 2-idea list isn't a #1 in a 50-idea list). Show source + in-list rank and
  let the human judge; offer normalization later as an explicit, labeled option.
- **A separate top-level nav page** → rejected: it's the same feature; a section on the existing
  page keeps one nav entry and one mental model (portfolio summary above, editable lists below).

## Open questions

- [x] **Opt-in cross-list normalization** — DONE (2026-06-16): `?normalize=list-relative|percentile`
      on `GET /portfolio` + a labeled "Compare" selector on the FE; raw is still the default,
      normalization is explicitly opt-in and labeled as a comparability aid (not absolute).
- [x] **Cross-host portfolio federation** — DONE (2026-06-16) via **ADR 0061** (Option A):
      a per-tenant registry of peer openwop-app origins + an SSRF-guarded, fail-soft merge of
      each peer's `/portfolio`, both ends running this host — so it rides the **non-normative
      host-extension route, no wire change / no RFC**. The genuinely wire-touching variant
      (Option B, a normative cross-vendor prioritization RFC) remains parked.

## Implementation ledger

Shipped 2026-06-16. `listPortfolio` + `PortfolioItem`/`PortfolioListRef` in
`priorityMatrixService.ts`; `GET /priority-matrix/portfolio` (per-org readability filter) in
`routes.ts`; `listPortfolio` surface method; FE Portfolio `<DataTable>` section + client.
Tests in `test/priority-matrix-portfolio.test.ts`. Backend `tsc` + frontend build green.
