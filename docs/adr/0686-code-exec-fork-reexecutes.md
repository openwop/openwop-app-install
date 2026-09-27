# ADR 0686 — A fork re-executes real code, under a docblock that says it never does

Status: **implemented** (verified 2026-09-17, #3833)
Date: 2026-09-14
Feature loop 2026-09, iteration 33 (Code execution, `FEATURES.md:201`)
Gap ids: `CEWF-1` (closed), `CEWF-3` (new, docblock), `CEWF-2` (re-verified, dispositioned)

## D1 (Blocker, `CEWF-1`) — the node is unclassified, so a `:fork` re-runs arbitrary code

`packs/feature.code-exec.nodes/pack.json` declares one node,
`feature.code-exec.nodes.run`, as **`role:"action"` with no `capabilities` key**.

**MEASURED:** the typeId appears in `MANIFEST_DECLARED_TYPE_IDS` **only**
(`sideEffectFloor.generated.ts:1093`) — not in `MANIFEST_SIDE_EFFECT_FLOOR`, not in
`MANIFEST_FAST_PATH_SERVED`. `isSideEffectingNode` therefore returns **false**, and
`executor.ts`'s `outcome = replayServed ?? …` re-executes the node on a `mode:'replay'` fork.

**This is the same class as ADR 0673/0676/0678/0679 and the highest-stakes instance of it.**
What re-executes here is not a Document write or a notification — it is **arbitrary user code in
a paid sandbox**, on a surface `FEATURES.md:201` itself calls *"a paid, high-blast-radius
surface"* sitting behind an HITL approval.

**And the node's own docblock states the opposite, in capitals** (`index.mjs:7-8`):
> *"Action node — its output is recorded in the event log, so replay/fork read the recorded
> result and **NEVER re-execute** (no nondeterministic re-run)."*

The inference is the same false one four previous ADRs have now corrected: `role:"action"`
confers nothing. `gen-side-effect-floor.mjs:139` binds `role === 'side-effect'` **OR** the
`side-effectful` capability, and nothing under `src/executor/` compares `role` to `"action"`.

**Verified NOT to be the it.29 no-op, before prescribing.** `classifyNodeReach` returns
**`no-ai-reach`** for this node, so the generator puts it in the floor **and** the served set —
unlike podcasts' `outline`/`transcript`, where the identical declaration would have been held
back as `invocation-log` and changed nothing. The reach was measured first, not assumed.

**Verified NOT to be masked by a backstop, before claiming severity.** ADR 0679 D2's correction
was that a replay of an egress node *throws* on `assertEffectAllowed` rather than duplicating.
That does not apply here: `host/sandboxAdapter.ts` contains **no `assertEffectAllowed` call**, so
the seam has no ADR 0531 backstop and a replay genuinely re-executes.

**Decision:** declare `capabilities: ["side-effectful"]` on the node, bump the pack and the
node's own version, move the feature pin in lockstep, and regenerate all three artifacts
(`sideEffectFloor.generated.ts`, `SERVED-SET-BASELINE.json`, `.steward-manifest.json`).

**Replay note (the row flags it and it is real):** a role/capability change alters fork behaviour
for any in-flight run past this node. The change is from "re-execute" to "serve the recorded
result", which is the direction the docblock already promised, so a run created before the fix
gains the guarantee rather than losing one.

**Witness:** `isSideEffectingNode` true for the node; the manifest declares the capability; and a
leg pinning the docblock no longer asserts a guarantee the manifest does not provide. Sabotage:
remove the capability and the first leg must go red.

## D2 (`CEWF-3`, NEW) — a second docblock claim is stale, and it is about the sandbox boundary

The same header says (`index.mjs:4-6`):
> *"when no sandbox adapter is wired (the DEFAULT — **there is no in-process runtime by design**)"*

**That is no longer true.** `host/sandboxAdapter.ts:222` resolves a third rung:
```ts
if (wasiRuntimeEnabled()) return { runtime: 'wasi', exec: runWasiSandboxedCode }; // in-process CPython-WASI (no host FFI)
```
Phase 8 added both first-party E2B (`:220`) and an **in-process** WASI runtime.

**Deliberately NOT overstated: this is stale documentation, not a security hole.** The WASI rung
is **opt-in** (`wasiRuntimeEnabled()`), it is third in the ladder behind both external options,
the resolver still returns `undefined` when nothing is configured — so the "honest-off ⇒
`capability_not_provided`" behaviour is intact — and the runtime itself is explicitly *"no host
FFI"*. What is wrong is the sentence, which tells a reader the in-process case cannot exist.

**Decision:** correct it to describe the ladder as it is, and say which rung is in-process.

## Re-verified and dispositioned

- **`CEWF-2` — the budget/executor binding is CONVENTIONAL, not enforced.** Confirmed:
  `createSandboxRunner(tenantId?)` returns the **raw, unbudgeted** executor when no tenant is
  passed (`sandboxAdapter.ts:229` — *"no tenant context → no budget (back-compat)"*). Both
  production callers do pass one (`host/agentToolProvider.ts:445` `scope.tenantId`;
  `executor/executor.ts:668` `run.tenantId`), **so the unbudgeted path is LATENT, not live** —
  and this ADR says so rather than filing a hole that no caller reaches. The row's point stands
  at the level it was filed: a third caller inherits neither gate, and an empty-string tenantId
  would take the same branch. The cure is to make the invariant enforced (require the tenant, or
  fail closed) rather than conventional — a seam change with its own blast radius, so it is
  carried with the mechanism recorded, per the `SPWF-10` ruling.
- **Ordinal mislabel — third independent instance of `KSWF-17`.** This section's own header reads
  *"Code execution (**FEATURES.md ordinal 201** of 71)"*. **201 is the LINE NUMBER**, not the
  ordinal — `grep -n "Code execution" FEATURES.md` → `201:`. `KSWF-17` filed two adjacent
  sections with this confusion; I hit a third in iteration 29 (Podcasts titled "feature 31/71")
  without having read the row, and this is a fourth sighting. Corrected here; the row stays open
  because the fix belongs corpus-wide.

## RFC verdict

**Host + pack work, no RFC.** D1 declares existing manifest fields; D2 is documentation. No wire
facet, no envelope kind. D1 bumps a pack, so it needs a steward re-attestation — and per ADR
0680's correction, `check-pack-pin-drift.mjs` scopes itself to `core.openwop.*`/`vendor.*`, so a
`feature.*` pack needs **no** registry republish.

## Open question

Should the sandbox seam also carry an `assertEffectAllowed` backstop, so that a future
unclassified caller fails loudly on replay instead of silently re-executing? Classification fixes
this node; the backstop would fix the *class* for any node that reaches the seam. That is a
core-seam change and is filed, not decided here.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3833**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** `packs/feature.code-exec.nodes/pack.json` pack+node 1.1.0 with `capabilities:["side-effectful"]`; floored AND served at `executor/sideEffectFloor.generated.ts:298,577`; pin lockstep `features/code-exec/feature.ts:26`; D2 docblock corrections `packs/feature.code-exec.nodes/index.mjs:1-20`.
