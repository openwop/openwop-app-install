# ADR 0845 — Strategy: an activation approval binds to the version approved, every protected writer goes through one gate, and the run lane asks who started the run

Status: **implemented** (2026-10-06, feature loop round 2 row 27 — this PR)

Extends **ADR 0079** (strategic planning), **ADR 0230 §B3/§B4** (activation gate, versions) and
**ADR 0597** (§3 state-set posture, §Correction 1 run link lane, §Correction 4 withdraw-on-edit).
Builds on **ADR 0839 D1** (absent caller ⇒ no access) and **ADR 0842** (run lane = the starter's
access; D10 strategy links). Takes the self-approval rule from **ADR 0732** (environment
promotion). Gap ids `STR3WF-1..7`, `GEN-STR3-1` in `docs/steward/WORKFLOWS-ASSESSMENT.md` §
"Strategic Planning + activation approval gate — feature loop round 2 (row 27)".

## Context

The `strategy-approval-gate` toggle (default OFF, `tenant` bucket) promises that a strategy goes
live only after an approver with `host:members:manage` in its org has seen and accepted it, and
that rewriting an approved strategy's protected content (`objectives`, `period`,
`planningHorizon`, `accountableExecutive`) sends it back for approval. Measured on `c1d746c08`
(`test/strategy-activation-binding.test.ts`, six legs born red, three matched controls green):

1. **CSV import bypasses both halves of the gate (`STR3WF-2`).** `POST /:id/import-objectives`
   (`routes.ts:865`) writes `objectives` directly. A pending review is not withdrawn, so the
   approver activates objectives they were never shown; and an active strategy stays active.
   ADR 0597 §Correction 4 said there were "TWO" writers of protected fields, found by walking
   `updateStrategy`'s callers. There were three.
2. **Restore keeps an approved strategy approved (`STR3WF-3`).** `POST /:id/versions/:n/restore`
   withdraws a pending review but never applies the protected-edit auto-revert. Restoring a
   draft-era revision onto an ACTIVE strategy puts never-approved objectives live.
3. **The submitter clears their own gate (`STR3WF-4`).** The `strategy-activation` approval
   records no proposer, so `decideStrategyActivation` cannot tell the submitter from a second
   approver, even when a second `host:members:manage` holder exists in the org.
4. **The run lane is tenant-trusted for strategy ROWS (`STR3WF-1`).** ADR 0597 §Correction 1 keyed
   the cross-entity LINK projection on `scope.actingUserId` and recorded the row lane as a
   residual. `surface.ts` still lists, reads, health-rolls and stale-scans every shared strategy in
   the tenant, and `checkIn` writes into any of them, including `mode:'sync'` CONFIRMED values on a
   sourced KR. An org-A-only editor's run reads org-B objectives and writes org-B check-ins; the
   route (`loadStrategyScoped`) and the agent tools (`canSubjectReadStrategy`) refuse that person.
   This is ADR 0842's `PMX4WF-1`, one feature over.

Also found (Improvements):

5. **The approver cannot see what they approve (`STR3WF-5`).** The inbox card says `Activate
   strategy "X"`, with no objectives and no link. Market leaders that gate OKR sets (WorkBoard,
   Quantive, Cascade) show the set, or a diff, on the approval itself; this is an assumption from
   the competitive notes in `docs/steward/UX_UPGRADE-strategy.md`, not a fresh market scan.
6. **`updateStrategy` / `replaceLinks` are read-then-put (`STR3WF-6`).** A concurrent write is
   silently lost, and the decide path has a window between its status compare and its flip.
7. **`surface.checkIn` takes `actor` from caller args (`STR3WF-7`).**

**The generator (`GEN-STR3-1`).** "Approve what you see" is enforced per WRITER, not at the
decide EXIT. The approval binds only to `strategyFromStatus`; content binding depends on every
writer of a protected field remembering both `withdrawActivationReview` and the auto-revert. Two of
three writers forgot one or both. A fourth writer added tomorrow fails open by default.

## Boundaries audit

- **Approvals** have ONE store and ONE decision core (`host/approvalService.ts`,
  `host/approvalDecision.ts`). The strategy handler (`activationApproval.ts`) is registered on the
  core hook; this ADR adds fields to the `strategy-activation` row and logic in the feature
  handler. No new store, no new kind.
- **Self-approval** has an in-tree owner: `hasDistinctScopeHolder` (`accessControlService.ts:2065`,
  ADR 0732), used by environment promotion. It is TENANT-wide. The strategy decide bar is
  `host:members:manage` IN THE STRATEGY'S ORG, so the distinct-holder question must be asked in
  that org. Extend the owner with an optional `orgId`; don't fork it.
- **Access predicates** have an owner: `canSubjectReadStrategy` (`strategyService.ts:373`). The
  route's `canWriteStrategy` (`routes.ts:79`) is a private copy of the write rule; it moves to
  `strategyService.canSubjectWriteStrategy`, so the route and the surface call ONE rule.
- **CAS** primitive exists: `DurableCollection.compareAndSwap` (`hostExtPersistence.ts:770`).
- **Revisions** (`revisions.ts`) hash the WHOLE strategy (`contentHash`); not reused for binding
  because a status flip or an unprotected edit changes it. A separate digest over exactly the
  protected fields is needed.

## Decision

(Revised after the `/architect` adversarial pass; see § "Architect pass" for what changed and why.)

**D1 — The run lane asks who started the run (`STR3WF-1`).** In `buildStrategySurface`, when
`scope.actingUserId` is present:
- every read verb (`listStrategies`, `getStrategy`, `getStrategyContext`, `getHealth`,
  `listCheckIns`, `listStaleKrs`) keeps only strategies that are `isShared` AND
  `canSubjectReadStrategy(tenant, actor, s)`. The private-draft exclusion stays, even for the
  creator: runs never saw user-scoped drafts, and widening that is not this ADR;
- `checkIn` takes the bar of what it creates. `mode:'agent'` creates a PROPOSED check-in that a
  writer must confirm, so it requires READ. `mode:'sync'` creates a CONFIRMED value, so it requires
  `canSubjectWriteStrategy`, which is the route's rule moved into `strategyService` so both call it.
  A denial returns `{checkIn: null, reason: 'forbidden'}`, and the `check-in` node maps any null
  check-in to a typed error rather than `success` (a node-pack change: `feature.strategy.nodes`
  is bumped);
- `syncMetrics` syncs only strategies the actor can write. It reports readable-but-unwritable
  sourced KRs as `skipped: not_writable`, so the run's output is still an honest sync-health view.

When `actingUserId` is absent, behaviour is unchanged: the tenant-trusted shared view. Only the
strategy cadence fires are actorless (`cadence.ts` registers no metadata). A user-created schedule
stamps its creator's `actingUserId` on every fire (`scheduleDaemon.ts:158-163`), so it now runs with
the creator's view. A surface-verb ratchet classifies every `buildStrategySurface` verb as `read`
or `write`; a new verb fails the test until it is classified. `orgScopeSubject` narrowing for
actorless runs remains a residual (as in ADR 0842).

**D2 — The approval binds to the exact content shown, verified at the decide exit
(`GEN-STR3-1`).** At queue time, `bindingOf(updated)` builds the binding from the SAME object the
route just wrote: `{orgId, scope, objectives, period, planningHorizon, accountableExecutive}`, in
stored form. That is the protected fields plus where the strategy lives (`H1`). The approval
records:
- `strategySnapshot`, which is the binding itself. The objectives are bounded by
  `STRATEGY_LIMITS` (50 × 30), so nothing is truncated: the card shows exactly what the digest
  covers, including each KR's `measure` (source kind and org), `weight` and target;
- `strategyContentDigest`, which is sha256 over canonical JSON of the snapshot.

`decideStrategyActivation(approved)`:
- **before** the CAS, it recomputes the digest from the current row. If it differs, it closes the
  approval as `rejected` with a system note (no `decidedBy`: the approver did not choose this
  outcome) and throws 409. Nothing has been consumed yet, which is the reason the existing
  deleted-strategy pre-check is placed there;
- the flip is D4's single-attempt CAS against the row that was just verified, with `status ===
  queuedFrom` and the digest re-checked against that exact row. A write that lands in between makes
  the CAS lose. The compensation `catch` then REOPENS the card (nothing was applied), and the
  approver retries, which hits the pre-check above and closes it with the reason.

**Legacy rows** (queued before this ships, with no digest) fall back to the status-only compare
and log `strategy_activation_unbound_legacy`. The production count of pending rows decides whether
this fallback can be removed.

**Re-submitting** while a review is pending (`queueStrategyActivationIfGated`) used to be a no-op.
Now, if the pending row's digest differs from the current binding, it closes that row and queues a
fresh one; if the digest is equal, it leaves it alone. The card is never stale at queue time (`L3`).

The per-writer withdraw is kept as UX: it tells the owner now rather than at decide time. It is no
longer what holds the guarantee. The withdraw triggers widen to include `orgId` and `scope`
changes, matching the binding.

**D3 — One gate for every writer of `strategy:record` (`STR3WF-2`, `STR3WF-3`, `STR3WF-8`).**
`gateProtectedWrite({gateOn, current, protectedChanged})` in `activationApproval.ts` returns the
status override (`draft`) and `autoReverted`. It holds the rule PATCH applied inline
(`protectedEditRequiresReapproval`). The rule is decided against the CAS base row, which D4 makes
the only row the write can land on:
- **PATCH** keeps presence semantics: a protected key in the body is the trigger. This is
  unchanged, and value-diff for PATCH is deferred as `STR3WF-F1`;
- **restore** and **import** use VALUE semantics: they compare the post-write protected fields with
  the base row's, after parsing (the parse slices at the caps). A restore or import that changes no
  protected value neither reverts nor withdraws. These are newly gated sites, so presence semantics
  have no compatibility claim on them;
- **create** (`POST /strategy`, `STR3WF-8`, found by `/architect`): with the gate ON, a body
  `status:'active'` creates the strategy as `draft` and queues an activation, exactly like PATCH's
  mixed-patch rule. `createStrategy` called from the service (the demo seeders) is a system writer
  and unchanged. Before this, a POST with `status:'active'` created a live strategy with no approval.

A source ratchet enumerates every writer of the collection. That covers the `strategies.put` /
`compareAndSwap` sites in `strategyService.ts`, plus every `createStrategy(`, `updateStrategy(` and
`replaceLinks(` call site under `src/`. Each is pinned to a class: `gated-route` (must reference
`gateProtectedWrite`), `unprotected-only`, `decide-flip`, `system-seed`, or `erasure`. A new writer
fails until it is classified.

**D4 — Strategy writes are compare-and-swap, single attempt (`STR3WF-6`).** `updateStrategy` and
`replaceLinks` take an optional `base: Strategy`, the row the caller read and decided against. When
it is given, the patch is applied to `base`, and the result is `compareAndSwap(base, next)`. When it
is omitted, the function reads, applies, and CASes against its own read. Either way:
- a lost race is a 409 `conflict` ("This strategy changed since you opened it. Reload and try
  again.") and is **never retried**. A retry would re-apply a patch the caller computed from a stale
  row (import, promote and links all build from `s`) and a gate decision made against that stale
  row. That would turn a safe failure into the bypass D2 closes;
- `updateStrategy` takes `precondition(base)` for the decide flip;
- the side effects (KB `removeStrategy` / `indexStrategy`, revision append) run once, after the
  winning swap, against the winning row's `orgId`.

Route callers pass `base: s`. Promote's second write (`replaceLinks`) passes the first write's
result.

**D5 — The submitter cannot approve their own submission when someone else can (`STR3WF-4`).**
The approval records `requestedBy` as the CANONICAL identity of the PATCH actor: the delegation
issuer for an `apikey:`/delegated subject (`delegationOf`, same tenant), otherwise the subject.
`decideStrategyActivation(approved)` canonicalizes `decidedBy` the same way, and refuses with 403
`forbidden` (`details.reason: 'separation-of-duties'`) when the two are equal and another subject
holds `host:members:manage` in the strategy's org. That closes the hole where someone submits by
session and approves with their own API key. ADR 0732 has the same hole, filed as a residual for
that owner. A delegated subject whose delegation cannot be resolved counts as the submitter (fail
closed).

The distinct-holder question extends `hasDistinctScopeHolder` with an optional `orgId`. With
`orgId` set, the member filter is exactly `m.orgId === orgId` (the org match
`resolveEffectiveAccessDirect` uses), and the shared-workspace root-only skip does NOT apply. That
skip applies only when `orgId` is absent, so a `ws:` tenant's sub-org admins count. The function
fails closed on error (it answers "a distinct holder exists"). A sole approver is not locked out
(the ADR 0732 rule). Self-REJECT stays allowed, because it is a withdrawal. Rows with no
`requestedBy` (legacy) are decided as before, with a log. The check runs before the CAS.

`requestedBy` is a subject id, so the `strategy-activation` redactor's `idFields` gains
`requestedBy` (`approvalService.ts:1155`).

**D6 — Approve what you see, on the card (`STR3WF-5`).** The inbox strategy card renders
`strategySnapshot` under the proposal: objectives, KRs with target/unit and their measure source,
period, horizon, executive and org. It also has an "Open strategy" link. `ApprovalsInbox` is not in
the entry chunk (it is reached only through lazy routes and tiles), so no extra `lazy()` is added.

**D7 — The run's actor comes from the scope (`STR3WF-7`).** `surface.checkIn` and
`surface.syncMetrics` attribute `run:<scope.runId>` when it is present, else `args.actor`, else
`'workflow'`.

**D8 — A metric source must be an org the writer can read (`STR3CD-6`, added by `/grade-code`).**
A KR's `measure.source.orgId` names the org whose CRM / commerce / analytics data feeds the KR,
and the standing source is what authorizes CONFIRMED sync writes. It was shape-checked only, so
a writer in org A could point a KR at org B's data, and the next sync copied B's totals into A's
check-ins. Create, PATCH (objectives) and restore now require `workspace:read` in every source
org they INTRODUCE OR CHANGE (`requireMetricSourcesReadable`). A source already on the same KR is
not re-checked, so editing a KR someone else configured does not lock the editor out. A
human-started run's `syncMetrics` skips a source org its starter cannot read
(`source_not_readable`). The cadence (actorless) sync is unchanged.

**D3 addendum — relocation is a protected change (`STR3CD-3`, `/grade-code`).** Moving an
APPROVED, non-terminal strategy to another org (`PATCH {orgId}`) returns it to draft with the
gate ON, and `autoRevertedFields` names `orgId`. Its approval came from the old org's approvers;
the move itself asked only for `workspace:write` in the destination.

## Alternatives weighed

- **Withdraw-on-write only (fix the two writers).** Rejected as the guarantee: it is the
  generator. Kept as UX on top of D2.
- **Bind to the revision number.** Revision append is fire-and-forget (`void appendStrategyRevision`),
  deduped and capped at 50, so `n` can be missing or pruned. A digest is computed synchronously
  from the row.
- **Value-diff the PATCH as well.** It would stop reverting saves that change nothing, which is
  better UX, but it changes ADR 0597's deliberate presence semantics on the hottest verb. Deferred
  (`STR3WF-F1`). The decide exit (D2) is value-based, so the guarantee does not depend on it.
- **Refuse self-approval unconditionally.** This would brick the default one-admin workspace.
  Rejected; ADR 0732's rule is used instead.
- **Run lane: let the creator's run read their own private drafts.** This widens access. Rejected;
  `isShared` stays.

## RBAC / replay / wire

- RBAC: no new scopes. The decide bar is unchanged (`host:members:manage` in the org), plus SoD.
  The run lane gains the route's predicates.
- Replay: the surface is a read/proposal surface. `checkIn` from a run is replay-classified as
  before (node roles unchanged). No pack content change is required.
- Wire: none. Host-extension routes and host-internal approval fields only (`strategyContentDigest`,
  `strategySnapshot`, `requestedBy` on the `strategy-activation` row). **RFC verdict: host-ext, no
  RFC.**
- Data: the new approval fields carry `requestedBy` (a subject id), so the approval redactor/DSAR
  must cover it. `strategySnapshot.accountableExecutive` is free text already on the strategy row.

## Product decisions (user-visible)

1. With the gate ON, a CSV import or a version restore that CHANGES protected content on an active
   or paused strategy returns it to Draft (it needs approving again) and withdraws a pending
   review. The response says so. One that changes nothing does neither.
2. With the gate ON, creating a strategy directly as Active creates it as Draft and submits it for
   approval.
3. With the gate ON and a second admin in the strategy's org, the person who submitted an
   activation can no longer approve it themselves, by session or by their own API key (403, with
   a message). A sole admin still can. The rule binds the SUBMITTER, not whoever authored the
   content, so an admin who edited the objectives can still approve an editor's submission.
4. A pending activation whose content or org changed by any route is refused at approve time (409,
   card closed with the reason), not activated. Re-submitting replaces a stale card.
5. A human-started workflow run, including runs from a user-created schedule, sees only the
   strategies its starter can read. It can propose check-ins only on those, and write confirmed
   (sync) values only on strategies the starter can write. A denied check-in fails the node
   instead of succeeding with nothing. Strategy cadence fires are unchanged.
6. Two writes that race on one strategy no longer silently erase each other: the second gets a 409
   ("changed since you opened it") and nothing is lost.
7. The approval card shows the full content being approved, and links to the strategy. For a
   user-scoped (private) strategy, this shows its content to the org's approvers, who must see it
   to approve it. The link 404s for them, because they cannot read a private strategy. The snapshot
   stays on the resolved approval row under the approvals retention policy.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 run lane + verb ratchet + `canSubjectWriteStrategy` single rule + node typed error (pack bump) | `strategy-activation-binding` STR3WF-1 legs |
| P2 | D4 single-attempt CAS + `base` + precondition; side effects once | stale-base 409 leg |
| P3 | D2 binding + digest + decide verification + re-submit refresh | digest-mismatch leg (a direct service write that skips withdraw), relocation leg |
| P4 | D3 gate helper on PATCH / restore / import / create + writer ratchet | STR3WF-2/-3/-8 legs |
| P5 | D5 canonical `requestedBy` + org-scoped distinct holder + redactor | STR3WF-4 legs incl. API-key + `ws:` sub-org legs |
| P6 | D6 inbox card snapshot + D7 | FE test, surface actor test |

## Architect pass (2026-10-06, before code)

An independent adversarial review of the first draft found 2 Blockers, 3 High, 4 Medium and 7 Low
issues, all in the decision text. Each was verified against the code before it was folded in.
- **B1 (D3).** `POST /strategy {status:'active'}` created a live strategy with no approval
  (`strategyService.ts:418`, `routes.ts:331`). That was a fourth writer, and it already shipped;
  the draft's ratchet, which listed only `updateStrategy(` callers, could never see it. It is now
  `STR3WF-8`, and the ratchet covers every writer of the collection.
- **B2 (D4).** "Retry from a fresh read" re-applied patches computed from the stale row, together
  with a gate decision made against that row. A PATCH that decided "no revert" against a draft
  could land on a row a decide had just flipped to active. The retry turned a safe 409 into the
  exact bypass. Writes are now a single attempt against the caller's base row.
- **H1.** Relocating a strategy left the approval in the old org (not protected, not withdrawn), so
  the old org's admins approved. The binding now includes `orgId` and `scope`.
- **H2.** "The snapshot is the data the digest covers" was false: the snapshot was a capped subset
  that hid `measure.source`, the field that authorizes confirmed sync writes. The snapshot is now
  the binding, uncapped (it is bounded by the limits).
- **H3.** A raw `requestedBy === decidedBy` compare is bypassed by approving with your own API key.
  Adding an `orgId` filter on top of the shared-workspace root-only skip would always answer "no
  distinct holder". Both are specified in D5.
- **M1–M4.** User schedules DO carry an actor. Agent-mode check-ins needed only read. The null
  check-in was success-with-empty. Restore was presence-based on a newly gated site. The
  redactor/snapshot disclosure was unnamed. All are folded into D1/D3/D5 and the product decisions.
- **L1–L7.** Use the `forbidden` code rather than a new error code. No lazy-load is needed. A stale
  pending card is refreshed on re-submit. The pre-check close carries no approver attribution. The
  digest is computed from one object. D7 covers `syncMetrics`. SoD binds the submitter.

## Corrections found during implementation

- **D6 said the card would show "everything the digest covers". It does not.** It shows the period
  (with dates), horizon, executive, every objective and KR, the KR target, and the metric source
  KIND. Weights, the measure's baseline and direction, the source org and query, and the
  org/scope are reached through the "Open strategy" link (`STR3UX-4` / `STR3CD-5`). The binding is
  unaffected, because the digest is computed over the full snapshot.
- **D6 said "no extra `lazy()`", which was right, but a separate component FILE was still a cost.**
  `StrategyActivationSnapshot` in its own file became a shared chunk, and the entry chunk's
  preload map gained its name (about 50 B, measured). It now lives in `ContentReviewContext.tsx`,
  which both inboxes already share.
- **Product decision 7's "under the approvals retention policy" was half true.** Resolved rows
  are capped per tenant (`pruneResolved`), but a closed row kept its full snapshot (4.5 MiB at the
  caps). Resolving a `strategy-activation` now drops `strategySnapshot` and keeps the digest
  (`STR3CD-4`). A card re-opened after a failed decide therefore shows the "no preview" line; the
  digest still binds it.
- **The Overview save defeated presence semantics on its own (`STR3UX-3`).** It sent
  `planningHorizon` and `accountableExecutive` on every save, so a summary typo deactivated an
  active strategy. It now sends only the fields that changed. The backend rule is unchanged
  (`STR3WF-F1` stays deferred).
- **An absent caller now reads no strategy.** `canSubjectReadStrategy(undefined)` used to resolve
  as the tenant owner. A board context resolved with no convener (`resolveBoardStrategyContext`)
  therefore gets no strategy block, counted as an authorization drop (`STR3CD-8`). This is the
  ADR 0839 D1 rule, applied deliberately.
- **Seeded demo admins count as second approvers (`STR3CD-11`).** The demo-people seeder creates
  real member rows with `admin`, so in a seeded workspace the real sole admin cannot approve
  their own submission. This matches the ADR 0732 environment-promotion behaviour, and is
  recorded rather than special-cased.

## Implementation record

Commits on `feat/fl2-27-strategy` (cited by subject, not sha):

| Phase | Commit subject | Witness |
|---|---|---|
| P1–P5, D7 | `fix(strategy): activation binds the version approved; one protected-write gate; run lane asks the starter (ADR 0845 D1-D5, D7)` | `test/strategy-activation-binding.test.ts`: 6 legs born red on `c1d746c08` (STR3WF-1 ×2, -2 ×2, -3, -4) |
| P6 | `feat(notifications): strategy approval card shows what is approved (ADR 0845 D6)` | `strategyActivationSnapshot.test.tsx` |
| grade-ux | `fix(strategy): grade-ux row 27 — the screen says what the gate did (STR3UX-1..3, ADR 0845)` | `strategyR5Adr0845.test.tsx` |
| grade-code, D8 | `fix(strategy): grade-code row 27 — relocation re-opens review, metric sources need read, snapshot dropped on resolve, uniform not-found, eraser CAS (ADR 0845 D8, STR3CD-1..12)` | relocation, metric-source, legacy, strip and behavioural-sweep legs |

**Sabotage witnesses.** Each guard was removed, its named leg went red, and the guard was
restored, with the source committed before each sabotage:
- S1: surface read
- S2: surface sync write
- S3: decide digest pre-check
- S4: import gate
- S4b: import withdraw
- S5: restore gate
- S6: create gate
- S7: separation of duties
- S8: key canonicalization
- S9: `ws:` org-scoped holder
- S10: CAS
- S11: typed node error
- S12: re-submit refresh
- S13: relocation
- S14: metric-source read
- S15: snapshot strip
- S16: surface check-in read

17 sabotages, 17 bit. Not independently witnessed: the decide flip's CAS precondition (a race
between the pre-check and the swap). It is held by reasoning plus S3, because removing the
pre-check leaves the precondition as the only thing refusing, and the leg still goes red on the
card.

Pack: `feature.strategy.nodes` 1.3.1 → 1.3.2 (`check-in` fails typed instead of succeeding with
null). The steward manifest was regenerated, and the `pack-surface-arg-parity` fixture moved only
by line numbers.

## Open questions

- [ ] How many PENDING `strategy-activation` rows exist in prod (they lack a digest, so the legacy
      fallback applies)? If zero, the fallback can log-and-refuse instead. *(asked of the orchestrator)*
- [ ] How many tenants have `strategy-approval-gate` ON? This sizes product decisions 1–3.
- [ ] `STR3WF-F1` — value-diff semantics for PATCH (deferred).
- [ ] Actorless-run `orgScopeSubject` narrowing (residual, shared with ADR 0842).
