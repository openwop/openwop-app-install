# ADR 0999 — Compaction: children inherit the frozen decision, write-back reads are exempt, and the workflow-as-tool lane is fenced

Status: Accepted (implemented on `feat/fl2-64-tool-output-compaction`; flips to `implemented` when merged)
Date: 2026-10-28
Feature loop round 2, row 64 (Tool-output compaction, `tool-output-compaction`)
Amends: ADR 0099 (tool-output compaction), ADR 0604 (exemption + replay), ADR 0680 (mode parse)
Gap ids: `TOC2CD-1..9`, `TOC2UX-1..7` (new, this pass); carried prior rows named per decision

## Context

Round 1 left this feature at a claimed B+ (WF). Re-measured on `origin/main` @ `88bb552fb`, the
baselines are **WF B · UX C+ · CODE C+ · AI-exchange C+**. The kernel itself is sound: `lossless`
deletes insignificant whitespace and nothing else (`compact.ts` `minifyJsonText`), the
never-bigger guard holds, the fork lane is witnessed on the real `:fork` route
(`test/tool-output-compaction-fork-real-path.test.ts`), and the schema exemption is derived from a
runtime denominator (`test/schema-read-exemption-completeness.test.ts`). What is wrong is at the
EDGES: who inherits a decision, which outputs a model writes back, and one lane that skips the
fence that every other lane applies.

**Prod exposure (read-only, 2026-10-28, counts only).** The toggle is `beta`. 27,363 of 27,488
runs carry a `compaction` stamp, and every one is `lossless`. 0 of 11,752 agent profiles carry
`configParameters.compaction` (floor: 180 carry `configParameters`). 0 `node.tool_use` events
(floor: 14 `agent.toolReturned`). 0 of 1,471 child runs have a parent/child stamp mismatch. **Every
defect below is LATENT.** None is a cross-tenant or cross-member leak.

## D1 — A sub-workflow child inherits its parent's decision; it never re-resolves (`TOC2CD-1`)

`executor/subWorkflowDispatcher.ts:308` builds the child's metadata with
`stripReservedRunMetadata(...)`, and `compaction` is a reserved key (`host/runDispatch.ts:98`,
correctly, since TOCU-17 made the stamp unforgeable). Nothing registers it with
`registerInheritedRunMetadataKey`, so the child reaches `insertRunWithStartContext` with no key, and
`resolveCompactionDecision` (`decision.ts:75`) checks only `derivedFromRun`. The child re-resolves
**against the live toggle and its own agent profile**:

- a parent born with the toggle OFF gets compacted children after the toggle flips ON;
- a `:fork` replay re-spawns children under whatever the toggle says NOW (TOCWF-1, one level down);
- a lossless parent can spawn a lossy child.

`host/runStartContext.ts` already states the contract ("a per-run-decision contributor contributes
nothing for a child, exactly as for a `derivedFromRun` copy"), and the campaign autonomy contributor
honours it (`campaign-orchestration/autonomyStamp.ts`). Compaction does not.

**Decision.** Both halves, because either alone is wrong:

1. `wireSeams` registers `compaction` as an inherited key, projected through
   `readCompactionDecision` (so a malformed parent value is dropped, never copied). The copy is
   taken from the PARENT RUN ROW (host-written), never from a caller, so the TOCU-17 strip stays
   intact.
2. `resolveCompactionDecision` returns `{}` when `ctx.parentRunId` is set. Without this, a parent
   born with NO decision (inherited state = absent) would still hand its child a live one.

3. **The workflow-as-tool lane (architect B2).** `bootstrap/nodes.ts` `onToolUse` creates its child
   through `dispatchSubRun` → `POST /runs` with `metadata.parentRunId`, admitted by
   `admittedLinkage` (`routes/runs.ts`). That lane never sets the `run.parentRunId` column, so
   neither 1 nor 2 reaches it. `POST /runs` therefore copies the parent row's frozen `compaction`
   decision (through `readCompactionDecision`) when the linkage is admitted, and
   `resolveCompactionDecision` also returns `{}` when `ctx.metadata.parentRunId` is a string. That
   metadata key is only ever host-admitted: `stripCallerAttribution` deletes a caller's
   `CALLER_LINKAGE_KEYS` (`host/runLinkage.ts`), and only `admittedLinkage` (a wildcard service
   caller naming a same-tenant parent) puts it back. If a caller could supply one, the only effect
   is an uncompacted run, the safe direction.

   > **CORRECTED by the closing `/code-review` (M3).** The first cut merged the whole
   > `inheritedRunMetadata(parent.metadata)` on this lane, which also carried the campaign family's
   > stamps. Their projectors can refuse a malformed parent with a 422, which on this lane would
   > have failed the child `POST /runs` and reached the model only as `sub_run_create_failed`.
   > Widening what this lane inherits is that family's decision, so the lane copies ONLY the
   > compaction key. Filed: `TOC2CD-12` (the dispatchSubRun lane carries no campaign stamps, as
   > before this ADR).
4. The projector is `(v) => readCompactionDecision({ compaction: v })` (`readCompactionDecision`
   takes the metadata object, not the value).

The root run's decision governs the whole tree. A child whose own agent opted into `lossy` stays
`lossless` under a `lossless` root. That is a behaviour change, and it is the point: the decision is
frozen per unit of work, not per node.

## D2 — The workflow-as-tool lane fences its result (`TOC2CD-2`)

`bootstrap/nodes.ts` `onToolUse` (the chat node with workflow tool bindings) returns
`applyToolResultTransform(formatSubRunResult(subResult), …)` to the provider dispatcher, and
`providers/dispatchAnthropicTools.ts` / `dispatchMiniMaxTools.ts` put it in the model's context
verbatim. A child workflow's output is whatever its nodes produced: an `http.fetch` body, a web
search, a form submission. It reaches the model with no RFC 0137 §F1 fence. The fence ratchet
(`test/tool-result-fence-callers.test.ts`) could not see this lane, because its population is
"files that mention `executeTool`" and this lane never calls it.

**Decision.**

- A new `toModelWorkflowToolResult(name, content)` beside `toModelToolResult` in
  `host/toModelToolResult.ts`, so the fence decision stays in the ONE module that owns the RFC 0021
  threat model. It always fences (a workflow's output is never host-authored vocabulary) and
  records the decision in the fence tally under `workflow:<name>`.
- `nodes.ts` applies it AFTER compaction (the fence wraps what the model reads, as on
  `agentDispatch`). A `completed` and a `failed` result are fenced: a child's `error` is a node's
  error text, which can echo fetched content. A `pending` result is host-authored (`runId` + a
  fixed sentence) and stays unfenced, so its instruction is not wrapped in a distrust warning.
  **This differs from `toModelToolResult`, which never fences an error (architect H6), on
  purpose:** a builtin's error is host-authored text, while a child RUN's `error` is whatever its
  failing node said. The builtin-error policy is unchanged here; whether a node-tool error on
  `agentDispatch` (`JSON.stringify(outcome.error)`) can echo fetched text is filed as `TOC2CD-11`.
- The fence ratchet's population widens to files that mention `executeTool` **or** `onToolUse`.
  `nodes.ts` is classified `MODEL_FACING`; the two provider dispatchers are `PROGRAMMATIC` (they
  forward the callback's content and never author a result). A `MODEL_FACING` row must call
  `toModelToolResult(` or `toModelWorkflowToolResult(`. `host/toolResultTransform.ts` names
  `onToolUse` in prose and joins as `PROGRAMMATIC`; the "not stale" check widens the same way
  (architect M10).

Binding names are `^[a-zA-Z0-9_-]{1,64}$` (`validateToolBindings`), so they cannot collide with a
builtin id (every builtin contains `:` or `.`). The candidate finding `TOC2CD-9` is refuted.

## D3 — Two read-before-write payloads were misclassified, and the marker is refused at the write edge (`TOC2CD-3`)

> **CORRECTED by the pre-code `/architect` pass (B1).** The first draft claimed the exemption "never
> asks the write-back question" and proposed a new `writeBackSource` declaration. **Both were
> false.** `test/schema-read-exemption-completeness.test.ts` already defines `true` to include
> "(c) a body the model READS BEFORE IT WRITES a replacement (the `get-design` family,
> `cms.get-draft-page`)". A second field would have been a second name for (c). Two of the four
> rows were also wrong: `cms.get-page` is adjudicated `false` on purpose (it is the PUBLISHED read,
> and `update-section-draft` works only on drafts and tells the model to read `get-draft-page`,
> which is exempt), and `discovery.list-rules → create-rule` mints a NEW rule, so it is a copy, not
> a write-back. What remains true is narrower.

| read | verdict | why |
|---|---|---|
| `openwop:cms.translate-section` | **(c), was `false`** | its `overlay` output is the body `update-section-draft` (with `locale`) writes back; `buildSectionData` filters a marker element out and persists the shortened overlay |
| `openwop:funnels.get` | **(c), was `false`** | its `steps` are "the bindings a revision must keep" (`funnels/agentTools.ts`), and `funnels.draft` with `funnelId` replaces the whole list; a model that drops the marker deletes the middle steps |
| `openwop:cms.get-page` | stays `false` | adjudicated already; the write path reads the exempt draft sibling |
| `openwop:discovery.list-rules` | stays `false` | a copied rule loses actions, no stored row is rewritten; filed against discovery (`TOC2CD-10`) |

**Decision.**

1. `cms.translate-section` and `funnels.get` declare `schemaCarrying: true` under category (c),
   with the reason at the registration site, and join the literal floor array. Their completeness
   rows flip to `true` with an inline correction note. No new field.
2. **The structural half: the marker is refused at the write edge.** A classification is reviewed
   by a person, so it stays a floor. The model-to-app edge also refuses the artefact itself. When
   the run's decision is `lossy`, a tool INPUT that contains a compaction marker (an array element
   that is an object whose only key is `_elided` with a number value) is refused before the tool
   runs, with the typed code `compaction_marker_in_input` and the JSON path. ONE helper
   (`findCompactionMarkerPath`, in `host/toolResultTransform.ts` beside the kernel's marker
   constant) is called on BOTH lanes that compact under a run decision: `runChatToolLoop` and the
   `nodes.ts` workflow-tool `onToolUse` (architect H4). The voice bridge has no run and never
   compacts, so it is out of scope. On `runChatToolLoop` the refusal is emitted exactly like
   `invalid_args` (`status:'error'`, `error.code`, no `durationMs`, because the tool never ran),
   beside that check rather than through `CAPABILITY_PRECONDITION_CODES`, which classifies codes
   derived from a tool that was CALLED. It never reaches `node.failed`; it is a tool-return error
   the model sees and can repair by re-reading. *(Corrected at implementation: the draft said it
   would join `CAPABILITY_PRECONDITION_CODES`.)* Accepted: under D5.3 a payload's own
   `{"_elided":N}` row survives compaction, and a lossy model that copies it is refused (that is a
   false refusal on genuine data, judged preferable to persisting a fabricated row).

3. **The writers refuse the marker too (lead review, 2026-10-28).** The tool-loop refusal (2) fires
   only under a `lossy` decision on a model lane. The three write tools the sweep found
   (`cms.update-section-draft`, `discovery.create-rule`, `funnels.draft`) now refuse a
   `{"_elided":N}` element themselves, first thing in `run`, with the same typed
   `compaction_marker_in_input`, instead of filtering it out. That closes the marker half of
   `TOC2CD-10`; the other malformed shapes those sanitizers still filter stay filed.

   **Why the exemption is still `schemaCarrying` category (c) and not a new `readBeforeWrite`
   flag.** It IS a declaration on the tool (`schemaCarrying: true` at the registration site, read
   by `isSchemaReadExempt`), and the completeness ratchet forces every registered tool to be
   classified against a question that now names write-back explicitly. A second flag with the same
   effect was the architect's B1 finding; a rename of the field is cosmetic churn across ~30 sites
   and is not done here.

A read-for-write check by description mention was measured and declined: matching full tool ids in
every write tool's definition finds 15 references among 219 tools, and misses `funnels.draft →
funnels.get` (the description never names it). TOCC-R3 declined the same instrument for the same
reason.

## D4 — An error result is never lossy-compacted (`TOC2CD-4`)

`agentDispatch.ts` applies the transform whatever `execOut.isError` says, and a node tool's failure
content is `JSON.stringify(outcome.error)`. Under `lossy`, a 12-item validation-issue list reaches
the model as 3 + marker + 1, so the ONE error-fed repair attempt sees a third of what is wrong. The
wire stays honest (the error code is derived from the uncompacted content), but the repair loop does
not.

**Decision.** `ToolResultTransformContext` gains `isError?: boolean`. `applyToolResultTransform`
downgrades a `lossy` decision to `lossless` for an error result (whitespace only, every byte of
every issue kept). `agentDispatch` passes `execOut.isError`; `nodes.ts` passes
`subResult.status === 'failed'`.

## D5 — Kernel: never throw, never drop a key, never put an object into a scalar array (`TOCC-7`, `-8`, `-9`, `TOC2CD-7`)

All red-probed on `88bb552fb`.

1. **`__proto__` (TOCC-9).** `{"__proto__":{"x":1},…}` loses the key under `lossy`: `out[k] = …`
   on a plain object sets the prototype instead of an own property, and the pass-through branch has
   the same defect. Output objects are null-prototype (`Object.create(null)`), so every key is an
   own data property in every branch.
2. **Scalar arrays (TOCC-8).** `elideArrays` claims "homogeneous" and checks nothing, so a string
   `enum` or an id list gains an object element. Elision now applies only when EVERY element is a
   plain object (a row list). Arrays of scalars (ids, enums, tags) are never elided. This also
   removes the id-list half of the D3 hazard (`discovery.search`, `recommendations.resolve`).
3. **Marker collision (`TOC2CD-7`).** An array that already contains an element with an own
   `_elided` key is not elided, mirroring the `_emptied` guard, so a payload's own data is never
   mistaken for our disclosure.
4. **Never throws (TOCC-7).** A 20,000-deep payload makes the recursive transforms throw
   `RangeError`. The boundary already fails open, but `surface.compact` surfaced an uncoded
   `RangeError`. `compactToolOutput` now returns the input unchanged when the lossy transform
   throws, which makes its docstring true. The catch covers `JSON.stringify` too, which throws the
   same `RangeError` on deep nesting (architect L14).
5. **What D5.2 costs, stated (architect H5).** Arrays of arrays (tabular rows) and object lists
   that contain a `null` also stop being elided, so `lossy` saves less on those shapes. Two pinned
   texts change with it: the `envelope-live-roundtrip` negative control (its rows become objects)
   and the `bi.list-metrics` adjudication, which cited scalar elision. The node's `mode` description
   and the `compact.input.json` text say "arrays of objects" (architect M13).

## D6 — The node schema publishes `minChars`; the notice says what is true (`TOC2UX-2`, `-3`, `-5`, `-7`)

- `compact.input.json` has `additionalProperties: false` and no `minChars`, while
  `surface.compact` accepts it. The schema gains `minChars` (integer, minimum 0). Pack `1.2.1 →
  1.2.2` in lockstep (pack, node, `$id`, steward manifest digest).
- The notice title "Shortened before the model saw it." renders only on the `compact` NODE's
  recorded output, which goes to downstream nodes and may never reach a model. It becomes
  "Shortened by tool-output compaction." in all four locales.
- The emptied-field list is joined with `Intl.ListFormat` in the active locale.
- The stale test-file citation in `CompactionNotice.tsx` is corrected.

## D7 — The per-agent `lossy` opt-in gets an editor and an indicator (`TOCU-2` Blocker, `TOC2UX-1`)

The only control that enables information-destroying compaction has been settable only through
the raw profile API since ADR 0099 Phase 2. An `AgentCompactionPanel` on the agent workspace,
following `AgentVoicePanel` (PUT merges, carries every sibling `configParameters` key, a viewer sees
a read-only state), shows the current mode and edits `lossy`, `head` and `tail`. Turning `lossy` on
shows what it does (rows elided, empty fields dropped, both disclosed) and that it applies to NEW
runs only (the decision is frozen at run start). The panel says the setting applies only to runs
this agent STARTS: after D1, a run inside another run's tree inherits the root's decision
(architect H7). Manual test `TOC-01` is rewritten around this
panel and the node lane, which a tester can actually observe.

## Refused / deferred

- **Retiring `lossy`.** It has 0 prod users, and D3/D5 make it safer rather than safe. Retiring it
  is a product decision, not this ADR's. Recorded for the owner.
- **The write-side silent filters** (`cms buildSectionData`, `discovery cleanActions`) drop a
  malformed element instead of refusing it. The compaction-marker half is closed by D3.3; the
  other malformed shapes belong to those features' rows. Filed as `TOC2CD-10` (partial).
- **`isSchemaReadExempt` is a live input on replay (`TOC2CD-5`).** A replay on newer code can
  exempt a tool the original run compacted. Accepted residue (as ADR 0604 recorded it): only ever
  toward MORE byte-exact output, and the run record holds the recorded node output, not the model's
  view.
- **`TOC2CD-6`** (the runless lane reads the profile by the addressed id) fails safe to lossless;
  carried to the identity-spellings row (`AKM2-R1`).
- **`TOC2CD-12`** — the `dispatchSubRun` lane inherits only the compaction key (D1.3 correction).
- `TOCU-3/-5/-6/-8/-9/-10/-14/-15/-16`, `TOCC-5/-11/-13/-15/-18`, `TOCC-D1..D5`, `TOCC-R1/-R2/-R4/-R5`
  are carried unchanged.

## D1.3 security — who can make a run inherit (lead review, 2026-10-28)

The copy happens only when `admittedLinkage` (`routes/runs.ts`, ADR 0902 D2, unchanged) admits the
parent:

```ts
if (principal.tenants?.includes('*') !== true) return undefined;
…
const parent = await storage.getRun(parentRunId);
if (!parent || parent.tenantId !== tenantId) return undefined;
```

- **(a)** Only the wildcard service principal (the sub-run dispatcher's internal token) can name a
  parent, and only one in the run's own tenant. A member's `metadata.parentRunId` is deleted by
  `CALLER_LINKAGE_KEYS` before the build. A wildcard principal passes every run-read predicate, so
  readability is implied, not re-checked.
- **(b)** A parent in another tenant, or one that does not exist, admits nothing: no linkage, no
  copy, and the same `201` as a run with no parent (no existence oracle).
- **(c)** Only the `compaction` key is copied on this lane. It is a frozen decision about how much of
  a tool result a model reads; it grants no scope, autonomy or authority.

Witnessed in `test/adr0999-compaction-linkage-and-writers.test.ts`: dropping the wildcard check
reds the member case, dropping the tenant check reds the cross-tenant case, and removing the copy
reds the control (which is also red on the pre-ADR code).

## Closing review fold-in (2026-10-28)

`/code-review` + `/grade-code` (C+ → **B+**, no Blocker or High) and `/grade-ux` (C+ → **B+**):

- **M1** — the D4 downgrade was witnessed only at the helper. Added wired witnesses on both lanes
  (`runChatToolLoop` with a failed tool, and the chat node with a failed child run).
- **M2** — this status line and the strip named in D1.3 (corrected above).
- **M3** — D1.3 narrowed to the compaction key (correction above).
- **M4** — the `nodes.ts` marker refusal now records `node.tool_use` + `node.tool_result{failed}`,
  so the refusal is on the timeline.
- **L5** — the marker path is bounded to 200 characters and the wire message is
  `scrubSecretShaped`, like `invalid_args`.
- **L6** — the marker check runs before the approval, permission and firewall gates, so a person
  is never asked to approve a write that is then refused.
- **L7** — known false negatives are listed at `findCompactionMarkerPath`.
- **L8** (the fence ratchet is a file-level substring) and **L9** are accepted; the behavioural D2
  witness covers the real path.
- **UX** — `TOC2UX-8` the chip states the SAVED mode, not the unsaved checkbox; `-9` Save is
  offered only for a change and a stale success notice clears on edit; `-10` a failed load shows a
  retry instead of a silently disabled form; `-11` the shared `CheckboxField`, with the lossy
  warning as its `aria-describedby` help; `-12` "Leave blank for N" help; `-13` head/tail are kept
  while lossy is off; `-15` plainer description; `TOC2UX-4` the pack description lost the
  `ctx.features[…]` jargon. Carried: `TOC2UX-14` (the scope note speaks of runs, not chat
  conversations) and the English-only node text (a repo-wide gap: 0 of 75 node packs localize).

## Implementation record

| Phase | Decisions | Commit |
|---|---|---|
| P1–P4 | D1–D7 | `8398a1a3f` |
| Closing review | M1–M4, L5–L7, TOC2UX-4/8–13/15 | the head of this PR |

## Pre-code `/architect` pass (2026-10-28) — fold-in

2 Blockers, 5 High, 6 Medium, 3 Low. Folded: **B1** (D3 premise false, `writeBackSource` deleted,
two rows dropped), **B2** (D1.3, the `dispatchSubRun` lane), **H3** (moot once B1 removed the new
field: category (c) already exempts from both modes, and `lossless` is whitespace-only), **H4**
(marker refusal on both lanes), **H5** (D5.5), **H6** (D2 note + `TOC2CD-11`), **H7** (D7 copy),
**M8** (D1.4), **M9** (the compensation probe sets `parentRunId`, so its decision changes from live
to `{}`; a witness pins that a child of an unstamped parent stays unstamped), **M10** (D2), **M11**
and **M12** (D3.2), **M13** (D5.5), **L14** (D5.4), **L15** (D5.1). **L16** confirmed the RFC
verdict: `agent.toolReturned.error.code` is an open string, and the registered-code check covers
only `run.failed`, `node.failed` and the snapshot error.

## RFC verdict

No wire change. `run.metadata.compaction` is a host-internal key, `schemaCarrying` is a host
`BuiltinTool` field, and `compaction_marker_in_input` is a tool-result error string on the existing
RFC 0064 tool-return lane (its `code` is derived as today). No new event type, field or capability.

## Implementation plan

| Phase | Scope |
|---|---|
| P1 | D1 child inheritance + D4 error downgrade + D5 kernel |
| P2 | D2 fence + ratchet widening |
| P3 | D3 declaration + floor + completeness rows + marker refusal |
| P4 | D6 schema/pack bump + notice copy; D7 panel + manual test |
