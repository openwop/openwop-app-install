# ADR 0237 — Honor `node.inputs` end-to-end: preserve through validation, interpolate `{{inputs.*}}` symmetrically with config

Status: Accepted (implemented — CHAINX-5)
Date: 2026-07-03
Depends on: RFC 0013 (workflow-chain packs — `{{params.*}}` expansion substitution), ADR 0163 (workflow-pack templates — the per-run `{{inputs.*}}` resolution model), `schemas/workflow-definition.schema.json` (`WorkflowNode.inputs` / `PortValue`).

## Context

A chain-execution test sweep across all 15 chain packs (CHAINX-5) found that a
node's authored `inputs` never reached the executor. Three independent agents
converged on it, and worked around it per-pack by moving templated values into
`config` and renaming params to match source-node read keys.

Root cause is a **broken link in the middle of an otherwise-complete pipeline**:

1. **The wire schema requires `inputs`.** `WorkflowNode.required` includes
   `inputs`, typed as a map of `PortValue` (`{type:"static",value}` |
   `{type:"expression",expression}` | `{type:"connection",nodeId,outputKey}` |
   the executor also accepts `{type:"variable",variableName}` and bare literals).
2. **RFC 0013 §expansion is normative:** *"Substitution MUST recurse into nested
   string values within `config` **and `inputs`**."* And this host's `expandChain`
   (`workflowChainPackLoader.ts:429-430`) correctly rewrites `{{params.*}}` →
   `{{inputs.*}}` in **both** `config` and `inputs` (the ADR 0163 per-run model:
   values arrive per run, not frozen at expansion).
3. **The executor honors `node.inputs`** — `executor.ts` resolves each PortValue
   (variable/static/literal), and merges it over edge-supplied inputs.
4. **But two asymmetries silently broke the `inputs` half:**
   - `validateWorkflowDefinition` (the register step between expansion and
     execution) **dropped `node.inputs` entirely** — re-emitting defs missing a
     schema-`required` field and discarding the expansion-rewritten inputs.
   - Even when present, the executor **interpolated `{{inputs.*}}` string tokens
     in `config` only**, not in `inputs` — so a templated input string was
     delivered verbatim as a literal.

So `config` worked end-to-end; `inputs` was dropped at validation and, if
preserved, wouldn't interpolate. Authors who followed the spec (`{{params.*}}`
in `inputs`) got silent failure.

## Decision

A **safety-fix** that closes both asymmetries so the host honors its own schema
+ RFC 0013 + its own expansion output — no new wire surface:

1. **`validateWorkflowDefinition` preserves `node.inputs`** (validates it is an
   object when present; `workflowDefinitionValidation.ts`). The registered def
   is now schema-faithful and the executor's existing `inputs` path is reachable.
2. **The executor interpolates `{{inputs.*}}` string tokens in `inputs`
   symmetrically with `config`** — reusing the same `interpolateRunInputs` /
   `hasInputTokens` against the same replay-stable run variable bag
   (`executor.ts`). A templated input now resolves per run instead of leaking a
   literal token string.
3. **`tarballLoader` preserves a pack node's own `error.code`/`message` on a
   RETURNED failure** (not only a thrown one) — it previously flattened
   `{status:'failed',error}` into a generic `pack_node_error`, hiding canonical
   codes (`not_eligible`, `connector_no_connection`, …) from the run event log.

## Alternatives rejected

- **Reject bare-string / literal `node.inputs` values** (steer to config): would
  VIOLATE RFC 0013 — literal input values (post-substitution) are legitimate, and
  `PortValue.static` is schema-defined. Rejected.
- **Preserve `inputs` but don't interpolate** (advisory metadata only): leaves
  the field present-but-ignored — the spec-mandated substitution still doesn't
  reach the node. Half-measure, rejected.
- **Reject `node.inputs` entirely** (edges-only): discards a required,
  executor-supported wire field and forecloses legitimate PortValue wiring.
  Rejected.

## Compatibility & risk

- **Classification: safety-fix.** Implements existing normative spec (schema
  `required` `inputs`; RFC 0013 §substitution) + this host's own expansion
  output. No new run-event field, capability flag, or endpoint contract → **no
  `../openwop` RFC required.** The host becomes *more* wire-faithful.
- **Replay/fork-safe:** `inputs` interpolation reads the same replay-stable
  variable bag config already uses; static PortValues are frozen. No new
  non-determinism.
- **Blast radius: strictly-more-works.** Chains that moved values to `config`
  (the sweep's workaround) are unchanged (config path untouched). Chains that
  kept templated `inputs` now resolve them instead of silently failing. Verified
  by re-running the full 15-pack chain-execution suite + the backend suite.

## Adoption note (2026-07-30) — four chains sat broken for want of this

Worth recording because it is a failure of DISCOVERY, not of the decision.

`feature.kb.nodes.rag` reads `orgId`/`collectionId`/`query` from `ctx.inputs`
and never from `ctx.config`. Four shipped chains wired the query through
`config`, so every real invocation reached `mustGetCollection(tenantId, '', '')`
and threw `not_found` — the KB step could not complete as shipped.

A test pinned one of them, asserting the `not_found` as *"the honest,
reproducible current behavior"*, and argued the gap could not be closed without
"a new shipped reshape-ports node or a change to `classify`'s output schema —
both beyond a wiring-only pack.json fix."

**That mechanism is this ADR**, and three other chains were already using it
(`knowledge.policy-qa`, `knowledge.compliance-review`,
`finance.month-end-close`). The stated blocker — that the node has an inbound
edge, so edge-derived inputs would win — is also answered here: the executor
merges declared `inputs` OVER the edge-derived map (*"fixture wins on
conflict"*), which is precisely why `node.inputs` had to be honored end-to-end.

Two things generalize. A capability shipped by one ADR is invisible to the next
author unless something points at it from where the problem is felt — the four
chains and the pinning test were all written after this landed. And a test that
documents a defect as unfixable stops the search: the other three chains had no
test at all, so nobody swept for siblings. Fixed, with a `rag`-specific ratchet
that fails when any chain binds these through `config` again.

## Open questions / follow-ups

- [x] ~~The `expandChain` rename-to-`{{inputs.*}}` model deviates from RFC 0013's
  literal-substitute-at-expansion wording (deliberate per ADR 0163 for reusable
  per-run templates). Worth a spec erratum/clarification in `../openwop` that a
  host MAY defer substitution to run time via `{{inputs.*}}` — not blocking, but
  the reference host and the spec text should agree. Recorded, not gated.~~

  **RESOLVED — 2026-07-04 (correction note).** The spec did NOT relax the
  expansion-time `MUST`; it was reaffirmed. The RFC 0013 amendment (2026-07-04)
  adjudicated the timing: there is no runtime `{{...}}` construct over
  `WorkflowNode.config`/`inputs` (config = pre-execution constants, inputs =
  PortValue refs), so a persisted `{{inputs.*}}` token over config is as
  non-conformant as `{{params.*}}` — it ships verbatim to any host that does not
  share this host's private per-run bag, breaking RFC 0013 portability. The
  rename-to-`{{inputs.*}}` model was therefore **replaced by expansion-time
  substitution ("Path A")**: `expandChain` now FREEZES the resolved param values
  into `config`/`inputs` (`host/workflowChainPackLoader.ts`) and the persisted
  definition carries zero `{{params.*}}`/`{{inputs.*}}` tokens. The whole-value
  raw-typed rule this ADR introduced (a value that is exactly one token keeps its
  JSON type) is **preserved and unchanged** — extracted into the shared
  `host/tokenSubstitution.ts` and reused at expansion time (RFC 0013 amendment
  §WCP2). The reusable "values per run" ergonomic is now the separate,
  capability-gated **deferred mode** (RFC 0124 / WCP4), not this token model.
  See the ADR 0163 correction note for the timing decision and the collision fix.
