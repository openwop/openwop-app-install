# ADR 0664 — Per-agent knowledge: the grant is real, the disclosure is missing, and deletion is not

Status: implemented (2026-09-12, feature loop it.15 — D1/D2/D3/D4/D6 shipped; D5 signature-only). D1/D2/D4/D5 were substantially corrected and D6 added pre-implementation after `/architect`; see the inline correction notes.
Date: 2026-09-12
Feature: Per-agent knowledge & memory (FEATURES.md ordinal 15 of 71; ADR 0038 profile/memory, ADR 0041 curated notes, ADR 0373 capability, ADR 0587, ADR 0643 the subject gate) · feature loop 2026-09 it.15
Plan input: `/grade-*` recon 2026-09-12, ids `AGKM-1..8` (prefix verified unused; `PAKM` collides inside a base64 font blob)
Related: ADR 0643 R3 (the decision this ADR corrects the *record* of, not the code), ADR 0662 (the previous iteration — the same "a control's consequence is undisclosed" shape)

## Context

### The finding I did NOT write, and why that matters

The recon filed a Blocker: per-agent retrieval passes `caller ?? PREAUTHORIZED_CALLER`
(`host/agentKnowledgeComposition.ts:379`) and `chatContext.ts:246` calls
`resolveAgentKnowledgeRetrieve` with four arguments where the fifth is `caller` — so the
`boundSubject` membership gate is never evaluated on the chat lane, and a private
project corpus reaches any tenant member who can address the agent.

**Every fact in that sentence is true, and "the gate is missing" would still be wrong.**
ADR 0643 D2 (`:195-197`) did require an agent chat turn reading a project-bound collection
they are not a member of to be refused. But the **R3 fold (`:363-373`) deliberately reversed
that for this lane**, with reasoning on the record: `PREAUTHORIZED_CALLER` "remains only on
the use lane after a binding exists", because "the binding is an owner-scoped grant and the
speaker is not the binder". Someone thought about exactly this and decided it.

That is a defensible product position — it is how sharing normally works: attach a document
to a shared agent and the people who use that agent can see it. **The bypass is the feature.**

> **CORRECTED after `/architect`: accurate for the lanes R3 discussed, OVERSTATED as a blanket
> claim.** R3's rule has a second half this ADR's first draft omitted — the fold re-resolves
> the principal *"wherever a principal exists"*. R3 therefore decided **principal-less** lanes;
> it did not decide a lane that HAS a principal and declines to use it. The lane inventory,
> enumerated rather than assumed:
>
> | Lane | Principal available? | R3 decided it? |
> |---|---|---|
> | `chatContext.ts:246` (chat) | no | yes |
> | `bootstrap/nodes.ts:1790`, `agent-knowledge/surface.ts:52` (run) | no | yes |
> | `agent-knowledge/routes.ts:124,148,237,264` (HTTP) | yes — and they DO re-resolve | yes |
> | **`routes/agents.ts:327` (agent dispatch)** | **yes — `req.userId`, used 17 lines later at `:344`** | **NO** |
>
> `POST /agents/:agentId/dispatch` holds a live principal and passes four arguments where the
> fifth is `caller`. By R3's own rule that lane should re-resolve, and it does not. It sits on
> a different router, which is why R3's enumeration missed it — and why sweeping every caller
> of `:379` together, as the first draft did, was wrong. **`AGKM-1` is a real, undecided
> bypass on exactly one lane.** See D6. (`surface.ts:51`'s docblock says "the four HTTP reads
> re-resolve the reader"; there are **five**, and the fifth does not.)

*(This ADR's author nearly shipped the wrong headline, two iterations after doing exactly
that in ADR 0660. The check that caught it was reading the governing document before relying
on a citation of it. Recorded here because the near-miss is the transferable part.)*

### What is actually wrong

1. **`AGKM-7` (Blocker) — the grant is invisible to the person granting it.**
   `frontend/react/src/features/agent-knowledge/i18n/en.ts` contains **zero** strings about
   who will be able to see a bound corpus. A member binds a private project collection to a
   tenant-global agent and is told nothing; from that moment every tenant member who can
   address the agent can retrieve it verbatim. The access decision is intended. **The
   consent is not informed.** Same shape as ADR 0662: not a missing gate, a control whose
   consequence is never shown to the person exercising it.

2. **`AGKM-8`/the record — the stated residual describes one of two consequences.**
   ADR 0643 R3 records the residual as "a binding outlives its binder's project membership"
   — the TEMPORAL case. It does not state the STRUCTURAL one: a person who was **never** a
   member reads it too, from the moment of binding. A maintainer reading that note would not
   learn the second fact.

   **A third consequence, found by `/architect` and also unstated:** the run lane's `agentId`
   is **caller-supplied and un-gated** (`agent-knowledge/surface.ts:52`,
   `bootstrap/nodes.ts:1790`), so any workflow author in the tenant can point
   `feature.agent-knowledge.nodes.retrieve` at **any** roster agent's id and dump its bound
   corpora into a run output they control — including a corpus someone else bound. That is
   materially wider than "the people who use the agent", which is the premise R3's
   justification rests on. Filed as **`AGKM-10`**; at minimum the node should consult
   `agentVisibleToTenant` (`host/agentVisibility.ts:19`).

3. **`AGKM-3` (Blocker) — deleting an agent does not delete its memory, and the name is
   deterministic.** Verified end to end:
   - `host/rosterCascade.ts:114-127` clears the profile, the durable notes
     (`clearSubjectNotes`), the in-memory scope (`clearMemoryScope`) and twin grants —
     and never calls `db.vector.delete`.
   - The sibling lane DOES: `host/subjectMemory.ts:410-418`, commented "Vector recall index
     (best-effort — a failure never blocks the durable erase)".
   - `rosterService.ts:145`: `rosterId = 'host:' + slugify(persona)` — deterministic, and
     the duplicate-persona 409 fires only while the row exists.
   - Recall really returns it: `subjectMemory.ts:138-158` queries `namespace: scope`, maps
     matches to **`md.content`** (the note text), and `if (ranked.length > 0) return ranked;`
     — the vector path WINS over recency.

   ⇒ Delete an agent, re-create it under the same persona name, and its first recall returns
   the **deleted** agent's private notes — taking precedence, because the recency path is now
   empty. Not orphaned storage: a live recall. **Sixth consecutive feature in this loop where
   deletion is complete on one lane and incomplete on its sibling.**

4. **`AGKM-4` (Improvement) — a privacy action silently re-grants the capability.**
   `agentProfileService.ts:407-409` unconditionally unions `knowledge` on every binding
   write, so `setMemoryWritable(…, false)` — and any bind/unbind/toggle — undoes ADR 0373's
   `DELETE …/capabilities/knowledge`. Stated purpose ≠ effect.

## Decision

### D1 — deletion deletes (`AGKM-3`, Blocker)

> **The first draft said "copy the sibling". `/architect` found that unimplementable AND
> insufficient.** `VectorSurface` is `{upsert, query, delete}` with **delete by explicit id**
> (`inMemorySurfaces.ts:162`), stated as a constraint at `vector/vectorTenantPurge.ts:8`:
> "no namespace-clear or tenant-clear at all". The sibling works only because it captures
> `rows` BEFORE deleting them; `rosterCascade.ts:123` runs `clearSubjectNotes` first, which
> returns a **count**, so by then there is no id source. And the sibling is itself incomplete:
> dispatch turn-summaries are written by `persistAndIndex` (`subjectMemory.ts:90-117`) with
> **no durable note row** — and they are exactly what the winning `ranked` path returns.

`deleteRosterMemberCascade` clears the agent's vector namespace through the
**`registerVectorTenantPurger` seam** (`vectorTenantPurge.ts:44`) — the host-internal seam
that exists precisely because a namespace clear must not land on the pack-facing RFC 0018
surface. Id-collecting (capture `listMemoryEntries` ∪ note-prefix ids *before* the clears,
then `vector.delete({namespace, ids})`) is the **in-memory fallback**, and is explicitly NOT
sufficient on its own: it misses TTL-expired rows and, on a pgvector deployment, every row
written by a prior process. Failure is logged and never blocks the durable delete.

The same turn-summary gap exists in the sibling eraser (`subjectMemory.ts:410-416`); it is
filed as **`AGKM-9`** rather than propagated.

**Witness born red on the DISPATCH lane**, which reads memory with no capability gate
(`agentDispatch.ts:633`, scope from `routes/agents.ts:322`): write a note AND a turn summary,
delete the roster member, re-create the same persona, assert recall returns nothing.
*A witness on the chat lane would pass vacuously* — `resolveAgentKnowledgeRetrieve:258`
requires the `knowledge` capability and `deleteAgentProfile` removed the profile, so it fails
closed regardless of whether D1 shipped.

**Stated explicitly:** this closes the *re-creation* path. Rows written before this ships are
not retro-cleaned by it; whether a sweep is warranted is recorded as an open question rather
than assumed either way.

### D2 — the bind door discloses who will see it (`AGKM-7`, Blocker)

> **Measured first, after `/architect`: the SPA has no bind-existing-collection control.**
> `bindCollection` (`agentKnowledgeClient.ts:72`) has **zero importers**;
> `AgentKnowledgePanel.tsx:27` imports only `unbindCollection`. The first draft would have
> shipped four locales of copy at a door that does not exist, and left the real one
> undisclosed — the very ADR 0662 shape it names.

The disclosure lands where the grant actually happens: **(i)** the create-collection door
(`agentKnowledgeClient.ts:68`, the SPA's real grant door — "documents added here are
retrievable by anyone who can address {{persona}}"); **(ii)** the bound-collection card, where
a `boundSubject` corpus gets the specific widened-audience line; **(iii)** the
`POST …/bindings` API response contract, today the only way a subject-bound corpus can be
bound at all. Also `notesHint` (`i18n/en.ts:57`), which says "Private to this agent" — a claim
`AGKM-3` makes false across a delete/re-create. ×4 locales. A bind-existing control added
later inherits (i)'s string.

This is a disclosure, **not** a new gate: the access decision stays exactly as ADR 0643 R3
decided it. If a future decision wants the gate back, that is an ADR, not a string change.

### D6 — the one lane R3 did not decide (`AGKM-1`, Blocker)

`routes/agents.ts:327` threads `{ subject: req.userId }` as `caller`, matching the four
`agent-knowledge/routes.ts` sites. This is **not** a reversal of R3: R3's rule is "re-resolve
wherever a principal exists", and this lane has one. `surface.ts:51`'s "four HTTP reads" is
corrected to five in the same change.

Witness born red: `POST /agents/:id/dispatch {live:true}` as a non-member of a `boundSubject`
collection returns zero chunks, with a member positive control.

### D3 — correct ADR 0643's recorded residual (`AGKM-8`)

Per this repo's "correct, don't rewrite" rule, ADR 0643 gains an inline correction note at
R3 stating all three consequences: the temporal one it already records, the structural one it
does not (a never-member reads the corpus from the moment of binding), and `AGKM-10`'s
caller-supplied `agentId`. The reasoning trail stays; only the understated residual is
completed. **Checked: safe** — no test or script reads ADR bodies or counts correction notes
(`check-adr-refs.mjs` parses filenames + `Status:` only), and 0643 is `Status: implemented`.

### D4 — a privacy action stops re-granting (`AGKM-4`)

> **The first draft's "only on binding creation" rule breaks two legitimate grants**, and its
> premise was understated. `agent-knowledge/service.ts:160` is a **durable write on a GET**
> (the dangling-binding prune inside `getAgentKnowledge`) — so today merely **opening the
> knowledge panel** re-grants a revoked capability.

`setAgentKnowledge` gains an explicit `{ activateCapability: boolean }` argument — a decision
at the **call site**, never inferred from the patch shape. `true` at `service.ts:300` (bind),
at the `!existing` mint branch (`agentProfileService.ts:398-403` — a first bind on a
profile-less agent must still grant), and at `kicktodo-core/kickbotService.ts:323` (a seed is
a grant even when KB is unavailable and its patch carries no `collectionIds`; under a
shape-inferred rule KickBot's memory recall would go dead silently). `false` at
`service.ts:311` (unbind), `:411` (`setMemoryWritable`) and `:160` (the self-heal prune).

Witnesses: revoke → `setMemoryWritable(false)` → still revoked; revoke → `GET …/knowledge` →
still revoked; revoke → unbind → still revoked; **and** KickBot seeded with KB unavailable →
capability present.

### D5 — the option exists (`AGKM-1`, hygiene, NOT a behaviour change)

`composeKnowledgeForSubject(tenantId, subject, query, opts?)` has **no caller parameter at
all**, so its lanes could not honour a principal even where one exists. It gains an optional
`caller`, and **no call site threads it in this ADR**.

> The first draft said "threaded where a principal is available" AND "default behaviour is
> unchanged". `/architect`: those contradict. `agentTools.ts:220` HAS `scope.actingUserId`,
> and passing it routes through `filterReadable` (`kbService.ts:986`) → `subjectReadAllowed`
> (`subjectAccess.ts:133`), which drops every bound collection the tool caller is not a member
> of — a notebook binding naming another subject's collection would silently go empty. That is
> a behaviour change, not hygiene.

P4 ships the signature plus a test pinning that **every existing call site still omits it**,
so the option exists without deciding the question.

### `/architect` review record (2026-09-12, before code)

Four Blockers, three SHOULDs — the **sixth consecutive iteration** where the Blockers lived in
the decision text rather than the diff. The review was explicitly asked to test whether this
ADR had talked itself OUT of a real defect, and **it had**:

1. **B1 — I over-swept.** "The bypass is deliberate" is accurate for the chat and run lanes and
   wrong as a blanket claim. R3's rule re-resolves *"wherever a principal exists"*, and
   `routes/agents.ts:327` holds `req.userId` (used 17 lines later) and passes no `caller`. One
   lane really is an undecided bypass → D6. Avoiding ADR 0660's error in one direction is not
   the same as getting it right.
2. **B2 — D1 was unimplementable.** `VectorSurface` has no namespace delete, only delete-by-id,
   and the ids are gone by the time the cascade would use them. Worse, the sibling I proposed
   copying is itself incomplete (turn summaries carry no durable note row). The seam that
   exists for exactly this is `registerVectorTenantPurger`.
3. **B3 — D2 targeted a door that does not exist.** `bindCollection` has zero importers in the
   SPA; the real grant door is `createCollection`. I would have shipped four locales of copy
   where nobody binds and left the actual grant undisclosed.
4. **B4 — D4 would have broken two legitimate grants** (the KickBot seed with KB unavailable,
   and the first bind on a profile-less agent), and understated its own premise: a durable
   write on a GET means merely *opening the panel* re-grants a revoked capability.

Plus: my `AGKM-3` witness would have passed **vacuously** on the chat lane (the capability gate
fails closed on the deleted profile) — it has to run on the dispatch lane; D5's two claims
contradicted each other; and the run lane's `agentId` is caller-supplied and un-gated, wider
than R3's premise (`AGKM-10`).

**What survived:** the headline check itself, the deletion-asymmetry finding, and the refusal
to convert a disclosure gap into a gate change.

## Alternatives weighed

- **Restore the gate on the chat lane.** Rejected: it reverses a lane R3 decided and reopens
  a reconciliation R3 deferred as a follow-on ("follow-on rather than half-built" — weaker
  than "closed", and the ADR says so rather than overclaiming), and it would break the
  feature's stated purpose (bind a corpus so the
  agent can use it *for the people who use the agent*). If it is to be reversed, that is its
  own ADR with its own argument, not a side effect of a consent fix.
- **Block binding a `boundSubject` collection to a tenant-global agent.** Rejected as
  paternalistic and probably wrong: the binder may well intend exactly that. Disclose, don't
  forbid.
- **Retro-sweep orphaned vector namespaces in D1.** Deferred to an open question — a sweep
  over every tenant's vector store is its own blast radius and wants measurement first.

## Open questions

1. D1: is a one-off sweep of already-orphaned namespaces warranted, or is closing the
   re-creation path sufficient? (Leaning: measure how many exist before deciding — an
   unmeasured sweep over vector stores is the kind of change that wants its own gate run.)
2. D2: does the same disclosure belong on the *agent* side (a reader seeing which corpora an
   agent carries), or only at the bind door?
3. `AGKM-5`: nothing verifies that a model-emitted citation corresponds to a retrieved chunk
   (`agentKnowledgeComposition.ts:104` is prompt text; `grep verifyCitation` → zero) while
   FEATURES.md:183 says "cited". Real, and larger than this ADR — recorded, not built here.

## Phased plan

| Phase | Scope | Closes |
|---|---|---|
| P1 | D6 — the one undecided lane | `AGKM-1` |
| P2 | D1 (the purger seam) + the dispatch-lane witness | `AGKM-3` |
| P3 | D4 (`activateCapability` at each call site) | `AGKM-4` |
| P4 | D2 (×4 locales, on the doors that exist) + D3 | `AGKM-7`, `AGKM-8` |
| P5 | D5 (signature only, pinned) | `AGKM-1` hygiene half |
| — | recorded, not built | `AGKM-2`, `-5`, `-6`, `-9` (the sibling's turn-summary gap), `-10` (caller-supplied `agentId`), **`-11`** (below), prior `WF-AKM-*` |

### `AGKM-11` — found by the census, during implementation, not by any grader

Adding D1's purge made `deleteRosterMemberCascade` **derivable** by the ADR 0657 D8
destructive-lane census for the first time — it had called no enumerated primitive before —
and the census immediately refused to let it pass without a row. Measured: **neither the
cascade nor its route (`routes/roster.ts:281-289`) reads the retention hold.** Deleting one
agent under a legal hold already destroyed its board, schedules, approvals, profile and
notes; D1 adds the vector namespace to that list without widening the gap in kind.

Recorded as a GAP rather than given a justification it does not have, and **not fixed
inside a deletion-completeness change**: a hold gate here is its own decision with its own
callers — three seeders call this cascade, and whether a hold should block demo cleanup is a
separate question. The census's unpinned ceiling was raised 2 → 4 **deliberately**, with both
rows named and this filing cited; the next change should close `AGKM-11` and lower it to 2.

*(The transferable part: a lane that deletes five kinds of durable state had been invisible
to a census built specifically to enumerate such lanes, because it happened to call no
primitive the census recognised. It became visible only as a side effect of an unrelated
fix.)*

**Two ceilings were loosened for this one gap, and that is worth saying plainly.** The census's
own `MAX_UNPINNED` went 2 → 4, and the `defect-pin-vocabulary` ratchet's `PIN_CEILING` went
4 → 5 — the latter because the census row literally says "not fixed", which that gate matches
and was right to match. The tempting move was to reword until it passed; that is policing a
spelling rather than the invariant, and it is how a ratchet stops meaning anything. Two
independent guards both flagged the same missing hold gate: that is the system working, not
redundancy to tune away. **Closing `AGKM-11` lowers both, and nothing else should be added
under either until it is.**

## Implementation record (2026-09-12)

| Decision | Landed in | Witness (sabotage-proven) |
|---|---|---|
| D6 the undecided lane | `routes/agents.ts` (threads `{subject: req.userId}`), `agent-knowledge/surface.ts` docblock | `kb-subject-gate-doors.test.ts` — TWO legs, because neither covers the other: the behavioural leg reddens only on a MECHANISM regression, the structural leg only on a CALL-SITE one. Both sabotaged separately |
| D1 vector namespace purge | `host/vector/vectorTenantPurge.ts` (new namespace seam + both adapters), `host/rosterCascade.ts` | `roster-lifecycle.test.ts` — on the DISPATCH lane deliberately; the chat lane would pass whether or not the fix shipped (capability gate fails closed on the deleted profile). Sabotage reproduces the leak verbatim |
| D4 `activateCapability` at the call site | `host/agentProfileService.ts`, `agent-knowledge/service.ts` ×4, `kickbotService.ts` | `agent-knowledge-capability-regrant.test.ts` — 6 legs incl. a non-vacuity leg and TWO positive controls, so the fix cannot become a blanket refusal |
| D2 the audience disclosure | `AgentKnowledgePanel.tsx`, i18n ×4 | `audienceDisclosure.test.tsx` — 5 legs incl. key parity and an assertion that `notesHint` no longer claims privacy it does not have |
| D3 ADR 0643's residual | `docs/adr/0643-*.md` correction note | n/a (record) |
| D5 | `composeKnowledgeForSubject` gains an optional `caller`; **no call site threads it** | deliberately behaviour-preserving |

**Gate:** EXIT=0 on a quiet machine — backend 1956 files / 15476 tests, 506 files, 757
frontend files, e2e green. An earlier run failed on a single e2e navigation timeout under load
13–19; the gate's own preflight says a red from a busy machine is not evidence, and a
standalone re-run could not disposition it (those tests need the backend the gate boots), so
it was re-run quiet rather than reasoned away.
