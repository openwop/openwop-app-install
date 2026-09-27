# ADR 0666 — Personal memory: make the consent grant readable, and make erasure reach the recall index

Status: **implemented** (verified 2026-09-17, #3777)
Date: 2026-09-12
Feature: Personal Knowledge & Memory (digital twin) — FEATURES.md ordinal 17 of 71 (`FEATURES.md:185`); extends ADR 0041 (subject memory), ADR 0042 (human knowledge binding), ADR 0120 (chat memory auto-extraction), ADR 0044/0589 (twin borrowed recall). Feature loop 2026-09 it.17.
Plan input: `/grade-workflows` 2026-09-12 (`docs/steward/WORKFLOWS-ASSESSMENT.md`, committed `6a212566a`), ids `PKWF-1..13` + `PKWF-T1..T3` + `PKWF-D1`
Mode: **EXTEND** — no new feature-package, no new toggle. `profile-memory` is always-on (`features/profile-memory/feature.ts`); `twin-recall` keeps its existing toggle id.
RFC verdict: **host-extension — NO new RFC.** Nothing here touches the OpenWOP wire: no run-event field, no capability flag, no `ConversationTurn` field, no endpoint contract, no normative MUST. All routes stay under `/v1/host/openwop-app/*`. D4 reads `isSideEffectingNode`, which is host replay classification, not a wire claim. **Explicitly flagged as considered and rejected:** a per-grant version stamp on a run would be RFC 0005-adjacent and is forbidden for a different reason (D6/`PKWF-6`).

## Context

### `PKWF-1` — the auto-extraction consent grant is written at one key and read at another (Blocker)

ADR 0120's lane writes a person's chat-derived facts into their own memory, gated on an explicit
grant. The two sides do not agree on the key.

**WRITE** (`features/memory-auto-extract/routes.ts:40`):
```ts
const g = await setExtractionGrant(tenantOf(req), subject, true, subject);
```
where `subject = callerSubject(req)` (`:23-27`), and `callerSubject` is
`req.userId ?? req.principal?.principalId` (`host/requestSubject.ts:17-19`).

**READ** (`features/memory-auto-extract/extractionBinding.ts:38-40`):
```ts
const subjectRef = `user:${userId}`;
return runMemoryExtraction(tenantId, subjectRef, conversationText, {
  isGranted: (t, s) => isExtractionGranted(t, s),
```
where `userId` is `run.metadata.actingUserId` (`host/exchange/persistExchange.ts:109`, `:117`),
and `routes/runs.ts:495` stamps that field with the **identical expression** the write uses:
```ts
const actingUserId = req.userId ?? principal.principalId;
```

`User.userId` is itself `user:<sha256>` (`features/users/usersService.ts:216-218`). So the write
files the grant at `${tenant}:user:<hash>` and the read looks for
`${tenant}:user:user:<hash>`. `getExtractionGrant` is an **exact point-get**
(`features/memory-auto-extract/grantService.ts:34-35`) with no key-form normalisation, so the
lookup cannot recover. **The lane has never written in production.** It is fail-CLOSED
(`grantService.ts:38-43`), so nothing leaks; the cost is an inert feature and a consent control
that does nothing.

Two facts make this a Blocker rather than a typo:

1. **The same key-form class was already fixed on the other path in this same file.** The
   eraser matches the **over-set** of both forms via `subjectKeyForms`
   (`grantService.ts:77-85`) — that was `AGMEM-4`. And `eraseSubjectMemory` carries a 12-line
   comment about exactly this double-prefix, ending "**PERSONAL MEMORY WAS NEVER ERASED BY A
   DSAR**" (`host/subjectMemory.ts:393-402`, the `GEN-TWIN-4` fix). So the mismatch was found,
   understood and written up — on the erase path. The read path was never revisited. **Ninth
   consecutive iteration of "fixed on one lane, open on its sibling", and the first where both
   lanes are in the same file.**
2. **The witness pins a fixture, not the contract.** `test/memory-extraction-binding.test.ts:40-41`
   sets the grant at `'user:alice'` and calls the binding with `userId = 'alice'` — a **bare**
   id. Inside the function that composes to `'user:alice'`, which matches, so the suite is green.
   No production caller can produce a bare id: every one passes a `User.userId`.

### `PKWF-2` — erasure does not reach the vector recall index (Blocker)

`eraseSubjectMemory` (`host/subjectMemory.ts:391-425`) deletes, per key form: the durable notes
(`:408-410`), the in-memory recall working set (`:412`), and the vector rows **by id**:
```ts
const ids = rows.map((r) => r.id);
if (ids.length) await buildHostSurfaceBundle({ tenantId }).db.vector.delete({ namespace: scope, ids });
```
(`:415-416`). The ids come only from the durable note rows. Dispatch turn-summaries are written
by `persistAndIndex` with **no durable note row** (`:90-118`), so none of their vector ids are in
that set — and note the `if (ids.length)` guard: a person who has only turn summaries and no
curated notes gets **no vector deletion at all**. The vector path **wins over recency** in `read`
(`:139-163`), returning `metadata.content` verbatim.

This is not a new discovery. ADR 0664 D1 fixed the identical gap for agents, and its own
implementation comment names this eraser as the incomplete shape it could not reuse
(`host/rosterCascade.ts:134-137`, citing `subjectMemory.ts:410-416`), filing the sibling as
`AGKM-9` rather than propagating (`docs/adr/0664-…:122-123`).

**What is new is the reachability, which is the argument ADR 0664 relied on for agents.** For
agents it was `rosterId = host:${slugify(persona)}`. For people:
- `userIdFor` is `sha256(tenantId:principalId)` (`usersService.ts:216-218`), re-derived by
  `createUser` (`:249`) — equally deterministic;
- the re-creation guard is a **no-op where it matters**: `tombstoneCanonicalPointer` returns
  `false` unless the tenant is a personal `user:`-prefixed one (`usersService.ts:552-553`), i.e.
  there is no tombstone in exactly the SCIM/SSO deployments that re-provision the same
  `principalId`.

So a re-provisioned person inherits the erased person's namespace, and their first RAG-backed
recall can serve the erased content.

### `PKWF-3` — a faulted authorization read presents as "not granted"

`features/twin/borrowedRecall.ts:128-132`:
```ts
let on = false;
try {
  on = (await resolveOne(TOGGLE_ID, { tenantId, … }))?.enabled ?? false;
} catch { on = false; }
if (!on) return closed('toggle-off', tenantId, agentId);
```
It is fail-closed on **content**, which the comment at `:124` intends. The defect is narrower: it
collapses "the feature is off" and "I could not tell" into one silent closure, and the closure
reason is log-only — it never crosses the seam, so no lane can distinguish them. The rule this
breaks is written in the sentinel ~90 lines away that exists to enforce it
(`host/agentRunnerNode.ts:221-223`): *"a faulted authorization read must never present as 'not
granted' (the empty-as-success family)."*

### `PKWF-4` — the replay property is real, load-bearing, and unpinned

Re-derived at this commit rather than carried: `local.openwop-app.agent-runner`
(`host/agentRunnerNode.ts:50`) is absent from `MANIFEST_FAST_PATH_SERVED` and
`MANIFEST_SIDE_EFFECT_FLOOR`, carries no `sideEffecting` flag, matches none of the
`SIDE_EFFECTING_TYPE_PATTERNS`, and is absent from `SERVED-SET-BASELINE.json` — so
`isSideEffectingNode` is false (`executor/sideEffects.ts:256-263`), `replayServed` stays null
(`executor/executor.ts:983`) and the node re-executes on `:fork`, re-reading consent live. That
is *why* revocation survives a fork, and `agentRunnerNode.ts:189-192` says so in prose: *"Do NOT
classify this node side-effecting."*

**The sibling lane pins its equivalent judgement and this one does not.**
`test/assistant-node-replay-classification.test.ts:81-100` asserts
`expect(isSideEffectingNode(typeId, null)).toBe(false)` over seven deliberately-unclassified
nodes, with the comment *"Asserted so the judgement is a pinned fact rather than a gap."* Here
the only anti-regression is indirect (classifying the node would turn `twin-fork-revoke.test.ts`
leg 2 red).

### `PKWF-5` — three lanes, three behaviours on a consent-store fault

The run lane catches and degrades with a fault sentinel that fires `onSourceError`, so the model
is told the corpus could not be read (`host/agentRunnerNode.ts:210-229`). The chat lane catches
and degrades (`host/chatContext.ts:304-308`). The **ad-hoc dispatch route has no dedicated
catch** — the await sits inside the route-wide `try` (`routes/agents.ts:341-362`, `catch` at
`:424`), so a transient consent-store read failure returns a 500 instead of an answer.

## Decision

### D1 — fix the READ, verbatim, and do NOT adopt the over-set (`PKWF-1`)

`extractionBinding.ts` passes the subject **exactly as the write filed it** — the caller's
subject, unprefixed by this function. The write side is canonical for three reasons, and the
third is decisive:

1. `MemoryExtractionGrant.subject` is documented as "`user:<id>` / `agent:<id>`"
   (`grantService.ts:16-17`), and `User.userId` **already is** `user:<hash>` — so the write
   already satisfies the declared convention and the read is the side that violates it by
   re-prefixing.
2. `callerSubject` is the same helper the rest of the host uses for a durable subject, and
   `actingUserId` is stamped from the identical expression — so passing it verbatim makes the two
   sides share one derivation instead of two.
3. **There may be real grant rows in production.** Anyone who has toggled the control has a row
   at `${tenant}:user:<hash>`. Fixing the read makes those rows effective; fixing the write would
   strand them and require a migration. The people who set them asked for exactly this.

**The over-set is REFUSED on this path — but NOT for the reason the first draft gave.**

> **CORRECTED after `/architect` — my stated principle was falsified by this repo's own code.**
> The first draft asserted "an over-set is safe on a destructive read and **unsafe on an
> authorizing read**". `host/emailApprovalDelivery.ts:155-156` does exactly what that forbids:
> it matches `subjectKeyForms(input.recipientUserId)` against tenant members to decide
> `tokenAllowed` — whether to embed an approval capability token in an email. That is an ALLOW
> read over the over-set, deliberately, and it is safe. So the ADR would have asserted a rule the
> codebase violates — the mirror image of ADR 0665's worst error (there I cited a real rule and
> carved an exception it forbids; here I invented a rule the code contradicts).
>
> **The true principle is narrower:** an over-set is safe wherever the extra forms cannot be an id
> that some OTHER principal legitimately holds. `emailApprovalDelivery` relies on that
> disjointness implicitly. It holds here too, so an over-set read would not actually be
> exploitable today.

The over-set is declined on **single-source-of-truth** grounds instead, which needs no trust
argument: the defect is one line building a subject string by hand. Normalising the read would
paper over the disagreement and leave the two sides still holding different conventions, and it
would make this read **tolerant of a bug class we want it to stay intolerant of** — the next
caller to hand-build a subject would silently work on one path and not another. One derivation,
shared, is the fix; form-tolerance is a second mechanism that hides the need for it.

**`addNote` is NOT changed.** Verified rather than assumed: the sink passes
`personSubject(userId)` (`extractionBinding.ts:42`), which yields scope `user:user:<hash>` — and
that is **identical** to how the person's own route writes, `selfSubject(user.userId)` with
`{kind:'user', id: user.userId}` (`features/profile-memory/routes.ts:33`, `:52`). The two
conventions differ legitimately: the grant store is keyed by a **subject string** (already
prefixed), the memory store by a **scope** the `kind` prefixes. A fix that "consistently"
stripped or added a prefix in both places would break the note write, which is correct today.

**Consent decision, stated rather than assumed.** Making the read work means a grant that has so
far done nothing begins writing memory. That is what the grantor asked for, and the control is
explicit and revocable — so this ADR takes the behaviour change rather than requiring re-consent.
Recorded as an open question (below) because it is a judgement about people, not code.

**Witness.** Born red, driving `maybeExtractMemoryOnClose` with a REAL `User.userId`. The existing
bare-id test is KEPT and RENAMED to say it is a unit-level case over a bare subject, plus a
comment that no production caller produces that shape — deleting it would lose the only coverage
of the extractor itself, and silently "correcting" its fixture would erase the evidence of how
the defect hid.

### D2 — the purge goes INSIDE `eraseSubjectMemory` (`PKWF-2`)

Reuse `purgeNamespaceVectors` (`host/vector/vectorTenantPurge.ts:118`) — ADR 0664 D1's seam, not
a second one — called per resolved scope inside `eraseSubjectMemory`, replacing the id-collecting
`vector.delete` at `:415-416`.

**Inside the eraser, not at the doors**, because the eraser is the one thing every DSAR door
already routes through (the registry fan-out at `host/subjectErasure.ts`, reached from both
`features/users/routes.ts` and `features/consent/consentService.ts`). Putting it at the doors
would need it added twice and would be missed by the third door someone adds later. Blast radius:
every `user:`-scope erasure now drops the whole namespace rather than the ids it could enumerate —
which is the intent, and is strictly more complete than today.

**The legal-hold asymmetry is preserved, not copied.** The agent cascade asserts no hold
(`AGKM-11`); this lane's hold is asserted upstream in the seam and again at the users door, so
importing the purge must not import the gap. D2 adds no new destructive entry point — it widens
an existing one that is already behind the hold.

**The invariant D2's safety depends on, stated because a namespace purge is unbounded where
the id-delete was bounded.** `eraseSubjectMemory` resolves MULTIPLE scopes: `subjectKeyForms`
returns `{subjectKey, raw, scope}` and each is re-prefixed by `personSubject`
(`host/subjectMemory.ts:403-404`), so erasing `user:<hash>` purges the namespaces
`user:user:<hash>` (the real stored scope) **and** `user:<hash>`. That is safe only because **no
real subject's memory scope equals `user:<the raw form of another subject's key>`**: every
`User.userId` is `user:<32 hex>` (`features/users/usersService.ts:216-218`), every agent scope is
`agent:*` and is unreachable here because `personSubject` forces `kind:'user'`, and KB vector
namespaces are `${orgId}/${collectionId}` or a bare UUID (`features/kb/kbService.ts:323-327`) —
none of which can collide. If that ever stops holding, D2 becomes cross-subject data destruction,
so it is written here rather than left as an accident.

**D2 also owes a prose correction, which the first draft omitted.**
`test/subject-erasure-coverage.test.ts` describes this store as "subject-authored notes DELETED
for the subject". After D2 erasure also drops the whole recall namespace, including turn
summaries, which are **not** subject-authored notes. That file's own `TWIN-DEBT-1` comment records
that its values are never asserted against source and that one of them once described the wrong
disposal — leaving this row stale would be that exact defect, committed knowingly.

**Best-effort, with the failure named.** A vector backend that is down must not block the durable
erase (today's `catch {}` at `:417-419` is silent; the replacement logs the named backends from
`VectorPurgeResult.failed`, matching `rosterCascade.ts:141-146`). A partial purge is never folded
into a success.

**Witness.** The agent lane's shape (`test/roster-lifecycle.test.ts:81-105`): write a turn summary
under a `user:` scope with NO curated note, erase, re-derive the same
`userIdFor(tenantId, principalId)`, and assert the recall does not serve the erased content.
The no-curated-note case is the one today's `if (ids.length)` guard skips entirely.

### D3 — distinguish "off" from "unreadable", and disclose only where it matters (`PKWF-3`)

A faulted toggle read no longer returns the same silent closure as a clean `false`. On a fault the
resolver continues to the link and grant checks — which are themselves fail-closed authorization
reads — and returns the **fault sentinel** retriever (`async (_q, onSourceError) => { onSourceError?.('kb'); return []; }`)
only when a live link and active grant exist. Reusing the sentinel shape
`agentRunnerNode.ts:228` already ships means no seam change: `BorrowedRecallSource` is returned as
normal and every lane's existing degradation path fires.

**Why gated on link+grant rather than disclosed immediately:** a tenant with the feature genuinely
off would otherwise see a spurious "could not read your owner's corpus" notice on an ordinary
turn. Disclosing only when the person actually has an active grant makes the notice true whenever
it appears, and reveals nothing to anyone else.

### D4 — pin the non-classification, against the REAL module (`PKWF-4`)

> **CORRECTED after `/architect` — the first draft's ratchet could not detect the classification
> it exists to prevent.** It asserted
> `isSideEffectingNode('local.openwop-app.agent-runner', null) === false`. But that predicate has
> three legs (`executor/sideEffects.ts:256-263`) and the second is
> `module?.sideEffecting === true`, which the executor evaluates against the **real** module
> (`executor/executor.ts:983`). Passing `null` makes that leg unreachable — so adding
> `sideEffecting: true` to the NodeModule, which is the most likely way anyone would classify this
> node and is literally what `host/agentRunnerNode.ts:189-192` warns against, would leave the
> ratchet **green**. The sibling test (`test/assistant-node-replay-classification.test.ts:81-100`)
> passes `null` too, so that is a **shared blind spot, not a precedent to copy**.

The ratchet imports the real module (`export default agentRunnerNode`,
`host/agentRunnerNode.ts:321`) and asserts `isSideEffectingNode(AGENT_RUNNER_TYPE_ID, mod) === false`,
plus a second leg asserting the module does not declare `sideEffecting` at all — so the assertion
fails for the right reason rather than incidentally. The sibling's blind spot is recorded here as
a follow-up (`PKWF-14`) rather than fixed in this PR; it is a different feature's witness.

### D5 — the ad-hoc dispatch route gets its own catch (`PKWF-5`)

Same fault sentinel as the run lane, in a dedicated catch around the resolver call
(`routes/agents.ts:341-362`), so a transient consent-store fault degrades with disclosure instead
of 500-ing. Deliberately its own catch: the route-wide catch at `:424` also fails the request, so
moving the await is a no-op — the same reasoning `agentRunnerNode.ts:215-218` records.

### D6 — recorded, corrected, or deferred (no code)

**Corrected in place** (docs, this PR):
- `PKWF-6` `host/twinService.ts:42` still documents `version` as "Phase 2 stamps it on a run for
  replay" — the exact optimization `agentRunnerNode.ts:189-192` forbids, in the docblock a
  maintainer reads first. Corrected with a note, not a rewrite.
- `PKWF-T1`/`T2`/`T3` the tracker-integrity findings, amended at the `WF-TWIN-8` row rather than
  rewritten: the body row asserts `tenantOf` is absent when it is armed
  (`host/twinService.ts:63`); the deferral is justified by a citation to prose that
  `git log -S "intentional" -- host/twinService.ts` shows **never existed at any commit**; and
  every line citation in five rows has drifted while the twin-core files are byte-frozen, so they
  were stale when filed. Also: row 44's "pin-site ceiling 5" is 4 at HEAD
  (`test/workflow-pin-site-ratchet.test.ts:609`).
- `PKWF-8` the promise, not the rule. `createBoundCollection`
  (`features/profile-memory/profileKnowledgeService.ts:160-170`) stamps no `boundSubject`, so a
  personal collection is org-readable. **The rule is DECIDED**: ADR 0042:94-99 accepts it in terms
  ("Correct RBAC, but a slightly leaky 'personal' abstraction") and its 2026-08-01 correction note
  closes the tenancy half as BY DESIGN (`GC-7`). What ADR 0042 did not license is the
  **assertion** — the UI says "Private to you." (`frontend/react/src/features/profile-memory/i18n/en.ts:9`).
  The ADR 0665 D3 shape: correct the promise, leave the rule, condition the wording on deployment
  shape (it is true in a single-member personal tenant). **Landed in the UX pass, not here.**
- `PKWF-D1` the run lane executes through a hard-coded in-tree `WorkflowDefinition`
  (`host/agentMentionWorkflows.ts:25-49`, resolved at `host/index.ts:492-493`) that is invisible
  to the pin-site ratchet **by construction** — the scanner classifies `registerWorkflow` call
  sites and this def is never registered, it is returned from a resolver. Not this feature's
  ownership gap; recorded so "zero pin sites" is not read as "the graded path is chain-backed".

**Deferred, each with a reason** — not silently dropped:
- `PKWF-7` (the `GEN-RCL-1` arity class one seam over: 3 of 4 `ShareableKbProvider` impls drop
  `opts.forUnshare`, `host/shareableKb.ts:19-26`) — semantically inert today because share-set
  equals unshare-set for all three, and the real cure is the type-aware lint `GEN-RCL-1` was
  declined in favour of. Fixing three signatures without that lint leaves the generator armed.
- `PKWF-9` (no legal-hold assertion on `removeSubjectNote`/`clearSubjectNotes`) — the exposure is
  real but per-call it is one self-owned note; the bulk lanes are `clearSubjectNotes` and
  `deleteProject`. The honest fix is to bring these lanes INTO the destructive-lane census
  denominator first (they are outside it, since it derives from storage-level deletes and seam
  runners), which is a census change with its own blast radius.
- `PKWF-14` (NEW, found by the review) the sibling replay-classification ratchet
  (`test/assistant-node-replay-classification.test.ts:81-100`) passes `null` as the module and so
  cannot see a `sideEffecting` declaration either — the same blind spot D4 fixes here. Deferred
  because it is another feature's witness; filed so the next pass on that feature inherits it.
- `PKWF-10` (notes not declared PII), `PKWF-11` (anon teardown missing
  `purgeTenantDurableSurfaces`), `PKWF-12` (latent raw-form-only key in `eraseSubjectKnowledge`,
  unreachable today because every writer passes `projectSubject`), `PKWF-13` (no retention lane
  possible without `tenantOf`) — each is a real gap; none is reachable as a live defect, and each
  wants its own witness rather than riding this PR.

### `/architect` review record (2026-09-12, before code)

Two Blockers and two SHOULDs, both Blockers in my own reasoning rather than in the diff — the
ninth consecutive iteration where the review paid for itself in the decision text.

1. **BLOCKER — D1's trust principle was falsified by an in-repo counterexample** (folded above).
   `emailApprovalDelivery.ts:155-156` is an allow read over the over-set. I asserted a rule this
   codebase violates.
2. **BLOCKER — D4's ratchet was blind to the `module.sideEffecting` leg** (folded above), and the
   sibling test I cited as precedent shares the blindness.
3. **SHOULD — D2 owed the erasure-coverage prose update** (folded above).
4. **SHOULD — D2's safety rested on an unstated invariant** about the scope over-set (folded
   above). This was the finding I flagged as the one I was least able to see myself, and the
   answer was "safe, for a reason that must be written down".

**Premises that HELD, checked rather than assumed:**
- Production grant rows **are** reachable — the UI control ships
  (`frontend/react/src/features/profile-memory/ProfileMemoryTab.tsx:15` imports
  `getExtractionGrant`/`setExtractionGrant`). D1's third reason stands, and with it the consent
  question: real people have toggled this and had nothing extracted.
- `addNote` is correct as-is, and the note readers agree on the scope form.
- `eraseSubjectMemory` is reachable **only** through `registerSubjectEraser`
  (`host/subjectMemory.ts:429-430` → `host/hostSubjectErasers.ts:70`) and therefore only behind
  the fan-out's hold assertion. D2 adds no unheld destructive lane.
- Nothing depends on the current silent `closed('toggle-off')` shape, so D3 breaks no caller.
- `PKWF-12`'s deferral is sound: the only `setSubjectKnowledge` writer is
  `features/projects/projectKnowledgeService.ts:96`, passing `projectSubject`.

## Alternatives weighed

- **`PKWF-1`: normalise the key at the store instead.** Rejected: `getExtractionGrant` is the
  authorization read, and making it form-tolerant is the unsafe direction of the over-set
  asymmetry above.
- **`PKWF-1`: fix the write to match the read.** Rejected: it strands existing grant rows and
  needs a migration, for no gain — the write already matches the declared convention.
- **`PKWF-2`: propagate the id-collecting shape.** Rejected on ADR 0664 D1's own grounds: turn
  summaries have no durable row and a pgvector deployment holds rows this process never saw.
- **`PKWF-3`: surface the closure reason across the seam.** Rejected as a seam-shape change when
  an existing, proven mechanism (the fault sentinel) already expresses "read failed" to every
  lane.
- **Fixing the "Private to you" rule rather than the wording.** Rejected — see D6/`PKWF-8`; a
  board-only, or here a personal-only, rule change is how two features that agree start
  disagreeing.

## Open questions

1. D1's consent judgement: should a grant that has never been effective begin writing on its own,
   or be re-confirmed? This ADR takes the behaviour change (the control is explicit and
   revocable). A product owner may prefer a disclosure on next visit.
2. `PKWF-8`: is "only me" the intended product promise for personal collections? If so it is a
   cross-feature ADR touching `readableCollection` and `tenantRetrieve`, not a wording fix.
3. `PKWF-13`: adding `tenantOf` to the note/binding collections would unlock a retention lane but
   arms a tenant index over a store that has never had one — needs its own migration note.

## Phased plan

| Phase | Scope | Closes |
|---|---|---|
| P1 | D1 + born-red witness; keep + rename the bare-id unit case | `PKWF-1` |
| P2 | D2 + no-curated-note re-provision witness | `PKWF-2` |
| P3 | D3 + D5 (the two fault lanes) | `PKWF-3`, `PKWF-5` |
| P4 | D4 ratchet | `PKWF-4` |
| P5 | D6 doc corrections (`PKWF-6`, `T1`–`T3`, `D1` note) | those ids |
| — | deferred with reasons | `PKWF-7`, `-9`, `-10`, `-11`, `-12`, `-13`; `PKWF-8` → UX pass |

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3777**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** D1 `features/memory-auto-extract/extractionBinding.ts:62`; D2 `host/subjectMemory.ts:40,472-475`; D3 `features/twin/borrowedRecall.ts:129,183`; D4 `test/twin-replay-classification.test.ts:25-35`; D5 `routes/agents.ts:352-383`; D6 `host/twinService.ts` docblock.

`PKWF-7/9/10/11/12/13/14` are deferred BY this ADR, so they are not gaps against it.
