# ADR 0602 — notebooks `topK` parity, honest poll give-ups, and locale truth

Status: implemented

Supersedes nothing. Follows ADR 0601 (feature-28 PR-A). Closes `NBWF-1` (= code
`NBC-5`) and `NBU-6`; extends `NBU-15`; reconciles the feature's dead-locale
count. Disposes of `NBWF-2` with a mechanism rather than a patch.

## Context

Feature 28 (Research Notebooks) was assessed at code **C+**, UX **D+**, workflows
**B**. PR-A (`d6bd6c261`) closed the two security Blockers. This is PR-B: the
correctness, honesty and coverage remainder.

Four items were scoped. Three of the four descriptions handed to this PR were
inaccurate in a load-bearing way, and finding that out was most of the work. Each
correction is recorded below at the item it belongs to, in the form the repo's
own rule requires — appended, not substituted for the original framing.

---

## 1. `NBWF-1` / `NBC-5` — `topK` disagreed FOUR ways, and the "safe" lane was not

### The enumeration (walked, not restated)

`topK` on `notebooks.mcp.search` / `.ask` is described by four artifacts:

| # | Artifact | What it said |
|---|---|---|
| A | chain `parameters.properties.topK` — the LAUNCH contract (`/builder`, the `/` picker, `…/workflows/from-chain`) | `"string"` |
| B | the `expose` node's `config.inputSchema` — the WIRE contract Ajv validates a `tools/call` against | `"integer"`, 1..50 |
| C | `packs/feature.notebooks.nodes/index.mjs:74` — the backing node | `typeof i.topK === 'number' ? i.topK : undefined` |
| D | `features/notebooks/surface.ts:198` — the code that actually calls retrieval | `surfaceOptStr(args.topK)` → `string \| undefined` |

Plus a fifth, model-facing: `agentTools.ts` told the model `topK` "default 5"
while `kbService.clampTopK` applied **8**.

### Correction 1 — the MCP lane was NOT safe

`WORKFLOWS-ASSESSMENT.md` records that the MCP lane is protected because Ajv
rejects a non-integer, "so a real integer reaches the bag". It does. And then **D
throws it away**: `surfaceOptStr` returns `string | undefined`, and a `number` is
not a `string`. So `topK: 5` became `undefined`, `clampTopK` substituted 8, and
the tool returned a wrong-sized result set with `status: success`. The lane
declared safe was broken for **every** caller, correctly typed or not.

Twenty-four lines below, the sibling `ask` hand-wrote the correct check. One
surface, two answers about one field. `surfaceOptStr` has **24 call sites**
repo-wide; enumerating all of them shows `args.topK` is the only numeric one, so
the class is exactly **1**, not a family.

### Correction 2 — the prescribed cure would have shipped an invalid definition

The filed cure reads: *"carry each variable's real type from
`spec.inputSchema.properties[v.name].type`."* `WorkflowVariable.type`
(`schemas/workflow-definition.schema.json`) admits only
`string | number | boolean | object | array` — **no `integer`** — and
`expandChain` copies a chain param's `type` VERBATIM onto the materialized
variable in deferred mode. Applied literally the cure writes `type:'integer'` into
every expanded definition, invalid against the host's own schema.

`integer` is therefore widened to `number` **once**, in one shared module, with
the numeric bound left on the tool `inputSchema` where a validator reads it.

### Correction 3 — a third member of the class, unfiled

`features/docs/mcpToolsWorkflows.ts` states in its own docblock that it mirrors
the notebooks generator "EXACTLY", and it mirrored the defect too:
`docs.mcp.docs_search.limit` is `number` on the wire and was `string` in its
launch contract. No tracker had it. It stayed invisible because the docs NODE
coerces a numeric string, so docs degraded gracefully where notebooks did not.

### Decision

- ONE shared coercion rule for the numeric-fan-out class: `surfaceOptCount` in
  `host/featureSurfaces.ts`, used by BOTH notebooks surface methods (the correct
  hand-written copy in `ask` was replaced by it, so the two cannot drift again).
  It REJECTS a string rather than coercing — coercing `"5"` would hide the
  launch-contract type drift from the gate below.
- ONE shared type mapper: `host/mcpToolVariableTypes.ts`, deriving a projection
  variable's type from the tool's own `inputSchema`, with the single documented
  `integer → number` widening and a **fail-closed throw** on anything
  unrepresentable (every input is an in-repo static literal, so this is
  unreachable from any request path).
- Both hard-coding generators corrected; the three chain params regenerated; pack
  `1.0.0 → 1.0.1` and the three changed chains likewise (the per-chain version is
  what `deterministicExpansionId` hashes).
- The model-facing default is now generated from `kbService.DEFAULT_TOP_K` and the
  bound from the tool's own schema constant.

---

## 2. `NBWF-2` — the nominated gate, REJECTED as the cause, with mechanism

The brief required `NBWF-1` and `NBWF-2` to land together, on the premise that
`NBWF-2` is "a gate that was supposed to catch exactly this mismatch and does
not". **That premise is false, and the falsification is the useful part.**

`chain-node-undeclared-keys.test.ts` compares node `config`/`inputs` **KEY NAMES**
against a node's declared schemas. It never reads `chain.parameters`. It never
compares a **type**. `topK` is a legitimately-declared key on both sides of the
disagreement. Under **any** declaration of the 14 notebooks node schemas, that
gate stays green on `topK: {type:'string'}` vs `{type:'integer'}` — a
key-presence gate is structurally incapable of seeing that two sides disagree
about what a key holds.

Its own separate vacuity is real, but it is **not a notebooks defect**. MEASURED
on this branch: of the distinct node typeIds used across all chain packs, **112
across 31 NODE packs declare neither `inputSchemaRef` nor `configSchemaRef`**
(plus 27 host-native typeIds absent from any pack manifest — a different
category). Notebooks is 14 of the 112. *(`L2`: "31 packs" are **node** packs —
the things that DECLARE the schemas. The **41 chain packs** that CONSUME those
nodes are a different population, and the bare word "packs" let the two be read
as one.)* Declaring those 14 moves the number to 98 and leaves
the gate exactly as blind for the other 30 packs — the "widening a
structurally-blind instrument produces a second blind instrument" trap the brief
itself names.

**Alternatives weighed and rejected:**

| Option | Rejected because |
|---|---|
| Declare the 14 notebooks node schemas | Would not have caught `NBWF-1` (mechanism above). Closes a real but DIFFERENT class, 12.5% of a corpus-wide hole, and needs a node-pack version bump ⇒ a registry republish — a different lane from a feature-28 correctness PR. |
| Widen `chain-node-undeclared-keys` to compare types | It has no access to `chain.parameters`; "widening" means rewriting it into a different gate under the old name, which hides the change from anyone reading its docblock. |
| Pin a repo-wide 112-entry shrink-only ratchet here | Out of lane for a feature PR, and would collide with peers touching other packs. |

**Decided:** REPLACE. The instrument that can fail on these values is new:
`test/mcp-projection-param-type-parity.test.ts`.

### The instrument

Per projection it asserts: the two contracts agree on each argument's **type**
(with `integer ≡ number` stated once); on the argument **names**, both
directions; on which arguments are **required**; that every param type is
**representable** as a `WorkflowVariable`; and that the in-tree generator SSoT
still equals the shipped pack — the last being what stops a repaired pack from
being silently undone by the next regeneration.

Zero baseline entries: the corpus is clean after this change. Fixture guards
assert 19 projections and >25 compared pairs, plus a floor requiring at least one
**non-string** pair — without that, every pair being `string↔string` would satisfy
the parity assertion while proving nothing.

### Proof the gate fails on the pre-fix values

| Sabotage | Result |
|---|---|
| pre-fix param types restored | 2 failures naming all three drifts, incl. `docs.mcp.docs_search.limit: parameters=string vs inputSchema=number` |
| the naive cure (`type:'integer'`) | representability assertion fails: `notebooks.mcp.search.topK: 'integer'` |
| expose typeId renamed (gate scans nothing) | both fixture guards fail — `expected 0 to be greater than 15` — rather than passing quietly |
| `surfaceOptStr` restored on `searchNotebook` | behavioural witness fails `expected 6 to be 2` |
| hand-copied "default 5" restored | `expected 'Max hits to return (default 5).' to contain 'default 8'` |

---

## 3. `NBU-6` — silent give-ups that then made a positive claim

There is **no request deadline anywhere** in this feature — no `AbortController`,
no `AbortSignal.timeout`, and `client/config.fetchOpts` adds none. Every timeout
here is a **polling give-up**, and all three were a bare `return`: ingest
(10 attempts / ~30 s), summarize and transform (8 / ~20 s each). Nothing
rendered, nothing announced, no readable state changed — byte-identical to the
success path minus the result.

**The brief warned against converting a blank surface into a confidently-wrong
one. That conversion had already happened, in the other direction.** With the
poll abandoned, the panel fell through to `sources.length === 0 ? "No sources
yet"` and `transformations.length === 0 ? "No transformations yet"` — positive
claims about the server's contents, rendered seconds after the client stopped
looking, after the user watched an upload be accepted. Silent first, wrong second.

### Decision

ONE poller (`pollUntilLanded`) replaces three hand-written copies that had already
drifted (10 attempts vs 8; one clearing its pending flag on the unmount bail, two
not). The give-up:

- is **not a failure claim** — copy in all four locales says "we stopped checking
  after about N seconds … this is not a report that it failed";
- is stated in the owning panel as a `StateCard announce`, **matching** the three
  failed-read siblings rather than replacing them;
- **suppresses** that panel's empty state while it stands;
- clears **only on evidence** — "Check again" re-runs the poller's OWN predicate.

**Channel and register.** `announce` is POLITE and delegates to the app-shell
`GlobalLiveRegion`, mounted long before any message — dodging the "a live region
mounted WITH content announces nothing" failure an inline `role=status` on a
conditionally-mounted card would hit. Polite, not assertive: an assertive
interrupt 20–30 s after the click, for something that has not failed, is
disproportionate; `Notice`'s assertive branch stays for failed ACTIONS
(`ui/StateCard.tsx`). The feedback rides the rendered card and **never a toast**,
because `DS-NB-1` is open — a repeated identical error toast coalesces without
inserting a DOM node and errors are excluded from `announce()`, so the second
identical failure would be silent to a screen reader.

`NBU-19` carried forward: a "Check again" that finds nothing reports a changing
recheck count, so a repeat click is observable rather than byte-identical.

---

## 4. The dead locale strings — 112, and how that was derived

**Reconciled: 28 keys × 4 locales = 112 strings.** The brief's two figures are ONE
population: the reviewer's extra ~20 (`createdMeta`, `deleteNotebookConfirm`,
`deleteNotebookLabel`, `openNotebook`, `workspaceLede` × 4) are a SUBSET of the
28. 112, never 132. All 28 are chrome of the removed standalone `/notebooks`
route; the feature-off pair is dead because the toggle-off path deletes the TAB
(`ProjectDetailPage.tsx:81`), so no notebooks-namespaced "not enabled" state has
a render path at all.

*(A parenthetical here claimed "the namespace held exactly 112 KEYS before this
PR added 10", offered as a coincidence to watch for. **It was FALSE and is deleted
rather than softened** — § Correction log item H. `origin/main` held **113** keys
and this PR added **9** (113 − 28 = 85; 85 + 9 = 94). The two errors cancelled,
which is exactly why it read as sound. 112 strings and 94 keys are both right; the
third population the note warned about never existed.)*

Derived by a node sweep, hand-verified in both directions and falsified by
sabotage — see the commit message for the full method. Post-deletion: 94 keys,
0 orphans, cross-locale parity 0 missing / 0 extra.

**Two defects were found in the sweep itself before it was trusted**, both of
which UNDERSTATED the count — the direction that looks like success:

1. an unattributed bare-`t('key')` mine credits a notebooks key for a reference
   made in a different namespace (`filterPlaceholder`, `noMatchTitle`,
   `emptyTitle`, `notEnabledTitle` are referenced only by `manual-tests` and
   `memory`). Attributing bare keys to files declaring
   `useTranslation('notebooks')` moved the count **6 → 28**;
2. **this PR's own `NBU-6` fix had committed the family it closes** — `stallCard`
   took key NAMES and called `t(titleKey)`, a dynamic key invisible to any
   reference miner. Fixed at the call sites.

### `check-i18n`: what it cannot see, and the one thing that was fixed

Orphans are `console.warn` and never set `failed`; `literalTokens` marks a key
used if the bare token appears in ANY quoted string in `src` (which masked
`createNotebook` — `asJson<…>(res, 'createNotebook')` in the client); the report
truncates at 40. MEASURED: removing all 28 keys moved its orphan total 255 → 250,
so it could see **5 of the 28**. That is a design position on a WARNING and was
**not** changed here.

What WAS fixed is an unambiguous bug in the **fatal** half. `stripComments` was a
regex pair, and a regex does not know what a string literal is: the file-input
`accept` attribute listing the audio/video wildcard MIME types
(`NotebooksPage.tsx:577` — **CORRECTED, `L3`: those are POST-PR coordinates. On
the commit where the defect existed, `d6bd6c261`, the `accept` attribute is at
**L448** and the JSX comment that closed the span is `{/* Notes */}` at **L554**,
a span of **106** lines. Citing a defect at coordinates that only exist after it
was fixed makes it unverifiable at the commit it is about — cite
commit-relative.**) OPENS a block comment that runs to the JSX comment above
the Notes panel 106 lines later, so that span was deleted before mining and the
FATAL key-parity check could see no `t()` call in it. Replaced with a string-aware
scanner, consolidated into the ONE shared helper both call sites already used
(`rawKeys` had the same flaw). Blast radius measured **zero** before shipping.

Sabotage: with `t('definitelyNotARealKey')` inserted at line 600, the OLD gate
printed `✓ … all t() references resolve`, EXIT=0. The new one: EXIT=1, naming the
file, key and namespace.

**CORRECTED (`M10`) — "the two produce IDENTICAL verdicts" was true at the
verdict and misleading as evidence.** The corpus verdict is indeed unchanged
across all three strippers (15103 keys / 129 namespaces / 250 orphans / 0
unresolved, measured before this round's `M8` deletion). What the sentence hid is
that the verdict is insensitive BY CONSTRUCTION. MEASURED by instrumenting the
real script: **2241 of 15104 defined keys (14.8%) are unreferenced but SUPPRESSED**
before the orphan list is built — **1384** by the namespace-blind `literalTokens`
mask and **857** by `constructedPrefixes` — against **248** actually reported. So
"the orphan total did not move" is weak evidence offered as strong. Restated
honestly: **the stripper change moved keys from unchecked to checked without
moving any verdict.** The 14.8% is recorded in § Residuals as the reason the
orphan half stays a warning.

---

## Phase → commit → test

| Phase | Commit | Instrument |
|---|---|---|
| ADR reservation | `456a0b751` | — |
| 1 · `topK` four-way parity + the replacement gate | `2c1d73d28` | `test/mcp-projection-param-type-parity.test.ts` (7); `notebooks-surface.test.ts` case (d); `notebooks-podcasts-agent-tools.test.ts` SSoT pin |
| 2 · `NBU-6` honest give-ups + 4 locales + `NBU-15` | `020c96e3b` | `__tests__/pollTimeoutStates.test.tsx` (9, incl. 3 controls) |
| 3 · 112 dead strings + the `check-i18n` fatal-half fix | `85143500b` | `scripts/check-i18n.mjs` sabotage (EXIT 0 → 1) |
| — | `5c9f3497a` | steward `NBWF-1`/`NBWF-2` row corrections |
| **R1** · the parity gate compared ONE keyword (`H3`, `L1`, `L6`) | `2e97e070b` | `mcp-projection-param-type-parity.test.ts` deep-compare (8) |
| **R2** · the stripper that replaced a regex was not a lexer either (`H1`, `H2`) | `1e8a8ced1` | `scripts/__tests__/gates.test.ts` × 3 fixtures |
| **R3** · a string `topK` was still a silent wrong-sized success (`M6`, `M5`, `L4`) | `c5c2f7fe6` | `notebooks-surface.test.ts` (d); `notebooks-podcasts-agent-tools.test.ts` M5 case |
| **R4** · the give-up card re-committed its own inversion (`M1`–`M4`, `M9`, `H4`, `L7`) | `785c2cc55` | `__tests__/pollTimeoutStates.test.tsx` (31) |
| **R5** · the record (`H4b`, `H5`, `M7`, `M8`, `M10`, `L2`, `L3`, `L5`) | *(this commit)* | steward trackers + this ADR |

Verification: backend `tsc --noEmit` EXIT=0; 8 directly-affected backend suites
118 passed; all 63 chain suites 555 passed; `npm run build` (the full FE gate
chain) EXIT=0; 32 frontend test files / 386 tests passed; `check-test-types`
172/172 ratchet holds; `check-pack-version-bump` green.

## Residuals — open, with measurements

- **`NBWF-2` proper.** 112 chain-used node typeIds across 31 **node** packs
  declare neither `inputSchemaRef` nor `configSchemaRef`; notebooks is 14. (The
  **41 chain packs** that consume them are a different population — `L2`.)
  Corpus-wide, needs per-pack version bumps and a registry republish. Not a
  `NBWF-1` cause.
- **`NBWF-3`** (no expansion-shape coverage for the four notebooks chains) and
  **`PROBE-NB-1`/`-2`** remain unrun. This PR's gate reads the PACK, not an
  EXPANDED definition, so the expansion-side verdicts are still static
  derivations.
- **`DS-NB-1`** (identical error toasts coalesce with no DOM node; errors
  excluded from `announce()`) is untouched. `NBU-6` was deliberately built off
  that channel rather than on it.
- **`check-i18n` orphan blindness** — warn-only, `literalTokens`, 40-entry
  truncation. Deliberately unchanged; flipping a repo-wide warning to fatal is
  not a feature PR's call. **MEASURED (`M10`): 2241 of 15104 defined keys
  (14.8%) are unreferenced but SUPPRESSED before the orphan list is built —
  1384 by the namespace-blind `literalTokens` mask, 857 by
  `constructedPrefixes` — against 248 reported.** That is the size of the hole,
  and it is why "the orphan total did not move" must never be cited as evidence
  that a mining change was inert.
- **Registry republish.** `examples/workflow-chain-packs/mcp-tool-projections`
  moved to 1.0.1; the registry copy takes precedence at boot
  (ADR 0370), so this needs publishing or the fix will not reach a deploy that
  installs from `OPENWOP_INSTALL_PACKS`.
- **The numeric-fan-out class is NOT closed corpus-wide (`M5`).** This ADR's
  §1 said "ONE shared coercion rule". True for notebooks (surface + agent
  tools) and for the four MCP projection generators; **false for the corpus**.
  MEASURED on this branch: **38 hand-written numeric-arg coercions across 18 of
  67 `features/*/surface.ts` files** (`kb`, `docs`, `entities`, `media`, `crm`,
  `territories`, `commerce`, `goals`, `strategy`, `app-builder`, and 8 more).
  `surfaceOptStr` has **27** call sites (the ADR said 24). Repointing them is a
  cross-feature sweep, not a feature PR.
- **The `M2` subject is the strongest the CLIENT can express, not the right one.**
  `addAudioSource` / `addYoutubeSource` / `applyTransformation` return only
  `{ runId }` — never the document id they will mint — and neither
  `NotebookSource` nor `Transformation` carries a `runId`. So "a source that was
  not here before" still admits a PEER's source landing in the same window. A
  server-side correlation handle (the run id on the projection) is what closes
  it; that is a route + service change, not a UI one.
- **`packs/feature.notebooks.nodes/index.mjs:74` is the same defect one layer
  up (`M6`).** `topK: typeof i.topK === 'number' ? i.topK : undefined` still
  DROPS a wrong-typed value instead of failing, so the typed failure added at
  `surfaceOptCount` is unreachable from the chain lane (it is reachable, and
  tested, from the agent-tool lane). Fixing it needs a node-pack version bump +
  registry republish — the same lane as the residual below, deliberately not
  mixed into a host PR.
- **`deleteNotebook` (`notebooksClient.ts:133`) has zero UI consumers (`M8`).**
  Left in place, not deleted: the backing DELETE route is live and
  `features/manual-tests/suites.ts:1162` names the verb in a manual step, so
  removing the wrapper would silently retire a documented lane. The 8 dead nav
  strings in the SAME finding WERE deleted, because those had no lane at all.
- **`check-pack-pin-drift` has NO caller.** `grep -rn 'check-pack-pin-drift'
  scripts/ package.json` finds the script and nothing that runs it, so the
  registry-republish residual above is disclosed but **not enforced by anything**.
  (It is separately inert in a local run for want of `--pins`/gcloud, but that
  is a configuration fact; having no caller is a structural one.)
- **`L5` — `workflowVariableTypeFor` throws at MODULE EVALUATION** of a file
  `features/index.ts` imports, so one projection typo fails host boot including
  `/readiness`. This is deliberate and stays: every input is an in-repo static
  literal, so the throw is unreachable from any request path and a bad edit is a
  deterministic test failure long before a deploy. Weighed against failing only
  that projection, a fail-closed boot is the smaller harm here — a host that
  silently drops one MCP tool advertises a capability it does not have, which is
  the dishonest-wire-claim family; and a partial-registration path would need
  per-projection error state that nothing currently reads. Recorded so the
  trade-off is a decision rather than an accident.
- **Chain-version identity change.** Bumping the three chain versions changes
  `deterministicExpansionId`, hence the expansion node-id prefix. `workflowId`
  is stable (`= chainId`) and the `outputRole` restore matches by suffix, so
  resolve-by-id and replay are unaffected — but this is a derivation from the
  expander source, not an observed expanded definition.

## Correction log

*(Appended, never rewritten. The three corrections to the INPUT briefs are
recorded inline at items 1, 2 and 4 above.)*

### Round 1 — an adversarial review of this ADR's own implementation (2026-08-23)

An adversarial review of the commits above returned **5 HIGH, 10 MEDIUM, 7 LOW**,
nearly all reproduced by probe or sabotage. Every one is dispositioned below.
**The single transferable lesson: five of the twenty-two defects were in the
INSTRUMENTS this ADR shipped to prevent the defects it was written about.** A
gate, a stripper, a floor and a test each looked like the cure and behaved like
the disease. The rule that would have caught all five is the one this repo keeps
re-learning — *sabotage the CURE, not only the defect.*

**A · `H3`+`L1` — the parity gate compared ONE keyword, and the floor was
decoration.** `2e97e070b`. The generator↔pack assertion walked `src.variables`
comparing `type` only, so `required`, `minimum`/`maximum`, `enum`, `minLength`
and `config.name` were editable on BOTH sides of the shipped pack and never
checked. PROVED: dropping `notebookId` from both `required` lists and narrowing
`topK.maximum` 50→5 left 3 suites / 29 tests EXIT=0 — and an unrequired
`notebookId` makes `notebook-search` return `{hits:[],citations:[]}` with
`status:'success'`, the very non-negotiable this ADR cites. Replaced with DEEP
compares of the whole expose config and the whole `parameters` block, each
against a derivation from the generator. Separately the non-vacuity floor said
"real value 6" (it is **7**) with a `> 3` bound, so reverting ALL THREE of this
PR's fixes left 4 and the floor PASSED on its own regression; the bound is now
the measured value and the three pairs are asserted by NAME.

**B · `H1`+`H2` — the comment stripper this ADR shipped was wrong in BOTH
directions.** `1e8a8ced1`. It replaced a regex with a hand-rolled character
scanner, which is still not a lexer. H1: a JSX apostrophe desynchronises string
tracking, so a doc comment goes unstripped and its EXAMPLE `t('…')` is mined as
live — **EXIT=1 on innocent code**, a failure mode the OLD regex did not have
(118 comment lines survived stripping across 7 files; 34 desync triggers across
25 files; none happened to contain a `t(`). H2: `/^[a-z]+:\/\//` reads as a line
comment and BOTH keys on the line vanish from the FATAL check — verbatim the
failure §4 is written about. Cure: use the TypeScript parser, already a
dependency. Corpus verdict identical; three regression fixtures added.

**C · `M6`+`L4` — a string `topK` was still a silent wrong-sized success, and the
new test PINNED it.** `c5c2f7fe6`. `surfaceOptCount` returned `undefined` for a
present-but-unusable value, so `'5'` fell through to the default of 8 and
returned `status:'success'`. Its stated reason was a non-sequitur (the parity
gate it named reads static pack JSON and never sees a runtime value), and
`notebooks-surface.test.ts` asserted the fallback — **a test that pins a defect
is worse than no test**. Now a typed `validation_error`, with `L4` folded in
(`v > 0 ? Math.floor(v)` returned **0** for `0.5`).

**D · `M5` — "exactly one coercion rule" was false in the model-facing lane.**
`c5c2f7fe6`. `agentTools.ts` kept two hand-written copies that had already
diverged (no `Number.isFinite`). Both repointed at the shared helper, reporting
the refusal rather than throwing it. The corpus remainder is a residual, with a
measurement, instead of a claim.

**E · `M1`–`M4`, `M9`, `H4`, `L7` — the give-up card re-committed the inversion it
exists to remove.** `785c2cc55`. An errored recheck was rendered as evidence of
absence (`M1`); "clears only on evidence" was a COUNT, so an unrelated arrival
cleared it and a delete+add could not (`M2`); the card outlived its own arrival
and **one tab switch destroyed it and restored "No sources yet"** (`M3`);
suppression was gated per-kind and one kind was forgotten (`M4`); the recheck
result was sighted-only (`M9`); and `NBU-6`'s filed cure was two-part with only
the copy shipped (`H4` — the `runId` now links `/runs/:id`). `L7` (pre-existing)
folded in at the shared poller.

**F · `L6` and the two remaining hand-written type tables.** `2e97e070b`.
`docs/mcpToolsWorkflows.ts` kept a `VARS_FOR_TOOL` table beside a file whose own
docblock calls itself the SINGLE source of truth, and they had already drifted;
`ucp` and `app-builder` still hand-wrote variable types, the latter with
`v.type ?? 'string'` — verbatim the `NBWF-1` shape. All four generators now use
the one shared mapper.

**G · `H4b`, `H5`, `M7`, `M8`, `M10`, `L2`, `L3`, `L5` — the record.** *(this
commit)*. `H5` is the `WFAC-13` class again: this PR corrected the falsified
`NBWF-2` causal claim at ONE site while it stood at **four**, the worst of which
still ranked the REJECTED cure at #3 in a priority list. The lesson is
mechanical — **grep the tracker set for the CLAIM, not the row you are editing.**

**H · `M7` — the "112 KEYS" parenthetical was FALSE and is deleted.** `origin/main`
held **113** notebooks keys and this PR added **9**, not 112 and 10. The two
errors cancel, so both headline numbers survive — which is exactly why it read as
sound and why it was repeated downstream. Deleted rather than softened: the
population it warned about never existed.
