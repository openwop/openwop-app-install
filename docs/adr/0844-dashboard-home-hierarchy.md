# ADR 0844 — dashboard home hierarchy

Status: implemented

Builds on ADR 0375 (the editable tile grid) and ADR 0377 (the tile catalog).
Changes the default composition and adds five tiles. The mechanism (registry,
resolution, customize, persistence) is unchanged.

## Context

The signed-in home (`/`, `/dashboard`) rendered seven default tiles of equal
weight: Shortcuts, Active runs, Recent conversations, Approvals inbox,
Notifications, Continue working and My to-dos. Two defects followed from that
shape rather than from any single tile:

1. **No hierarchy.** Nothing said what needed the person. An approval, a
   failed run and an expired connection lived in three places (one of them
   admin-only), each usually empty, and none of them first.
2. **A new workspace saw six empty boxes.** Measured on the live demo
   2026-10-06: every default tile rendered its "nothing yet" state, and the page
   offered no first action beyond three links in Shortcuts.

A design exploration benchmarked the home screens of n8n, Zapier, Vercel,
Stripe, GitHub, Linear and the MyndHyve dashboard this app's tile system was
ported from. The patterns that recur among the strongest: a prompt as the front
door (Zapier, GitHub), one triage lane for what is blocked on you (Linear,
GitHub), run health with a period comparison (n8n, Stripe), a status-first
activity list (Vercel, n8n), and a setup checklist in place of empty widgets
(Stripe, Vercel, Zapier).

## Decision

Re-cut the default launchpad as a hierarchy, every part of it an ordinary tile
in the existing registry:

| Order | Tile | Replaces as a default | Reads |
|---|---|---|---|
| −30 | **Ask** — a composer that stages a draft with the ADR 0334 composer seed and opens `/chat` | Shortcuts (`quick-create`) | none |
| −25 | **Get started** — a checklist ticked from real state | — | chat sessions, runs; + connections, BYOK refs for admins |
| −20 | **Needs you** — approvals, runs waiting for input, runs failed in the last 24 h, connections `expired`/`needs-reconsent`, newest first, the fix on each row | Approvals inbox | approvals, runs, connections |
| −15 | **Run health** — runs, success rate, median duration, runs waiting on people; Today / 7 days / 30 days against the previous equal period | — | runs |
| −10 | **Run activity** — every recent run, status first, filterable to *needs attention* / *running* | Active runs | runs |

Continue working moves up beside Run activity (−8). Recent conversations,
Notifications and To-dos keep their places. The default-on set stays at nine,
the top of the launchpad guardrail. The three displaced tiles stay in the
catalog, opt-in.

### D1 — the Ask tile is not a chat

It never sends. It stages text with the existing `stageComposerDraft` and
navigates to the ONE chat, where the draft appears in the real composer. This
is the CLAUDE.md "reuse, never recreate" rule applied: no second composer, no
second send path, no BYOK gate of its own.

### D2 — run statistics are computed client-side, and say when they are a sample

There is no run-statistics route. Rather than add one now, the tiles share a
single `GET /runs` (one page, 100 rows, deduped by `sharedRead`) and compute
from it (`runsWindow.ts`). That is a sample, so:

- `covered` is false when a full page does not reach back to the window start,
  and the tile then says "Based on your latest 100 runs" instead of the period
  comparison;
- a comparison against the previous period is produced only when that period is
  also fully covered — never a comparison against a partly-seen period, which
  would read as a collapse in volume.

**Alternative rejected for now:** a host-extension `GET …/runs/stats` with
server-side aggregation. It is the right end state for busy tenants (the sample
covers less than a day for them) but it is a new route, a new query against the
run store and new tenancy tests; it can replace `runsWindow.ts` behind the same
tile without a UI change.

### D3 — a source that fails is named, not dropped

Needs you reads three sources. "Nothing needs you" is a claim, so it is shown
only when all three answered; otherwise the tile names what it could not check.
Get started never marks a step done whose read failed.

### D4 — no link a caller cannot follow

`/runs` and `/runs/:id` are admin-tier. Run rows in Needs you and Run activity
render without links for non-admins rather than linking to "Administrator access
required"; Get started omits the two steps that live on the admin-tier Access
page. (The pre-existing Active runs tile linked members to `/runs/:id`; it is no
longer a default.)

### D5 — first-paint reads

Shared reads (`sharedReads.ts`: chat sessions, connections; `runsWindow.ts`:
runs) keep the nine default tiles to about eight requests: runs, approvals,
connections, chat sessions, notifications, to-dos, continue-working, and BYOK
refs for admins. That is far below the 600/min read budget (ADR 0640).

> **CORRECTED 2026-10-07 (issue #4511) — D2, D4 and D5 shipped every member
> the WORKSPACE's runs.** The shared read was `GET /runs`, which is
> workspace-wide and returns full snapshots (inputs, variables, error,
> configurable), and all five tiles were workspace-tier and default-on. So
> every member's browser received other people's run snapshots, and Needs you
> labelled a colleague's failed run "blocked on you". D4 dropped the *links*;
> the *data* still arrived. The fix, by audience:
>
> - **Run health / Run activity are admin-tier**, the tier of the `/runs`
>   pages whose data they summarise. A member's default home is seven tiles.
> - **A new self-scoped read, `GET /host/openwop-app/dashboard/my-runs`**
>   (`features/dashboard/ownRuns.ts`): the caller's OWN runs — the RFC 0165
>   owner principal (`runOwner`) equal to the opaque projection of the
>   session subject, or every run in the caller's own personal workspace —
>   as five-field rows, from a bounded newest-first scan (1000 rows) with a
>   `truncated` flag. Same `runs:read` scope as `GET /runs`, narrower answer.
> - **Needs you** reads it for a member (an admin keeps the workspace view),
>   lists only the member's personal connections, and never links a member to
>   the admin-tier Access page. **Active runs** (opt-in) does the same.
> - **Get started** ticks "Run a workflow" from the viewer's own runs.
> - The home drops its cached run/chat/connection reads on mount, so a run
>   made on another page shows on return rather than after the 30 s TTL.
>
> D2's sample-honesty rules are unchanged; they now apply to the admin tiles.

## Consequences

- Users who never customized get the new layout. Saved layouts are untouched,
  apart from the five new tiles appearing (default-enabled tiles a saved layout
  has no row for), in their default order.
- `DashboardTileDef.refreshable` (optional, default true) lets a data-less tile
  omit the meaningless refresh control.
- `sharedRead` caches for 30 s, so a tile's refresh inside that window re-reads
  the cached runs/connections. This is unchanged from the existing shared-read
  tiles.

## Implementation record

| Piece | Where |
|---|---|
| Shared runs read + pure statistics | `features/dashboard/runsWindow.ts` |
| Named shared reads | `features/dashboard/sharedReads.ts` |
| Tiles | `features/dashboard/tiles/{Ask,GetStarted,NeedsYou,RunHealth,RunActivity}Tile.tsx` |
| Registry + defaults | `features/dashboard/allTiles.ts`; pin in `__tests__/catalog.test.ts` |
| Tests | `__tests__/homeHierarchy.test.ts` (coverage honesty, ranking, filters) |
| #4511 own-runs read + tiers | `backend/typescript/src/features/dashboard/ownRuns.ts`; tests `backend/typescript/test/dashboard-my-runs-route.test.ts`, `__tests__/runTilesScope.test.tsx`, `__tests__/homeActivityInvalidation.test.tsx` |
| Copy | `features/dashboard/i18n/{en,es,fr,pt-BR}.ts` |

## Open questions

- [ ] Server-side run statistics (D2's rejected alternative) once a tenant's
      100-run sample covers less than the 7-day default.
- [ ] Workflow display names in run rows. The runs list carries only
      `workflowId`; showing names needs a join that is not done here.
