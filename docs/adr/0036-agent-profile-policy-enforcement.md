# ADR 0036 — `agentProfile` policy enforcement (permissions / hitl / within-policy allowlist)

**Status:** Accepted
**Date:** 2026-06-13
**Depends on:** ADR 0031 (the `agentProfile` shape — `permissions{read,write,never}`,
`hitl[]`, `autonomy{specLevel,level,withinPolicyActions}`, `requiredConnections`),
ADR 0033 (`requiredConnections` activation gating — `host/connectionReadiness.ts`
`gateAutonomyByReadiness`), ADR 0028 (connector/action governance — the adjacent
admin-policy owner this composes WITH, never forks), ADR 0023/0025 (heartbeat
pick + the assistant action→approval loop = the two enforcement seams).
**Surface:** host runtime only — the heartbeat pick (`host/heartbeatService.ts`)
and the assistant action enqueue (`features/assistant/actionApproval.ts`). No
route, no wire field, no advertisement.
**NON-NORMATIVE — no OpenWOP RFC.** This enforces host-local product config
(`agentProfile`, ADR 0031) that no OpenWOP client reads; it touches no `/v1`
contract, capability flag, or run-event field. Per CLAUDE.md the RFC gate is for
wire-surface changes; this is host work.

## Why this exists

ADR 0031 added the rich `agentProfile` with explicit access controls
(`permissions.never`), human-in-the-loop requirements (`hitl[]`), and an
"autonomous within policy" allowlist (`autonomy.withinPolicyActions`). Its
§Open-questions deferred the hard part:

> Should `permissions`/`hitl` be advisory metadata only (day-1) or enforced at
> the tool-policy layer? (Recommend: advisory + displayed day-1; enforcement is
> a follow-on once the tool-policy layer reads them.)

Day-1 only `requiredConnections` was *enforced* (ADR 0033). `permissions.never`,
`hitl`, and the `withinPolicyActions` allowlist were displayed but inert: a twin
whose profile declared `never: ['email.send']` and ran at `auto` could still
auto-send. That makes the profile a dishonest claim — the UI shows a guardrail
the runtime doesn't honor. This ADR closes the gap: the policy fields become
enforced at the two points an agent is about to act.

## Decision

A **single pure resolver** — `host/agentPolicyResolver.ts` `resolveAgentPolicy()`
— turns `(agentProfile, actionClass, baseLevel, connectionReadiness)` into one
verdict, and the two enforcement seams consult it. It owns **no store**: the
profile is `agentProfileService` (ADR 0031), the readiness is
`connectionReadiness` (ADR 0033), the admin action-kind policy is
`governanceService` (ADR 0028). It is pure resolution over the existing owners —
no parallel evaluator, no parallel store (the ADR 0028 discipline: *configure the
enforcement points that already exist; never become a second evaluator*; and
MEMORY's "no parallel architecture" rule).

### The resolver contract

```ts
type PolicyVerdict = 'deny' | 'review' | 'guided' | 'auto';   // most→least restrictive
resolveAgentPolicy({ profile, actionClass, level?, readiness? }): { verdict, reason }
```

Composition order — **MOST RESTRICTIVE WINS**:

1. **`permissions.never` ⊇ actionClass → `deny`.** Fail-closed, short-circuits
   everything (wins even over an `auto` agent with the same action on its
   `withinPolicyActions`). The caller MUST NOT run, draft, enqueue, or even queue
   for approval — there is no human override path for a forbidden action class.
2. **`hitl` ⊇ actionClass → `review`.** Force a human approval regardless of
   autonomy level or readiness. Never `auto`; never `deny` (a human may still
   approve it — that is the whole point of HITL).
3. **Readiness gate (ADR 0033).** `gateAutonomyByReadiness(baseLevel, readiness)`
   — an un-ready required connection forces `review`. This only ever *lowers*
   `auto`/`guided`, never widens.
4. **Autonomy level.**
   - effective `auto` → `auto` **only if** `withinPolicyActions` includes the
     action class; off-list → `review`. An **empty or absent** allowlist at
     `auto` permits **nothing** to auto-run (conservative / fail-closed): an
     "autonomous within policy" agent with no policy has no autonomy. (Chosen
     over the permissive reading "empty = allow all", which would make a
     misconfigured profile silently more powerful than a configured one.)
   - effective `guided` → verdict `guided`: the action class is permitted; the
     **caller** applies its own guided middle-rule (the heartbeat runs routine
     picks, proposes HIGH-priority ones — ADR 0025). The resolver decides only
     *whether the action class may auto-run at all*, not the priority split.
   - effective `review` → `review`.

A **profile-less / requirement-less** agent is ungated: the readiness-gated base
level passes straight through, so an agent with no profile behaves *exactly* as
it did pre-0036 (back-compat).

### Where it hooks in

| Seam | actionClass | What the verdict drives |
|---|---|---|
| **Heartbeat pick** (`runHeartbeatOnce`, `host/heartbeatService.ts`) | the picked card's `workflowId` | `deny` ⇒ **skip the card** (neither run nor propose — a human/other agent handles it); `review` ⇒ queue a proposal (the existing `createApproval` path); `guided` ⇒ propose only HIGH-priority cards; `auto` ⇒ start the run. Replaces the prior inline `gateAutonomyByReadiness` + `guided`-priority block with one resolver call (the readiness gate is now composed *inside* the resolver, so the two can't drift). |
| **Assistant action enqueue** (`enqueueActionWithApproval`, `features/assistant/actionApproval.ts`) | the action `kind` (`email.send`, `calendar.invite`, …) | `deny` ⇒ throw `403 forbidden` — nothing drafted, enqueued, or approvable (fail-closed, mirroring ADR 0028's `disabled`-kind throw). `review`/`guided`/`auto` need no extra branch: this path **always** proposes (it creates a `PendingApproval`; execution waits on a human approve in ADR 0023 T6), which *is* `review` behavior — so the load-bearing enforcement at this seam is the `deny`. The acting agent is the assistant-capability holder (`ensureAssistantAgent`, resolved by capability not `roleKey` per the ADR 0023 2026-06-13 correction); `profileId = its rosterId`. |

Action classes are matched by **exact string id**. The seed profiles
(`host/seed-data/exampleAgents.json`) use one dotted namespace for
`permissions.never` / `hitl` / `withinPolicyActions` (`email.send`,
`crm.stage-advance`, `ticket.tag`, …) which is the same namespace as the
assistant `PendingActionKind` and the heartbeat workflow ids — so each seam
passes the action-class id it already has, no translation table.

### Relationship to ADR 0028 (no fork)

ADR 0028 is the **admin/tenant** governance owner: `GovernancePolicy.actionPolicy`
(`disabled`/`draft-only`/`approval-required`) set per *workspace*. ADR 0036 is
**per-agent** policy from the agent's own profile. They compose at the assistant
enqueue seam — ADR 0028's `disabled` check runs first (workspace forbids the
kind for *everyone*), then ADR 0036's `permissions.never` (this *agent* is
forbidden the kind). Both are fail-closed throws; whichever fires first wins, and
the net effect is the union of restrictions (most-restrictive). No ADR 0028 code
moved or forked.

## Alternatives weighed

1. **A new tool-policy store / second evaluator** — rejected. The profile is
   already the owner; a second store would drift and contradicts ADR 0028's
   "configure the points that exist" + MEMORY's no-parallel-architecture rule.
2. **Enforce inside `toolHooks` (RFC 0064) like ADR 0028's action-kind policy** —
   considered. ADR 0028 lowers admin action-kind policy into the RFC 0064
   pre-hook. But `agentProfile` policy is keyed by the *acting agent's profile*,
   and the two enforcement points here (heartbeat workflow pick; assistant action
   enqueue) sit *above* tool invocation — the heartbeat decides whether to start
   a run *at all*, before any tool fires. Enforcing at those seams is where the
   "agent is about to act" decision actually lives. A future per-tool-call layer
   could additionally consult `permissions.read/write` inside `toolHooks`; that is
   left for a follow-on (see open questions) and would reuse this same resolver.
3. **Empty `withinPolicyActions` at `auto` = allow all** — rejected as a
   foot-gun: a profile that forgets to fill the allowlist would silently become
   *more* autonomous than a careful one. Empty = permit nothing is fail-closed.
4. **`hitl` ⇒ `deny`** — rejected: HITL means *ask a human*, not *forbid*. Only
   `permissions.never` denies.

## Replay / determinism

No new replay surface. The autonomy `level` and `requiredConnections` are already
read from the **persisted profile at run creation** and stamped into run metadata
(ADR 0031 §Replay); historical runs replay/fork against the stamped values. This
ADR's resolver runs at the *activation/enqueue decision* (before a run exists or
is dispatched), not inside run execution, so it introduces nothing a replay must
recompute — the heartbeat either started a run (replayable as-is) or queued a
proposal (a human act). `permissions`/`hitl`/`withinPolicyActions` are read live
from the profile at decision time; changing a profile changes *future* decisions
only, never the meaning of a past run.

## Implementation plan

| Phase | Work | Gate / commit |
|---|---|---|
| 1 | `host/agentPolicyResolver.ts` — pure `resolveAgentPolicy` over profile + readiness | tsc + unit tests |
| 2 | Compose it into `runHeartbeatOnce` (replace inline gate+priority block) | heartbeat tests |
| 3 | Compose `deny` into `enqueueActionWithApproval` (fail-closed 403) | assistant tests |
| 4 | This ADR | — |

## Tests (landed with this ADR)

- **`test/agent-policy-resolver.test.ts`** — pure resolver: `never`→deny;
  `hitl`→review (even at auto+allowlisted); never-beats-hitl; `auto`+allowlist
  permits only listed (off-list→review); empty/absent allowlist at auto→review;
  composition with readiness (un-ready→review, most-restrictive); guided rides
  through; profile-less is ungated.
- **`test/agent-policy-heartbeat.test.ts`** — `runHeartbeatOnce`: a `never`
  workflow card is skipped (no run, no proposal); a `hitl` workflow is proposed;
  `auto`+allowlist runs an allowlisted workflow and proposes an off-list one; an
  un-ready required connection forces a proposal (and once active, runs); the
  guided priority split (HIGH→propose, routine→run).
- **`test/agent-policy-assistant-enqueue.test.ts`** — `enqueueActionWithApproval`:
  a `never` kind → 403, nothing drafted; a non-forbidden kind enqueues; a
  profile-less agent is ungated.

## Open questions / decisions checklist

- [ ] **Per-tool-call `permissions.read/write` enforcement.** Today `never` (the
      hard deny) is enforced; the positive `read`/`write` allowlists are still
      advisory/displayed. A follow-on could lower them into `toolHooks` (RFC 0064)
      reusing this resolver, so a tool invocation outside `permissions.write`
      fail-closes. Deferred until a twin's tool surface needs it.
- [ ] **Surface the verdict reason in the proposal text.** The heartbeat already
      annotates "missing connection(s)"; extend to "(held — requires approval per
      policy)" for `hitl` and "(off autonomy allowlist)" for `not-within-policy`,
      so the inbox explains *why* it asked. Cosmetic; not done here.
