# ADR 0716 — The ranking door asks a different question about board ownership than every other door

Status: **implemented** (the fix ships in the same PR as this decision)

**Feature:** Ranked work selection (`FEATURES.md` ordinal 213) · ADR 0308/0610 · feature-loop 2026-09 it.45

## Context — and what this ADR is NOT

**There is no live leak here, and this iteration found no Blocker.** That is the honest
result of the pass and it is recorded first so no reader infers otherwise from the fact
that an ADR exists.

`readBoardRanking` (`features/work-selection/agentTools.ts:49`) is the ONE shared
predicate behind the HTTP route, the workflow surface op and the agent tool. Its
membership gate keys on the board's owner:

```ts
if (board.ownerSubject) {
  const level = await resolveSubjectAccess(tenantId, board.ownerSubject, caller);
  if (level !== null && !levelSatisfies(level, 'read')) return [];
}
```

Every other board door asks the question differently. `routes/kanban.ts:109` uses
`boardSubject(board)` — which ADR 0045 introduced precisely as *"the bridge from the legacy
`rosterId`/`ownerUserId` storage fields"*, mapping `rosterId → {kind:'agent'}` and
`ownerUserId → {kind:'user'}` when no explicit `ownerSubject` is stored
(`host/kanbanService.ts:166-171`).

So the ranking door sees `undefined` for a board whose ownership is recorded in a legacy
field, and skips its gate before the resolver is ever consulted.

### Why that is not a leak today — measured, not assumed

Two independent facts, both verified at this commit:

1. **Only two resolvers exist** — `'project'` (`features/projects/feature.ts:47`) and
   `'board'` (`features/advisory-board/feature.ts:45`). There is **no `'user'` or
   `'agent'` resolver**, so even the canonical derivation would return `null` for exactly
   the boards the raw field misses.
2. **`null` means the same thing at the main door, deliberately.** `authorizeBoard`'s
   null branch is `if (board.tenantId === tenantOf(req)) return board` — the documented
   legacy rule that *"agent + personal boards keep their tenant/owner visibility"*
   (`routes/kanban.ts:143-144`). Tenant-wide read of a personal board is the INTENDED
   behaviour, not an oversight.

A `kind:'project'` board is unaffected in either direction: `boardSubject` never derives
`'project'` from a legacy field, so such a board always carries an explicit
`ownerSubject` and both doors already agree on it.

**⇒ The two doors produce identical answers today.** The divergence is in the QUESTION,
not yet in the ANSWER.

### Why it is still worth closing

The moment a `'user'` or `'agent'` resolver is registered — which is the natural way to
make personal boards actually private — the two doors diverge silently: kanban would
refuse a non-owner and the ranking door would keep returning the board's To Do cards,
titles included. The feature ships its rows to an agent tool, so the divergence would land
in a model's context.

This is the shape this repo keeps paying for: a gate that is correct at one door and
absent at its sibling, discovered only after the enabling change lands somewhere else.
Closing it now costs one expression and makes the guarantee independent of resolver
registration order.

## Decision

### D1 — The ranking door derives the owner the same way every other door does

`readBoardRanking` calls `boardSubject(board)` instead of reading `board.ownerSubject`.
One canonical owner query, so "who owns this board" has exactly one answer across the
route, the surface op, the agent tool and kanban itself.

The `null` semantics are deliberately left alone: `null` still means "not
membership-scoped ⇒ the tenant gate stands", matching `authorizeBoard`. **This ADR does
not change who can read anything today** — it changes only which field the question is
asked of.

### D2 — A witness that fails without D1

A behavioural test registers a `'user'` resolver for the duration of the test and asserts
that a legacy `ownerUserId`-owned board refuses a non-owner. Before D1 the ranking door
returns the board's cards (the raw field is `undefined`, gate skipped); after D1 it
returns `[]`, matching kanban.

This is the only way to make the fix non-vacuous: with no `'user'` resolver registered the
change is behaviourally invisible, so a test that does not supply one would pass either
way and pin nothing.

## Tracker corrections (verified at this commit, not carried)

- **`WSC-1` is genuinely CLOSED.** `readBoardRanking` takes a caller and consults the
  `subjectAccess` seam, reporting EMPTY on refusal with no existence leak; all three
  callers thread a real acting subject. (My first check grepped the literal
  `callerSubject` and found nothing — the parameter is named `caller`. The row is honest;
  my instrument was wrong, the same class of error as grepping for a field that has a
  default.)
- **`WSU-1` is STALE-OPEN — already implemented.** The panel holds the space with
  `SkeletonRows` while the first read is in flight (`AgentUpNextPanel.tsx`, marked
  `UPN-1`), and it distinguishes *disabled* (renders nothing) from *failed* (a quiet
  warning notice, `UPN-2`). Both landed after the 2026-08-27 pass. Row ticked.
- **`WSU-2`** remains genuinely open — it is a live theme/breakpoint check that static
  analysis cannot perform.

## Not in scope

- **Making personal boards private** (registering a `'user'` resolver). That is a product
  decision about ADR 0025 semantics with a real blast radius across every board surface,
  not a consistency fix. D1/D2 make it SAFE to take later; they do not take it.
- The `null`-means-legacy convention itself. It is documented, consistent across doors,
  and load-bearing for agent/personal boards.
