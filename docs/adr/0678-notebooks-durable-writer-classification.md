# ADR 0678 — Five notebooks writers outside the replay guard, and the docblocks that hid them

Status: **implemented** (verified 2026-09-17, #3809)
Date: 2026-09-14
Feature loop 2026-09, iteration 28 (Research Notebooks, `FEATURES.md`)
Gap ids: `NBWF-8` (new, Blocker), `NBWF-9` (new, corpus-wide), `NBWF-2`/`-3`/`-4`/`-5`/`-6`/`-7` re-verified

## D1 (Blocker, `NBWF-8`) — five chain-reachable durable writers are unclassified

All 14 nodes in `packs/feature.notebooks.nodes` (v1.0.1) are `role:"action"` and **not one
declares a `capabilities` array at all**. Five of them write durable state:

| node | write | chain(s) reaching it |
|---|---|---|
| `.write-transformation` | `docs.createDocument` (`index.mjs:226`) + `docs.addVersion` (`:238`) | `notebooks.transform` |
| `.ingest-source` | `notebooks.ingestSource` (`:571`) | `notebooks.ingest-audio`, `notebooks.ingest-youtube` |
| `.mcp-add-source` | `notebooks.ingestSource` (`:647`) | `notebooks.mcp.add-source` |
| `.mcp-create-note` | `notebooks.addNote` (`:665`) | `notebooks.mcp.create-note` |
| `.store-summary` | `notebooks.setSourceSummary` (`:182`) | `notebooks.summarize` |

**MEASURED:** all 14 typeIds appear only in `MANIFEST_DECLARED_TYPE_IDS`
(`sideEffectFloor.generated.ts:1254-1267`); **zero** are in `MANIFEST_SIDE_EFFECT_FLOOR` or
`MANIFEST_FAST_PATH_SERVED`, and `sideEffects.ts` has no `notebooks` pattern arm. Since
`executor.ts:1062` computes `outcome = replayServed ?? …` and `replayServed` is populated only
for a node `isSideEffectingNode` recognises, **a replay re-executes all five**: a forked
`notebooks.transform` mints a SECOND Document (`createDocument` at `:226` carries no
idempotency key — only the later `addVersion` does, `:242`), a forked ingest re-ingests a
duplicate KB source, and `mcp-create-note` re-creates the note. `store-summary` is idempotent
by shape (a set), so it is the mild one.

**The pack's own docblocks assert the protection the manifest withholds** — `index.mjs:170`
and `:199` both say *"Recorded → replay-safe."*, and `:628-629` says it for the MCP writers.
This is the **fourth consecutive iteration** in which a docblock claimed a replay guarantee
the classification did not provide (ADR 0673 `feature.email.nodes`, ADR 0676
`feature.strategy.nodes`, ADR 0677 `core.email.draft`). The sentence is not decoration: it is
what a reader checks instead of the manifest.

**Why the build does not catch it.** `gen-side-effect-floor.mjs:139` derives the floor from
`role === 'side-effect' OR capabilities includes 'side-effectful'`, and fails closed only on a
MISSING or unrecognised role. `"action"` is a valid member of the closed taxonomy (`:71`), so a
durable-write node mislabelled `action` passes silently. The generator's own header (`:12-15`)
records that the predecessor allowlist *"has drifted twice on record … Both times the manifest
declared `side-effect` and nothing read it"* — the inverse drift (nothing declares it) has no
detector.

**Decision (D1a):** declare `capabilities: ["side-effectful"]` on the five writers **and
`"capabilities": []` on the other nine** — so a read's non-classification is a reviewed decision
a diff can show, matching `packs/feature.strategy.nodes/pack.json`, rather than the "nothing
declares it, and that direction has no detector" state this section's own §"Why the build does
not catch it" describes. Bump each changed node's own `version` 1.0.0 → 1.1.0 and the pack
1.0.1 → 1.1.0 (the ADR 0676 precedent bumped both).

**THREE generated artifacts move, not two** — the third is a hard CI gate the first draft
missed: `sideEffectFloor.generated.ts` (`gen-side-effect-floor.mjs`),
**`docs/steward/SERVED-SET-BASELINE.json` (`gen-served-set.mjs`, gated by `ci.sh:288` — MEASURED
floor 318→323, served 275→280, `servedByRole.action` 27→32, undischarged unchanged at 43)**, and
`packs/.steward-manifest.json` (`gen-steward-manifest.mjs`, `ci.sh:316`). Note the ratchet's own
message: the undischarged counters do NOT move, so only the stale-baseline check catches it.

**One leg, deliberately.** `sideEffects.ts` repeatedly insists a manifest declaration "must not
be separated from" an explicit `SIDE_EFFECTING_TYPE_PATTERNS` regex (the #2871 two-leg lesson).
One leg suffices here because ADR 0572 P3 made the derived set primary — `isSideEffectingNode`
consults `MANIFEST_FAST_PATH_SERVED` first (`sideEffects.ts:266`) — and ADR 0676 did the same.
The two-leg entries predate that change and prove the typeId path independently.

**Decision (D1b — promoted from an Open Question to a Blocker by the review):**
`write-transformation` routes through `ctx.features.documents.createDraftDocument` with a
**content-derived** `idemBase`, replacing the hand-rolled `createDocument` + `addVersion`
two-step. The existing key is **inert**: `index.mjs:242` is
`notebook-transformation:${runId}:${nodeId}:${sourceId}:${document.documentId}` — it embeds both
a `runId` that is fresh on every fork AND a `documentId` minted by the `createDocument` two lines
above, so it **can only ever collide with itself**, on a fork or a plain retry. Classification
(D1a) serves `mode:'replay'` only (`routes/runs.ts:1725`; `executor.ts:1565`); a `mode:'branch'`
fork re-executes live with `ctx.replaying === false`, where neither classification nor the
backstop applies — so a deterministic content-derived id is what converges there. This is the
same defect and the same cure as ADR 0676 D1, one iteration later; the governing rule is pinned
at `test/strategy-nodes.test.ts:87` ("the idemBase must be CONTENT-derived, never runId-derived").

**Correct SIX false replay claims, not three** — the two that matter most were missing from the
first draft: `index.mjs:10-12` asserts it **pack-wide** for all 14 ("Every node is `role:"action"`
… replay/fork read the recorded result"), which `sideEffects.ts:193-197` already records as a
known lie; and **`pack.json:4`'s `description`** advertises the same guarantee to the node
catalog, i.e. to a reader who never opens the source. Plus `:170`, `:197-198` (the inert
idempotency key), `:199`, `:551`, `:629`.

**Witness** (the first draft had none; ADR 0676 shipped one): `notebooks-writer-replay.test.ts`,
mirroring `strategy-board-memo-replay.test.ts` — (a) `isSideEffectingNode` true for each of the
five and **false for the nine**; (b) the manifest declares the capability on exactly those five;
(c) `write-transformation` resolves the SAME documentId for identical content and a DIFFERENT
one for different content. Sabotage: remove the capability from one node and (a) must go red.

**Deliberately NOT classified — the nine reads and two non-writers:**
`.ask`, `.search`, `.read-source`, `.list-notebooks`, `.get-notebook`, `.list-sources`,
`.list-notes` are reads. `.transcribe-source` (`:285-320`) and `.fetch-youtube-source` (`:483-539`) write no durable app
state — verified by reading both: no cached transcript, no source row.

> **CORRECTED on two counts.** (a) The first draft said they do a `callAI` and a `safeFetch`
> **"respectively"**. `.fetch-youtube-source` does **both** (`index.mjs:527-536` is a Tier-2
> `ctx.callAI`). (b) The ADR 0673 D1 precedent was cited as the reason to hold them back, and
> **it does not govern this case**: that precedent is about the `SIDE_EFFECTING_TYPE_PATTERNS`
> regex list, which `sideEffects.ts:81-85` says would OVERRIDE the generator's holdback — a
> **manifest capability does not override anything**; the generator reads it and routes by reach.
>
> The real reasons, measured: declaring the capability on `.fetch-youtube-source` lands it in
> the generator's **`invocation-log` arm** (MEASURED: served 275→282, invocation-log 28→30), so
> the ratchet would report it **DISCHARGED while its egress half is served by nothing and still
> throws** — a false discharge claim. And `.transcribe-source` writes no durable state while
> ADR 0326's invocation log already discharges its only effect, so floor membership would add a
> row without adding a guarantee. Per-node declaration remains the correct instrument, but for
> these two the answer is "no", on their own merits.

## D2 (`NBWF-9`, corpus-wide) — FILE, do not fix here

The generated header's census is **321 `action` vs 254 `side-effect`** corpus-wide, so this is
very unlikely to be notebooks-only. A cheap proxy — chain-reachable nodes that are unclassified,
whose role is not `pure`/`read`/`gate`/`streaming-output`, and whose **pack source** contains a
durable-write call — returns **on the order of 60-75 nodes across 12-16 packs**, dominated by
`feature.kicktodo.nodes` (21) and `feature.notebooks.nodes` (14), with `podcasts`,
`campaign-brief` and `app-builder` at 5 each and `crm`/`commerce` at 4.

> **The RANGE is the honest form, and the first draft's precise "61 across 12" was not.** An
> independent re-derivation of the same described method returned **72 across 16** — an 18%
> swing on the choice of write-verb regex, which is unstated and unstateable without a real
> call graph. The top six matched exactly, so the SHAPE is stable and the total is not. The
> first draft also excluded `feature.app-builder.nodes` (5) and `feature.job-search.nodes` (3)
> under "a tail of 1-2", which its own headline count contradicts.

**This is a CANDIDATE SET, not a defect count, and the distinction is the point.** The probe
matches at PACK level — a read node in a pack that writes elsewhere counts — so it over-counts
by construction. (Tell: `feature.strategy.nodes` shows 2 despite ADR 0676 having classified all
four of its writers; those 2 are reads.) Notebooks' five were confirmed by reading each
implementation, which is the only way to convert a candidate into a finding.

**Decision: file with the measurement and its limits stated.** Naming a 61-node sweep inside a
single-feature iteration is how a measured change becomes an unmeasured one — the same ruling as
ADR 0676 `SPWF-10`. What this row should produce is a detector: the missing one is not "is the
role valid" (it is) but "does a node that reaches a durable-write surface declare it".

## Re-verified, with two rows stale in the SAFE direction

- **`NBWF-1`'s residual note is STALE.** The row says `feature.notebooks.nodes` was never bumped
  so "`index.mjs:74` still silently drops a wrong-typed `topK`" and ADR 0602's typed failure is
  "unreachable from the chain lane". `index.mjs:74` does still drop a non-number — but **the
  chain lane can no longer deliver one.** ADR 0602 fixed the generator, so the projection param is declared `{"type":"number"}`.
  > **CORRECTED — right conclusion, WRONG REASON, which the review notes is worse than a wrong
  > one because nothing looks off.** I measured `expandChain` preserving `topK:5` as a number.
  > That is true (`host/tokenSubstitution.ts:49-50` returns the raw bag value for a whole-value
  > token) **but it governs the from-chain lane, not this one.** The `notebooks.mcp.*`
  > projections register **deferred** (`features/index.ts:290` → `chainBackedWorkflows.ts:78`,
  > `expandChain({deferred:true})`), so `{{params.topK}}` materialises as `{type:'variable'}`
  > (`workflowChainPackLoader.ts:1184-1192`) and **never reaches `substituteTokensDeep` at all**.
  > What actually keeps a wrong-typed `topK` off the node is the MCP boundary — `inputSchema
  > {"type":"integer","minimum":1,"maximum":50}` validated before run start
  > (`features/notebooks/mcpToolsWorkflows.ts:95`) — plus `seedRunVariables` copying the raw
  > value (`host/variablesRuntime.ts:127-133`).
  The silent drop at `index.mjs:74` survives only for a hand-authored binding — a hardening
  item, not the live defect the row describes.
- **`NBWF-3` is PREMISE-WRONG on its literal claim.** "Nothing calls `buildChainBackedDefinition`
  for any `notebooks.*` id" is false, and the strongest refutation is **production, not tests**:
  `features/index.ts:244` (`registerNotebooksWorkflows` → `registerChainBackedWorkflow` →
  `buildChainBackedDefinition`, `chainBackedWorkflows.ts:191`) and `features/index.ts:290`
  (`registerMcpProjectionWorkflows`, covering every `notebooks.mcp.*` id). Tests reach it too
  (`test/chain-backed-deferred-param-aliases.test.ts:66`/`:151`, plus corpus loops at
  `:79`/`:108`) — but citing a test to refute "nothing calls it" is the weakest available
  evidence. **The substantive gap survives in narrowed form:**
  nothing asserts expansion SHAPE — no edge-port survival, no `outputRole` restoration (the
  corpus loops pass no `postProcess`, so `features/index.ts:246-260` is never exercised), and no
  build-twice byte-identical check, which peer families do have
  (`workflow-chain-people-hr-offboarding-host.test.ts:111-112`).
- **`NBWF-4`'s mechanism is REAL, its reachability is NOT.** `deterministicExpansionId`
  (`workflowChainPackLoader.ts:777-783`) passes `Object.keys(params).sort()` as a
  `JSON.stringify` **replacer array**, which applies recursively, so a nested object serialises
  as `{}` and two different values hash identically. But no shipped notebooks lane can trigger
  it: `from-chain` discards the expanded id (`routes/workflows.ts:866`), the boot lane expands
  with **no params** (`chainBackedWorkflows.ts:78`), and on the product lanes `ownerSubject` is
  server-derived from `notebookId` (`features/notebooks/routes.ts:481`), a sibling **string**
  param that IS hashed — so any two real param sets differing in `ownerSubject` also differ in
  `notebookId`. Real loader defect, correctly LOW; the "live trigger" framing overstated it.
- **`NBWF-5` is TRUE and stronger than filed.** `hostOwned` has **zero callers repo-wide** — the
  hedge "most omit it" understates: all 16 do. So the ids the notebooks routes ignite resolve by
  id but sit in no tenant ownership index.
- **`NBWF-6` TRUE verbatim**, with two different silences: an HTTP-lane failure becomes a
  per-request 500 long after a green boot, and an MCP-lane failure is indistinguishable from the
  toggle being off.
- **`NBWF-2` (a) TRUE; (b) the number DRIFTED** — 112 → **110** chain-used typeIds lacking both
  schema refs; the "31 packs" holds. A further 27 chain-used typeIds have no manifest entry at
  all and are skipped earlier, which is a larger hole than the one filed.
- **`NBWF-7` is FALSE as filed, and INAPPLICABLE to D1 — this row was MY error, twice over.**
  The first draft said the script "still has no caller anywhere (verified: every hit is a
  self-reference)". **It has a caller:** `scripts/preflight-deploy.sh:109` resolves it and
  `:118` runs it as a deploy gate (ADR 0655 D5); `deploy.sh:91` forwards `--allow-pin-drift`
  and `test-deploy-gates.sh:323` pins its exit-3 contract. Independently, the script scopes
  itself to `MANAGED = /^(core\.openwop\.|vendor\.)/` (`check-pack-pin-drift.mjs:52-53`,
  *"`feature.*` / `community.*` … are never pinned"*), so a `feature.*` pack is never compared
  — **D1's bump needs no registry publish and no re-pin.**
  > **How the false claim survived a "verification", because the method is the lesson.** The
  > grep piped through a filter (`grep -v "^./scripts/…"`) that never fired — `grep -r … .`
  > emits paths WITHOUT the `./` prefix — so five self-references filled a `head -5` and
  > truncated before `preflight-deploy.sh` (alphabetically later). The command then echoed
  > *"(none above = still no caller)"*, so a failed query read as confirmation. **A `head -N`
  > on a query whose point is "are there any hits?" cannot distinguish absence from
  > truncation**, and writing the expected conclusion beside the command removes the last
  > chance to notice. The row was also TRUE when ADR 0602 filed it and acquired its caller
  > later — a carried claim deserves the unfiltered form.

## RFC verdict

**Host + pack work, no RFC.** D1 declares existing manifest fields; no wire facet changes.
D1 bumps `feature.notebooks.nodes`, so it needs a steward re-attestation and — per `NBWF-7` —
a registry republish that nothing in the repo enforces.

## Open questions

1. Should `.transcribe-source` be classified despite writing no durable app state? It burns a
   billable provider call. **Leaning no**: ADR 0673 D1 holds `ctx.callAI` reachers back
   deliberately so RFC 0041 §B divergence injection survives, and the invocation log already
   serves the model call.
2. `write-transformation`'s `createDocument` carries no idempotency key while its `addVersion`
   does. Classification serves the whole node on replay, so the asymmetry stops mattering there
   — but a `mode:'branch'` fork still re-executes live (ADR 0677 D2's correction). Should this
   node route through `createDraftDocument` like ADR 0676 D1 did for strategy?

## Status correction (2026-09-17)

This read `Status: Proposed (revised after adversarial pre-implementation revie…` — a PRE-implementation phrasing that went stale when
the work landed in **#3809** (D1a/D1b). `docs/steward/FEATURE-LOOP-2026-09.md` records the
row **DONE** with that PR, which is the independent evidence for this correction.

**It was invisible to the steward staleness ratchet for a structural reason worth recording.**
That gate tested `Status:` for the EXACT string `Proposed`, so the parenthetical after the
word silenced it permanently — no baseline row, no exemption, nothing in a diff that reads as
a suppression. Seven ADRs were hidden that way, and the commit that claimed the baseline was
"drained to zero" was wrong about its own headline. The test is a prefix match now.
