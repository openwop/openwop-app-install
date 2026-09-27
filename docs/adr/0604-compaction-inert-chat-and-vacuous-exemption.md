# ADR 0604 — Tool-output compaction: an inert chat lane, a vacuous exemption gate, and a mode whose name was the defect

Status: implemented (2026-08-23)

Supersedes nothing. **Corrects ADR 0099** (Tool-output compaction) at ~~four
current-state claims~~ **many more than four — see §4 and the closeout note below**, and corrects
one citation each in `ARCHITECTURE.md`, `FEATURES.md`, `ROADMAP.md`, `ADR 0388`, and the
operator-facing toggle description.

> **CORRECTED 2026-08-23 (feature-30 closeout).** "Four current-state claims" was written before
> review M5 opened ADR 0099 at all, and was never updated: M5 alone added a correction block at
> "The kernel", struck and superseded the item-2 specification, annotated every −52 %, and
> corrected "four MORE stale sites in the same file" — and the §3 TOCU-2 row corrects the
> Phase-2 status row on top of that. The closeout then found **seven more** in the same file
> (§7). A count in a header is the cheapest thing in an ADR to leave stale, and this one
> understated the document's own reach by roughly a factor of four.

Context: the feature-32 assessment (`a99a8ef0f`, #3449) graded this surface
**C+ / C+ / C** (D on replay/fork) with 9 Blockers. This ADR records what was
fixed, what was refused and why, and what is deferred with a mechanism.

---

## 1. The through-line

Every Blocker in this batch is the same failure in a different costume: **a
guarantee asserted in prose, enforced nowhere, and defended by an instrument
that could not fail.**

- `:fork` was documented as replay-safe by a comment on the line where it was
  not, and witnessed by a test that modelled the fork as `(m) => ({...m})`.
- The chat lane was advertised in three documents as the flagship surface and
  was never handed a decision.
- The schema-exemption invariant was guarded by a loop over its own allowlist.
- The mode called `lossless` deleted fields, and three tests **asserted that it
  did** — pinning the defect as the specification.

The transferable lesson is the one CLAUDE.md already states about itself: **a
citation is a claim, not evidence.** In this feature, four separate documents,
one in-code invariant comment, and 61 green tests all agreed with each other and
all disagreed with the code.

---

## 2. Decisions

### D1 — `derivedFromRun`: absence on a copied blob is inherited state

**Problem (TOCWF-1, PROVED by execution on the real route).** `:fork` copies
`sourceRun.metadata` verbatim and then inserts through
`insertRunWithStartContext`, which re-runs every run-start contributor. The
"never overwrite an existing key" merge protects a key that is **present** and
says nothing about one that is **absent**. A run born while the toggle was OFF
carries no key, so a fork taken after the toggle flipped ON acquired
`{mode:'lossless'}` it was never created under.

Blast radius is not marginal: the toggle ships OFF, so **every run in an existing
deployment is in the vulnerable state**.

**Decision.** `RunStartContext.derivedFromRun` marks a run whose metadata is a
verbatim copy. `resolveCompactionDecision` resolves nothing when it is set —
checked *before* the toggle read, because the toggle's current value is exactly
the input a fork must not be sensitive to. The flag is **advisory per
contributor**: the authority contributor deliberately ignores it, since
re-deriving against the forking caller's scopes is the point there.

**The prescribed cure was falsified and NOT applied.** The assessment prescribed
"stamp `{mode:'off'}` explicitly". Enumerating the readers by call graph
(`executor.ts:734` → `NodeContext.compaction`; `routes/agents.ts:361`; then
`packIsolationDispatch`, `packWorkerRunner`, `agentRunnerNode`, `agentDispatch`,
`bootstrap/nodes`) shows `off` ≡ absent at every one, so the stamp is
behaviourally inert *except* for blocking the re-stamp. But:

1. **It does not close the Blocker.** It protects runs created *after* the fix.
   Every run already in the database has no key, so forking any of them after
   enabling the toggle would still compact. That is a mechanism-level
   insufficiency, not a stylistic preference.
2. It writes a decision key onto every run in the system forever, including runs
   of features that never call an LLM, and it changes `run.metadata` on the read
   wire. ~~`test/subrun-parent-linkage.test.ts:32` asserts an exact metadata
   object and reddens.~~

   > **CORRECTED 2026-08-23 (review LOW) — that citation is FALSE, and it was
   > settled by execution rather than by argument.** The cited test stubs
   > `fetch` and asserts the OUTBOUND POST body built by `dispatchSubRun`; no
   > run-start contributor runs in it at all. MEASURED: with the rejected cure
   > applied (`return { compaction: { mode: 'off' } }` on the toggle-off branch)
   > `test/subrun-parent-linkage.test.ts` is **2 passed**. The general point —
   > that the stamp perturbs `run.metadata` for every run forever — stands; the
   > specific test named as its consequence could not exhibit it. **A rejected
   > cure's rationale gets the least scrutiny of anything in an ADR, precisely
   > because nobody has to build it.**

`derivedFromRun` closes it for legacy rows *and* new ones, and adds no bytes.

> **REVIEW H1 (2026-08-23) — GROUND 1 WAS THE RIGHT AXIS AND WAS NOT FULLY
> WALKED.** The enumeration above was done by call graph **over the READERS** of
> the decision. The property that needed enumerating is the WRITE side: which
> run creators hand the insert seam a metadata blob COPIED from an existing run.
> There are exactly two — `routes/runs.ts` (`:fork`) and the redrive route in
> `routes/workflowDebug.ts` — and only the first got `derivedFromRun`, so the
> redrive HALF-inherited: a present decision survived the copy, an absent one
> was re-resolved against the live toggle. Proved by execution. Fixed, and
> `test/run-metadata-copy-sites.test.ts` is now the ratchet over that
> population.

### D2 — `lossless` means lossless; the savings were the defect

**Problem (TOCC-3 / TOCWF-7).** Measured on the shipped kernel:

| input | output |
|---|---|
| `{"results":[],"query":"q"}` | `{"query":"q"}` |
| `{"ok":false,"error":""}` | `{"ok":false}` |
| `{"agents":[],"workflows":[],"roster":[],…}` | `{}` |
| `{"type":"object","required":[],…}` | `required` gone |

(`false` and `0` **are** preserved — the classic `[]`-truthy / `''`-falsy trap
was correctly avoided. The defect is semantic, not that one.)

An empty array that means "we looked and found nothing" is not noise. Dropping it
converts an honest empty into an **absent field** — the success-with-empty family,
with the *app* on the lying side. `agent-author.nodes.get`'s honest fail-empty
compacted to `{}`.

**Decision.** `lossless` is now minify-only and proved information-preserving by
a round-trip deep-equal property test. `dropEmpty` moved under the per-agent
`lossy` opt-in and **discloses what it removed** (`_emptied: [keys]`).

**Why not "narrow the rule" or "just rename it".** There is no rule that
separates a *noise* empty from a *claim* empty without the payload's schema, and
the kernel has no schema. A rename alone leaves the harm; a narrowing (drop only
`null`? only nested?) is a guess dressed as a rule. The only defensible position
is that a transform which cannot tell them apart must not be the default-on
behaviour.

**MEASURED, AND IT COSTS SOMETHING.** `0 of 336` `JSON.stringify(...)` call sites
across `src/features/*/agentTools.ts` pass an indent argument — every builtin tool
already emits minified JSON. **So minification saves nothing on real tool output,
and 100% of the measurable saving `lossless` ever produced came from the lossy
half.** The advertised "~−52 % structure-preserving" number was the defect,
quantified. This is recorded in `compact.ts`, `FEATURES.md`, `ROADMAP.md` and the
operator-facing toggle description rather than hidden, because an operator
enabling this on the old copy was buying token savings with silently-altered tool
output.

A consequence worth naming: with disclosure, `dropEmpty` usually costs more bytes
than it saves, so the never-regress guard simply declines. That is correct
behaviour, pinned by a test — **compaction never buys a saving by going silent.**

### D3 — exemption becomes DERIVED; the gate takes a runtime denominator

**Problem (TOCC-2 / TOCC-2a).** `envelope-live-roundtrip.test.ts:137` walked
`SCHEMA_READ_EXEMPT_TOOLS` and checked each member — no `expect.assertions`, no
length floor, no negative control. **Emptying the array was green**, and 4 of 9
entries were deletable with the suite green.

The deeper problem is that **no static gate over that array could ever be
complete.** `BUILTINS` is six static entries plus two spreads
(`RAG_RETRIEVER_IDS`, `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`) and is then MUTATED by
~184 `registerFeatureAgentTool` calls. Any census of the source is a floor **by
construction** — demonstrated by the assessment's own prescribed census, which
said "6 static + 7 projected" when the truth is 6 + 2 + 9, and missed
`feature.crm.nodes.segment-vocabulary`: a **schema-carrying tool invisible to any
grep of `features/*/agentTools.ts`**, because it is projected from a node typeId
rather than registered.

**Decision, two parts.**

1. **Declare, don't remember.** `BuiltinTool.schemaCarrying` sits beside
   `contentTrust`, and `isSchemaReadExempt` derives from it. The literal array
   survives as a **registration-independent floor** — `builtinAgentTool` answers
   from a map populated at feature init, so in a process where a feature has not
   registered the derivation lane would return `undefined` and fail OPEN into
   "compact it". A test asserts the two lanes agree, so they cannot drift.
2. **A runtime denominator.**
   `test/schema-read-exemption-completeness.test.ts` boots the real app and takes
   its population from a live `builtinAgentToolIds()` — **201 ids** — requiring
   every one to appear in a total classification. A new tool reddens the suite
   until somebody answers "does this output carry a closed world the model must
   cite back exactly?". A runtime denominator cannot be a floor.

**Why `schemaCarrying` is OPTIONAL when `contentTrust` next door is REQUIRED.**
`contentTrust` guards a security boundary and its fail-open default silently
unfenced 166 of 168 registrations, so the compiler had to be the ratchet. Here a
required field would force a judgment at 201 sites in one pass, and ~180 of those
would be a reflexive `false` — **a fail-open wearing a ratchet's clothes.** The
ratchet is the completeness test instead, which forces the judgment one tool at a
time, at the moment somebody actually knows the answer.

**And note what D2 did to this problem.** "Schema-carrying" is not a fact about a
*tool*; the harm was a fact about the *transform*. Dropping `required: []` hurts
every tool that returns a present-but-empty field, and there are 201 of them.
Fixing the transform fixed all of them at once, including the ones nobody
classified. The list now guards only the opt-in `lossy` path. **Enumerating the
victims of a lossy transform was the wrong axis.**

**Derived census — nine ids were missing:**
`feature.agent-author.nodes.get`, `feature.workflow-author.nodes.get`,
`documents.get-template`, `slides.get-design`,
`feature.crm.nodes.segment-vocabulary`, `feature.crm.nodes.validate-segment`,
`cad.get-design`, `drawings.get-design`, `campaign-studio.get-design`.
The last three come from resolving the `get-design` family, whose exact
structural twin `app-builder.get-design` had been exempt since the list existed.

### D4 — wire the chat lane rather than retract the advert

**Problem (TOCC-1 / TOCWF-3).** `conversationToolLoop.ts` passed fifteen keys into
`runChatToolLoop`; `compaction` — an option the loop has accepted since ADR 0099
Phase 1 — was not one of them, so `applyToolResultTransform` short-circuited on
`!ctx.decision` at every chat turn. `FEATURES.md`, `ARCHITECTURE.md` ("Covers
chat…") and ADR 0099's pass-3 note all said otherwise. The ADR had conflated the
`bootstrap/nodes.ts` heartbeat node — whose tool names are regex-validated to
exclude `:` and `.`, so no `openwop:*` id can reach it — with the interactive `/`
chat.

**Decision: wire it.** The lane reads the run's own frozen metadata (the reader
the executor uses), so it inherits the run-start freeze and stays replay-safe. A
live toggle read at turn time is exactly what the freeze exists to prevent.

Cost one line; retracting the advert would have cost three documents and left a
capability the architecture already supports switched off by omission.

### D5 — a fence must not be removable by length

**Problem (TOCC-4).** `openaiSideband.ts:351` sliced an **already-fenced** tool
result at 4000 chars. The fence header alone is ~230, so any result over ~3.8 KB
lost `END UNTRUSTED CONTENT` and an **unterminated, data-only fence was injected
into a live realtime session.**

**Decision.** `truncateFencedContent` truncates the body and re-closes the fence,
disclosing the loss *inside* the fenced region, and fails **closed** when the
budget cannot hold header+tail. A plain `.slice()` on possibly-fenced text is now
a defect the helper makes unrepresentable, and a call-site ratchet keeps it that
way.

### D6 — one denominator for both properties a tool result must satisfy

**Problem (TOCC-6).** `tool-result-fence-callers.test.ts` exists *because* the
voice bridge once drifted unfenced. Compaction had no equivalent, and
`toModelToolResult.ts` asserted "compaction runs BEFORE fencing" — false on one of
the two paths **that file itself enumerates** (`toolBridge.ts` fences, never
compacts).

**Decision.** `test/tool-result-compaction-callers.test.ts`, over the **same
`executeTool` population** as the fence ratchet. Two ratchets over two
populations is how one develops a blind spot the other cannot see — which is
literally what happened: the fence ratchet classified
`conversationToolLoop.ts` PROGRAMMATIC ("the loop fences"), which was true, and
nothing anywhere asked whether the loop also compacts.

---

## 3. Refused, deferred, and recorded — with mechanisms

| id | disposition | mechanism |
|---|---|---|
| **TOCWF-1 prescribed cure** (`stamp {mode:'off'}`) | **REFUSED** | Does not close the Blocker for any run already in the database, and perturbs `run.metadata` on every run forever. See D1. |
| **`schemaCarrying` as a REQUIRED field** | **REFUSED** | 201 sites in one pass produces ~180 reflexive `false`s — a fail-open with a ratchet's shape. Replaced by a runtime-denominator completeness test. See D3. |
| **Anon lane compaction** | **RECORDED, not fixed** | `anonymousActor.ts` creates its run with a bare `storage.insertRun`, bypassing `insertRunWithStartContext`, so no frozen decision exists. Routing it through the seam also runs the AUTHORITY contributor for an **anonymous** principal — a security-relevant change that needs its own decision, not a token-savings fix. Recorded at the call site and as a reasoned exemption in the caller ratchet. |
| **Voice-bridge compaction** | **RECORDED, not fixed** | The realtime bridge has no run and therefore no frozen decision. Guessing one live would break the run-start freeze. Recorded as a reasoned exemption. |
| **Both of the above, as *registered* debt** | **PINNED, ceiling raised 2 → 4** | The two rows above are recorded in the vocabulary `defect-pin-vocabulary.test.ts` watches for, so the two new enumeration ratchets (`run-metadata-copy-sites`, `tool-result-compaction-callers`) tripped it — correctly. They are `pin`, not `correction`: each blesses a **shipped, open** gap and will need editing when it closes. The alternative was to reword the `why` strings until the grep stopped matching, which would have turned the gate green while leaving the debt identical — so the ceiling was raised deliberately, with the anon lane's security caveat repeated at the registry entry. Found by CI on the fix batch itself, not by review. |
| **TOCU-2 — the lossy config editor** | **DEFERRED; ADR 0099 corrected** | `agentProfile.configParameters.compaction` has **no editor anywhere in the SPA** — `AgentVoicePanel` edits `.voice` only and `AgentGuardrailsPanel` merely passes the bag through (its docblock even names `.compaction`). Given D2, **lossy is now where 100% of the savings live**, so this is the gap that matters most; it is a new surface (form + i18n×4 + a11y + tests) and is scoped as a follow-up rather than smuggled into a fix batch. **CORRECTED 2026-08-23 (review M6): "no editor anywhere in the SPA" was presented as meaning lossy is UNREACHABLE, and it was not.** `run.metadata.compaction` was client-forgeable — `POST /v1/runs {"metadata":{"compaction":{"mode":"lossy","head":0,"tail":0}}}` froze a lossy decision with the tenant toggle OFF (traced three hops, then executed). So the only path to lossy was the one that BYPASSED the operator. `compaction` is now in `RESERVED_RUN_METADATA_KEYS`; the deferral stands, the reachability claim does not. ADR 0099's Phase-2 row is corrected: a capability with no operator path is not "Implemented". |
| **TOCU-7 — `call.inputs` / `call.outcome`** | **DELETED** | Unreachable by construction: readers exist, no writer anywhere in the SPA, and the transport makes it structural — `agent.toolCalled` carries an `argsHash`, never args, and `agent.toolReturned` carries no result payload. Reviving them needs an RFC in `../openwop`. A disclosure that looks like tool transparency and shows nothing is worse than its absence. |
| **TOCU-7 — `agentEvents.decisions` / `.handoffs`** | **RECORDED, not deleted** | Different class: these are a WIRING gap in `hooks/chatSession/lib.ts` (no `handoff`/`decision` branch beside `tool-called`), not a wire limitation. The components are already correct. Recorded at the constructor. |
| **TOCU-4** | **OUT OF SCOPE** | Shares a root cause with the open `WFAU-4`: both need an **RFC 0064** change in `../openwop`, not a host PR. A spec change needs an RFC there. |
| **`check-failure-card-recovery` population** | **ANALYSED; no change** | The assessment noted this feature is outside the gate twice over (`failureCardScan.mjs:63` matches `/<StateCard\b/`; `FAILURE_COPY` has no truncation term) and asked whether the gate should reach it. **It should not**: that gate asserts a *failure card* offers a recovery action, and a truncation disclosure is not a failure — there is nothing to recover. The gate that *should* have reached it is `check-notice-announce`, whose population is `variant="success" \| "error"`; an **`info`** notice carrying a content-integrity fact is a third class it does not cover. Not widened here (that gate's baselines are a separate, carefully-argued cohort), but ~~the component announces via the delegated `GlobalLiveRegion` and its own test asserts the delegation is load-bearing~~. **CORRECTED 2026-08-23 (feature-30 closeout) — THIS ROW CONTRADICTS §5 AND THE MERGED CODE.** Review M10, folded into this same ADR, made `announce` **opt-in and default OFF** (`CompactionNotice.tsx:119`), and only `RunStepInspector.tsx:63` passes it; `RunTimeline.tsx:298` is deliberately **silent**. So the mitigation this row offers for leaving the gate un-widened — "the component announces" — is now false on one of its two call sites, and §5's own witness row asserts the opposite ("**SILENT** inside a collapsed `<details>`"). The honest statement: the notice announces **on the expanded surface only**, by design, and the timeline instance is outside every announce gate AND announces nothing. That is defensible, but it is a narrower claim than the one that was left standing here. **A late fold-in that changes a component's behaviour must re-read the earlier sections that cited that behaviour as a mitigation** — this ADR's §5 was updated by M10 and its §3 was not. |

---

## 4. Corrected current-state claims

| where | was | now |
|---|---|---|
| `routes/runs.ts` fork comment | "a fork that never had one stays uncompacted" | corrected in place with the mechanism |
| ADR 0099 row 9 | "read back verbatim on `:fork`, never re-resolved … covered by a dedicated replay/fork test" | both halves corrected; the cited `test/feature-replay-fork.test.ts` has **zero** compaction references |
| ADR 0099 §decision, §runInsert, §precedent | same claim, three more places | corrected in place |
| `FEATURES.md:198` | "deterministic, structure-preserving, replay-safe" | honest scope, incl. the measured 0/336 |
| toggle description (operator-facing) | "Structure-preserving (drops empty fields, minifies)" | says what the default does and where savings actually are |
| `ROADMAP.md:255` | "**structure-preserving** … ~−52 %" | corrected with the provenance of that number |
| `ARCHITECTURE.md:146` | "Covers chat…"; `agentDispatch.ts:832` (a **blank** line); `bootstrap/nodes.ts:1726` | claim corrected; citations → `:1252` / `:2024` |
| `toModelToolResult.ts` | "compaction runs BEFORE fencing"; `toolResultTransform.ts:98` | scoped to the path where it is true; stale line ref removed |
| `executor/types.ts:391` | "`lossless` → minify + drop-empty" | corrected at the type |
| `ADR 0388:152` | CAD's schema tools "stay in `SCHEMA_READ_EXEMPT_TOOLS`" — none were | corrected; `cad.get-design` is now genuinely exempt |
| `packs/…/pack.json` (**pack**-level, `:4`) | "Structure-preserving by default" | corrected |
| `packs/…/pack.json` (**node**-level, `:14`) | "minify + drop empty fields" — **MISSED by the row above; same file, eleven lines lower** | corrected 2026-08-23 (review H3). This one is projected into the node catalog by `nodeCatalogBuilder.ts:126`, i.e. it reaches a MODEL — a live violation of the CLAUDE.md non-negotiable. Pack + node versions bumped 1.0.0 → **1.1.0** with all four coherence legs; pinned by `test/tool-output-compaction-node-catalog-parity.test.ts`, which grades the claim against the KERNEL and reads the description back out of `buildNodeCatalog()` |
| `docs/adr/0099-tool-output-compaction.md` | **UNTOUCHED by this ADR** — still titled the kernel "structure-preserving", still NORMATIVELY specified drop-empty as the default defended by "lossless for LLM comprehension" (the exact reasoning §D2 falsifies), and still stated −52 % as fact | corrected 2026-08-23 (review M5): a correction block at "The kernel", the item-2 spec struck and superseded, and every −52 % annotated with its provenance. **§D2 listed six places it had corrected and the decision record that OWNS the feature was not one of them** — the worst possible omission, because a stale ADR is where the next implementer starts |
| `executor/types.ts`, `compact.ts`, `surface.ts`, toggle description | "`lossless` … provably information-preserving: `JSON.parse(out)` deep-equals `JSON.parse(in)`" | corrected 2026-08-23 (review H2): TRUE and the WRONG CLAIM. The STRING is what reaches the model, and re-serialising rewrote it. `lossless` no longer re-serialises |

---

## 5. Witnesses

| file | proves | sabotage |
|---|---|---|
| `test/tool-output-compaction-fork-real-path.test.ts` | the `:fork` invariant on the REAL route, asserted on the row read back from storage | remove the contributor guard → 2 failed; drop `derivedFromRun` → identical 2 failed |
| `test/tool-output-compaction-kernel.test.ts` | lossless round-trips deep-equal; lossy discloses; compaction DECLINES when honesty costs more | (the three tests that pinned the defect are rewritten) |
| `test/schema-read-exemption-completeness.test.ts` | 201-id runtime denominator; both lanes agree; negative control | empty the array → 3 failed; register a new unexempt schema-carrying tool → born-red naming the id |
| `test/envelope-live-roundtrip.test.ts` | the exemption gate can now fail | covered by the same emptied-array sabotage |
| `test/tool-result-compaction-callers.test.ts` | every `executeTool` caller is classified for compaction | un-wire the chat lane → born-red on `conversationToolLoop.ts` |
| `test/fenced-truncation.test.ts` | the fence survives every budget; the call site uses the helper | restore the bare slice → born-red; the fail-closed guard's sabotage is born-red **only after** the witness was strengthened (below) |
| `src/runs/__tests__/compactionNotice.test.tsx` | the disclosure renders, states the count, stays silent when there is nothing to say, and delegates its announcement; **and (review M10) that it is SILENT inside a collapsed `<details>`, at N=3 notices** | remove the timeline disclosure → born-red; give `Notice` its inline region back → born-red; restore the unconditional `announce` → `silent by default — a notice inside a collapsed disclosure says nothing` |
| `test/run-metadata-copy-sites.test.ts` *(review H1)* | all 21 run-creation sites classified FRESH / COPIED_FROM_RUN / SEAM, with `loadsExistingRun` DERIVED from the source | drop `derivedFromRun` from the redrive → `routes/workflowDebug.ts copies another run's metadata but never passes derivedFromRun: true` |
| `test/tool-output-compaction-node-catalog-parity.test.ts` *(review H3)* | each mode's ADVERTISED behaviour executed against the kernel; markers compared to the kernel's exported constants; the description read back out of `buildNodeCatalog()` | restore the stale node description → 3 legs fail |
| `src/chat/__tests__/toolCallCardError.test.tsx` *(review M9)* | the witness TOCU-6 shipped without: each known code, an unknown code (generic, never a bare token), a transport message winning | point `forbidden` at the generic key → `expected 'The tool call failed.' to be 'This tool isn't permitted for this agent.'` |

### A green sabotage, reported

The first sabotage of `truncateFencedContent`'s fail-closed guard came back
**GREEN**. The cause was the instrument, not the fix: the witness asserted only
`endsWith(END)`, and the real failure mode is
`slice(header, maxChars - tail.length)` going **negative**, which JavaScript reads
as an offset from the end and silently returns nearly the whole payload — **with
the fence intact.** The fence survived; the budget did not. A length bound was
added and the sabotage is now born-red. This is the standing lesson in its exact
form: a witness can be non-vacuous and still measure a condition production never
has.

### And the fix reproduced the family it closes

The first draft of the `_emptied` disclosure was **itself elided** by the sibling
`elideArrays` transform: with eight dropped keys the marker became
`['a','b','c',{_elided:4},'h']`. The honesty affordance was silently truncated by
the very transform it exists to disclose. Caught by the witness written to prove
the disclosure works, and fixed with an explicit (not order-dependent) guard.

---

## 6. Review #42 fold-in (2026-08-23)

An adversarial review of this branch found 4 HIGH, 6 MEDIUM and 5 LOW, nearly
all proved by execution rather than by reading. All are folded in above; this
section records what the review says about the METHOD, because that is the part
that transfers.

**The three findings worth carrying forward.**

1. **§D1's enumeration was done over the wrong property.** It walked the
   READERS of `run.metadata.compaction` by call graph, which was rigorous and
   answered a different question. The property that needed enumerating was
   **writers of a COPIED metadata blob** — and `derivedFromRun` had exactly one
   call site repo-wide, which should have been the tell. When a fix introduces a
   new flag, the population to enumerate is *everywhere that flag ought to
   appear*, not everywhere the value it guards is consumed.

2. **A completeness gate forces a ROW, not a CORRECT row.** D3's runtime
   denominator genuinely fixed completeness and this ADR presented it as if it
   had fixed correctness. Three rows were classified `false` in one pass with no
   recorded adjudication, the negative control then PINNED those answers, and
   `TOCC-2a`'s ~14 explicitly-flagged LEADS were answered the same way. The
   repair is a recorded judgment per id — including for the `false`s — against a
   rule stated once so the verdicts are checkable. That rule also gained a
   necessary condition nobody had written down (the payload must be
   TRUNCATABLE by the kernel), which falsified the lead with the best prior.

3. **This batch closed the "cure reproduces the family" pattern twice more.**
   The `lossless` cure was itself lossy at the string level, with a witness
   blind to the class BY CONSTRUCTION (it compared `JSON.parse(out)` to
   `JSON.parse(in)` — a round-trip oracle cannot measure the round trip). And
   the M6 cure, applied naively, would have cancelled the H1 fix: reserving
   `compaction` makes `buildRunRecord` strip it from the redrive's copied
   metadata, so a born-ON run would have been redriven UNCOMPACTED. Caught
   before commit only because H1's witness existed first.

**And it happened a third time, in the fold-in itself.** The M10 memoisation was
placed next to its use site in `RunTimeline`, which is below
`if (events.length === 0) return …` — a rules-of-hooks violation that reddened
five tests in two files, neither of which touches compaction. `tsc --noEmit` and
all **27** gates in `npm run build` were green on it; `eslint src`
(`react-hooks/rules-of-hooks`) catches it, and `npm run ci` runs lint, but the
frontend BUILD does not. **"FE build exit 0" is not "the frontend is verified"** —
which is exactly the "ask what a verification instrument EXCLUDES" lesson,
arriving while writing up the batch that lists it.

**Also corrected here:** a red test this branch shipped
(`tool-output-compaction-surface.test.ts` still asserted `not.toContain('tags')`
— it PINNED the drop-empty defect TOCC-3 removed, and the review's own
"verified clean" list did not include it); two ratchets that claimed a
population and policed a spelling (M8, and the compaction-caller ratchet's
`executeTool`-only census that could not see `bootstrap/nodes.ts`); a
`MUST_SUPPLY` leg that proved a KEY was written rather than a DECISION supplied;
and a shrinker that returned 227 characters for a budget of 1.

**Declined, with the measurement.** The review's description-parity ratchet
("the only legal" / "closed" / "catalog" / "never invent" ⇒ must be
`schemaCarrying: true`) was measured before adoption: 21 descriptions match,
~7 are genuinely schema-carrying, ~14 are false positives with a common shape
(WRITE tools naming the closed world they validate AGAINST). A ~67 %
false-positive rate would force fourteen wrong exemptions or fourteen
suppressions. The salvageable form — nominate a lead, require an adjudicated
row, never force the verdict — is recorded in
`test/schema-read-exemption-completeness.test.ts`.

**Still open, unchanged:** `TOCU-2` (no SPA editor for the lossy config),
`TOCU-4`/`WFAU-4` (need an RFC 0064 change in `../openwop`, not a host PR), and
the two recorded-not-fixed lanes (anon, voice bridge).

---

## 7. Closeout fold-in (2026-08-23) — what the closeout pass found

The feature-30 closeout re-derived this batch's population claims from source and
re-read this record against itself. Grades and dispositions are recorded in the
three steward trackers; this section records only what was found **wrong or
unrecorded**, because that is the part that transfers.

**7a. THE H1 POPULATION CLAIM IS TRUE — and the ratchet that carries it has a
file-scoped hole.** Independently re-derived by call graph (`Storage` declares
exactly ONE run-row writer, `storage.ts:138 insertRun`; the only raw
`INSERT INTO runs` outside `test/` are inside the two adapters; no
`createRun`/`upsertRun`/`REPLACE INTO` lane exists; the ~30-way fan-in behind
`host/runStarter.ts:123` was walked by hand and is FRESH at every one). The set
difference against `test/run-metadata-copy-sites.test.ts` is **∅ in both
directions**, and both copiers do pass `derivedFromRun: true`. **So "exactly 2 of
21" is not a floor — it is exact.** Three defects in its *prose and instrument*,
however:

1. **"21 run-creation sites" is a FILE count.** There are **23** run-creating
   invocations across 20 creator files, plus the seam file — `routes/runs.ts`,
   `routes/workflowDebug.ts` and `routes/compensationSeam.ts` each hold two.
2. **The `derivedFromRun` assertion is FILE-scoped** (`/derivedFromRun:\s*true/`
   over the whole file). Both `COPIED_FROM_RUN` files **also contain a FRESH
   creator** (`routes/runs.ts:495`, `routes/workflowDebug.ts:276`). A **third**
   copier added to either file would inherit a green check from its neighbour's
   flag without ever passing the argument — §D1's exact defect, undetected. This
   is the "a gate that forces a ROW, not a CORRECT row" lesson of §6.2 arriving
   in the instrument §6.1 prescribes. Filed as `TOCC-R1`.
3. **The docblock undercounts the bypass lanes** — it says bare `.insertRun(` is
   "the two lanes that deliberately bypass" the seam; there are **four**
   (`host/workforceEval.ts:133`, `host/anonymousActor.ts:400`,
   `routes/anonSurfaceSeam.ts:168`, `routes/testSeam.ts:723`). Its own
   `CLASSIFIED` table names all four correctly — only the prose is wrong. §3
   records one of the four. The tracker row is `TOCC-11`, still open.

Worth naming because it is the nearest live analogue: **`host/scheduleDaemon.ts:161`
spreads a *schedule-job* row's metadata into a new run**, and lands through
`runStarter.ts`, so the file-level ratchet classifies it FRESH and cannot see it.
It is safe **only** because `runStarter.ts:109 stripReservedRunMetadata` removes
reserved keys — and `compaction` became reserved in this same batch (M6). The
safety is a coincidence of two independent fixes, not a designed property.

**7b. THIS RECORD CONTRADICTED ITSELF at §3's `check-failure-card-recovery` row.**
Corrected in place there: the row's mitigation for leaving the gate un-widened
("the component announces") was falsified by review M10, folded into this same
ADR, which made `announce` opt-in and default OFF. §5 was updated by M10; §3 was
not.

**7c. THE FIX BATCH USED ITS OWN `TOCU-` NUMBERING, and it does not match the
tracker.** Mapping measured against `docs/steward/UX-ASSESSMENT.md`: this batch's
"TOCU-3" is tracker **`TOCU-13`**; its "TOCU-6" is tracker **`TOCU-7`**; its
"TOCU-7" is tracker **`TOCU-4`**; only "TOCU-1" / "TOCU-2" / "TOCU-4" land on
their own numbers. The commit messages, §3 and §5 all carry the wrong ids, so a
reader closing rows by number would have closed the wrong rows — and the row that
*was* actually fixed (`TOCU-7`, three hardcoded English strings on a live chat
path) would have been left open. The `TOCC-` and `TOCWF-` ids are all correct;
only the UX lane drifted. **Cross-lane ids are the one thing in a fix batch that
cannot be re-derived from the code, so they are the one thing that must be read
from the tracker rather than remembered.**

**7d. ADR 0099's correction hygiene.** M5 corrected the kernel/−52 % family
properly (strikethrough + dated notes). Four other hunks were **silent
rewrites** — §Boundaries "Toggle + variant-stamp precedent" and §Phase-1
"single run-insert seam" (both undated, no strikethrough), the deleted
"Covered by a `feature-replay-fork`-style test" sentence, and matrix row 9,
whose falsified leading claim was left **standing and unstruck** while its
cited text was deleted rather than struck — so §4's "both halves corrected"
described an edit that was not made. The row-9 blockquote was also spliced
mid-sentence, so CommonMark lazy continuation pulled original 2026-06-20 prose
inside a 2026-08-23 correction note. Three sibling "the editor exists / is a
Phase-4 nicety" claims that `TOCU-2` falsifies were left standing, the
`Status:` line still claimed all four phases while its own table retracted
Phase 2, the `TOCC-12` citation sweep never reached ADR 0099's five
current-state instances of `agentDispatch.ts:823/827/832`, and "recorded its
correction in six places" is a count reproducible from nothing. All corrected
in `docs/adr/0099-tool-output-compaction.md` in the closeout PR, each under
`~~` with a dated note.

**7e. The batch flipped ZERO tracker rows.** Every `TOCC-`, `TOCU-` and `TOCWF-`
row was still `- [ ]` on `origin/main` after the merge, and neither `#3451` nor
`4ed05c4f5` appeared anywhere in the three trackers. That is the normal division
of labour in this loop (the closeout PR owns the trackers) and is recorded here
only so that "ADR 0604 closes X" is never read as "the tracker says X is closed".
