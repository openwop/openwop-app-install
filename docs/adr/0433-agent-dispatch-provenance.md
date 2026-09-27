# ADR 0433 — Agent-dispatch provenance: completing the PRD §13 delegation record

Status: **implemented** (P1 + the P2 stamp helper, 2026-07-19; record below)

**Requirements source:** `docs/kicktodo-prd.md` §13 AI and orchestration — "Delegation records parent named-agent and project subjects, specialist identity/version, workflow/node versions, context refs, tools, budget, output, and merge decision; specialists do not inherit private memory or personal Connections by default."
**Depends on:** `host/agentDispatch.ts` (the single dispatch owner), RFC 0002 §A14 (the tool-allowlist intersection already recorded as `toolSurface`), ADR 0031 (agent profiles).
**Surface:** host-internal telemetry on an existing seam. **NO new RFC** — nothing is advertised or wire-visible.

## Why this exists

The PRD names nine things a delegation record must carry. `AgentDispatchResult` carries three of them today — specialist identity (`agentId`/`persona`), tools (`toolSurface`), and output (`result`). The other six are absent: **parent named-agent subject, project subject, specialist version, workflow/node versions, context refs, budget, and the merge decision.**

This matters beyond bookkeeping. Without provenance, a specialist's output cannot be attributed to the delegation that requested it — so "which named agent asked for this, under what budget, and did a human accept it?" is unanswerable after the fact. That is precisely the audit question governance surfaces exist to answer.

## Boundaries audit (verified against live code)

- **`agentDispatch.ts` is the single constructor.** `AgentDispatchResult` is built in exactly one file; `workforceEval.ts`, `a2aServer.ts`, `agentRunnerNode.ts`, and the chat tool loop only READ it. An additive-optional extension therefore cannot break a consumer — verified by grep, not assumed.
- **NAME COLLISION, avoided deliberately:** `host/approvalDelegations.ts` already owns the word *delegation* — and means something different by it (act-on-my-behalf approval coverage, including out-of-office windows). Using "delegation" for dispatch provenance would put two meanings on one noun in the same `host/` directory, which is exactly the drift this repo's boundaries audit exists to catch. **This ADR names the concept `provenance`.**
- **No second record store.** Provenance rides the EXISTING dispatch request/result pair. There is no delegation table, no new collection, and no second audit log — the intent-ledger and run-event owners keep their jobs.
- **Tools are already recorded** as `toolSurface` (the RFC 0002 §A14 intersection). The PRD's "tools" item is satisfied; this ADR does not duplicate it.

## Decision

**Provenance is CALLER-SUPPLIED on the request and echoed VERBATIM onto the result.**

`runAgentDispatch` is a pure function over its request: it cannot know which named agent delegated to it, which project the work belongs to, or what budget the caller set. Inferring any of that would be a fabrication — so the dispatcher records what it is told and nothing more. A caller that supplies nothing gets a result with no provenance, which is honest, rather than a guessed parent.

```ts
export interface AgentDispatchProvenance {
  /** The named agent that delegated this work, and its stable subject. */
  parentAgentId?: string;
  parentSubject?: string;
  /** The project the work was performed for (descriptive, never authority). */
  projectSubject?: string;
  /** The specialist's pack version — identity alone is not reproducible. */
  specialistVersion?: string;
  /** The workflow/node that dispatched, with versions. */
  workflowId?: string;
  workflowVersion?: string;
  nodeId?: string;
  nodeVersion?: string;
  /** OPAQUE refs to the context handed over — ids only, never content. */
  contextRefs?: string[];
  /** The budget the caller set, and what the turn actually consumed. */
  budget?: { maxUsd?: number; maxTokens?: number; spentUsd?: number; spentTokens?: number };
  /** What the PARENT did with the output. Set by the merging caller AFTER the
   *  turn returns — the dispatcher never decides its own merge outcome. */
  mergeDecision?: 'pending' | 'accepted' | 'accepted-with-edits' | 'rejected';
}
```

- **Every field optional.** A required field would break every existing caller on the day it lands; optionality is what makes this safe on a shared seam.
- **`contextRefs` are ids, never content.** A provenance record that embedded handed-over context would become a second copy of that data with its own leak surface.
- **`mergeDecision` defaults to `pending`** when provenance is supplied at all — the honest state before a parent has judged the output, distinguishable from "no provenance recorded".
- **Replay/fork-safe by construction:** provenance is echoed, never re-resolved, so a fork reproduces the recorded values rather than recomputing them against a moved world.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | The `AgentDispatchProvenance` type, the optional `provenance` field on request + result, verbatim echo through both `runAgentDispatch` and `runAgentDispatchLive`, and tests: absent stays absent, supplied echoes exactly, `mergeDecision` defaults to `pending`, and no existing caller shape breaks. |
| **P2** | `recordMergeDecision(...)` so the merging caller can stamp the outcome after the turn; the KickTodo factory's specialist handoffs populate provenance as the reference consumer. |

## Implementation record

| Phase | Landed |
|---|---|
| P1 — `AgentDispatchProvenance` + optional `provenance` on request and result; `echoProvenance` wired into BOTH dispatch paths' single result factories (`base()` deterministic, `finish()` live) so a delegation is attributable on success, escalation, and failure alike. Test-pinned: absent stays absent (`'provenance' in result === false`, so no existing caller's shape changes), supplied echoes field-for-field, an explicit `mergeDecision` is never overwritten by the default | kicktodo/e-delegation |
| P2 (helper) — `recordMergeDecision` for the merging caller, pure and non-mutating (test-pinned); the KickTodo factory adopting it as the reference consumer remains open | kicktodo/e-delegation |

**Architect findings, all built to:** the blast radius is one file (`AgentDispatchResult` is constructed only in `agentDispatch.ts`; `workforceEval`, `a2aServer`, `agentRunnerNode` and the chat loop only read it) — verified by grep before writing, which is what made additive-optional demonstrably safe. Provenance is caller-supplied and echoed because `runAgentDispatch` is a pure function with no caller identity: inferring a parent would be fabricated attribution. The name `provenance` avoids the live collision with `approvalDelegations`' different meaning of "delegation".

## Feature matrix

1. Package: host seam, not a feature package — no `src/features/<id>/`. 2. Toggle: none (telemetry on an existing path, not a product surface). 3. `ctx` surface: none. 4. Node pack: none. 5. Envelopes: none. 6. Agent pack: none. 7. Public surface: none. 8. RBAC: unchanged — provenance is recorded, never authorizing. 9. Replay/fork: echoed verbatim, never re-resolved. 10. Frontend: none in this ADR.

## Alternatives weighed

- **Infer the parent from call context** — rejected: `runAgentDispatch` has no caller identity, and a guessed parent in an audit record is worse than an absent one.
- **A separate delegation-record store** — rejected: a second audit surface beside the intent ledger and run events, with its own retention and drift. The dispatch pair already spans exactly the right lifetime.
- **Reuse `approvalDelegations`** — rejected: different concept, and overloading it would corrupt the approval-coverage semantics.
- **Make the fields required** — rejected: it would break every existing caller simultaneously on a shared seam.

## Open questions

1. Should `budget.spentUsd` be populated by the dispatcher (which knows the live provider call) rather than the caller? Recommend **yes for spend, caller for limits** — the dispatcher is the only honest source for what was actually consumed. Deferred to P2 so P1 stays a pure echo.
2. Does the intent ledger want a projection of provenance? Likely, but it is a separate owner and a separate decision.

## RFC verdict

**Host work, no new RFC.** Provenance is host-internal telemetry on an existing seam; nothing is advertised at `/.well-known/openwop`, no run-event shape changes, and no normative behavior is claimed.
