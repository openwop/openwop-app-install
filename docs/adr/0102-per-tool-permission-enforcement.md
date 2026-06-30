# ADR 0102 — Per-tool `permissions.read/write` enforcement (the ADR 0036 toolHooks follow-on)

**Status:** Accepted
**Date:** 2026-06-22
**Depends on:** ADR 0031 (`agentProfile.permissions{read,write,never}`), ADR 0036
(`permissions.never` enforced at the action-class seams via `agentPolicyResolver`),
ADR 0101 (this is its Phase 4). **Implements (host-local):** RFC 0064 (tool-invocation
hooks & authorization, `Accepted`).
**Surface:** host runtime only — the shared live tool loop (`host/agentDispatch.ts`
`runChatToolLoop`). No OpenWOP wire field, capability flag, or run-event change; the
verdict is recorded in the EXISTING `agent.toolReturned{status:'forbidden'}` (RFC 0064).
**NON-NORMATIVE — no new RFC.**

## Why this exists

ADR 0036 enforced `permissions.never` (and `hitl`, `requiredConnections`,
`withinPolicyActions`) at the heartbeat-pick + assistant-action **action-class**
seams, but explicitly deferred the positive `permissions.read/write` allowlists:

> Per-tool-call `permissions.read/write` enforcement … the positive `read`/`write`
> allowlists are still advisory/displayed. A follow-on could lower them into
> `toolHooks` (RFC 0064) … **Deferred until a twin's tool surface needs it.**

ADR 0101 Phase 4 picks that up: make `read`/`write` enforce per TOOL CALL, not just
per action class, so a twin whose profile says `write: ['kanban.card.write']` can't
have the model call `crm.field.delete`.

## Decision

A **pure host evaluator** (`host/agentToolPermissions.ts` `evaluateToolPermission`)
composes with the live tool loop — the same compose-don't-fork shape as
`agentPolicyResolver`. It is NOT baked into the RFC 0064 `evaluateToolHook`
(that evaluator stays purely normative — scopes + rate); the host permission gate
is a separate host concern layered at the call site.

### Matching model

A permission token matches a tool name on an **exact or dotted-namespace-prefix**
basis: token `crm` covers `crm.field.update`; token `crm.read` covers `crm.read`
(and `crm.read.*`); `crm` does NOT match `crmx.foo` (no dot boundary). This lets the
seed lists (`crm.read`, `kanban.card.write`) and coarser namespace tokens both work.

### Verdict composition (most → least restrictive)

1. `never` ⊇ toolName → **deny** (`never`), short-circuits.
2. `read ∪ write` empty/absent → **allow** (`ungated`) — the agent hasn't opted into
   tool allowlisting; its tools are unchanged (still bounded by `never` + the manifest
   §A14 allowlist). **Fail-open by opt-in.**
3. `read ∪ write` ⊇ toolName → **allow** (`allowlisted`).
4. otherwise → **deny** (`not-allowlisted`). **Fail-closed once opted in.**

### Wiring + replay

The gate sits in `runChatToolLoop` (the single shared live tool loop both the manifest
dispatch and the chat conversation reuse) right after the §A14 manifest-allowlist
refusal and before arg-validation/execution. A denied call emits
`agent.toolReturned{status:'forbidden'}` and is never executed. Because the verdict is
recorded in the run event log (not recomputed), a `:replay`/`:fork` reproduces it
deterministically — no live re-resolution of the profile at replay time.

### Activation: shadow mode → validate → flip

The gate self-runs in **shadow mode**: whenever a standing agent carries `permissions`
the verdict is always computed, and a *denial* is **logged** (`agent_tool_permission_denied
{ agentId, toolName, reason, enforced:false }`) but **not blocked** until
`OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED=true` (default off, flipped per-deploy without a
rebuild — mirrors the rate-limit env knobs). The shadow log IS the validation harness:
run with the flag off and watch for `agent_tool_permission_denied` lines — each one is a
tool that WOULD be blocked, i.e. a real tool name the seed allowlist doesn't cover.

`rosterId` resolution is solved: a standing agent's `rosterId` IS its dispatchable
`agentId` (the `host:` form), so `resolveAgentToolPermissions(tenantId, agentId)` keys the
profile directly; a pack/manifest agent (no `host:` prefix) has no profile ⇒ ungated.

Two of the three original gates are now closed by code; one validation gate remains
before the flip:

1. **Real tool-call names vs. seeded permission ids** — STILL the gate. Confirm via the
   shadow log (no unexpected `agent_tool_permission_denied` for legit tools) before
   default-on; expand the seed allowlists where the real tool surface isn't covered.
2. **`agentId` → profile resolution** — ✅ done (`resolveAgentToolPermissions`).
3. **Caller threads `toolPermissions`** — ✅ done for the chat path
   (`conversationToolLoop`) and the live dispatch path (`runToolLoop` via `deps.tenantId`).

This is a real engineering gate (security-sensitive, high blast radius), not scope-cutting:
the logic, wiring, shadow validation, and tests all land now; only the default-on flip
waits on gate #1 evidence.

### Known coverage gap

Heartbeat-/schedule-triggered runs that hit an **inline `chat-completion` workflow node**
(`bootstrap/nodes.ts`) use provider-specific tool dispatchers, NOT the shared
`runChatToolLoop` — so those tool calls are neither shadow-logged nor gated yet. Routing
that node through `runChatToolLoop` (or adding the same gate to its dispatchers) is a
larger refactor, tracked as a follow-on. The chat-gate + live-dispatch paths (where a
standing agent uses tools interactively / on demand) ARE covered.

## Implementation status

| Piece | Status |
|---|---|
| Pure `evaluateToolPermission` + tests | ✅ implemented |
| Gate wired in `runChatToolLoop` (shadow-mode + env flag) + tests | ✅ implemented |
| `resolveAgentToolPermissions` (`agentId`→profile) + test | ✅ implemented |
| Callers thread `toolPermissions` (chat gate + live dispatch) | ✅ implemented |
| Seed allowlists permit the builtin tools (`builtinToolNamespaces`) | ✅ implemented |
| Backfill existing profiles' `permissions.read` (app migration v1) | ✅ implemented |
| Heartbeat inline-chat-node path | ↳ scoped in **ADR 0105** — its tools are workflow-bound sub-runs, governed by the workflow portfolio + autonomy (ADR 0036), not this native-tool gate; native-tool gating there is targeted + conditional, not a full refactor |
| Default-on flip | ✅ safe to enable (gate #1 closed) |

### Gate #1 closure — permitting the builtin tools

The seeds declared illustrative DOMAIN ids (`crm.field.update`, …) in `permissions.read/
write`, but the tools agents actually call are the host BUILTINS (`openwop:knowledge.search`,
`openwop:ai.research.web`, `openwop:core.openwop.http.fetch`, RAG, compute). None matched,
so default-on would have blocked every opted-in agent's tools. Closed two ways:
- **Seeds** now include the builtin namespace tokens (`builtinToolNamespaces()` →
  `openwop:knowledge`/`ai`/`core`/`feature`) in each agent's `permissions.read`, which
  prefix-match all builtins (a test asserts this).
- **Existing profiles** are backfilled by **app migration v1**
  (`backfillProfileReadPermissions`) — idempotent set-union on `permissions.read`,
  concurrency-safe, only touching profiles that already carry a `permissions` block
  (permission-less agents stay ungated). `initHostExtPersistence` moved before
  `recordAppVersion` so the host-ext collection is wired when the migration runs.

The domain `never`-deny and domain write allowlists remain the real per-tool governance;
the builtin grant only stops the gate from blocking the platform's own safe tools.

## Risks

- **Fail-closed over-block** if enabled before validation — mitigated by default-off +
  the opt-in (`read∪write` empty ⇒ ungated) so only agents with an explicit allowlist
  are ever gated.
- **Token/name mismatch** (the gate #1 risk) — the matching model is prefix-tolerant to
  reduce it, but only live traces confirm coverage.

## Open questions

- [x] **Resolved 2026-06-22 (grade-code ATOOL-4) — `read` vs `write` stays a single union
      allowlist; the two fields are kept as forward-compatible authoring affordances, NOT
      collapsed.** The gap report flagged that the field names `read`/`write` imply a
      distinction the evaluator doesn't enforce (it tests `read ∪ write`,
      `agentToolPermissions.ts`). Two honest fixes were weighed:
      - **(a) Enforce the split** — requires a per-tool read/write CLASSIFICATION, and
        there is **no source** for one: RFC 0069 only excludes the `exec` class; it defines
        no general read/write/side-effect tag, and the tool catalog carries none. Enforcing
        a split today would mean inventing a classification, which would drift.
      - **(b) Collapse to a single `allow`** — removes the implied distinction, but is a
        **breaking rename** of the persisted `agentProfile.permissions` shape (ADR 0031)
        and the seeded allowlists, and throws away the field that the split will use the
        day a classification source lands.
      **Decision: neither — keep `read`/`write` as the authoring shape, enforce them as a
      union, and STATE it.** The fields are a forward-compatible affordance (an author can
      already group tools by intent); the *enforcement* is `read ∪ write` until a
      side-effect classification source exists. The contract is now explicit (here +
      ADR 0105's read/write note + the `agentToolPermissions.ts` doc-comment), so the
      naming no longer over-promises. **Revisit trigger:** a tool-catalog side-effect tag
      (e.g. a future RFC 0069 extension or a host-side classification) — at which point the
      evaluator gates `write`-class tools against `write` only, with no schema change.
