# ADR 0547 — one validator for tool `inputSchema`: close the fail-open, kill the duplicate

Status: implemented

Composes: `host/agentToolProvider.ts` (the tool registry + the single execute choke),
`host/mcpServerRouter.ts` (which already validates), RFC 0020 §D (untrusted inbound),
RFC 0137 §F1 (`contentTrust`), ADR 0308 (`registerFeatureAgentTool`).

## Correction — the original premise was false (recorded 2026-08-10, before implementation)

**This ADR was drafted on the claim that the chat tool loop does not validate tool
arguments. That claim is wrong.** It was found and killed by the pre-phase architecture
review of P2, by reading the code rather than the doc comment.

`runAgentDispatchLive` (`agentDispatch.ts:1127`) calls `compiled.validate(call.input)`
**before** `deps.executeTool` (`:1136`). On failure it emits
`agent.toolReturned status:'invalid_args'` and feeds the model Ajv's `errorsText`. The
validator is pre-compiled per tool at `resolveAgentTools` (`:478`) via
`compileToolValidator` (`:506`) on a module-level `Ajv2020` (`:65`).

So three of the four original decisions were **already implemented**:

| Original decision | Reality |
|---|---|
| D1 — validate at the single choke | Already done, one layer up at `agentDispatch:1127` (a better location than `executeTool`: it can `continue` the loop without faking a tool result) |
| D3 — warn, then enforce | Already **enforcing**. There is nothing to roll out. |
| D4 — give the model the Ajv error path | Already done — `toolAjv.errorsText(...)` is put in the message to the model |

The stated failure mode — *"a model that omits `orgId` reaches the handler with
`undefined`"* — **cannot happen through a required schema property.** It is already
rejected. Only a schema that does not require `orgId` lets it through, which is a schema
bug, not a missing-enforcement bug.

`agentToolProvider.executeTool` is genuinely unvalidated, but it is not the model's path
into a tool; the dispatch loop above it is. Inserting a second validation there would have
been **redundant work on the hot path**, justified by a defect that did not exist.

### What actually survives — and it is real

Two validators exist for the **same schema class**, and they disagree:

| | MCP (`mcpServerRouter`) | Chat (`agentDispatch`) |
|---|---|---|
| Ajv config | `{allErrors:true, strict:false}` | `{strict:false, allErrors:true}` — **identical** |
| Schema that fails to **compile** | **fails closed** — `rpcError(INVALID_PARAMS, 'tool inputSchema compile failed')` | **fails OPEN** — `return () => ({ ok: true })` (`:519`), validation silently disabled for that tool |
| `$id` handling | kept | **stripped** before compile (`:510`) |
| Compiled-schema cache | content-hash `Map`, shared across requests | none — recompiled per `resolveAgentTools` |

**The fail-open is reachable, and it is measured, not assumed.** Ajv2020 with
`strict:false` throws on exactly the mistakes a hand-written schema makes — and all 174
are hand-written:

```
THROWS    bad $ref          can't resolve reference #/definitions/nope
THROWS    bad regex         Invalid regular expression: /[/u
THROWS    bogus type        data/properties/a/type must be equal to one of the allowed values
COMPILES  unknown keyword   (propertyz — the one that does NOT throw)
```

A tool whose schema has any of the first three accepts **any arguments at all** on the
chat path, while the same tool rejects the same call on MCP. *That* is "one `inputSchema`,
two meanings" — the original title's thesis, surviving in a much narrower and entirely
verifiable form. The in-code comment at `:517-518` already names it (`ENG-4`) and ships it
anyway.

The decisions below are rewritten against this. D1/D3/D4 are withdrawn.

## Context

Every host agent tool declares an `inputSchema`. **That declaration means two different
things depending on who calls the tool**, and nothing in the codebase says so:

> ⚠️ **The table below is the FALSIFIED original claim, kept for the reasoning trail. Read
> the Correction above first — the chat loop validates at `agentDispatch.ts:1127`, one layer
> above the row this table cites.**

| Caller | Behaviour *(as originally — and wrongly — believed)* |
|---|---|
| **MCP** (`host/mcpServerRouter.ts:234-238`) | `compileSchema(tool.inputSchema)` → invalid arguments are **rejected before dispatch**. A hard contract. *(Accurate.)* |
| ~~**Chat tool loop** (`host/agentToolProvider.ts:617-631`)~~ | ~~`return await tool.run(input, scope)` — no validation.~~ **WRONG** — this is the layer *below* the model's entry point. `runAgentDispatchLive` validates before it ever calls this. |

There are **174 declared `inputSchema`s** across `features/*/agentTools.ts` and
`host/agentToolProvider.ts`, and **no generation from a source of truth** — every one is
hand-written. On the chat path nothing ever reads them, so a schema that has drifted from
what its handler expects is *undetectable by construction*: the model is told one shape,
sends roughly that shape, and the handler receives whatever arrived.

~~The concrete failure: 88 call sites read `input.orgId`. A model that omits it reaches the
handler with `undefined`.~~ **Falsified** — an omitted *required* property is already
rejected at `agentDispatch.ts:1127`. `orgId` reaches a handler as `undefined` only when the
schema does not require it, which is a schema bug and not an enforcement gap. The 88 call
sites are not evidence of anything on their own.

### How this was found, and what it corrects

An earlier recommendation in this area proposed a **parity ratchet**: a test asserting each
declared `inputSchema` matches the arguments its `run()` body actually reads. Architecture
review rejected it, and the reasons are worth recording because they generalise:

1. **It cited a precedent that does not support it.** `promptCatalogParity` compares two
   *named declarations* by regex and fails loudly if either disappears. Inferring reads from
   an arbitrary function body is AST analysis — a different technique with no precedent here,
   and it already breaks on the `input[k]` dynamic access used at 8 sites.
2. **It misdiagnosed the defect.** The problem is not that two texts disagree; it is that
   **one declaration has two contracts**. A parity test compares texts and says nothing about
   whether anything enforces either — so it would have produced false confidence over an
   unenforced schema.

## Decision

**One validator for the tool-`inputSchema` class, shared by both callers, failing closed on
a schema that cannot compile — and a ratchet so a broken schema is a red build, not a
silently-disabled guard.**

### D1 (revised) — One validator per schema CLASS, shared by every caller of that class

*(This replaces the withdrawn "validate at the choke". The lift is still right; the reason
changed.)*

An earlier draft justified the lift as "don't add a **second** Ajv instance." That was
false — the host already runs **seven**: `artifactTypes.ts:21`, `mcpServerRouter.ts:73`,
`envelopeAcceptor.ts:68`, `agentEvalGrader.ts:16`, `runInputValidation.ts:16` (plain
`Ajv`/draft-07, `validateFormats:false` — deliberately unlike the rest),
`workflowChainPackLoader.ts:153` (memoized, not per-call — a suspected perf issue that
turned out not to exist), and `agentDispatch.ts:65`.

The right principle is **not** "one Ajv for the app". It is:

> **One validator per schema CLASS, shared by every caller of that class.**

Five of those seven validate genuinely *different* classes — artifact types, RFC 0021
envelopes, eval rubrics, run inputs, pack manifests. Merging them would couple unrelated
schema languages for no gain, and they correctly stay separate.

`mcpServerRouter.ts:73` and `agentDispatch.ts:65` are the exception: they validate **the
same class** — a tool's `inputSchema` — from two callers, with two different failure
postures and two different `$id` treatments. That is the duplication worth removing, and
the only one.

### D2 — A schema that cannot compile is a HOST defect, so fail closed

`compileToolValidator` returning `() => ({ ok: true })` treats an uncompilable schema as a
reason to **stop checking arguments**. That inverts the risk: the tools whose schemas are
broken are precisely the ones whose handlers are most likely to receive a shape they do not
expect.

The two paths must agree, and they should agree on **closed**. The distinction that makes
this safe: a bad *schema* is not a bad *request*. MCP already reports it as such
(`'tool inputSchema compile failed'`), and the chat path should refuse to offer a tool it
cannot describe — which is the posture `resolveAgentTools` **already takes** for a tool it
cannot resolve ("a host that can't describe a tool does not offer it to the model",
`agentDispatch.ts:468`). Dropping an uncompilable tool from the offered surface is
therefore not a new rule; it is the existing rule applied to a case that escaped it.

This is strictly better than failing the call at execution: the model never sees the tool,
so it cannot try, fail, and retry.

### D3 — The ratchet is the actual fix; the runtime posture is the backstop

Failing closed at runtime turns a silent hole into a visible missing tool. That is an
improvement, but the user still loses a capability and nobody is told why.

**A test that compiles every registered tool's `inputSchema` and fails if any throws** moves
the whole class from runtime to CI. It is ~15 lines, it needs no fixtures, and it can never
have false positives: either Ajv compiles the schema or it does not.

This is the highest-leverage item in the ADR, and it is the one the original four phases
did not contain.

### D4 — Keep the `$id` strip, and make it shared

Chat strips `$id` before compiling (`:510`); MCP does not. Stripping is the more robust
behaviour — a `$id` colliding across two tool schemas in one Ajv instance throws — and
since the lifted module now compiles for both callers from **one** instance, that collision
becomes reachable on the MCP path too. So the shared module strips, and MCP inherits it.

This is a real behaviour change to the MCP path, and it is a **loosening** (a schema that
previously failed to compile because of a duplicate `$id` now compiles). It cannot make a
previously-rejected argument set pass validation on its own merits, so it does not weaken
`mcp-server-untrusted-args`.

### D5 — Validation is not fencing, and this changes nothing about trust

RFC 0137 §F1 `contentTrust` governs the tool's **output** (is it attacker-authored text that
must be fenced before reaching the model). This ADR governs the tool's **input** (does it
match the declared shape). They are orthogonal, they compose, and neither substitutes for the
other. Note the deliberate comment at `agentToolProvider.ts:622-628`: fencing happens at
model-message construction, never at execution — validation belongs before dispatch, so the
two concerns stay in their own layers.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | Core only. `host/toolSchemaValidation.ts` (lifted) + one insertion in `host/agentToolProvider.ts`. No feature package, no new owner. |
| 2 | **Toggle** | **None.** A correctness fix behind a toggle is still a defect in the OFF bucket. The warn→enforce stage (D3) is the safety mechanism, not a feature flag. |
| 3 | **Workflow surface** | None. |
| 4 | **Node pack** | None. |
| 5 | **Envelopes** | None. |
| 6 | **Agent pack** | None. |
| 7 | **Public surface** | None. |
| 8 | **RBAC** | Unchanged. Note validation runs **before** the handler's own access checks — it is a shape gate, never an authorization gate, and must not be mistaken for one. |
| 9 | **Replay/fork** | Validation is deterministic over the recorded arguments, so a replayed call validates identically. A previously-tolerated invalid call **will** fail on replay once enforcement lands — recorded as OQ-2. |
| 10 | **Frontend** | None directly; the model self-corrects (D4) rather than surfacing a new UI state. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** ✅ | Lift `compileSchema` → `host/toolSchemaValidation.ts`; MCP imports it. **No behaviour change.** | **Done.** 27 MCP-touching test files / 261 tests pass **unmodified** — the whole assertion of a pure lift. The exported `_resetMcpRouterCaches` seam (zero callers) delegates rather than being deleted, since both callers will share the cache from P2. |
| **P2** ✅ | `agentDispatch.compileToolValidator` uses the shared module (D1/D4). Seventh Ajv (`agentDispatch.ts:65`) deleted along with its `Ajv2020` import; both callers now share one instance + one content-hash cache. | **Done.** Full backend suite green with **no test edits** to any dispatch test. Duplicate-`$id` case pinned in `tool-schema-fail-closed.test.ts` — two tools may share a `$id` and each still validates as itself. |
| **P3** ✅ | Fail closed (D2): `resolveAgentTools` drops a tool whose schema will not compile and logs `agent_tool_dropped_uncompilable_schema`; MCP keeps its typed error. | **Done** — `test/tool-schema-fail-closed.test.ts`, 6 tests. **Sabotage-verified:** neutering the guard turns 2 tests red; restoring it turns them green. Also pins that the drop is not a blanket bypass — the sound tool still rejects a missing required property with the Ajv path. |
| **P4** ✅ | The ratchet (D3): compile every registered `inputSchema` in CI. | **Done** — `test/tool-input-schema-compiles.test.ts`, 5 tests. Carries its own self-sabotage case (a known-bad schema must be rejected) and a **vacuity floor**: a bare import registers **17** tools, `createApp` registers **199**, so without booting features the ratchet would have checked 9% of the surface while reporting green. Both compile postures (`$id` stripped and kept) are asserted. |

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Add validation at `agentToolProvider.executeTool`** (the original decision) | **Withdrawn** — the model's path into a tool is `agentDispatch:1127`, which already validates. This would have been redundant work on the hot path, justified by a defect that did not exist. |
| **Warn-then-enforce rollout** (the original D3) | **Withdrawn** — the path already enforces. There was nothing to roll out. |
| **Parity ratchet over `run()` bodies** | **Rejected** (see Context) — no precedent for the technique, breaks on dynamic access, and checks agreement rather than enforcement, producing false confidence. |
| **Leave the fail-open, just log it louder** | Rejected — it is already logged (`agent_tool_schema_compile_failed`) and shipped anyway. A log nobody reads is how this survived; CI is the reader that does not forget. |
| **Fail the CALL at execution instead of dropping the tool** | Rejected — the model would see the tool, try it, and be told it failed, with no way to succeed. Dropping it from the offered surface matches the existing "can't describe it, don't offer it" rule (`agentDispatch:468`). |
| **Generate all 174 schemas from a SSoT** | **Deferred.** The right long-run answer, but there are no Zod contracts to generate *from* today. The P4 ratchet is the cheap 90% — it catches every schema that cannot compile, which is the failure mode that actually bites. |
| **Share one validator, fail closed, ratchet in CI (chosen)** | Removes the only true duplicate, inverts the one fail-open, and moves the class from runtime to build time. |

## RFC gate

**Host work, no RFC.** No wire surface: MCP's `tools/call` behaviour is unchanged (it already
validates), and the chat tool loop is host-internal. Nothing new is advertised at
`/.well-known/openwop`.

## Open questions

- **OQ-1 — how many schemas fail to compile today? RESOLVED: zero, of 199.** Measured by
  P4 against the booted surface (the count is 199, not the 174 the Context estimated from
  `grep`). **So the fail-open is latent, not active** — no tool is currently running
  unvalidated, and D2/P3 fix a hole nobody has fallen into yet.

  That is worth stating plainly rather than dressing up: the ratchet's value here is
  **preventive**, and P3's is **defence in depth**. Neither is fixing a live incident. The
  case for doing them anyway is that the failure is silent, individually invisible in review
  (one bad `pattern` in one of 199 hand-written schemas), and the ratchet costs ~15 lines.
- **OQ-2 — does dropping an uncompilable tool change an agent's advertised surface?** Yes,
  and that is the point — but a tool vanishing is user-visible. P3 must log at `warn` with
  the tool id, and the P4 ratchet should land **first** so the drop is a hypothetical rather
  than a live regression. *(Sequencing note: P4 before P3 in calendar order, even though the
  numbering reads the other way.)*
- **OQ-3 — `additionalProperties: true` as the norm.** `agentToolProvider.ts:103` declares it
  explicitly. Under a working validator a permissive schema validates almost anything, so lax
  schemas are *load-bearing laxity* rather than oversight. Out of scope here; worth its own
  pass once P4 has the data. **Note this is unaffected by the correction above** — it was
  true whether or not the chat path validated.
- **OQ-4 — replay.** Withdrawn along with the original OQ-2: since the chat path has always
  enforced, there is no population of historically-tolerated invalid calls for enforcement to
  newly break. P2–P4 do not change replay for any recorded run.

## Implementation record

| Phase | Commit | Evidence |
|---|---|---|
| P1 | this branch | `host/toolSchemaValidation.ts` created; `mcpServerRouter` imports it. 27 MCP-touching files / 261 tests green **unmodified**. |
| P2 | this branch | `agentDispatch.ts:65` `toolAjv` + its `Ajv2020` import deleted; `compileToolValidator` delegates. Ajv instances for the tool-schema class: **2 → 1**. |
| P3 | this branch | `resolveAgentTools` drops uncompilable tools. `test/tool-schema-fail-closed.test.ts` (6). Sabotage-verified. |
| P4 | this branch | `test/tool-input-schema-compiles.test.ts` (5). Sabotage-verified against a real schema — the failure names `openwop:knowledge.search` and the reason. |

**Full backend suite:** 1454 files / 10,530 tests. One ratchet fired on the new module —
`tool-result-fence-callers.test.ts`, which enumerates every file mentioning `executeTool` and
demands a classification. `toolSchemaValidation.ts` matched on **prose only** (it validates
tool *input* and never touches a tool *result*), so it is classified `PROGRAMMATIC` with that
reason. This is the ratchet working as designed, and it is the second time in this ADR that a
guard caught something review did not.

### What this ADR is worth, stated honestly

Measured: **0 of 199** tool schemas fail to compile today. So P2–P4 repaired **no live
defect**. What they removed is a *silent* failure mode — a duplicate validator whose two
halves disagreed about the same schema class, where the disagreement surfaced only as a tool
quietly accepting anything. The ratchet is what keeps that at zero, and it costs ~15 lines.

The larger lesson is in the Correction: **three of the four original decisions described work
that was already done.** They survived drafting, and died in the first ten minutes of reading
the code that the pre-phase review forced. The ADR is materially smaller and materially more
correct for it.
