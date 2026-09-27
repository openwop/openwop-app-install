# Conformance quarantine (ADR 0550 P1)

`quarantine.json` lists conformance scenarios that are **known to fail** and are
excluded from the blocking gate so the rest of the suite can block.

## Why this exists

`npm run test:conformance` was wired into **no gate at all** — not
`scripts/ci.sh`, not `.github/workflows/ci.yml` — while `conformance/run.ts`'s
own header comment said CI gated on it. Behind that absence the suite drifted
red: **31 failures across 11 files** when first measured (2026-08-11, against
`origin/main` at `3373372b6`).

The choice was between leaving the suite ungated (invisible, unbounded drift) and
wiring a red suite into the gate (blocking every unrelated PR). Neither is
acceptable, so: exclude the already-failing scenarios by name, gate everything
else, and make the list shrink-only.

## This is a debt ledger, not an opt-out

Two different lists, and they must never be confused:

| List | Meaning |
|---|---|
| `OPENWOP_OPTED_OUT_PROFILES` in `run.ts` | "We do **not claim** this capability." An honest absence. |
| `quarantine.json` (this file) | "We **claim** it and we are currently **failing** it." A debt. |

**Never move a scenario from the quarantine into the opt-out list to make
something green.** That converts a failure into a false claim of non-support,
which is exactly the dishonesty ADR 0548 invariant 3 exists to prevent.

## Rules

- **Shrink-only.** `maxEntries` is a ratchet enforced by
  `test/conformance-quarantine.test.ts`. Removing an entry means lowering it in
  the same commit.
- **Every entry needs a reason and a `since` date.**
- **Adding an entry is a deliberate, reviewed act**, and it means a scenario the
  host claims to support is failing. Prefer fixing.
- A quarantined file that no longer exists in the installed suite is a **stale
  entry** and fails the guard — a renamed scenario would otherwise be silently
  un-covered.

## See the truth

```bash
( cd backend/typescript && OPENWOP_CONFORMANCE_NO_QUARANTINE=1 npm run test:conformance )
```


## RESOLVED 2026-08-13 — the quarantine is EMPTY, and it was never host non-conformance

All ten entries are gone. Not fixed one at a time: they shared a single cause,
and the cause was in the harness, not the host.

### What was actually wrong

`conformance/run.ts` boots the backend via `createApp`. `index.ts main()`
therefore never runs, so `ensureLocalPacksMounted()` never fires — the
entry-point hazard CLAUDE.md documents for any non-vitest boot. The node-pack
resolver then read whatever the **shared** `~/.openwop-packs` happened to
contain: a directory other checkouts, other sessions and stale registry
installs all write to.

On the measuring machine, `~/.openwop-packs/core.openwop.ai` was a real
directory containing **only** `.openwop-installed.json` — no `pack.json`, no
`index.mjs`. That pack supplies `core.ai.structuredOutput`, which is the single
node in every `conformance-envelope-*` fixture. The typeId could not resolve, the
run never reached `dispatchStructured()`, and so not one `envelope.*` event could
fire.

**MEASURED, same commit, same code, only the pack directory differing:**

| Pack dir | Result |
|---|---|
| ambient `~/.openwop-packs` | 8 files / 26 tests FAILING |
| vendored packs mounted | **403 files / 2565 tests passing, 0 failing** |

Both `replay-*` entries clear too. The suite is green with the quarantine off.

### Two defects, neither in the code the entries blamed

1. **The harness measured the machine, not the commit.** Fixed: `run.ts` now
   mounts this checkout's vendored packs into a private per-run temp dir and
   logs the count. Not `~/.openwop-packs` — writing there is what created the
   hazard and would race parallel worktrees.
2. **A contentless registry pack dir could never be repaired.**
   `mountLocalPacks.shouldShadow()` returns false when the destination's
   manifest is unreadable, so the dev mount declined and the vendored copy
   stayed blocked permanently, with no repair path short of deleting the
   directory by hand. Fixed, with `test/mount-local-packs-unloadable-dir.test.ts`.

### The correction that mattered most, because it nearly shipped

The first version of the harness fix set `process.env.OPENWOP_PACK_DIR` inside
`main()`. The log said `mounted 208 vendored pack(s)` and ten files stayed red.

`bootstrap/nodePackResolver.ts:24` and `bootstrap/agentPackResolver.ts:24` both do
`const PACK_DIR = resolveDefaultPackDir()` at **module scope**, so the static
import of `../src/index.js` froze the pack dir before `main()` ran. The
assignment was real, the mount was real, and the resolver ignored both. The log
was telling the truth about the mount and nothing about what got used — and it
was read as if it were the second thing.

`resolveDefaultPackDir()` is documented as reading the env *at call time*, and
`test/setup/isolatePackDir.ts` depends on that contract; those two consumers
quietly break it, and `isolatePackDir` survives only because vitest `setupFiles`
run before test imports. The harness now uses a dynamic import, with the reason
recorded at both the import site and the mount site.

### What this says about the ledger itself

The ten entries read *"pre-existing failure on main, not diagnosed"*, which any
reader would take as the host failing a capability it claims. It was not. **A
conformance result that depends on ambient machine state is not evidence about
the host** — and the fact that such a result can be written into a debt ledger,
in good faith, is what made it durable. The earlier diagnosis in this file
recorded a *different* symptom (`workflow_not_found`); that machine state is not
reproducible now, so it is left standing as observed rather than overwritten.

Before quarantining anything again: confirm the failure survives a
**deterministic** pack mount. If it does not, the entry belongs in a harness
bug, not in this file.

## RE-OPENED 2026-08-16 — two entries, and neither is a host failure

`maxEntries` moved 0 → 2. Recording why, because a ratchet that goes back up
without a reason is how the list starts growing again.

| File | Since |
|---|---|
| `src/scenarios/replay-llm-cache-key.test.ts` | 2026-08-16 |
| `src/scenarios/replay-llm-cache-key-portable.test.ts` | 2026-08-16 |

Both assert the **retired v1** LLM cache-key recipe. ADR 0549 P3 implemented RFC
0150 §C recipe v2 (`openwop-semantic-request-v2`), so the host's
`llm-cache-key` seam now answers v2 and the scenarios' locally-recomputed v1
expectation no longer matches.

**The pinned suite contradicts itself, which is the whole reason this is a
quarantine and not a fix.** `@openwop/openwop-conformance` 1.106.0 ships
`semantic-digest-v2.test.ts` alongside these two, and its docblock says v1's
exclusion of `max_tokens`/`stop`/`seed` "**is wrong**… a cache keyed identically
for both returns the wrong response — not a miss, a wrong hit." `spec/v1/replay.md`
agrees: the v1 exclusion list survives only inside a blockquote labelled as the
defect. Neither quarantined scenario mentions RFC 0150; they were not re-pointed
when §C landed.

**Why not just make them pass.** Answering v1 from the seam would make the suite
green by reporting a recipe `callAI` does not compute — a peer would conclude our
cache keys follow v1 and that cross-host replay works under v1 rules, and both
are false. That is ADR 0548 invariant 3's failure mode exactly: a green scenario
licensing a claim the host does not honour. Removing the seam (the scenarios
self-skip on 404) was rejected for the reason stated above about the opt-out
list — it converts a failure into an absence.

**What was NOT dropped.** These files also held assertions that are still
correct, including *"hosts advertising version: 4 MUST advertise
`replayDeterminism.llmCacheKeyRecipe`"*. Excluding a whole file takes those with
it, so they were re-pinned host-side and strengthened in
`test/llm-cache-key-advert-parity.test.ts`: the conformance scenario checked the
advertisement is a string; the host test checks it is TRUE, comparing the seam's
answer to the same `semanticRequestDigestV2` the live path calls.

**EXIT CONDITION.** A conformance bump that re-points these two scenarios at the
v2 recipe. Remove both entries and lower `maxEntries` back to 0 in that commit.
Until then, `OPENWOP_CONFORMANCE_NO_QUARANTINE=1` shows the 4 failures.

## CLOSED 2026-08-16 — the exit condition was met, and it is the FIRST entry to leave this file that way

`maxEntries` is back to 0. Both `replay-llm-cache-key*` entries are gone.

openwop#1011 re-pointed the two scenarios at the RFC 0150 §C v2 recipe, and the
pin bump `@openwop/openwop-conformance` `^1.106.0` → `^1.123.0` brings it in.
Checked against the **installed** package rather than the sibling working tree —
those are different artifacts and only one of them is what the lane runs:

```bash
grep -rl "openwop-semantic-request-v2" \
  node_modules/@openwop/openwop-conformance/src/scenarios/replay-llm-cache-key*.test.ts
```

Both files match. The host was already answering v2; the suite has stopped
asking for v1. Nothing host-side changed to close this.

**Worth naming, because the two emptyings of this file are not the same event.**
The 2026-08-13 emptying was a harness defect — the entries described a host
failure that was not happening, and the ledger made a machine-dependent
measurement durable. This one is the ledger working as designed: an entry was
opened with a falsifiable exit condition, the condition was met by an upstream
release, and the entry left on exactly those terms. That is the difference
between a debt that is paid and a debt that was never owed.

The assertions rescued host-side when the files were excluded
(`test/llm-cache-key-advert-parity.test.ts`, which checks the advertisement is
TRUE and not merely a string) **stay**. They are stronger than the conformance
scenario's version and cost nothing to keep.
