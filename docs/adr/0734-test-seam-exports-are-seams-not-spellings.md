# ADR 0734 — A test-only export is a seam, not a spelling

Status: Accepted (implemented; see § Implementation record)

Date: 2026-09-19

Related: ADR 0599 §6 (removed the insights-suite toggle-status registrant), ADR 0610,
ADR 0359 (collab room lifecycle), ADR 0464 (subject erasure), ADR 0690 (KickTodo readiness)

## Context

A cleanup sweep inventoried **53** exported helpers in `backend/typescript/src` matching
the repo's test-only naming conventions (`__resetFoo`, `_fooForTest`, `fooForTesting`) that
no code anywhere references. Out of 350 test-shaped exports total, that is roughly one in
seven. They are not free: `scripts/build-whitelabel-zip.sh` is a `git archive` of `HEAD`,
so all of `src` ships to every adopter as a source fork, and an exported symbol in that
tree reads as API even when the `__` prefix says otherwise.

The obvious action is "delete all 53." An architectural review of that proposal found it
**wrong in a way the reference scan could not see**, and the error is the point of this
record.

## The finding that changed the decision

`__stopCollabLeaseHeartbeat` and `__stopCollabUpdateSweep` (`host/collab/collabRoom.ts`)
are the repo's **only** stop-a-boot-started-interval seam, against 30 `setInterval` sites
in `src`. `attachCollabWebSocket()` arms a 5-minute sweep and a **20-second** heartbeat.
**Six test files call it and none stopped them.**

> ### § Correction (2026-09-19, before merge) — the evidence in this section was invented
>
> This section originally argued that vitest "re-evaluates the module graph per test file
> but does not restart the process", so a full run "accumulated up to a dozen live
> intervals in one worker", each reaching `evict()`'s uncaught detached IIFE and surfacing
> as an order-dependent red in an unrelated file.
>
> **That is false, and measuring it takes one probe.** Two test files, run with
> `--maxWorkers=1 --fileParallelism=false` (the case most favourable to the claim):
>
> | file | pid | `globalThis.__probeMarker` | interval fires seen |
> | --- | --- | --- | --- |
> | A (arms both) | 4852 | `set-by-a` | — |
> | B (reads after 400ms) | 4838 | `undefined` | `undefined` |
>
> Different processes. Vitest v4 defaults to the forks pool with `isolate: true`, and
> `vitest.config.ts` overrides neither, so each test file gets a fresh child process that
> is destroyed afterwards. **A timer cannot cross a file boundary because the process does
> not survive it.** Two further facts make the original claim unrecoverable even within one
> file: both timers are module-level singletons behind idempotent guards
> (`collabRoom.ts:165`, `:354`), so six `attachCollabWebSocket()` calls arm **one** of each,
> not twelve; and both are `unref`'d, so they never hold a process open.
>
> The ADR contradicted itself on this — its own § Residual already said module state cannot
> leak across files under forks + isolation. The residual was right.
>
> **The decision does not change; the justification does.** Wiring the two stops is correct
> hygiene: it stops a 20-second heartbeat from firing during the rest of that same file's
> teardown, it leaves the module registry as the file found it, and it becomes genuinely
> load-bearing the day anyone sets `isolate: false` or moves to the threads pool. What it is
> NOT is the fix for an observed cross-file leak, and anyone who reads this ADR must not go
> hunting one. Of the five wirings, the two that are load-bearing **today** are the
> INTRA-file ones: `adr0464-host-subject-erasure.test.ts` (`beforeEach`) and
> `kicktodo-readiness.test.ts` (`afterEach`), where one `it()` really does inherit the
> previous one's registry.
>
> `evict()`'s missing `.catch` was misdescribed the same way. Every `await` inside that
> detached IIFE is already internally caught — `persist()` (`:584`/`:680`),
> `deriveHostCanvas()` (`:231-280`, both branches), `putLease()` (`:301-312`), and
> `leases.delete(...).catch()` (`:773`). The only unguarded statements are the synchronous
> `awareness.destroy()` / `doc.destroy()`. So no rejection was observed and none could be.
> The `.catch` is still worth having — under Node's default `--unhandled-rejections=throw`
> a future uncaught await there would kill a Cloud Run instance — but it is a guard against
> a future defect, not a fix for a present one.
>
> **The transferable lesson is the one this repo keeps paying for: a mechanism I could have
> measured in ninety seconds was instead described from memory of how test runners
> generally behave, and the description was confident, specific, and wrong.** It survived
> writing an ADR, six file edits and a commit message. It did not survive the first probe.

## Decision

**The reviewable unit is the seam the helper resets, never the name it is spelled with.**
When a test-only export has no reader, classify before acting:

| Situation | Action |
| --- | --- |
| The seam is dead — its registrar has no callers either | Delete the **whole** seam |
| The seam is live and a test dirties it without cleaning up | **Wire** the helper into that test's teardown |
| The seam is live in production and untouched by tests | Delete the helper alone |

That third row is the majority and it is correct. The first two are where a name-shaped
sweep does damage.

Applied to the 53:

- **52 deleted** (the third row). All seven registrar-style seams among them
  (`registerEntitlementCheck`, `setCrmVisibilityResolver`, `setUserDisplayResolver`,
  `setAgentLabelResolver`, `onConversationDeleted`, `setManagedBalanceProvider`,
  `registerTenantEntitlementCheck`) were checked and **every one has live callers** — so
  only their reset helpers were dead.
- **2 wired** — the collab stops above. Hygiene and defence-in-depth, not a fix for an
  observed leak; see the correction note.
- **3 wired** (the second row), each a case where a test calls the mutator and never
  cleans up: `__resetFeaturePacks` (`kicktodo-readiness.test.ts` pins a fake
  `feature.kicktodo.never-shipped@9.9.9` on the real `kicktodo-core`, and the next `it()`
  read that poisoned blocker list — passing only because the assertions are loose
  `.some(/regex/)` matches); `__clearFeatureSurfaces` (four files, two of which register
  the entire `BACKEND_FEATURES` surface set); `_resetRunnerRegistryForTest`
  (`adr0464-host-subject-erasure.test.ts` carried registry residue between cases).
- **1 seam deleted whole** (the first row). `__resetToggleStatusListeners` was the
  clearest illustration of the failure mode: `registerToggleStatusListener` has **zero**
  callers in `src` and `test`, because ADR 0599 §6 removed its only registrant. A
  name-shaped sweep would have deleted the reset and left a live registrar with no
  consumer and no way to unregister — a worse end state than doing nothing. The type, the
  array, the registrar, the reset **and both dispatch loops** (which iterated an array
  that could never be non-empty) are gone together, with a comment recording how to
  restore the whole thing if a feature needs it again. Stronger still than "dead": it was
  **superseded and unsound**. `docs/steward/WORKFLOWS-ASSESSMENT.md` (ISWF-8) records that
  this listener fired only on a global `status` change, so `on → beta`, a narrowed
  `betaCohort` and a `tenantOverrides` flip all escaped it; ADR 0599 §6 replaced it with a
  resolution-aware fire-time gate. Deleting it removes a trap, not an affordance.

## Ratchet

`backend/typescript/test/test-seam-export-ratchet.test.ts` fails when a test-shaped export
in `src/` has no reader.

**It is in the shipped test lane, not `test/steward/`.** The strip rule exists to stop
tests reading paths the white-label bundle removes; this one reads only `src/`, so it
reads nothing stripped — and it *must* ship, because the invariant is one adopters should
keep enforcing on their own fork. Under `test/steward/` it would be stripped out and every
adopter silently exempted.

Three design choices, each from a recorded past failure:

1. **The floors sit on the denominator, not the violation count.** `srcFiles.length ≥ 1650`
   (measured 1741) and `decls.size ≥ 260` (measured 290). A glob that stops matching, or a
   detector that stops recognising the shape, reds instead of passing an empty assertion.
2. **The spelling set covers all four conventions.** The sweep's own first-draft regex
   missed the `ForTesting` suffix, which is live at `host/surfaceBackends.ts`,
   `host/durable/durableKv.ts`, `host/sql/pgSql.ts`, `host/durable/durableSql.ts` and
   `byok/kmsEncryption.ts`. All five are referenced, so the deletion set was not
   under-inclusive — but a ratchet carrying that regex would have waved the next
   zero-reference `_resetFooForTesting` straight through.
3. **Comments do not count as readers, and the ratchet does not count itself.** A docblock
   saying "we used to call `__resetFoo`" must not hold `__resetFoo` alive. The ratchet's
   own prose names every swept symbol, so it excludes its own file — its first draft's
   negative control failed for precisely that reason, which is the argument for having a
   negative control at all.

## Alternatives weighed

- **Delete all 53 as proposed.** Rejected: it removes the only timer-teardown pattern in
  the repo while the leak it addresses is live, and it leaves the half-dead toggle seam in
  a worse state than before.
- **A `no-unused-export` lint.** There is no ESLint in the backend (`"lint"` is
  `tsc --noEmit`), and a generic unused-export rule cannot make the seam-vs-spelling
  distinction this ADR is about — it would prescribe deletion in all three rows.
- **Keep the helpers as documented extension points.** Rejected for the 47: the `__`
  prefix is the repo's own "not API" marker, nothing in `ARCHITECTURE.md`, `README.md` or
  `docs/` names one, and `backend/typescript/package.json` is `"private": true` with no
  `files`/`exports`.

## Residual, stated plainly

- **An adopter who forked earlier and wrote tests against a deleted helper gets a compile
  break on upgrade.** This is a source fork, not a package surface, so the break is loud
  and local. It belongs in the `/cut-app-release` "Upgrading from" note, not in a decision
  to keep dead code. Precedent: `__clearGmailSyncs` (#3961) and
  `__resetExperimentStampResolverForTests` (#3972) were deleted on the same reasoning.
- **The ratchet proves a symbol has A reader, not a GOOD one.** A helper referenced only
  by a skipped test still passes. That is a weaker invariant than "is exercised", and the
  stronger one is not cheaply decidable.
- **Comment-stripping is regex-based.** A symbol named only inside a string that contains
  `//` could in principle be missed. Measured today: stripping changes the orphan list not
  at all (still empty), so there are no false positives in the current tree.
- **`vitest` isolation carried the argument for 48 of the 53 — and for the other 5 too.**
  Nothing survives a file boundary under forks + `isolate: true`, timers included
  (measured; see the correction note). So "a test should reset this and doesn't" was a
  false premise for every CROSS-file case. The wirings that matter are intra-file.
- **The `.catch` on `evict()` trades a crash for a leak.** If `awareness.destroy()` throws,
  the lease was already deleted but `rooms.delete(canvasId)` is skipped, so `hasLiveRoom()`
  reports true locally with no global lease. Previously that crashed the instance, which
  cleared it. A persistent bad state behind one log line is still better than killing a
  multi-tenant server, but it is a trade, not a pure win.
- **The ratchet's comment-stripping is not string-literal aware.** A `/*` inside a string
  literal starts a bogus strip. This direction is safe — it yields FALSE POSITIVES (a live
  symbol reported dead, i.e. a red someone must read), never a false green. Measured: no
  effect on the current tree.
- **The ratchet reads three trees, not one.** `src/`, `test/` and repo-root `scripts/`.
  The white-label conclusion is unchanged — `scripts/` ships, and zero of the 300 seams are
  referenced only from the stripped `test/steward/` lane, so stripping cannot orphan one
  and red an adopter's first `npm test`.

## Generalisation beyond the test-shaped name

The architectural review for the follow-on phase asked whether this rule should be applied
to the whole internal-only export surface. **Measured, then declined for the majority.**

| population | count |
| --- | --- |
| exported symbols in `backend/typescript/src` + `frontend/react/src` | 15,762 |
| with no reference outside their declaring file | 1,731 |
| of those, **declaration-only** (not even used in their own file) | 114 |
| of those, test-seam-shaped (this ADR's population) | 43 |
| **genuinely dead, non-test-shaped** | **71** |

Two independent methods agreed on 71. Script: `docs/steward/phase-d-measure.mjs`; full
list and per-symbol classification: `docs/steward/PHASE-D-GROUNDWORK.md`.

**The 1,617 internal-only symbols that ARE used inside their own file are deliberately NOT
swept, and that is a decision rather than an omission.** Un-exporting them is
type-safety-neutral here — `backend/typescript/tsconfig.json` sets `"declaration": false`
and the frontend `"noEmit": true`, so TS4023/TS4053 ("has or is using private name") cannot
fire, and a consumer of an exported signature whose parameter type is un-exported still
gets full checking with the type named in the diagnostic. It does not reduce shipped bytes
(the white-label bundle is a `git archive` of the whole tree). It would touch ~874 files
against ~34 live worktrees, and a reviewer could not distinguish a correct `-export` from
an incorrect one by reading the diff, because the compiler will not tell them either.
`noUnusedLocals: true` already IS the ratchet for the valuable case: dropping `export` from
a symbol with no in-file use becomes a TS6133 immediately.

**The three-row table transfers unchanged, and the follow-on phase found the same trap.**
Roughly a dozen of the 71 are reset / cache-invalidation helpers named with neither a
leading underscore nor a `ForTest` suffix, so no spelling-keyed sweep could see them — and
four of the 71 are row 2, where the dead symbol is the **missing limb of a live feature**
rather than a leftover:

- `devtools/networkRecorder.ts#appendSseEvent` — the panel renders an SSE event timeline
  and it is localized into four languages, but this is its only writer and nothing calls
  it, so the field is always `undefined` and that view can never show anything. The
  repo's recorded "rendering ≠ working" family.
- `kanban/AssigneeControl.tsx#invalidateMembersCache` — exists so the member list reloads
  after invites; unwired, so the list is stale for the life of the page.
- `host/packRevocations.ts#listPackRevocations` / `#unrevokePack` — `isPackRevoked`
  enforces in production and boot loads the rows, but `revokePack` has only test callers.
  A pack can be *enforced* as revoked while no operator can create, see, or lift one.
- `webinars/entities/marketingEvent.ts#deleteMarketingEvent` — the entity's only delete
  path, uncalled; webinars registers a subject eraser and a retention purger for
  `pendingPush` only, so those rows are deleted by nothing at all.

A reference-count sweep deletes all four, and each deletion makes a live gap permanently
harder to close. That is the same argument this ADR makes for the collab stops, arriving
independently in a different population.

## Implementation record

| task | change | witness |
| --- | --- | --- |
| classify | 58 inventoried → 52 delete / 5 wire / 1 seam-delete | this ADR |
| hygiene | `__stopCollab*` wired into 6 `afterAll`s | the six collab test files |
| future-proofing | `evict()`'s detached IIFE gets a `.catch` | `collabRoom.ts` |
| dead seam | `ToggleStatusListener` + registrar + reset + both dispatch loops removed | `tsc` clean |
| conditionals | `__resetFeaturePacks`, `__clearFeatureSurfaces`, `_resetRunnerRegistryForTest` wired | 6 test files |
| sweep | 52 exports deleted, anchored at `export`, comment block only if adjacent | 55 export lines removed = 52 + the 3-symbol toggle seam; no collateral |
| ratchet | `test/test-seam-export-ratchet.test.ts`, shipped lane | 5 tests incl. positive, negative + duplicate-name controls |

**Sabotage-verified, three ways — two of them added because the first version failed them.**
Re-adding `__resetPriceLists` reds the ratchet by name. Review then found two blind spots
and both are now closed:

- **Duplicate declaration names.** `decls` was `Map<symbol, file>`, so 11 separate `__test`
  declarations collapsed to one entry and ten were never inspected — and the other ten
  declaration LINES each counted as a reader of the survivor. Appending a dead
  `export const __test` to `host/subjectDisplay.ts` left it 4/4 green. Keys are now
  `file#symbol`, sibling declarations are excluded, and for a name declared in more than
  one place a mention only counts when its IMPORT SPECIFIER resolves to that module. The
  sabotage now reds.
- **The spelling set had the very hole this ADR claims it closed — twice.** The shipped
  regex was `[A-Za-z0-9_]*ForTest(?:s|ing)` (suffix not optional), so a bare singular
  `clearConfigDomainsForTest` was invisible; six such symbols are live in `src`. Fixed,
  plus `class|var|enum` in the declarator list. **Then a second, larger hole:** the rule
  keyed on a DOUBLE leading underscore, and `src` holds **43 single-underscore exports** it
  could not see — `_resetHostSurfaceRegistry`, `_resetMcpRouterCaches`,
  `_resetEnvelopeAcceptorCaches`, `_resetRateLimitState`, `_resetOidcVerifier`,
  `_resetBreakGlassAttempts` and the rest. Every one is a test seam by name and none is
  plausible public API, so a single leading underscore IS the marker. Widening it surfaced
  **five more orphans**, all deleted here after the same three-row classification (each
  one's seam is live in production — `registerHostSurface` 3 callers, `acceptEnvelope` 7,
  `normalizeEnvelopePayload` 1, `dispatch` 591 — so only the helper was dead).

  **A docblock-intent rule was tried and rejected**, and the rejection is the useful part:
  matching "test seam" in a 6-line context window above a declaration attributes
  NEIGHBOURING prose to the symbol and flagged 53, including plain types like `Principal`
  and `VmExecResult`. False positives red an innocent build, so the detector stays keyed on
  the name and the miss-rate is closed by widening the name rule instead.

The first draft also failed its own negative control, because the ratchet's prose names
every swept symbol and the ratchet was reading itself. That is the argument for having a
negative control.

**Count reconciliation.** `docs/steward/CLEANUP-LOOP-2026-09.md:38` files the original
measurement as *54 of 350*; this inventory is **53**. The delta is
`__resetExperimentStampResolverForTests`, already deleted in tracker row 9 (#3972). An
unexplained off-by-one in a sweep's opening measurement is how its floor becomes
untrustworthy, so it is reconciled here rather than left to the next reader.
