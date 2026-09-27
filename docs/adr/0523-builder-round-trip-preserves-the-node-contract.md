# ADR 0523 — The builder round-trip preserves the whole node contract

Status: implemented (2026-08-03)

Supersedes nothing. Extends **ADR 0440 P1** (which established round-trip fidelity
for `metadata` and `outputRole`) to the fields it did not reach.

> Numbering note: drafted as 0516, now at 0523 after THREE renumbers — parallel
> sessions landed 0516–0522 while this was in flight, and the last collision was
> only visible after merge (a peer's `0519-forms-is-a-standard-collection-page.md`
> was created 2026-08-03, this one 2026-08-04, so first-created gave them the
> number). Checking free numbers at branch time is not enough; the collision can
> land while you are in review. Verify with
> `git log --diff-filter=A -- docs/adr/NNNN-*.md` before assuming a number is yours.

## Why this exists

**The builder silently deleted node `inputs` on every save.** Opening a workflow
and touching anything — the autosave is a 1.5s debounce on any store edit, not an
explicit Save — rewrote the stored definition without them.

Measured across the shipped corpus: **114 of 169 chains author node `inputs`, on
187 nodes.** The key histogram names the damage precisely — `title` ×59 (the in-app
notification headline), `orgId` ×20, `briefId` ×16, `subject` ×14, `query` ×13,
`notebookId` ×12, **`to` ×10 (email recipients)**.

It failed silently rather than loudly. ADR 0237 has the executor merge declared
`node.inputs` OVER edge-derived ones ("fixture wins on conflict"). Strip them and
the node falls back to edge-derived only; where no edge feeds that port the value
is `undefined` and the node still reports success — `{emitted:false,
reason:'title_required'}` for notify, `to: undefined` for email. That is this
repo's dominant defect family, and it was reachable by a normal user action:

> Open a workflow that ADR 0498's migration had just repaired, touch anything, and
> it is broken again — with a green run.

## The root cause, stated as an invariant

The host's node contract is declared **independently in three places**:

| Role | Module | Fields |
|---|---|---|
| **Producer** | `host/workflowChainPackLoader.ts` (`expandChain`) | `nodeId, typeId, config?, inputs?, outputRole?` |
| **Ingest** | `host/workflowDefinitionValidation.ts` | `nodeId, typeId, config?, inputs?, outputRole?` |
| **Round-trip** | `builder/schema/serialize.ts` | `nodeId, typeId, config?, outputRole?` ← the odd one out |

The producer and the ingest already agreed. The builder disagreed by exactly one
field, and **nothing compared the three lists**, so the drift was invisible for as
long as it existed.

## Decision

**Conform the third writer to the contract that already exists.** Do NOT invent a
new preservation mechanism.

The rejected alternative was a general "carry unmodelled node fields verbatim"
passthrough modelled on ADR 0440's `definitionMetadata.ts`. It is wrong here:
`validateWorkflowDefinition` rebuilds each node from its own whitelist and drops
everything outside it, so a builder carrying `notes`/`settings`/`agent`/… would
POST fields **the server discards anyway** — advertising a preservation guarantee
it does not have. That is the "false promise" family (ADR 0491). Carry-verbatim is
sound only where the receiver accepts the field; for the one field it does accept,
carry-verbatim collapses into "model the field".

What DOES carry over from ADR 0440 is its docblock's *rule* — "use this at EVERY
site that POSTs a definition". That rule lived only as prose. It is now mechanical.

### `variables[]` ships in the same phase, not as a follow-on

Preserving `inputs` alone would have been a **worse** bug, better camouflaged.
Deferred expansion rewrites whole-value input tokens to
`{type:'variable',variableName}` refs that resolve against a bag seeded from
`definition.variables[]` (`host/variablesRuntime.ts`). Preserve the refs, drop the
declarations, and they resolve to `undefined` — the same silent failure, now with
an input that *looks* present. `ui/RunInputsForm` also renders from
`definition.variables[]`, so dropping it **emptied the run-inputs form**.
`configurableSchema` (RFC 0124 bare-param aliases) rides the same path.

Also fixed: `deserialize` conflated the two, doing `def.defaultInputs ??
def.variables` — stringifying an ARRAY of variable declarations into a textarea
labelled "Default inputs (JSON)". Wrong semantics, and the only place it survived.

### Visibility is part of the fix, not a follow-on

The executor's "fixture wins on conflict" means a preset input **silently
overrides an edge the author draws into the same port**. Today that hazard is
masked because the input gets deleted. Preserving it invisibly would trade a
silent LOSS for a silent OVERRIDE — same family, new member. So the Inspector now
lists a node's preset inputs read-only.

The override caution is shown **per port, only where an edge actually feeds that
port** — not as a blanket line. See §"What the UX review changed about P2": the
blanket version was correct for 0 of 187 shipped preset nodes, and a warning that
is never true is training to ignore warnings. The section's standing justification
is the stronger one anyway: these values determine what the node SENDS (an email's
`to`, a notification's `title`) and were previously unauditable anywhere in the
app.

Editing them is deliberately NOT included: node input *ports* are derived from the
pack `inputSchema`, so an authored `inputs` record is a second source of truth for
the same concept. An editor must key off the derived ports so a typo cannot mint a
dead port. Tracked, not built.

## What was already broken about the enforcement

Both artifacts that should have caught this were vacuous.

1. **`workflow-node-field-tripwire.test.ts` examined ZERO nodes.** It scanned
   `packs/` — which holds NODE packs and contains no chain nodes at all — while all
   551 chain nodes live under `examples/workflow-chain-packs/`. Its anti-vacuity
   guard asserted `files.length > 0` and passed on **1407 files while iterating an
   empty set**. A file count cannot detect a root that holds no nodes. Now scans
   both roots and guards on the **node** count.
2. **`roundTripFidelity.test.ts` encoded the bug in its own fixture type.** Its
   docblock said "the 5-field node whitelist"; the type listed four. The missing
   one was `inputs`. Because no fixture ever carried it, the loss was unobservable.

   The neighbouring fixed-point test could never have caught it either, and the
   reason generalises: **an idempotence check cannot detect a loss that happens
   before its baseline.** Stripping is idempotent, so the pipeline was a perfectly
   stable fixed point *at the lossy value*. Fidelity-to-original and
   stability-under-repetition are different properties; only the first sees this.

## Implementation

| Phase | What | Where |
|---|---|---|
| P0 | Tripwire scans both roots, guards on node count; round-trip fixture type gains `inputs`; **three-whitelist parity ratchet** | `backend/typescript/test/{workflow-node-field-tripwire,node-field-contract-parity}.test.ts` |
| P1 | `inputs` modelled + read + emitted; `variables`/`configurableSchema` carried; conflation fixed; clipboard/clone/paste and chain-pack export wired | `builder/schema/{workflow,deserialize,serialize,chainPackManifest}.ts`, `builder/store/builderStore.ts`, `builder/nodeClipboard.ts`, `builder/persistence/backendStore.ts` |
| P2 | Read-only **Preset inputs** section + per-port override marker, 4 locales | `builder/inspector/Inspector.tsx`, `builder/i18n/*`, `styles/global.css` |

### What the UX review changed about P2

- **The override caution was unconditional and therefore useless.** It rendered on
  every node with preset inputs, while **0 of 187** shipped preset nodes actually
  have an incoming edge landing on a preset port. A warning that fires 100% of the
  time and is correct 0% of the time trains users to ignore warnings. Now computed
  per port from `BuilderEdge.targetPort` and shown only on a real collision; the
  section leads with what the value *is*.
- **"Pinned" was already taken.** ADR 0475's debug pins own that word and render a
  few sections below in the same panel ("Pinned output", "Clear pins"). Renamed to
  **Preset inputs**.
- **Values were raw JSON envelopes.** The two longest values in the corpus are
  approval prompts a user wants to read, rendered as
  `{"type":"static","value":"An MCP client requests…"}`. Now unwrapped, with a
  JSON fallback so an unrecognised shape stays visible rather than blank.
- **pt-BR used the wrong term** — `conexão de entrada`, where this catalog's word
  for an edge is `aresta` and `conexão` already means an OAuth connection. Fixed
  to `aresta de entrada` using the catalog's own vocabulary.
- **a11y:** the `<dl>` had no accessible name and the caveat was announced *after*
  up to 7 rows of data. Now `aria-labelledby` + `aria-describedby`, note first.

The parity ratchet is the durable artifact: it parses the node-field set out of
all three source literals and asserts set equality **in both directions** — a
missing field is a silent deletion, an extra one is a false promise.

> **Correction (code review, same day).** The first version of this sentence was
> false: the ratchet parsed **two** writers, not three — the producer was never
> read — and I had written the overstated claim into this ADR and the assessment
> doc. A doc that overstates a ratchet is the same false-promise family the ADR
> itself names. The producer is now genuinely parsed and the claim is true.
>
> Two further blind spots the review found by SABOTAGE, not by argument: the field
> matcher was a **closed alternation** of the five known names, so a sixth field
> added to the validator was invisible to every assertion; and the slice was not
> comment-stripped, so replacing `inputs?: …` with `// inputs field removed` kept
> it green — this repo's own `ratchet-gates-count-comments` lesson, recurring
> inside the ratchet written to end this class. Both fixed and re-probed.
>
> Its remaining boundary is now stated in the file: it reads SOURCE TEXT, so it
> catches a DELETED emit but not one left in place and disabled at runtime
> (`...(false && n.inputs ? …)` stays green — probed).

**Wiring, not just mechanism (ADR 0502).** `backendStore.loadWorkflow` builds
`SavedWorkflow` field by field and never read `variables`, so the deserialize
change was inert on the real load path until it was wired there too. Caught by
writing the test against the actual pipeline instead of a replica.

**The defect class recurred TWICE inside its own fix.** Both times the shape was
identical — *a type says a field is accepted while a second, hand-maintained
allowlist silently drops it*:

1. `builderStore.updateNode` declares `Partial<Pick<BuilderNode, …>>` in its
   interface AND re-enumerates the same fields in its body. Widening only the
   `Pick` let `inputs` typecheck while the implementation discarded it. A patch
   that compiles and does nothing.
2. `backendStore.loadWorkflow` (above).

A field-by-field reconstruction is a whitelist whether or not it is named one, and
TypeScript cannot see through one. Every such site is a place the next field will
be dropped. The parity ratchet covers the three *declared* contracts; these
in-body reconstructions are not yet mechanically checked — recorded under Open.

**The code review then found THREE MORE, and they mattered most.**
`builderStore.loadFromSaved`, `snapshot` and `persist` are allowlists three, four
and five — so `variables`/`configurableSchema` reached `SavedWorkflow` and were
discarded one call later, leaving the def-level half of this ADR **inert on the
builder's own save path** (autosave, Run, debug, collab, chain-pack export). The
ADR argued at length that this half must ship in-phase precisely to avoid
"preserve the refs, drop the declarations"; without the review it would have
shipped in exactly that state, with this document asserting otherwise.

`snapshot()`'s own comment records a previous grade pass fixing the identical
class for `lifecycle`/`metadata`. That makes this the **third** recurrence in that
one function. The lesson is not "check these five sites" — it is that a
field-by-field rebuild between a load and a save is a defect generator, and the
repo has five of them on one path.

Every schema-level test stayed green throughout, because they all hand-build a
`SavedWorkflow` and call serialize directly — replicating the pipeline rather than
driving it, which is the exact critique this ADR levels at the tests that missed
the original strip. A store-driven test (`loadFromSaved → snapshot →
serializeWorkflow`) now covers the hop, and was sabotage-probed.

**A visibility feature caused an infinite render loop**, caught by the tests the
UX review pointed out were missing. The `fedPorts` zustand selector built a new
`Set` per render, so the equality check never matched: "Maximum update depth
exceeded". Select the stable array, derive in a `useMemo`. Fifteen lines with a
green build is exactly the size at which "rendering ≠ working" bites.

## RFC gate

**No RFC.** This sends a field the host validator already accepts and already
persists, on the non-normative `/v1/host/openwop-app/workflows` route.

Two **pre-existing** wire divergences were found while verifying that and are
explicitly NOT fixed here (they are not caused by, worsened by, or fixed by this
change): `GET /v1/workflows/{workflowId}` returns the host runtime shape while
`../openwop/api/openapi.yaml` `$ref`s the canonical schema; and `PortValue` is a
closed `oneOf` in the spec while 74 of 187 shipped input values are bare literals
the executor deliberately supports. Both need an `../openwop` RFC.

## What the grade trio then found (2026-08-03)

**A SIXTH allowlist, and it carried the exact asymmetry this ADR forbids.**
`BuilderShell.onImportFile` rebuilds `SavedWorkflow` field-by-field in BOTH
branches. Node `inputs` rode through (deserialize reads them) while
`variables`/`configurableSchema` did not — "preserve the refs, drop the
declarations", which §"`variables[]` ships in the same phase" calls *a worse bug,
better camouflaged*. Reachable in one gesture (**Export → Import**, since export
writes the whole `SavedWorkflow` including `variables`) and untested. Fixed, with
a regression test. **Six allowlists on one path, found by four different readers.**

**The ratchet's FOURTH hole — it checked a promise, not delivery.** It parsed the
builder's `interface BackendNode` rather than its emit site, so a probe that
deleted the emit while leaving the declaration re-introduced the whole bug and the
ratchet stayed green. It now parses the emit site AND the read site (neither side
of the builder's two-function round trip had been covered), and matches ES
shorthand properties — `nodeId,` was being under-reported by a colon-only matcher.
Re-probed with the grade's own sabotage: now red on two assertions.

**Copy that becomes a required field's help text.** The derived per-parameter
`description` flows through `chainParamsToVariables` into `RunInputsForm`'s `help`
prop, so "Value for `{{params.n}}`, exported from the builder graph" was
explaining provenance under a field a user must fill. Rewritten to say what to
type. `required: paramNames` is KEPT deliberately — an unfilled param freezes to
`''` and the node SUCCEEDS, so blocking the preflight is the safer failure.

**An unlocalized user-facing string I added, that no gate could see.** The
`(empty)` label lived in a `.ts` helper, and `check-i18n` scans JSX only. Moved to
the catalogs across four locales. A checker's corpus is not its claim.

**Presentation:** the override marker rendered in `--mono` (it is prose inside a
mono value cell) at `--ink-3` — the dimmest text in the row, dimmer than the value
it warns about. Now sans, `--ink-2`, `--weight-emphasis`.

## Open

- Editable preset inputs, keyed off the derived ports (see above).
- **`routes/workflowChainExpandSeam.ts:89-93` is a FOURTH node-shape writer** and
  drops `inputs` when mapping onto the RFC 0013 wire shape for conformance
  scenarios — RFC 0013 requires substitution to recurse into `inputs`, so the host
  is under-reporting there. Pre-existing, zero local test coverage, and a
  conformance surface: filed rather than fixed blind at the end of this change.
- **Chain-pack export declared `parameters: {}` unconditionally** while exporting
  `{{params.*}}` tokens — an undeclared token freezes to `''` and the node
  SUCCEEDS (ADR 0507). Exporting `inputs` widened that from `config` to
  `inputs.to`. Now derived from the tokens actually present, which also closes the
  pre-existing `config` exposure.
- **`GEN-0518-1` — the fix is CLIENT-SIDE ONLY and there is no server-side
  guard.** An un-refreshed SPA keeps stripping. Worse, the collab derive is a
  wholesale head writer with no merge and `WORKFLOW_COLLAB_FIELDS` excludes
  `variables`/`configurableSchema`, so an old-bundle peer re-strips a head a
  new-bundle peer just restored — with REST autosave suspended, so nothing
  corrects it. The save route already re-reads the prior head for the
  removed-node disclosure; reusing that read to refuse or warn on a dropped
  `inputs` is the structural cure a source-text ratchet cannot reach.
- **Promoted workflows keep running the stripped definition.**
  `resolveLaunchDefinition` pins `publishedRevision`, so a promoted workflow
  launches the stripped revision until its owner re-promotes.
- **PII in chain-pack export.** The shipped corpus has zero literal emails (all 10
  `to` values are tokens), but an INSTANTIATED workflow may have had its recipient
  frozen to a literal — and the publish banner invites the user to PR the file to
  a public registry. `paramNamesIn` cannot declare away an already-frozen value.
- **Two existing steward probes are vacuous** — `DATA-ASSESSMENT.md:2215` and
  `DATA-ASSESSMENT-adr0507-deferred-seeding.md:149` query
  `k LIKE 'hostext:wfreg:%'`, but the key is a flat `wfreg:<workflowId>` with no
  `hostext:` prefix. Neither can match a row, so both "expect 0" results —
  including a shared-definition PII probe — mean nothing.
- **`chainPackManifest.ts` has no test file at all**, so the behaviour that
  changed most in this delta is asserted only by review.
- **In-body field allowlists are not mechanically checked.** The parity ratchet
  covers the three declared contracts, but `updateNode` and
  `backendStore.loadWorkflow` each re-enumerate fields inside a function body
  where TypeScript cannot see the omission. Both dropped `inputs` after the types
  said otherwise. A lint rule or a ratchet over field-by-field reconstruction
  sites would close the class.
- Node `name`/`position` persist only to localStorage — the validator drops both
  and `expandChain` never emits them, so canvas layout is lost across devices. A
  three-layer gap, pre-existing.
- Widening the validator past five fields stays deferred (ADR 0440). Zero of 551
  shipped nodes carry one of the ten dropped fields — now actually verified, by a
  tripwire that reads the right corpus.
