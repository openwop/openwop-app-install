# ADR 0697: Workspace membership has no natural key, so removal does not hold

Status: **implemented** (verified 2026-09-17, #3860)

## Context

ADR 0684 §7 auto-joins a participant into the shared default workspace on first
sign-in. Phase 2 of that ADR gated the action on a durable join RECORD rather than
on current membership, and gave a long justification for why: the question "has
this action already run?" is about the past and must not be conflated with "is this
subject a member?", which is about the present. The header of
`host/workspaceJoinLedger.ts` names the reason that ordering is a SAFETY property
rather than tidiness — an operator who removes someone from the one workspace
everybody is in is almost never doing org hygiene. They are acting on abuse, spam,
or a banned account. Under that reading, "a removed user auto-rejoins next morning
with no error" is a control that quietly does not hold.

That reasoning was correct and the ledger honours it. **This ADR is about the same
control failing by a different route — one the ledger cannot see, and which is
reached even when auto-join behaves perfectly.**

### What was measured

A peer session observed two auto-join events for one subject on `host:kicktodo`,
logged 1 ms apart. That double-fire was a read-check-write race in `claimJoin`,
fixed by ADR 0684's follow-up (`joins.putIfAbsent`). The duplicate join *records*
were treated as residue to clean up.

**They are not the residue. The member rows they created are, and those outlive
any fix to the ledger.**

### The chain, at HEAD

1. **`createMember` has no natural key.** `accessControlService.ts:683` mints
   `memberId: mbr-${randomUUID().slice(0, 8)}`. Nothing in the store constrains
   `(tenantId, orgId, subject)` to one row. The only "already a member" guard in
   the repo is a read-check-write inside one route (`features/orgs/routes.ts:205`)
   — the same shape as the race it would need to prevent. Two concurrent
   auto-joins therefore wrote **two member rows for one person**.

2. **The ADR 0684 phase-5 index hides the first row.** `memberIndex` is keyed
   `(tenantId, subject)` (`:421`, `:431`), so the second `createMember`'s entry
   OVERWRITES the first's. Row #1 is invisible to every point read from that
   moment on — including the one the console lists from.

3. **`deleteMember` removes one row and one index key** (`:768`–`:775`). It is
   given a `memberId`, and it deletes exactly that row. The operator removes the
   member they can see.

4. **`isWorkspaceMember` re-grants membership from the orphan.** `:987` falls
   through, deliberately, to the authoritative `members.list()` scan, and row #1
   still matches. **The subject is still a member on the very next request.**

So: the operator removes a banned participant, the console reflects it, the index
reflects it, and the authorization check says they are still in. Nothing logs an
error, because nothing is in an error state — every layer did exactly what it was
written to do.

### CORRECTION, same day, before this ADR was implemented — the RACE is not the live route

The peer session that measured the production double-fire verified this chain
independently and supplied a fact that changes the severity framing, and it has to
sit here rather than be quietly absorbed:

**The duplicate rows actually on `host:kicktodo` are INERT for the ban path.** They
were written before the double-prefix fix, under the subject `user:user:<hash>` —
a shape no read path resolves (`features/users/authRoutes.ts:100` documents this,
and that spelling bug is separately fixed). `isWorkspaceMember` is asked about the
canonical `user:<hash>`, so it never matches those rows. They are orphan garbage
worth cleaning, not a live bypass. **An earlier draft of this ADR implied the
production data was actively re-granting membership to removed users. It is not,
and the difference matters: the first framing would have justified an urgent sweep
of a collection ADR 0684 §6 says must not be scanned.**

**What is live is worse in one specific way: it needs no race at all.**
`POST /v1/host/openwop-app/orgs/:orgId/members` (`routes/accessControl.ts:458`)
calls `createMember` with no check for an existing membership. An operator who adds
a participant who was already auto-joined writes a **second row for the canonical
subject, deterministically**. Not a window, not a concurrency edge — the ordinary
result of an ordinary operator action, and the one operator action most likely to
be taken on someone who is already in the default workspace. The same is true of
the invitation path (`features/orgs/invitationsService.ts:546`); only
`features/orgs/routes.ts:205` guards, and it guards with the read-check-write shape
whose failure is what produced the original duplicates.

So the correct statement of the defect is: **the race was the route that got
noticed, and closing it fixed nothing structural.** Every remaining route is a
plain unguarded write, which is why the decision below is a key rather than a
guard.

### What is NOT the defect

**The index fallback at `:981`–`:986` is correct and must not be "fixed".** Its
comment states the rule plainly: a negative from the index is not authoritative
enough to deny on, because a missed marker would lock a real member out of their
own workspace, and that is the one direction an authorization check must not fail.
Making the fast path authoritative would close this hole by opening a worse one.

**The duplicate row is the defect**, and the mechanism that prevents it was already
known in this same file, thirty lines below the one that fails:

```
// accessControlService.ts:896
//  `(tenantId, subject)`. Concurrent first-access calls compute the SAME id, so
//  they upsert one row instead of minting duplicate owner members (the random
//  `mbr-<uuid>` path would race to two).
```

`personalOwnerMemberId` (`:899`) derives the id as
`mbr-${sha256(`${tenantId}:${subject}`)[0..12]}` for exactly this reason. **The
hazard was understood, the remedy was implemented, and it was applied only to
personal workspaces** — because when it was written, a shared workspace-root
membership was always created by a human action, never by a race. ADR 0684 added a
concurrent writer to that path and did not inherit the remedy. That is the whole
story: not an unknown failure mode, an unextended one.

## Decision

Two changes that fix two different things. Both are needed, and conflating them is
how this closes on paper and stays open in production.

### D1 — A workspace-root membership's id is DERIVED from `(tenantId, subject)`

Generalise `personalOwnerMemberId` into `workspaceRootMemberId(tenantId, subject)`
and use it for **every** membership where `orgId === tenantId` and a subject is
present — which is precisely `indexableWorkspaceMember`'s existing predicate
(`:424`), the same definition `isWorkspaceMember` matches on. A personal workspace
becomes a special case of one rule rather than the only place the rule is applied.

`createMember` then point-reads that id before writing: an existing row is
RETURNED, not twinned. Two concurrent callers compute the same key and converge on
one row. Sub-org memberships (`orgId !== tenantId`) keep `mbr-<uuid>` — they are
not what `isWorkspaceMember` reads and are not on this path.

**This prevents new duplicates. It does nothing about the ones already written.**

### D2 — Removing a workspace-root membership removes the RELATIONSHIP, not a row

`deleteMember` on a workspace-root membership deletes **every** row matching
`(tenantId, orgId, subject)`, not only the `memberId` it was handed.

This is the change that actually closes the ban path, and it is the one that works
on data already in production — no migration, no backfill, no sweep that has to be
run before the fix means anything. It is also the more honest model: an operator
removing someone is acting on a relationship. That the store happens to represent
that relationship as one row is an implementation detail which, today, is
occasionally false.

The bounded read is `members.listForTenantIndexed(workspaceId)` — the per-tenant
slice, not the cross-tenant scan — and it runs on a cold, rare, operator-initiated
path. ADR 0684 §6's prohibition is on unbounded reads on hot paths; this is
neither.

The ≥1-owner compensating restore (`:776`–`:780`) must count and restore against
the full set it deleted, or removing a duplicated owner could strand a workspace.

### Why D2 and not a migration

A backfill that collapses duplicates would be a one-time sweep of a collection
ADR 0684 §6 says must never be scanned, on data whose shape we would be inferring.
D2 makes the duplicates HARMLESS instead of hunting them, and it stays correct for
any duplicate that predates D1 by any route — including ones written by the two
mint sites this ADR does not otherwise touch (`routes/accessControl.ts:469`,
`features/orgs/invitationsService.ts:546`).

Cleanup then becomes optional hygiene rather than a safety obligation, which is the
right order. **Do not clean up the duplicates before D1 ships, or the cleanup
re-runs the race it was cleaning up after.**

## Alternatives considered

| Option | Why not |
|---|---|
| Make the phase-5 index authoritative for denial | Closes this hole by opening a worse one — a missed marker would lock a real member out of their own workspace. `:981` already rejects this. |
| Store-level `putIfAbsent` on `createMember` | Insufficient alone: a random id is absent every time. The key is the problem, not the write primitive. |
| A uniqueness guard in each mint site | Three sites today and no way to fail a fourth. It is also the read-check-write shape whose failure produced this. |
| Migrate/collapse duplicates and stop there | Leaves the mechanism intact, and the sweep must re-run after every race. Fixes the instance, not the class. |
| Do nothing — the console lists both rows, so an operator can delete both | Requires the operator to notice a duplicate they have no reason to expect, and to read the failure of a removal as "there was a second row". The control has to hold without that. |

## Phased plan

| Phase | Work | Gate |
|---|---|---|
| P1 | `workspaceRootMemberId` + `createMember` idempotence (D1) | A test that fires two concurrent `createMember` calls for one subject and asserts ONE row |
| P2 | `deleteMember` removes the relationship (D2) + owner-count correction | A test that plants a legacy duplicate, deletes the visible row, and asserts `isWorkspaceMember` is FALSE |
| P3 | Re-key path (`:1058`) audit — it already special-cases deterministic ids; confirm it covers the newly-deterministic shared rows | Existing re-key tests extended |

**The P2 test is the one that matters**, and it must be written to fail against
today's code first. A test that plants the duplicate through the fixed
`createMember` would find the duplicate unrepresentable and pass vacuously — it has
to write the twin directly to the store, the way the race did.

## Open questions

1. Should `createMember` returning an existing row be silent, or should the
   operator-facing add-member route (`routes/accessControl.ts:469`) surface a 409?
   Auto-join wants silence; a human clicking "add" may deserve to be told.
2. ~~Are there duplicated rows with DIVERGENT roles (one `viewer`, one `admin`)?~~
   **MEASURED on `host:kicktodo` by the peer session holding the instruments, and
   the answer is NO — but it does not close the question, and the reason it does
   not is the interesting part.**

   Three measurements, from provenance rather than from a member list nobody can
   read: auto-join's `createMember` passes no `roles`, so every auto-joined row is
   `['viewer']` by the default at `accessControlService.ts`; `POST`/`DELETE`/
   `PATCH` on `/orgs/host-kicktodo/members` in 24h is **zero**; invitation-accept
   into `host-kicktodo` is **zero**. So every row in that workspace is an
   auto-join `viewer` row, and the only duplicates are the pre-fix
   `user:user:<hash>` twins — **both halves `viewer`, same subject, same role.**

   **D1's winner-choice is therefore a no-op on today's data, which is exactly why
   it must still be decided deliberately rather than left to fall out.** The
   condition that makes it live is an operator manually adding someone who is
   already a member — the ordinary action named as the live route above. A rule
   chosen because "no data currently distinguishes the options" is a rule chosen
   by accident, and it will be load-bearing the first time an operator touches
   this workspace. The decision stands as written: **keep the existing row**, so a
   racing or repeated auto-join can never demote an operator's role edit. The
   asymmetry is deliberate — silently losing a granted role is worse than
   silently ignoring a redundant add.
3. Does the demo seeder (`host/demoPeopleSeed.ts:139`) create workspace-root
   memberships that would change id shape under D1, and does any fixture pin the
   `mbr-<uuid>` form?
4. **FILED, not fixed here: D2 makes the existing twins harmless, it does not
   delete them.** `host:kicktodo` will keep carrying the pre-fix
   `user:user:<hash>` rows indefinitely — invisible to `isWorkspaceMember`,
   visible to `listMembers`. If a console ever renders a workspace member list,
   someone sees ghost entries under a subject that resolves to nobody. Cosmetic,
   not a safety issue, and deliberately out of scope for this PR. It is recorded
   because "D2 handles it" will otherwise read later as "they are gone", which is
   the stale-conclusion shape this repo keeps paying for. The fix, if it is ever
   worth doing, is a bounded per-tenant pass over rows whose subject resolves to
   no user — not a scan for duplicates.
   **Why PERMANENT and not merely deferred** (the peer session's wording, which is
   sharper than my first statement of it): *D2 never fires for a subject nobody
   signs in as.* D2 removes the relationship when someone removes a member — and
   nobody will ever remove `user:user:<hash>`, because nobody can see them as a
   member and nobody signs in as them. These rows are not waiting for a delete
   that will eventually come. They are waiting for one that cannot.

## References

- ADR 0684 §6 (bounded reads), §7 (auto-join gated on the action)
- `backend/typescript/src/host/workspaceJoinLedger.ts` — the ban-path reasoning
- `backend/typescript/src/host/accessControlService.ts:424`, `:683`, `:768`, `:896`, `:987`

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3860**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** D1 `host/accessControlService.ts:449 workspaceRootMemberId` + `createMember:765-770` point-reads the derived id and RETURNS the existing row instead of twinning (`:772` keeps `mbr-<uuid>` for sub-orgs); D2 `deleteMember:879-887` sweeps every same-`(tenantId, orgId, subject)` twin, `:889` `removed`, `:896-900` owner invariant counted over the full removed set with a compensating restore, `:901-906` group `memberIds` pruned by the whole set; P3 re-key audit `:1232`,`:1235` (docblock `:1206-1214`).

**Documented deviation at `:874-879`:** this ADR specified the bounded `members.listForTenantIndexed(workspaceId)`; the code deliberately uses the full `members.list()` so the sweep sees exactly what `isWorkspaceMember`'s authoritative fallback sees — otherwise removal still would not hold.
