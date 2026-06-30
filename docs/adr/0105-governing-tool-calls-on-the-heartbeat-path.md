# ADR 0105 — Governing tool calls on the heartbeat/scheduled path (per-tool permissions vs. workflow-bound tools)

**Status:** implemented (premise confirmed + trip-wire test landed 2026-06-22 — see "Premise confirmed")
**Date:** 2026-06-22
**Depends on:** ADR 0102 (per-tool `permissions.read/write` enforcement on the
interactive paths), ADR 0036 (action-class autonomy enforcement at the heartbeat
pick), ADR 0089 (one shared tool executor — `runChatToolLoop` — no forked
enforcement), RFC 0064 (tool-invocation hooks), RFC 0069 (`exec`-class exclusion).
**Surface:** host runtime only. No wire change. **NON-NORMATIVE — no new RFC.**

## Why this exists

ADR 0102 made `agentProfile.permissions.read/write` enforce **per tool call** on the
interactive paths (`runChatToolLoop`: agent dispatch + the chat conversation gate).
Its known follow-on was the **heartbeat/scheduled path**, documented as "uses an inline
`chat-completion` node with provider-specific dispatchers, not the shared loop." A
deeper investigation (this ADR) found that "extend the gate to one more loop" is the
wrong frame: the heartbeat path's tools are a **different kind of thing**, and the right
answer is probably two governance models, not one gate everywhere.

## What we found

The heartbeat/scheduled path runs the **`chatResponderNode`** (`bootstrap/nodes.ts`).
When its model calls a tool, the tool is a **workflow-bound sub-run**: each binding maps
`name → workflowId`, executed via `dispatchSubRun({ workflowId, … })` inside the provider
dispatchers' `onToolUse` callback (`dispatchAnthropicTools.ts:178`,
`dispatchMiniMaxTools.ts:155`). This differs from the interactive paths in two ways that
matter:

1. **Different tool surface.** The interactive paths call NATIVE/MCP builtins
   (`openwop:knowledge.search`, `openwop:ai.research.web`, …) — exactly what the ADR 0102
   permission allowlists name. The heartbeat path's "tools" are **workflow ids**, which do
   NOT appear in any agent's `permissions.read/write` allowlist. Enforcing the per-tool
   gate there as-is would deny *every* workflow-tool (`not-allowlisted`).
2. **Different executor.** The node executes via `dispatchSubRun` (a sub-workflow run),
   not the `executeTool` that `runChatToolLoop` owns. So "route the node through
   `runChatToolLoop`" is not a drop-in — the two have different execution models.

Crucially, **workflow-bound tools are ALREADY governed**, by a different and appropriate
layer:

- the agent's **workflow portfolio** (`RosterEntry.workflows`) — which workflows it may run;
- the node's **§A14 tool allowlist** — which workflows are bound as tools;
- the **autonomy gate** (ADR 0036) — whether the agent auto-runs at all, per action class;
- the **sub-run's own tenant-scoped authz** (`dispatchSubRun`).

The per-tool `permissions.read/write` model is fine-grained authz over NATIVE external
actions (CRM updates, sends, fetches). Conflating it with workflow-tool governance is a
category error — the workflow-tool layer above already answers "may this agent run this
workflow."

## Options

| Option | What | Cost | Risk |
|---|---|---|---|
| **A — Route `chatResponderNode` through `runChatToolLoop`** | One executor, one gate (ADR 0089 ideal). | High (~2–3d) — circular-dep extraction + the `dispatchSubRun`-vs-`executeTool` mismatch | High: refactors a security + replay seam; the node does node-specific things the loop doesn't |
| **B — Insert the gate into both provider dispatchers** | Copy the `evaluateToolPermission` check to the two `onToolUse` sites. | Low (~1d) | High: **forks enforcement** (violates ADR 0089), divergent `agent.toolReturned` event shape → replay-divergence risk, two sites to keep in sync |
| **C — Scope per-tool permissions to NATIVE tools; govern workflow-tools by portfolio + autonomy** | Declare the heartbeat path's workflow-tools out of scope for the ADR 0102 native-tool gate; keep them governed by the existing portfolio/autonomy/sub-run-authz layer. Only build native-tool gating on the heartbeat path **if** a heartbeat chat node binds NATIVE tools (today it binds sub-workflows). | Low (doc + a targeted check) | Low |

## Decision (recommended)

**Option C.** The per-tool permission model (ADR 0102) governs **native/MCP tool calls**;
**workflow-bound tools** are governed by the workflow-portfolio + autonomy + sub-run-authz
layer, which already exists and is the right altitude for "may this agent run this
workflow." The "ungated heartbeat path" is therefore *mostly a non-gap* — its tools have
appropriate governance under a different model.

The genuine residual question is narrow: **does a heartbeat/scheduled `chatResponderNode`
ever bind NATIVE tools (not sub-workflows)?**
- If **no** (today's behaviour — bindings are `workflowId`): the gap is closed by this
  ADR + a doc note. No code, no refactor, no forked enforcement.
- If **yes** (a future node binds native tools): gate ONLY those native bindings — a small,
  targeted change at the node's binding-resolution site (resolve the agent's
  `permissions` and `evaluateToolPermission` on the native-tool bindings only), reusing the
  pure evaluator, NOT the full unified-loop refactor. This stays within the "one evaluator"
  spirit even if it's a second call site, because it gates the SAME native-tool surface
  with the SAME pure function — not a divergent re-implementation.

We explicitly do **not** take Option A or B now: A is a multi-day refactor of a
security/replay seam for a path whose tools don't fit the model; B forks enforcement and
risks replay divergence — both poor trades against C.

### The read/write distinction (ADR 0102 open question)

Deferred. Splitting `read` vs `write` enforcement needs a per-tool read/write
CLASSIFICATION, and there is no source for one — RFC 0069 only excludes `exec` from the
protocol tier; it defines no general read/write tags. Until a tool catalog carries an
exec-class/side-effect tag, `read ∪ write` stays a single positive allowlist (the current
ADR 0102 behaviour). Revisit if/when a tool-classification source lands.

## Consequences

- **No risky refactor, no forked enforcement.** The interactive paths stay the single
  enforced surface for native tools (ADR 0102); the heartbeat path keeps its appropriate
  workflow-level governance.
- **Honesty:** ADR 0102's "heartbeat inline-chat-node path — follow-on" row is resolved to
  "governed by workflow portfolio + autonomy (ADR 0105); native-tool gating is targeted +
  conditional," not an open enforcement hole.
- **A trip-wire to add:** if a heartbeat `chatResponderNode` ever binds a native tool, the
  targeted gate (above) is the required follow-up — worth a code comment / test at the
  binding-resolution site so the condition is caught.

## Premise confirmed (2026-06-22)

The load-bearing premise of Option C — that `chatResponderNode` tool bindings are
**always** workflow sub-runs, never native tool ids — is **structurally guaranteed**, not
merely observed. `validateToolBindings` (`bootstrap/nodes.ts`) requires every binding to
carry a string `workflowId` and **silently drops any binding without one**:

```js
function validateToolBindings(raw) {
  for (const r of raw) {
    if (typeof rec.workflowId !== 'string') continue;   // ← no workflowId ⇒ dropped
    if (typeof rec.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rec.name)) continue;
    out.push({ workflowId: rec.workflowId, name, description });
  }
}
```

The downstream `onToolUse` callback then executes each binding via
`dispatchSubRun({ workflowId: binding.workflowId, … })` — there is **no code path** by
which a native/builtin tool id reaches the heartbeat tool surface. So the "ungated
heartbeat path" is confirmed a **non-gap**: its tools are workflow sub-runs, governed by
the portfolio + autonomy + sub-run-authz layer (Option C). The ADR moves to **Accepted**.

### Deliverable (the trip-wire — small, no refactor)

Because the premise is enforced by `validateToolBindings`, the trip-wire is a **test that
pins that invariant** so a future change that lets native ids in fails loudly:

> a `validateToolBindings` unit test asserting a binding **without** `workflowId` is
> dropped (and that a well-formed `{workflowId,name,description}` binding survives) — the
> structural guarantee that no native tool can enter the heartbeat surface unguarded.

If a future feature deliberately adds native-tool bindings to `chatResponderNode`, THAT
change must (a) extend `validateToolBindings`/`ToolBinding` to carry a native-tool kind and
(b) gate exactly those native bindings with the pure `evaluateToolPermission` +
`resolveAgentToolPermissions` (one evaluator, one extra call site — not the unified-loop
refactor). The test above is the alarm that forces this.

## Open questions / decisions checklist

- [x] **Confirmed** `chatResponderNode` bindings are always `workflowId` (workflow
      sub-runs) — structurally enforced by `validateToolBindings` (above).
- [x] **Landed** the `validateToolBindings` invariant test (`test/validate-tool-bindings.test.ts`, 5 cases) + the security-invariant doc-comment at the validator + `export` for the test. The validator now structurally + test-pins "workflow-bound tools only."
- [ ] If native bindings are ever added, implement the targeted native-only gate at the
      binding-resolution site (small, reuses `evaluateToolPermission` +
      `resolveAgentToolPermissions`).
- [x] **Decided** the read/write split is deferred until a tool read/write classification
      source exists — formalized in ADR 0102 (see its "Resolved 2026-06-22" note).
