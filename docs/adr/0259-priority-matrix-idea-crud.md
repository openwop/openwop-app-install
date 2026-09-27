# ADR 0259 — Priority Matrix: per-idea edit / delete / clone

**Status:** Accepted — implemented (2026-07-04)

## Context

The Priority Matrix (ADR 0058) lets users capture ideas into a list, score them,
move them through statuses, and build a meeting agenda. But once an idea was
created there was **no way to edit its title/description, delete it, or clone it** —
the only idea mutations were create, score, move-status, schedule, intake, merge, and
promote-to-project. A typo in an idea title was permanent; a scrapped idea lingered;
producing a near-duplicate variant meant retyping it. Users asked for the three
missing table-stakes CRUD verbs on the ranked-ideas views (List / Grid / Matrix).

An idea IS a `host.kanban` card on the list's board (ADR 0058, no parallel idea
store). The card primitives already exist (`updateCardFields`, `deleteCard`,
`createCard`); what was missing was the priority-matrix service wrappers, the host
routes, the client functions, and the UI affordance.

## Decision

Add three per-idea operations, each a thin wrapper over the existing kanban
primitives plus the feature's overlay bookkeeping. All three are **`workspace:write`**
scoped — the same tier as create/score/move (ideas are collaborative; a write-scoped
member can already move an idea to *Won't do*), not the elevated config-authority tier
(that gates list configuration + vote breakdowns).

- **Edit** — `PATCH /lists/:listId/ideas/:cardId` → `editIdea()` wraps
  `updateCardFields` for `title`/`description` only (scores, status, schedule, votes,
  intake untouched), then re-indexes the KB doc (ADR 0100) so a retitled idea stays
  searchable. An empty title is rejected (400).
- **Delete** — `DELETE /lists/:listId/ideas/:cardId` → `deleteIdea()` removes the card
  and the overlays this feature owns keyed by `${listId}::${cardId}` (single-mode
  score, per-voter votes, schedule) and drops the KB doc (via `indexIdea`, which
  removes the doc once the card is gone). Idempotent (404 → the client treats it as a
  no-op, the `removeIdeaEvidence` idiom).
- **Clone** — `POST /lists/:listId/ideas/:cardId/clone` → `cloneIdea()` creates a fresh
  card in the `New` column seeded with the source's title (localized `… (copy)` suffix
  supplied by the caller, or a plain `(copy)` fallback) + description. In **single**
  mode the source's scores are copied so the clone lands pre-ranked; in **multi-voter**
  mode per-voter votes are NOT copied (the clone starts unscored, to be re-voted).

UI: a shared `ui/Menu` kebab (⋯) per idea in both the **List** (a trailing actions
column) and **Grid** (in the card header) views, with Edit → a seeded modal
(`EditIdeaModal`, mirrors the add-idea form), Clone → one-click, Delete → `confirm()`.
New `CopyIcon` added to the DS icon set. Strings in all four locales (en/es/fr/pt-BR).

## Alternatives & trade-offs

- **Full satellite cleanup on delete (intake / evidence / score-history rows).**
  Rejected as unnecessary. Those overlays are keyed by `cardId` and are only ever
  read through a still-present card, so once the card is deleted they are **inert
  orphans** — never surfaced, just dead storage. Reaching across module boundaries
  (`intake.ts`, `scoreHistory.ts`) to hard-delete them adds coupling for no
  user-visible benefit. We clean the same-store overlays (score/votes/schedule) that
  are cheap and co-located, and leave the rest as inert.
- **Cross-feature strategy-link cleanup.** A deleted idea may still be referenced by a
  strategy alignment link (`kind:'priority-idea'`, owned by the *strategy* feature).
  ADR 0079's one-directional import rule means priority-matrix cannot import strategy
  to clean these. We rely on the strategy feature's existing graceful handling —
  unreadable/missing refs are already filtered and hidden ("Links you can read are
  shown; unreadable ones are hidden"). The `host.priority.idea.deleted` event is
  emitted, so a future strategy-side listener could reconcile if desired.
- **Clone as a frontend-only re-create (like advisory-board clone).** Rejected: it
  couldn't copy the source's scores server-side, and a clone that silently drops the
  scoring is a worse default for a *scoring* tool. A backend clone endpoint copies the
  single-mode scores in one round trip.
- **A new RFC.** Not needed — these are non-normative host-extension routes under
  `/v1/host/openwop-app/priority-matrix/*`; they never touch the OpenWOP wire.

## Implementation

| Layer | Change |
|---|---|
| Service | `editIdea` / `deleteIdea` / `cloneIdea` in `priorityMatrixService.ts` (import `updateCardFields`/`deleteCard`); each emits `priorityMutated` (`updated`/`deleted`/`cloned`) + re-indexes KB. |
| Routes | `PATCH` + `DELETE` `/lists/:listId/ideas/:cardId`, `POST /…/:cardId/clone` (all `workspace:write`). |
| Client | `updateIdea` / `deleteIdea` (404-tolerant) / `cloneIdea` in `priorityMatrixClient.ts`. |
| UI | `ui/Menu` kebab in List + Grid views, `EditIdeaModal`, `confirm()` delete, `CopyIcon`; i18n ×4. |
| Tests | `test/priority-matrix-idea-crud.test.ts` (5 cases: edit + untouched-siblings, empty-title 400, delete + idempotent 404, clone copies scores, clone title override). |

## Open items

- A strategy-side listener on `host.priority.idea.deleted` to hard-remove dangling
  `priority-idea` links (today they're hidden, not removed). Deferred — cosmetic.
- Bulk delete (multi-select is already wired for "Add to meeting agenda"; a bulk
  delete bulk action could reuse it). Deferred.
