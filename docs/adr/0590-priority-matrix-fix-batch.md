# ADR 0590 — Priority Matrix fix batch (feature 22/71): teardown purge pre-hook, AI provenance stamp, reject-seam surfacing, fork-propose idempotency

Status: implemented

## Context

The three-lane assessment of Priority Matrix (merged as PR #3418: code B+ with
Blockers `PMX-1`/`PMX-7`, UX B− with Blockers `PMXU-1..4`, workflows B with
Blocker `PMXWF-1`) named seven Blockers and ~40 gaps across
`backend/typescript/src/features/priority-matrix/` and
`frontend/react/src/features/priority-matrix/`. This ADR records the four
decisions in the fix batch that are architectural (the rest are direct defect
fixes riding the same PR), the places where a witness FALSIFIED the tracker's
prescribed fix, and the accepted residuals. All routes stay non-normative
host-extension surfaces (`/v1/host/openwop-app/*`) — no wire facet, no RFC.

## Decision 1 — tenant teardown: a feature-registered purge PRE-hook inside `purgeTenantHostExt` (PMXWF-1)

Five PM collections (`priority-matrix:score|vote|schedule`,
`priority:intake|evidence`) carry rows keyed `listId::cardId[::voterId]` with
neither `tenantOf` nor a JSON `tenantId`; the generic teardown walk cannot
match them and deletes the `priority-matrix:list` rows that are their only
tenant resolution — orphaning PII (`IdeaIntake.requester`, `addedBy`,
`voterId`) forever, on BOTH teardown lanes (account delete and the anon
retention sweep).

**Alternatives weighed:**
- *Add `tenantId` to the five row shapes* (the commerce-connect cure): needs a
  backfill migration for existing rows and still leaves the next markerless
  feature to rediscover the class.
- *A `purgeTenantPriorityMatrix` call site in `routes/account.ts`* (the literal
  KT-D1 `purgeTenantKanban` precedent): covers ONE lane; the anon sweep
  (`retentionSweepDaemon`) calls `purgeTenantHostExt` directly and would still
  orphan — and a host daemon importing a feature module inverts the layering.
- **Chosen:** a `registerTenantPurgeHook(id, fn)` registry in
  `host/hostExtPersistence.ts`, run FIRST inside `purgeTenantHostExt` (while
  the parent rows still resolve the tenant). One composition owner ⇒ every
  caller, present and future, is covered ("a gate on the creation lane is not a
  gate on the use lane" — this is the use-lane gate). Hook failures PROPAGATE:
  an incomplete purge must never report success.

The PM hook (`purgeTenantPriorityMatrix`) is a deliberately QUIET direct sweep,
not a `deleteList` loop: teardown is not a product mutation, so it must not
emit `host.priority.*` webhooks or append audit rows for a tenant whose SQL
rows are already gone (the account lane wipes SQL before the host-ext walk).
Boards ride `deleteBoard` so the anon lane — which never calls
`purgeTenantKanban` — does not orphan the PM cards (idempotent when the account
lane's kanban pre-step already ran).

**Observed sibling defect (recorded, NOT fixed here):** the anon-teardown lane
never calls `purgeTenantKanban` at all, so non-PM kanban cards (no top-level
`tenantId`) orphan on that lane — the same KT-D1 class one seam over. That is
host-kanban's fix to make (ideally by registering its own purge hook on this
new seam); filed in the PR body.

## Decision 2 — AI provenance is stamped at the WRITER; absence is never backfilled (PMXU-1)

`card.source` was hard-coded `'human'` for every idea regardless of writer, and
score/vote rows carried no actor class at all. The writers now stamp
truthfully: chat tools pass `'agent'`, run-surface verbs pass `'workflow'`,
routes default `'human'`; the stamp rides `KanbanCard.source`,
`IdeaScore.source`, `IdeaVote.source`, `IdeaScoreChange.source` and the
vote-breakdown wire. **Existing rows are untouched:** an absent stamp means
"pre-stamp row", never "human" — a backfill would fabricate provenance, which
is the defect this closes. The FE renders the `scenarioProposed`-style chip
beside AI-written ideas, labels the literal `workflow` voter as automation, and
chips AI-cast votes.

## Decision 3 — the scenario reject seam surfaces the decision at READ; the page gains a reject action (PMX-6 / PMXU-2 / PMXWF-2)

A rejected agent scenario was byte-identical on the wire to an undecided one.
Chosen: `GET …/scenarios` JOINS `approvalStatus` from the shared approval row
at read (one approvals read per session) rather than stamping the scenario row
at decide time — a read-side join cannot drift from the one durable decision
record, and the reject handler stays effect-free (architect Q1: selection is
inert data). The page select uses a PENDING-only guard (its well-worded 409 now
fires instead of the raw core "Approval already rejected."), and a page-level
reject route (the strategy check-in dismiss pattern) decides the SHARED row
through the one decision core. The reject lane, the `workspace:write` 403 arm,
and the ADR 0066 compensating reopen are all witnessed against the real resolve
path.

## Decision 4 — fork-propose idempotency: content-keyed, pending-gated (PMXWF-6, architect option (c))

`scenarioId` is minted `scn-${randomUUID()}` in a writer reachable from a run;
replay is safe (`role:action` records the output) but a `:fork` RE-EXECUTES the
node and minted a duplicate scenario + a second pending approval, permanently
occupying cap slots (no scenario delete exists — PMXU-20, deferred).

**The tracker's prescribed fix (a) was falsified before building:** "a
deterministic scenarioId derived from run+node identity" is a NO-OP for the
named defect — a fork mints a FRESH runId (fork ≠ resume), so run-identity-
derived ids diverge per fork exactly like `randomUUID()`. A content-hash id
would collapse them but breaks `scenarios[]` id-uniqueness without upsert logic
and can resurrect a DECIDED scenario on id collision.

**Chosen (c):** in `addScenario`, agent lane only — an identical
`{sessionId, name, selection, constraints}` re-propose while the prior
proposal's approval is still PENDING returns the existing scenario (the
submit-idea ignition-dedup contract). Pending-only preserves decision finality;
the human route lane is untouched. **Accepted residual:** two SIMULTANEOUS
forks racing the pre-read can both mint — the pre-fix behavior in a vanishingly
narrow window; the reject lane (now fixed) is the human recovery.

## Witness-falsified prescriptions (recorded per the batch's method rule)

1. **PMX-1:** the prescribed `cleanOpaqueToken` charset (`[A-Za-z0-9_.:-]`)
   REFUSES legal RFC 6750 `token68` bearers carrying `~ + / =` (plain base64
   with padding) — witnessed by the padding-token round-trip. Shipped:
   `cleanBearerToken` (token68 grammar, verbatim storage, loud 400).
2. **PMX-5:** the prescribed `safeUrl` helper itself calls `cleanString` and
   therefore ALSO destroys ≥40-char URL id segments — the prescription was the
   same scrub oracle one layer up. Shipped: URL refs verbatim after
   scheme+length checks (http(s)-only already excludes dangerous schemes);
   id refs via `cleanOpaqueToken`; free-text `label`/`notes` keep the scrub.
3. **PMXWF-6 (a):** see Decision 4.
4. **PMX-D3:** the "deterministic loser by `(createdAt, id)` order" design was
   built and falsified by its own witness — same-millisecond timestamps have no
   happened-before order, so the election can point at an innocent established
   row and the guard is vacuous. Shipped: fail-closed self-compensation (any
   racer observing overshoot deletes its own row and refuses; at the boundary
   both may refuse and a retry succeeds — the cap invariant always converges).

## Other calls made in this batch

- **PMX-2:** promote resolves the completion lane BEFORE minting (pure
  `completionColumnOf`, unit-tested on renamed boards; no completion lane ⇒
  400 before any write); `markPromoted` is CAS-guarded; a lost stamp race
  COMPENSATES the freshly-minted project (`deleteProject`), and the move
  outcome is reported (`{moved, movedToColumnId}`) and surfaced in the FE.
- **PMX-3/PMX-4:** `FederatedPeer.createdBy` is the NINTH subject-keyed store
  (redacted to `ERASED_USER_REF`, tenant-scoped, discriminator-tested); the
  eraser returns `{rowsTouched}` so the DSAR aggregate's `foundNothing`
  wrong-tenant tell can see PM.
- **PMX-D2/PMXWF-4:** the evidence cascade rides its `ev:${listId}::` prefix
  lane and the score-change cascade rides the tenant index (signature gained an
  optional `tenantId`).
- **FE honesty batch:** intake-modal errors inside the modal (`Modal
  error/errorAnnounce`) + retryable failed load; schedule read tri-state
  ("Schedule unavailable", never a fabricated "No date"); typed
  `PriorityMatrixApiError` so only a real 403 renders the restricted notice;
  projects/peers/members failures stated; sequence tokens on the six loaders;
  `props` identity dropped from the two loader dep arrays (the per-keystroke
  `GET /portfolio` — witnessed by a dep-array sabotage probe); dirty-guards on
  all four editors; confirm on merge; loud invalid scenario constraints; both
  Top-N fields keep the raw string while typing.
- **PMX-14/PMX-15:** ONE `orgScopeGranted` predicate exported from routes and
  imported by the tools (the CRM pattern); the two schema-carrying tool ids are
  compaction-exempt with a parity assertion.

## Explicitly deferred (with reasons — deferral is a claim)

- `PMXWF-3` (`host.priority.*` in the operator event catalog): rides the
  ADR 0584 build-time parity gate; hand-adding one line is what that gate
  exists to reject.
- `PMXU-5` (~40 backend English literals reaching non-en users): a
  feature-spanning i18n error-code mapping program (the CSM family), not a
  batch item.
- `PMXU-13/15/18/20/23`: wire additions (score-trail rendering, evidence
  links, session card-id resolve, scenario delete/dismiss, `GET /lists/:id`
  adoption) — each changes the client/route surface beyond this batch's blast
  radius; PMXU-20 interacts with Decision 4 and should ride its own change.
- `PMX-13/16/18/19/20`, `PMX-D1/D5/D6`, `PMXU-6/10/11/14/17/21/22`,
  `TODO-PM-*`: nice-to-haves and debt with no irreversibility pressure;
  unchanged from the assessment's ordering.
- `PMXWF-5` (a node-pack fn over the REAL built surface): not attempted this
  batch; the packs test still witnesses mechanism over a stubbed surface.

> **CORRECTION (closeout 2026-08-20): `PMX-D4` was OMITTED from this list.**
> The FE dead-export/param debt row (`quadrantAxes`/`QuadrantAxes`/
> `MatrixPlacement` exports, the hardwired `kbEnabled` prop, the
> `MODEL_LABEL_KEY` casts) is neither fixed by this batch (verified untouched
> in the merged tree at closeout) nor named anywhere in this section — and
> “deferral is a claim” is this section's own operating rule, so an open row
> with NO disposition is exactly what it prohibits. Disposition: DEFERRED with
> the same no-irreversibility-pressure reason as `PMX-D5/D6`; the tracker row
> stays open.

## Implementation record (phase → commit, all on PR branch `fix/pmx-batch`)

| Phase | Gaps | Commit |
|---|---|---|
| §1 teardown purge pre-hook (+D2 prefix sweeps) | PMXWF-1, PMX-D2/PMXWF-4 | `d7887b67c` |
| §2 scrub-oracle pair | PMX-1, PMX-5 | `c906a7508` |
| §3 AI provenance + trail logging | PMXU-1, PMX-10 | `298d68930` |
| §4 promote lane + CAS + compensation | PMX-2 | `036eec0b7` |
| §5 reject seam (three lanes) | PMX-6/PMXU-2/PMXWF-2 | `779ca32ac` |
| §6 FE honesty + refetch batch | PMXU-3/4/7/8/9/12, PMX-7/8/9/11 | `6d7b89871` |
| §7 erasure pair | PMX-3, PMX-4 | `ca678e816` |
| §8 fast-follows | PMX-14, PMX-15, PMX-D3 | `3856d207e` |
| §9 fork-propose idempotency | PMXWF-6 | `c2feb8191` |

Every fix landed with a born-red witness (or, where an interleaving cannot be
forced deterministically, an interleaving-independent invariant assertion plus
a sabotage probe); the deviations from tracker prescriptions above were each
discovered BY the witness, not by argument.

> **CORRECTION (adversarial review of PR #3419, five findings folded — the
> paragraph above was overstated on one lane, and the batch itself minted two
> fresh instances of families it closed.)**
>
> - **F1 — the PMX-2 "concurrent promote" witness was VACUOUS for the
>   compensation block.** Under `memory://` storage two route handlers never
>   interleave mid-request, so the loser 409s at `assertNotPromoted` BEFORE
>   minting and the one-project assertion held with the `deleteProject`
>   compensation DELETED (sabotage-proved by the reviewer). The born-red claim
>   above was therefore false for that lane. Cure: a DETERMINISTIC witness — a
>   `DurableCollection.prototype.compareAndSwap` spy that fails the swap only
>   for rows carrying `promotedTo`, forcing the post-mint stamp loss — now
>   red-under-sabotage for both promote lanes. The original concurrent test
>   stays as an interleaving-independent invariant, no longer as the
>   compensation's witness.
> - **F2 — the symmetric sibling lane** (`strategy/routes.ts`
>   `POST /:id/initiatives/from-idea`) kept every defect PMX-2 fixed (literal
>   `'done'` move, swallowed move result, no compensation) — and this batch
>   WIDENED `markPromoted`'s throw surface (the double-CAS-loss 409), giving
>   the sibling a new debris path. It now gets the identical treatment:
>   completion-lane resolution before any write, `moved` reported, and a lost
>   stamp compensates the initiative + the link + the cap slot (deterministic
>   witness, red under sabotage).
> - **F3 — the cap-race class had FIVE instances, not three.** `cloneIdea`
>   (probe: 1001/1000 cards) and `addIdeaEvidence` were the fourth and fifth
>   pre-check-then-create sites; both now carry the post-write guard. The
>   mechanism is witnessed end-to-end at the EVIDENCE lane (cap 50, the one
>   cheap enough to seed to its boundary; sabotage-proved); the
>   clone/createList/submitIdea lanes share the identical guard shape but are
>   not end-to-end witnessed (seeding 200/1000 rows) — disclosed, not claimed.
> - **F4 — two writers laundered the PMXU-1 stamp:** `seedVotesFromScores`
>   (the single→multi migration) and `cloneIdea`'s score copy bypass
>   `setIdeaScore` and dropped `source`. Both now carry it VERBATIM — a
>   migrated or cloned agent-scored row is still agent-derived data (the human
>   clicked Clone/switched the mode; the scores were model-cast). Born-red
>   witnesses for both shapes.
> - **F5 — the dead `onError` prop** on `IdeaIntakePanel` (whose comment
>   invented a consumer) is REMOVED, not annotated. **Demo seeds** (`
>   demoOpsPlanningSeed`, `strategyShowcaseSeed`) keep the `'human'` default
>   DELIBERATELY: the PMXU-1 stamp answers "did a model/workflow write this in
>   YOUR workspace", and for curated fixture content modeling human-authored
>   sample ideas the honest answer is no — stamping `'workflow'`/`'agent'`
>   would put AI-provenance chips on content no model wrote, and the
>   `KanbanCardSource` taxonomy has no `'seed'` value (adding one is a host
>   taxonomy change out of this batch's scope). Recorded here so the default is
>   a decision, not an accident.
