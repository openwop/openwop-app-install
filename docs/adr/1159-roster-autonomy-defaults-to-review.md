# ADR 1159 — Roster autonomy defaults to review

Status: Accepted (2026-11-24). Implemented in the PR that carries this ADR.

Host-extension only: `roster.autonomyLevel` is never on the normative roster
response (RFC 0086), so no OpenWOP wire change and no RFC.

## Context

"Agents propose, humans dispose" is the app's stated doctrine, and the approval
inbox (`host/approvalService.ts`) exists to enforce it. The roster level that
drives it defaulted the other way:

- `autonomyOf()` (`host/rosterService.ts`) returned `auto` for any entry with no
  `autonomyLevel`, and `createRosterEntry` / `applyRosterPatch` stored `auto` as
  absent.
- The heartbeat passes `autonomyOf(entry)` into `resolveAgentPolicy` as
  `level`, so the resolver's own fail-closed `?? 'review'` fallback never applied,
  and an agent with no profile was returned `auto` and claimed and started its
  pick with no human gate.
- The hire modal and create wizard both defaulted to `auto` and omitted the field
  when it was `auto`.

The seeded example agents are all `review` or `guided`, so only agents created
by hand or by API were exposed. Found by the 2026-11-24 vision-versus-build audit.

## Decision

1. **Absent reads as `review`.** `autonomyOf()` returns `auto` only for an
   explicit `auto`.
2. **Every write stores the level.** `createRosterEntry` stores
   `input.autonomyLevel ?? 'review'`; a patch stores whatever level it carries,
   `auto` included.
3. **The UI defaults to review.** The hire modal and create wizard start on
   review and always send the level; roster views read absent as review.
4. **Existing agents do not change (user decision, 2026-11-24).** Before this,
   an absent level could mean "chose auto" or "never chose", and the two cannot
   be told apart. App-migration 27 stamps an explicit `auto` on every absent row,
   so every live agent keeps its current behaviour and only new agents default to
   review.

## Alternatives weighed

- **Flip existing absent rows to review.** Safest, but it silently changes live
  behaviour for agents someone set to auto on purpose. Rejected by the user.
- **Only change the UI default.** Leaves API, agent-author and import callers
  ungated. Rejected.

## Rollback

Safe without a reverse migration. Older code reads an explicit `auto` as auto
and an explicit `review` or `guided` as itself; it would re-normalize `auto` to
absent on its next write, which it reads as auto.

## Open questions

- Should `guided` rather than `review` be the default for agents created from a
  role template? Not decided here.
