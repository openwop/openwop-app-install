# ADR 0507 — The embedded-param family, and deferred seeding

Status: Accepted

> **Renumbered 0506 → 0507**: a peer ADR 0506 (test-seam authority) merged first, so
> theirs is canonical per the first-created policy. This one was still on an open
> branch.

Corrects **ADR 0504** (a measurement error and a blind spot it named but under-rated).
Closes `CHAIN-SEED-1`.

## Context

`CHAIN-SEED-1` was recorded as "114 of 169 seeded chains carry required params that
never froze." Investigating it produced two results: **the headline number was
wrong**, and **a worse defect was hiding underneath it**.

### Correction 1 — the population was wrong

`seedWorkflows.ts` seeds only **zero-config** chains (`isZeroConfig` = no `required`
params). Every chain in the 114 has required params — which is *why* it has unfilled
ones — so **none of them were ever seeded.**

| | ADR 0504 recorded | Measured 2026-08-01 |
|---|---|---|
| Population | 169 "seeded" chains | **52** actually seeded |
| Affected | 114 | **9** |

ADR 0504's ratchet measured `listChains()` rather than the seeded subset. The ratchet
itself is sound for what it counts (chains that *would* be broken if instantiated
without params — the `from-chain` lane); its **framing as "seeded" was wrong**, and
that framing reached TODO.md, a memory file and a merged PR description.

This is the same failure ADR 0498 recorded and ADR 0504 quoted back: *measuring the
wrong artifact*. Recording it a third time because knowing the lesson evidently did
not prevent it — what prevents it is naming the population explicitly before counting.

### Correction 2 — the blind spot ADR 0504 named was the dangerous half

ADR 0504 §Open-2 noted that embedded tokens resolve to `''` rather than `undefined`
and left them "deliberately out of scope." That ranking was wrong, and it is inverted
here.

- **Whole-value** `"{{params.x}}"` → freezes to `undefined`, key vanishes, the node
  **fails loudly**: `core.web.search requires a non-empty 'query' input`.
- **Embedded** `"…Invoice: {{params.x}}"` → freezes to `''`. A valid string. Nothing
  fails.

`finance.invoice-ap` declares `invoiceText` **required** and ships:

```
"Extract vendor, line items, amounts, and totals from the invoice. Invoice: {{params.invoiceText}}"
```

`finance.invoice-ap` is NOT seeded (it has required params) — it is reached through
`from-chain`, which is the lane a user drives by hand. Instantiated without the
param, its prompt reads *"…from the invoice. Invoice: "* — and a model is asked to extract vendor, line items and totals from
nothing. It obliges. The fabrication flows to an approval gate for a human to
rubber-stamp.

**Measured: 36 chains** (12 exclusively embedded, 24 carrying both families),
including `devops.pr-review` (`diffText`), `support.email-triage` (`emailText`),
`knowledge.doc-summarizer` (`documentText`) — every one a "read this text" prompt
whose text silently disappears.

> Absent input that FAILS is a bug. Absent input that SUCCEEDS with invented content
> is worse, and it is the one nothing was looking for.

## Decision

1. **Detect the embedded family.** `expandChain` records embedded findings with
   `embedded: true` so a consumer can rank them above the loud ones.
2. **Report them unconditionally.** `findUnfilledExpansionParams` re-checks the live
   node for family 1 ("is it still empty?"). That test would **drop every embedded
   finding**, because the live value is the interpolated string — long and truthy.
   The absence is *inside* the string, not instead of it. Accepting a rare false
   positive (someone hand-edits the prompt) is correct here: nothing blocks on this
   signal, it is surfaced on the `from-chain` response only.
3. **Seed in RFC 0124 deferred mode.** Fixes the 9 seeded chains, and fixes *both*
   families — deferred lifts inline prompts into minted templates that **keep their
   tokens** for run-time interpolation, and materialises params as `variables[]`,
   which `ui/RunInputsForm` already renders from.
4. **Migrate existing rows via `APP_MIGRATIONS` v14**, not the boot path.
5. **Refuse to seed a chain with an `x-openwop-sensitive` param.**

### Why the migration is not boot-path logic

The seeder is register-if-missing, so the mode change alone is inert for every
deployed host — and because `wfreg:` is **global, keyed by workflowId with no tenant
component**, a tenant seeding later inherits the cached broken definition too.

A conditional re-seed on the boot path runs on every cold boot of every instance, and
read-then-`registerWorkflowDurable` has **no CAS** — precisely the shape of the
§Correction (grade-data RI-1) incident where "one cold boot silently rewrote the
definition every tenant runs." `APP_MIGRATIONS` is versioned, recorded, and
single-shot by construction.

### Why this is replay-safe

Node ids are **byte-identical** between the two modes — measured across all 169
loaded chains, and pinned by a test that is the migration's gate. `expansionId` hashes
`(chainId, version, resolvedParams)`, and `resolvedParams` is built identically in
both modes; only sensitive params differ, hence decision 5.

So a run resolving HEAD still matches its checkpoints by `nodeId`, and a run that
pinned `definitionRevision` keeps resolving its own revision row — those rows are
content-addressed and additive, so re-seeding **adds** one and never deletes the pin.

**Stated honestly:** `resolveRunDefinition.ts:31-37` falls through to HEAD when a run
has no pin or its revision row is missing (`seedWorkflows` records revisions with
`.catch(() => undefined)`). Such runs replay against the new shape.

That used to be where this ADR asserted "equal or better". **/grade-data tested it
instead** (`docs/steward/DATA-ASSESSMENT-adr0507-deferred-seeding.md`):

- `seedRunVariables` (`variablesRuntime.ts:129-133`) applies `defaultValue` when an
  input is absent, so a no-input run gets the same values the frozen literals gave it.
- Resolving every seeded chain's config against an EMPTY run bag: **112 keys compared,
  0 different.**
- Interpolating the lifted prompts against the same empty bag: **2 lifted templates,
  both byte-identical to the frozen string, 0 different.**
- `getRevision` is `store.get(keyOf(...))` with **no tenant filter**
  (`workflowRevisions.ts:151`), so a pinned run resolves its own revision regardless of
  which tenant recorded it.

So the claim holds, and it holds by measurement. It is still not "nothing changes" —
the node config genuinely changes shape — but no currently-succeeding seeded run
resolves to a different value.

## Alternatives considered

| Option | Why not |
|---|---|
| Drop the whole thing once the 114 → 9 correction landed | The 9 are real, and the embedded family found on the way is the more serious defect |
| Extend the family-1 re-check to embedded findings | Structurally impossible — the live value is the interpolated string |
| Boot-path conditional re-seed | Reproduces the RI-1 global-row rewrite |
| Seed expansion-time but pre-fill defaults | Nothing to pre-fill — every affected param is required-with-no-default by construction (that is why it never froze). True of all 9 seeded and all 234 across the wider from-chain population. |

## Implementation record

| Phase | Change | Test |
|---|---|---|
| 1 | Embedded detection + `embedded` flag | `seed-deferred-and-embedded.test.ts` |
| 2 | Unconditional reporting for embedded findings | same — "long and truthy" case |
| 3 | `seedWorkflows` → deferred + sensitive-param tripwire | same |
| 4 | `APP_MIGRATIONS` v14 `reseed-chain-workflows-deferred` | same |
| 5 | Migration self-loads the chain registry | `reseed-migration-not-vacuous.test.ts` |
| 6 | Deferred variable names humanise without the expansion-id prefix | `ui/__tests__/runInputs.test.ts` |

Sabotage-probed: disabling embedded recording failed 2 of 8; routing embedded findings
through the family-1 re-check failed exactly the two that guard the drop bug; removing
the migration's registry self-load failed 3 of 4.

**Two defects found in this change during its own review**, both invisible by
construction:
- The migration iterated `listChains()` at `index.ts:186`, but the registry is not
  populated until `index.ts:427` — it would have examined ZERO chains, rewritten
  nothing, and recorded itself complete forever. A one-shot migration that silently
  never runs looks exactly like one that succeeded.
- `humanizeVariableName` rendered the RFC 0124 materialisation prefix verbatim, so a
  form label read *"Finance invoice ap a2ec352bceed invoice text"*. Harmless until
  now only because seeded workflows carried no variables and the form drew nothing —
  deferred seeding is what puts it in front of people, so the fix ships with it.

## Open questions

0. **The 36 chains' params are MISCATEGORISED — the remediation is re-authoring,
   not defaulting** (analysed 2026-08-01, after this ADR merged). `invoiceText`,
   `diffText`, `emailText`, `documentText` are **per-run DATA modelled as
   instantiation CONFIG**. None has a default because none *can* — there is no
   sensible default for "the invoice to extract". `TemplatePreflightModal`'s
   §Correction prescribes "chain content carrying real defaults"; that is correct for
   `provider`/`model` and **impossible** for a content param.
   Reachability is also narrower than the raw 36 suggests: the preflight modal DOES
   render `RunInputsForm` for chain params, so a gallery user sees the fields — it
   just does not block on blanks, by deliberate contract. Fabrication needs a blank
   confirmed, or an API caller omitting params.
   Tracked as `CHAIN-EMBED-1` with candidate fixes in preference order; option (3),
   distinguishing CONFIG from DATA params in the chain schema, is an RFC 0013 change
   and needs the RFC gate.
1. **ADR 0504's ratchet is mis-framed, not wrong.** Its 114 counts `from-chain`-
   instantiable chains, not seeded ones. It should be renamed and its docstring
   corrected rather than deleted.
2. **The `from-chain` lane still has no prompting.** Only `ProjectWorkflowsTab` and
   `TemplatePreflightModal` render `RunInputsForm`; chat `@workflow` mentions,
   `AgentWorkflowPortfolioPanel` and `EventBindingsPage` launch with no prompt and an
   enabled Run. That is the human-facing half and is deliberately a separate PR.
3. **`seedWorkflows` has no sub-chain handling** (unlike `from-chain`, which calls
   `coRegisterSubChains`). Pre-existing; no zero-config chain composes sub-chains
   today, so it is latent rather than live.
