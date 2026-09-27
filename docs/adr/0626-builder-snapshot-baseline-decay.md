# ADR 0626 — The /builder snapshot baseline decays by design, and an advisory lane cannot notice

Status: Accepted — P2 implemented 2026-09-02 (pinned fixture). P1's refresh was
attempted, measured stale within 24h, and deliberately withdrawn; the baseline is
re-recorded here as the LAST step of P2, which is the only order that holds.

## Context

The `/builder` route snapshot (`e2e/route-snapshots.spec.ts`, `@advisory`) has been
failing on `main` for roughly two weeks. Measured 2026-09-01 at `39cd3dd34` on an
idle machine, using `ci.sh`'s own boot recipe (own pack dir,
`OPENWOP_MOUNT_LOCAL_PACKS=false`, memory storage):

```
builder @light / @dark:  15959 → 17598px,  ratio 0.20 of all pixels differ
```

The baseline on disk was recorded in `9988b8d76` (2026-08-16). Since then **three**
commits added chain packs — #3333 (2026-08-18), #3398, #3577. Cropping the top of
expected vs actual and reading it: the new tiles (`kicktodo-accountability`
"Session reminder", `insights-suite`, `it-support`) push the existing tiles down and
**reflow the three-column grid**. Every pre-existing card renders identically; they
have only moved. There is no visual regression. The baseline is simply out of date.

### This was already diagnosed, and that is the actual finding

The 15959px render is *already* identified in the project's own notes as
"pre-#3333 — recorded before a chain pack added a gallery card", written
2026-08-18. Verified here: #3333 landed 2026-08-18, the baseline commit is
2026-08-16, and #3333 is not an ancestor of it. So the cause was understood within
two days and the baseline was still never re-recorded.

Nothing forced anyone to. `scripts/ci.sh` runs this pass and prints

> ⚠ advisory: the @serial/@advisory e2e pass … FAILED — not failing THIS step.

so `npm run ci` — the merge gate — exits 0 while the lane is red. **A gate that can
fail without consequence decays.** This is the same disease as the Conformance Soak
sitting red for 40 runs and #3050 leaving `main` red for five commits, one notch
quieter each time because nothing goes red in front of anyone.

### Measured decay rate: ~1 day, and the cause is wider than chain packs

The refresh below was recorded at `39cd3dd34` (2026-09-01), inspected, and
confirmed green by a full `npm run ci` — the advisory warning absent for the first
time. Re-verified the next day at `f2862cdd6`: **stale again, 17598 → 17946px.**

The cause is not a new chain pack (none were added). #3617/#3621 **reworded an
existing chain pack's description** — `examples/workflow-chain-packs/people-hr`
gained a sentence about `feature.orgs.nodes.invite` plus two new params — and the
card reflowed. Found by grepping Playwright's `error-context.md` page dump for the
new node id and reading the surrounding ARIA node, then diffing that pack.

So the invalidating surface is **any edit to any chain pack's prose or params, by
any feature team** — not, as an earlier draft of this ADR said, only commits that
ADD a chain. That is a far larger surface, touched by routine feature work that
never opens `/builder`, and it is why the refresh has a shelf life of about a day.

### The decay is structural, not an oversight

ADR/DSYS-4 (H33, `9988b8d76`) deliberately gave the e2e boot its own pack dir so the
snapshot is **a function of the commit** rather than of `~/.openwop-packs`. That was
correct and remains correct. Its consequence is that **every commit adding a chain
pack legitimately invalidates the /builder baseline** — the page really is different,
because the repository really is different.

So "re-record it" is not a fix. It restores signal until the next chain pack lands,
which on current cadence is days. Any solution that does not address *who re-records
and when* returns to this state.

### A latent hazard that makes naive regeneration unsafe

`/builder` waits for the chain-pack load with `waitForTimeout(1500)` — right under
the full suite (the non-serial `test:e2e` pass runs first, so the load has long
completed) and wrong in isolation. Regenerating with `--grep builder` from a cold
boot can therefore bake in a **mid-load** render: a baseline asserting repository
content the commit does not contain. That exact failure has happened once already.
`/chat` uses `waitForSelector(...)` for this class; `/builder` does not.

## Decision

**P1 — refresh the baseline: ATTEMPTED, VERIFIED, AND WITHDRAWN.** It was
regenerated in the environment that asserts it: full non-serial `test:e2e` pass first to complete the pack load,
then `--grep builder --update-snapshots` only — never a blanket update of the serial
lane, which would silently re-record other baselines that may be red for real
reasons. Verified by inspection (all three post-baseline chains present and fully
rendered, so not a mid-load capture) and by two independent gate-condition runs on
the same commit (A ≡ B ⇒ deterministic, so the baseline is recoverable rather than
the page being unstable), and a full `npm run ci` went green with the advisory
warning line absent.

**It is still not shipped.** The next day's `main` already invalidated it. A
baseline with a one-day shelf life buys a few hours of green, costs a ~3.8 MB PNG
churn per refresh, and — worst — briefly hides a red lane that should stay visible
until it is fixed properly. Recoverability is now *proven* (that was the open
question); shipping the artifact is not the same thing as proving it. **Whoever
takes P2 should re-record as the LAST step of that change, not before it.**

**P2 — the structural choice, OPEN.** Three candidates, none free:

| option | cost | what it gives up |
|---|---|---|
| **A. Make the lane fatal** | every chain-pack PR reds the gate until its author re-records | pain is on the right person, but a 20-min gate failure for a legitimate content change is a strong tax, and a fatal lane with a known-stale baseline is worse than an advisory one |
| **B. Mask the gallery region** | small, mechanical | the gallery's own layout loses all visual coverage — and the gallery IS most of the page |
| **C. Render a FIXED fixture set** | the e2e boot points at a pinned chain-pack subset rather than the live `examples/` | most coverage retained and stable, but the snapshot stops asserting the real gallery, and someone must keep the fixture representative |

**Recommendation: C, with the fixture pinned in-repo next to the spec**, because it
is the only one that keeps the page under visual contract *and* decouples the
baseline from unrelated feature work. B is the cheap fallback if C's fixture proves
burdensome. A alone should not be chosen while the baseline can be invalidated by a
commit that never touches `/builder`.

**CORRECTED 2026-09-02 — this recommendation was already done, and I read a
comment instead of the code.** An earlier draft said to replace `/builder`'s
`waitForTimeout(1500)` with a `waitForSelector`. The spec has waited on
`[data-chains-state="ready"]` since **#3365** (`8a9bcde56`, H86); the remaining
1500ms is a generic settle, not the pack-list race. The sentence I based the
recommendation on was the spec's own stale comment, still describing pre-#3365
code. Same class as every other doc-vs-code miss in this repo: **a comment is a
claim about the code, not the code.**

## Implementation record

| Phase | Change | Verification |
|---|---|---|
| P1 | Re-record attempted at `39cd3dd34`, then **withdrawn** | inspected both themes; two gate-condition runs green (A ≡ B); full `npm run ci` green, advisory line absent — then stale at `f2862cdd6` one day later (+348px) |
| P2 | **Not done — decision open** | — |

## Open questions

- Does anything else in the `@serial/@advisory` lane depend on repository content
  the same way? This ADR measured `/builder` only, and found it by accident while
  running the gate for unrelated work.
- How long has the *rest* of the advisory lane been red? "Advisory" hides count as
  well as cause, so nobody has a number — including this ADR.


## Implementation record — P2 (2026-09-02)

**Option C (pinned fixture), as recommended.** The e2e boot's gallery is now a
function of the SPEC rather than of the repository.

| # | Change | Why |
|---|---|---|
| 1 | `OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0` drops root 3 in `defaultWorkflowChainPackRoots()` | root 1 is a PRECEDENCE override, not an exclusive one — pinning your own chains still inherited every example underneath |
| 2 | `frontend/react/e2e/fixtures/chain-packs/` — 4 packs, 28 KB, pinned beside the spec | keeps card variety under contract: params / no-params, four feature labels, both chip and button states |
| 3 | `ci.sh` e2e boot sets the fixture dir + the flag | the two lines that make the gallery deterministic |
| 4 | `/builder` baselines re-recorded | **17598px / 3.8 MB → 1246px / 160 KB** |

The flag is not a test backdoor: a white-label adopter shipping their own
catalogue has the same need, and `!== '0'` mirrors `OPENWOP_CHAIN_SUBCHAINS` in
the same module.

### The trap that ate the first attempt

`features/app-builder/designWorkflow.ts:51` has an `ensureChainLoaded()` fallback
whose comment says it loads *"OUR pack directly"* — and whose code loads **the
whole `examples/workflow-chain-packs` directory**. With the examples root dropped,
the app-builder chain was absent at boot, the fallback fired, and the entire
gallery came back: the page grew to 18813px (my fixtures ADDED to the examples)
and the flag looked broken. Fixed here by pinning `app-builder` in the fixture so
the early return holds. **Narrowing that fallback to the single pack its comment
promises is a follow-up** — it is a live second path to the broad root set, and
the next person to drop the examples root will meet it again.

### Verification

| property | how | result |
|---|---|---|
| flag works, default unmoved | `test/chain-pack-examples-root-flag.test.ts` (4) | pass; sabotage `always-suppress` reds 2, truthiness-instead-of-`=== '0'` reds 1 |
| no blast radius | all 10 route snapshots | only the 2 builder baselines regenerated; other 8 unchanged |
| deterministic | two independent gate-condition boots | A ≡ B |
| **immune to the decay source** | reworded `people-hr`'s description — the exact 2026-09-02 edit class | **still green** |
| **still able to fail** | reworded a FIXTURE pack's description | **red**, then green on revert |

The last two are the pair that matters. Immunity alone would be a gate that
cannot fail, which is the disease this ADR is about, one layer over.

### Still open

- **Promoting the lane off `@advisory`.** The objection was "the baseline can be
  invalidated by a commit that never touches `/builder`" — now false. Promotion is
  unblocked and wants a few stability runs behind it; deliberately not done here,
  because a gate-policy change is a separate decision from a determinism fix.
- **Narrowing `ensureChainLoaded()`** to the pack its comment names.
- Whether anything else in the `@serial/@advisory` lane tracks repository content
  the same way. Still unmeasured — "advisory" hides the count as well as the cause.
