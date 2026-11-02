# ADR 1005 — RFC 0082 agent deployment lifecycle (`agents.deployment`), the host half

Status: Accepted (2026-10-30; /architect pass folded in: findings 1–6, marked inline)

Amends ADR 0440 (its open question 1, answered for `agent` only; correction note
there). Implements openwop RFC 0082 (`Accepted`) at major 2: `listAgentDeployments` /
`transitionAgentDeployment` (`GET`/`POST /agents/{agentId}/deployments`), the
channel pin on `agent.invocation-started`, and the eval gate. The wire is locked
(`schemas/v2/agent-deployment*.schema.json`, `spec/v2/facets/agents.schema.json`
§deployment, `api/v2/openapi.yaml`), so no new RFC is needed. Brief: issue #5393.
The user decided on 2026-10-29 that this app builds it. myndhyve.ai runs on this
white-label and inherits it; api.myndhyve.ai, the only host that advertised it,
retired the same day.

## Context

Measured on `origin/main` `02ca1d9b3`:

- `AgentRef` (`executor/types.ts:398`) already types `channel?`. Nothing reads it.
  The executor copies a node's `agent` onto `RunSnapshot.agent`
  (`executor.ts:817`), and every consumer reads only `agentId`.
- No `agent.invocation.*` event is emitted for a workflow run. The only emitters
  are the eval trials (`host/evals/agentEvalRun.ts:468`, `:606`).
- `validateWorkflowDefinition` drops a node's whole `agent` field
  (`host/workflowDefinitionValidation.ts:539`). Conformance fixtures are loaded raw
  (`host/index.ts:68`), so the vendored `conformance-agent-channel-dispatch` keeps
  its `{agentId: core.conformance.channel-agent, channel: stable}` binding.
- That fixture is LISTED in discovery today: its one node is `core.identity`, so
  `fixtureIsAdvertisable` passes it. Its contract says only a host advertising
  `agents.deployment` can seed it. The listing is harmless today only because the
  v2 legs gate on the facet first.
- `conformance-eval-gate-failing` is withheld by `UNLISTED_FIXTURE_SUITES`
  (`host/evals/fixtureSuites.ts:68`, ADR 0984 P2) because nothing behind it exists.
- No host code creates a run outside `POST /runs`, so there is no ready seat for
  RFC 0082's "deployment-management run".
- RFC 0249 proposals (ADR 0972) is the nearest precedent: a v2 facet with its own
  routes, key-lane scopes (`requireKeyLaneScope`), a `DurableCollection` store
  with a CAS revision, and an advertise-gated 404.

The suite legs (openwop #2060 `v2-deployment-lifecycle`, ten `0082.*` legs, in
the unpublished 2.46.35; `v2-deployment-eval-gate`, two legs, since 2.46.29) drive
the wire with no seam. One cut walks the fixture agent: list → run the fixture
(R1) → unscoped promote → illegal pause/deprecate of the draft → promote
draft→test→staged→active on `stable` at 100 → run again (R2 must resolve the
candidate) → replay R1 (must re-read R1's version) → adjust-canary to 50 →
rollback → list. The rollback leg needs a version OTHER than the candidate still
`active` on `stable` after the promote, so promoting a candidate to `active` must
not retire the incumbent.

## Decision

### D1 — A feature package, off by default

`features/agent-deployments/` (ADR 0001): `types.ts`, `stateMachine.ts`,
`store.ts`, `service.ts`, `evalGate.ts`, `capability.ts`, `v2Routes.ts`,
`channelResolver.ts`, `feature.ts`. Advertised and served only when
`OPENWOP_AGENT_DEPLOYMENT=on`. Off, both routes answer `404 not_found` (core
`errors.md` §Unadvertised operations) and a channel-bound node fails (D5).
Default off, so the deploy that ships the code changes no cut row; turning it on
in production is an env change and needs the user's approval.

The facet, from ONE builder (`agentDeploymentFacet()`) that discovery and the
routes both read:

```jsonc
"deployment": { "channels": ["stable", "canary", "latest"], "canary": true, "rollback": true,
                "states": ["draft","test","staged","active","paused","deprecated","rolled-back"] }
```

The v2 facet has no `supported` member (it is closed), so presence is the claim.

### D2 — The record store

A tenant-partitioned `DurableCollection` keyed `${tenant}::${agentId}::${version}`,
with `tenantOf` for teardown. Each row holds the wire record plus host fields:
`revision` (every write is a CAS on the row read), `activatedAt` (orders the
actives on a channel), `supersedes` (the version that was serving the channel when
this one was activated, the rollback target), `updatedAt`. The wire view strips
them. The list is version-sorted (semver, then string order).

**An agent with no stored records** shows one synthesized baseline: its installed
version (`resolveAgentForTenant`), `active` on `stable`. Installed means serving
today, so this is the honest starting state. It is never written by a read; the
first transition of that agent materializes it. An agent the tenant cannot see is
`404 not_found`, the same as an absent one (no cross-tenant existence leak).

### D3 — The state machine and its refusals

> **CORRECTED 2026-10-30 — RFC 0254 (Active, openwop #2061 `c26f60d9`) settled
> what this section guessed.** An illegal transition is `409
> deployment_state_conflict`, `details: {state, transition}` (it was `conflict` +
> `reason`). Resume is a `promote` from `paused` and records
> `deployment.state.changed`, not `deployment.promoted`. Rollback restores the
> most recent OTHER version active on the same channel, and `409` when there is
> none; the stored `supersedes` pointer is gone. Until the pin vendors the 2.46.35
> error registry, the v2 envelope sends the new code vendor-prefixed. The rest of
> this section stands.

The checks run in this order, and each refusal leaves the record unchanged:

1. advertised? else `404 not_found` (also for the reserved `roster` / `org-chart`
   agentIds, which name sibling routes);
2. key-lane scope (D6) → `403`;
3. membership authority (D6) → `403`. It runs before anything is loaded, so a
   member without authority learns nothing about which versions exist
   (architect finding 1);
4. body against `agent-deployment-transition.schema.json` → `400 validation_error`;
5. the agent exists for this tenant and the version has a record → `404 not_found`;
6. the target state is in the advertised `states` → `400 validation_error`
   (and `canaryPercent < 100` with `canary: false` → `400`; inapplicable here);
7. the transition is legal from the record's state → `409 conflict`,
   `details: {reason: "illegal_transition", state, transition}`;
8. the eval gate (D7) → `422 eval_gate_unmet` (added to `OpenwopErrorCode`; it is
   in the v2 error envelope).

Legal transitions:

| transition | from | to | notes |
| --- | --- | --- | --- |
| `promote` | draft / test / staged | the next of draft→test→staged→active | `toState`, when given, MUST be that next state; skipping is illegal |
| `promote` | paused | active | the resume verb (upstream has not ruled on one; D11) |
| `pause` | active | paused | |
| `deprecate` | active | deprecated | |
| `rollback` | active | rolled-back | restores the rollback target to `active` (below) |
| `adjust-canary` | active | active | `canaryPercent` required |

**Channels.** A promote into `active` binds `channel` when given (added to
`channels[]`), at `canaryPercent` (absent ⇒ 100). It does NOT retire the version
already serving that channel: that version stays `active` and is recorded as the
new one's `supersedes`. A channel not in the advertised list is `400`.

**Resolution** of `(agentId, channel)`: the actives listing `channel`, newest
`activatedAt` first. The newest takes its `canaryPercent` share and the next one
the remainder; a lone active takes everything. `latest` is the highest semver
`active` version on any channel. The draw is `sha256(runId|agentId|channel) mod 100`,
so even a lost pin event cannot make two resolutions of one run disagree.

**Rollback** of `V` on its channel restores `V.supersedes` when that record still
exists and is not `rolled-back`, else the next-newest other active on the channel,
else `409 conflict` (`reason: "no_rollback_target"`). The target becomes `active`
with `canaryPercent` cleared; `V` becomes `rolled-back` with
`rollbackPointer = target`. Both rows are written under CAS, target first.

### D4 — The `deployment.*` events go to the tenant audit log

> **SUPERSEDED 2026-10-30 by RFC 0254 §D.** Every applied transition now mints a
> deployment-management run (`workflowId: openwop-app.agent-deployment`, the
> caller's tenant, never executed, the ADR 0858 negotiation-audit-run shape) that
> carries `authorization.decided` and the `deployment.*` event. Every changed
> record names it as `transitionRunId`, readable at `GET
> /runs/{transitionRunId}/events/poll` with `runs:read`. The run is opened only
> after every check passes, so a refusal creates none; a write that loses its CAS
> closes it `failed`. `transitionRunId` goes on the wire only once the vendored
> `agent-deployment.schema.json` seats it (`wire.ts`, the ADR 0972 D9 precedent),
> because the 2.46.33 record is closed. No approval gate applies on this host, so
> a legal transition is always `200`, never RFC 0254's gated `202`. Refusals are
> still audited on the tenant log. The original text follows.

Every applied transition appends one content-free `deployment.promoted` /
`deployment.rolled-back` / `deployment.canary.adjusted` /
`deployment.state.changed` payload (exactly the `run-event-payloads` shapes) and
every decision appends `authorization.decided`, through `appendAudit(tenant, …)`.
RFC 0082 puts them on "the deployment-management run", but no operation names
that run, the suite does not witness it, and whether a transition returns or links
it is unsettled upstream (#5393). This host does not invent a run id the wire
cannot reach. When the ruling lands, the run seat is P3.

### D5 — The channel pin, through a host seam

`host/agentChannelPin.ts` holds the seam the executor calls; the feature registers
the resolver into it (`registerAgentChannelResolver`), so `executor/` never
imports `features/`. In `runOneNode`, after the module and capability checks and
before execution, a node whose `agent` carries `channel`:

1. reuses a pin already in THIS run's log: an `agent.invocation.started` with the
   same `agentId` + `resolvedChannel` (a resume, a retry, a second node, or a
   fork's inherited prefix);
2. else, on a fork (`parentRunId` set, any fork mode), re-reads the parent's pin
   for that pair. A replay never re-resolves (RFC 0082 §B; facet: "replay and fork
   MUST re-read it");
3. else resolves through the registered resolver.

It then appends `agent.invocation.started {invocationId: runId:nodeId:n, agentId,
source: "workflow-node", resolvedChannel, resolvedAgentVersion}` and, after the
node's terminal event, `agent.invocation.completed`. No resolver registered (the
feature off), a channel not advertised, or no active version on it → the node
fails `validation_error` (`details.reason: "no_active_deployment"` /
`"channel_not_advertised"`), fail-closed, never an arbitrary version. A node with
an exact `version` or no binding is untouched.

The started/completed pair keeps RFC 0077's bracket well-formed. The payload's
description ties the event to `agents.liveRuntime`, which this host does not
advertise; the fixture contract requires the event on a channel-bound run all the
same, and the payload carries identifiers only (architect finding 5).

**Registration keeps the binding** (architect finding 2). `validateWorkflowDefinition`
dropped a node's whole `agent` field, so a channel bound in a user-registered or
chain-instantiated workflow never reached the executor, and with the facet off a
channel-bearing ref was accepted and discarded rather than refused. It now keeps
`agent` and validates it: `agentId` a non-empty string, `version` XOR `channel`
(`400 validation_error`), and `channel` only while the facet is advertised
(`400 validation_error`, as `agent-ref.schema.json` requires of a host without it).
This is additive: `RunSnapshot.agent` starts showing for user-registered workflows,
as it already did for fixtures.

Resolution happens at the node's first resolution, the facet's refinement of
RFC 0082 §B's "at run start". A create-time `400` for a channel with no active
version is not done in P1 (D11).

**The fixture is listed only when it can pass**: `fixtureIsAdvertisable` withholds
`conformance-agent-channel-dispatch` unless the facet is advertised, which fixes
today's listing.

### D6 — Authorization

> **CORRECTED 2026-10-30 — RFC 0254 ruled `deploy:*` ONE literal scope.** The
> three verb scopes are gone: a key that declares scopes needs `deploy:*`, and a
> refusal is `403 forbidden` with `scope="deploy:*"` in the challenge.

**Key lane.** A key that declares scopes needs `deploy:*` or the verb's scope:
`deploy:promote` (promote, adjust-canary), `deploy:pause` (pause, deprecate),
`deploy:rollback` (rollback). Upstream has not ruled whether `deploy:*` is a
literal or a family, so the literal and the three verbs are all accepted and all
mintable. They join `scopes_supported` only while the facet is advertised (the
ADR 0972 D9 precedent). `GET` needs `runs:read` (the openapi `security`).

**Membership.** A key acts as its provenance says (`credentialScopesIn`); a browser
session reads `resolveSubjectScopesUnion`. A transition needs `packs:publish`, the
RFC 0049 scope for releasing agent code; a list needs `workspace:read`. An env key
is the tenant owner.

The scope check runs before the agent is loaded, so a key minted in another tenant
(the in-process harness's `conformance-low-scope`) gets `403`, not `404`.

### D7 — The eval gate

A transition that cites `evalRunId` is always verified, whether or not policy
requires it: citing failed evidence never promotes. A promote also needs an
`evalRunId` when the agent's promotion policy carries `requiredEval`. The run must
be in the caller's tenant, an agent eval run (`isAgentEvalRun`) of THIS agent,
`completed`, with `metadata.evalSummary.passed === true` (or `aggregateScore >=
requiredPassScore` when the policy sets one). Otherwise `422 eval_gate_unmet`,
`details: {reason}`. Another tenant's eval run is refused byte-identically to a
run id that does not exist (`eval_run_not_found`, one storage read either way;
identity.md tenant rule, RFC 0252 §C single refusal, 7e's condition on RFC 0254),
and the cited id is not echoed. The verified id is stored on the record's
`evalRunId`.

P1 policy is a code table, one row: `core.conformance.agents.scripted` → promote
requires eval. That row is what listing `conformance-eval-gate-failing` states,
so the fixture is listed iff the facet is advertised (out of
`UNLISTED_FIXTURE_SUITES`). Operator-set policy is P3.

### D8 — The conformance agents

Two reserved ids that exist without an inventory entry:

- `core.conformance.channel-agent`: on first touch per tenant, seed `1.0.0`
  `active` on `stable` and `1.0.1` `draft`.
- `core.conformance.agents.scripted`: seed `1.0.0` `draft`.

Seeds and mints are create-if-absent on deterministic keys (`1.0.0`, `1.0.1`, then
max patch + 1), so two concurrent first touches or two racing mints write one row.
A rollback writes the target first: if the second write loses its CAS, the target
is `active` (as it usually already was) and `V` still `active`, and a retry
completes it (architect finding 4).

The cut leaves the candidate `rolled-back` and the incumbent `active` alone, so the
host keeps one rule after every transition of a reserved agent: if it holds no
`draft`, mint the next patch version as one. The incumbent needs no reset, because
the rollback restored it at 100. The eval-gate promote is refused, so its draft
stays. A cut that dies mid-walk leaves two actives on `stable`; the next cut still
passes (its pinned leg accepts any active version, its walk promotes a fresh
draft), and an operator can roll the stray back.

### D9 — Tenant scoping

Every read and write is keyed by `tenantOf(req)`; resolution by `run.tenantId`.
Channels are tenant-scoped, as the facet says for `installScope: 'tenant'`.

### D10 — Replay and fork safety

- The pin is a recorded fact on the run's own log (D5), re-read on resume and fork.
- The resolver reads live deployment state, so it is never consulted on a fork
  whose parent recorded a pin.
- The draw is a pure function of `(runId, agentId, channel)`, never `Math.random`.
- A transition is not a run, so it has no replay; its audit rows are append-only.

### D11 — Open questions (all five settled by RFC 0254, 2026-10-30)

- [ ] Illegal-transition error code: `409 conflict` + `reason` here; the suite asserts 4xx.
  `conflict` is not a v2-registered code, so the v2 envelope sends it vendor-prefixed
  (`openwop-app.conflict`), as for every unregistered code.
- [ ] The paused→active verb: `promote` here.
- [ ] `deploy:*` literal vs family: both accepted here.
- [ ] Does a transition return or link the management run? Audit log here (D4).
- [ ] Create-time `400` for a channel with no active version (RFC 0082 §B) vs
  first-resolution (facet). First resolution here.

### D12 — Operator promotion policy (P3a)

Each `(tenant, agentId)` may carry one stored policy, in a tenant-partitioned
`DurableCollection` (`agent-deployment-policies`), with two optional parts:

- `requiredEval: { requiredPassScore? }`: the D7 eval gate, now set by an operator
  rather than the code table;
- `approval: { onActivate: true }`: a promote that would leave the record `active`
  (from `staged`, or the resume from `paused`) needs a human approval (D13).

The D7 code table becomes a **floor**. A reserved conformance agent's policy is
fixed (`core.conformance.agents.scripted` still requires an eval), and a write to
a reserved id is `403`, so a cut can never be broken by an operator. For other
agents the stored row is the whole policy. With no row, no gate applies, which is
the P1 behaviour.

Routes (non-normative, `/host/openwop-app/agent-deployments/:agentId/policy`):
`GET` with the transition's membership scope (`packs:publish`), `PUT`/`DELETE`
with **`host:org:manage`**. The stricter scope is deliberate: a caller who can
deploy must not be able to remove the gate on their own promotion. Writes are CAS
on the row read (`If-Match` revision), audited as
`agent-deployment.policy.changed` on the tenant log, and 404 while the facet is
not advertised.

### D13 — The approval gate answers `202` (RFC 0254 §D, P3a)

When D12 requires approval, a transition that passes every check (D3, D7) does
not write. Instead:

1. It opens the management run as usual, then suspends it: one `approval`
   interrupt on node `deployment-approval` (through `getSuspendManager()`, so it
   gets a token, an expiry and the inbox notification like any gate),
   `node.suspended` + `interrupt.requested` on the run's log, and the run moves to
   `waiting-input`. The interrupt data carries `actions: ['accept','reject']`, the
   transition (agent, version, from and to state, channel, canary) and the
   requester. It never carries prompts or eval content.
2. The response is `202` with the record **unchanged except `transitionRunId`**,
   which names the suspended run. Nothing is written to the deployment row.
3. One pending approval per `(tenant, agentId, version)`: a second gated request
   for the same version while one is open is `409 deployment_state_conflict`
   (`details.reason: "approval_pending"`). The pending index is a CAS-created row
   keyed on that triple and is cleared when the gate resolves.

The approval resolves through the **ordinary** interrupt route (`POST
/runs/{runId}/interrupts/{nodeId}`), with its normal checks: `approvals:respond`
and tenant ownership (`loadOwnedRunForDecision`), `requireInterruptDecider`, the
token, the timeout sweep and the CAS claim. The executor cannot resume this run
(it has no definition), so the route needs a hand-off, which D14 adds. On the
claimed outcome:

- **accept**: the transition is planned again against the **current** rows (state
  may have moved while it waited) and committed on the same management run. If it
  is now illegal, or the eval is no longer valid, the run closes `failed` with that
  code and no row changes. The approval is spent; the operator asks again.
- **reject**: the run closes `failed` with `approval_rejected`, and no row changes.
- **timeout** (the RFC 0093 sweep): the same as reject.

**Separation of duties.** The requester may not approve their own request: the
hand-off refuses it with `403 forbidden` *before* the claim, so the interrupt
stays open for someone else. Reject by the requester (withdrawing the request) is
allowed.

> **CORRECTED 2026-10-31 (independent review of the P3a diff, five findings, all
> fixed with tests):**
> - **Self-approval across identities.** The first cut compared raw spellings, so
>   asking with your own `owk_` key (principal `apikey:<id>`) and accepting in your
>   session passed. Now the request stores every canonical spelling of the requester
>   (session user, principal, key issuer, each through `canonicalDecider` →
>   `canonicalReviewerUserId`, the autonomy gate's helpers), the decider is
>   canonicalised the same way, and a spelling that cannot be resolved refuses every
>   accept (fail closed). Witnessed: the test reddens only when both the issuer and
>   the canonicalisation are removed, since each covers the key lane on its own.
> - **A cancel stranded the version.** `host/runCancel.ts` closes gates directly and
>   never reached `onResolved`, so the pending row stayed and every later request was
>   `approval_pending`. The handler now has `onCancelled` (called by the cancel path)
>   and the claim **self-heals**: a held row whose run is gone, terminal or no longer
>   waiting on its gate is released and the claim retried once. A failure after the
>   run is inserted closes it `failed` and drops the claim.
> - **A cancel during the apply** made an applied transition's run `failed`. A
>   `RunLogClosedError` after the rows are written now leaves the transition applied
>   and the run with the status its log closed with.
> - **Canary raise bypass.** Only activation was gated, so an approved 1% canary
>   could be taken to 100% without review. `adjust-canary` **upward** is gated too.
>   Lowering it, pause, deprecate and rollback stay ungated, deliberately: they reduce
>   exposure. (Rollback can widen the restored target's channels to the rolled-back
>   version's; it restores what was already approved, so it stays ungated.)
> - **No timeout by default.** The interrupt now carries `timeoutSec` = 7 days, so an
>   undecided approval expires as rejected and frees the version (witnessed through
>   the real sweep).
>
> Two choices the review asked to state: any `approvals:respond` holder (an Editor)
> may decide, though only `packs:publish` may ask. The gate is a second pair of eyes,
> not a seniority rule. And the emailed decide link always answers `403` (a bare token
> carries no identity), which the confirm page shows as raw JSON. That is a follow-up
> for P3c, not a hole: it fails closed.

Replay and fork: a management run is never forkable, resumable or pausable (`409
conflict`, `reason: "management_run_not_forkable"`), the same guard the eval run
has (`isAgentEvalRun`). The decision is a recorded fact on its log
(`interrupt.resolved`), and the transition it applied is the `deployment.*` event
after it.

Conformance: RFC 0254 leaves the `202` leg "gated on a host fixture; none exists
(G2)". This host adds no fixture, so the leg stays unwitnessed by the suite. It
is witnessed here by route tests.

### D14 — A hand-off for host-owned runs in the interrupt route (P3a)

`host/hostRunInterrupts.ts` holds a registry keyed by `workflowId`:
`registerHostRunInterruptHandler(workflowId, { authorize, onResolved })`.
`resolveAndResume` consults it after its common checks and before it resolves a
gate node from the run's definition:

- `authorize(run, interrupt, decision, decidedBy)` may throw. It runs before the
  claim, so a refusal leaves the interrupt open. D13's self-approval rule lives
  here.
- After the claim is **won**, the route appends `interrupt.resolved` and calls
  `announceResolved`, exactly as the gate path does, then calls
  `onResolved(run, interrupt, outcome, resumeValue)` **instead of**
  `dispatchGateResume`. The timeout sweep calls the same `onResolved` with
  `rejected`.

The route stays feature-blind (ADR 0001): it knows a registry, not deployments.
The feature registers its handler in `registerRoutes`. A `workflowId` with no
handler behaves exactly as today.

**Alternatives weighed for D13/D14:**

- **Register a one-node `core.approvalGate` workflow for the management run and let
  the executor resume it.** Rejected: the management run is defined as never
  executing (D4/RFC 0254 §D), a pinned in-tree definition is forbidden here, and a
  node that applies a deployment would execute host-state writes inside a replayable
  run.
- **Use the host approvals queue (`host/approvalService.ts`, the
  compensation-action precedent).** Rejected: RFC 0254 §D puts the approval
  interrupt **on the run**, readable with `runs:read` through the ordinary run reads,
  and the `202` names that run. A queue row is not an RFC 0051 interrupt.
- **An interrupt-resolution observer** (`registerInterruptResolutionObserver`).
  Rejected: observers run before `dispatchGateResume`, which still runs and fails
  with `approval_node_unresolvable` / `workflow_not_found`, and they are fail-soft,
  so a failed apply would look like an approval.

## Alternatives considered

- **Retire the incumbent when a candidate goes active at 100.** Simpler, but the
  rollback leg then has no active target, and canary has no remainder to split.
- **Resolve once at `POST /runs` into `run.metadata`.** Matches the RFC's older
  wording, but a run can bind several agents, a fork copies metadata it should
  re-read, and the facet chose first resolution.
- **A synthetic management run per transition.** It needs a run-creation path that
  does not exist outside `POST /runs`, for an id no operation exposes. Deferred to
  the ruling (D4).
- **Seed real agents' records on read.** Rejected: a GET must not write. D2
  synthesizes the baseline instead.

## Implementation plan

| Phase | Scope | Status |
| --- | --- | --- |
| P1 | D1–D10: store, state machine, routes, pin seam, eval gate, fixtures, tests | this PR |
| P2 | pin `@openwop/openwop-conformance` 2.46.35 once published; user-approved `OPENWOP_AGENT_DEPLOYMENT=on` in prod; certified cut | P1 merged #5399 (`d1421077a`); P2a pin: this PR; flag + cut next |
| P3 | management run (D4 ruling), operator promotion policy (D7), draft minting on pack install / agent edit, a deployment console in the agents UI | the management run shipped in P1 (RFC 0254 folded in) |
| P3a | D12 operator policy, D13 the `202` approval gate, D14 the host-run interrupt hand-off | merged #5415 (`e6e1e27b2`, train 309); `test/adr1005-p3a-approval-gate.test.ts`, 10 cases, sabotage-witnessed |
| P3b | draft minting when a pack installs a new agent version | **superseded by ADR 1014** (user decision 2026-10-31): on a one-version-per-agent runtime a minted draft would label live code `draft`, so versions run side by side first and minting is ADR 1014 P3 |
| P3c | a deployment console in the agents UI (records, transitions, policy, pending approvals) | after P3a |

## Implementation record

**P2a: pin 2.46.35** (user-approved 2026-10-30; branch `chore/pin-conformance-2.46.35`).
`@openwop/openwop-conformance` and `@openwop/spec-artifacts` are on `^2.46.35`, and
the schemas are vendored at `v2.46.35` (`c26f60d9`). Under npm 10.9.8 the lockfile
moves only those two packages (`changed 2`, added 0, removed 0). Four v2 schemas
change: the deployment record seats `transitionRunId`, the transition schema states
the one-step `toState` rule, the capabilities descriptions are reworded, and the
error registry lists `deployment_state_conflict`. The fixtures are unchanged. So
`wire.ts` now sends `transitionRunId`, and the `409` code goes out bare (it was
vendor-prefixed before). The test pins both. Across the pin, `requirements.json`
goes from 2863 to 2877 ids, +14 −0 with none changed, all in one new scenario file,
`v2-deployment-lifecycle`. With the flag off, every leg soft-skips `inapplicable`
(the facet is not advertised). The flag-off cut prediction is the 253B baseline
508/0/11/378 + 15 inapplicable (14 requirement rows + the scenario row) =
**508/0/11/393 = 912**. The m2 lane on the pinned tree passes 210 of 210 v2 files.

**RFC 0254 fold-in** (same branch): the run seat, the error code, single-scope
`deploy:*`, resume and rollback as ruled. With openwop `origin/main` `c26f60d9`'s
`schemas/v2` overlaid on this worktree (uncommitted, restored after) and the suite
run from an extract of that commit, `v2-deployment-lifecycle` and
`v2-deployment-eval-gate` at major 2 gave **16 executed-pass, 2 inapplicable,
twice back to back on one tenant**. That covers all 14 applicable `0082.*` legs,
`transition-run-linked`, `transition-event-recorded` and `resume-from-paused`
among them. This previews P2's pin bump; it is not a certified cut.

**P1** (branch `feat/agents-deployment-rfc0082`):

- `test/adr1005-agent-deployments.test.ts` (11 cases) drives the cut through the
  real routes. Sabotage-witnessed, each red then reverted: not re-reading the
  parent's pin on a fork → the replay leg; deleting the key-lane deploy scope
  check → the `insufficient_scope` challenge assertion; skipping the eval
  `passed` check → the `422` leg.
- **The upstream legs, run locally against this branch** (openwop `origin/main`'s
  unpublished `v2-deployment-lifecycle.test.ts` + witness copied into the
  worktree's installed 2.46.33 suite, `v2-deployment-eval-gate` from 2.46.33
  itself, `OPENWOP_TARGET_MAJOR=2`, the low-scope key minted through the
  developer-keys route): **12 executed-pass, 2 inapplicable** (the unadvertised-
  state leg, because all seven states are advertised; and the no-canary leg).
  Two back-to-back cuts on one tenant both passed, so the host restores its own
  preconditions (D8).
- **Advert with the flag off (the deploy default):** `fixtures[]` loses
  `conformance-agent-channel-dispatch`, which production lists today (100
  entries, measured 2026-10-30). No other discovery change. Expected row delta:
  **0**. Every leg that reads the fixture (`agent-channel-dispatch`,
  `v2-deployment-lifecycle`) gates on the `agents.deployment` facet first, so
  they record `inapplicable` either way, and `v2-run-execution-bounds` picks
  `conformance-noop` first.
