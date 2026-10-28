# ADR 0942 — Campaign autonomy policy: per-campaign HITL, frozen at run start

Status: Accepted (P0–P3a, P4a, P4b, P5, P6 implemented 2026-10-20; P3b open)
Date: 2026-10-19

Program: **Campaign Studio** (ADRs 0941–0962), Tier 0, the governance keystone.
Depends on ADR 0941 (the campaign exists before its first run and is stamped on
it). Extends ADR 0924 D4 (per-client approval policy) from one action to every
campaign action class. Net-new, not a MyndHyve port.

## Context

David's ask: "as much or as little HITL as each campaign needs", with identified
human roles at review steps and active notifications. Today HITL is decided in
three unrelated places, none of them per campaign:

1. **Hard-coded in the graph.** The orchestration spine pins a `core.approvalGate`
   on the messaging kernel (`features/campaign-orchestration/orchestrationWorkflow.ts:46, 66`).
   `core.approvalGate` always suspends (`bootstrap/nodes.ts:1018-1062`); a
   campaign cannot say "auto" for it, and a chain author must remember to add a
   gate before every risky node.
2. **Per tenant, at effect chokepoints.** ADR 0028 `GovernancePolicy`
   (`host/governanceService.ts:26-82`): per-kind `actionPolicy`
   (`disabled | draft-only | approval-required`), `adSpend.approvalThresholdMinor`,
   commerce thresholds. `adsAdapter` reads them at its one chokepoint
   (`host/adsAdapter.ts:295-306, 339-355`, called at `:1417` and `:1521`).
3. **Per agent.** ADR 0036 `resolveAgentPolicy` (`host/agentPolicyResolver.ts:104-140`):
   `permissions.never` → deny, `hitl` → review, autonomy level + allowlist; on
   person-authorized lanes only `never`/`hitl` apply (ADR 0775 P3b,
   `host/autonomousDispatchPolicy.ts:28-40`).

Plus ADR 0924 D4: `ClientAccount.approvalPolicy` (`agency | client |
client_and_agency`), literal `'agency'` on main
(`features/campaign-ops/types.ts:24-25`, `clientService.ts:65`).

The competitive scan (brief) shows the market gap exactly here: HubSpot Breeze's
per-play "review before send vs send automatically" is the best approval mode in
its segment and is per play, not per campaign or per risk; Gumloop has
per-connector approval rules and spend caps but no replay; Klaviyo/Braze have one
approve button; GHL Agent Studio has no approval node. Nobody configures HITL per
campaign **by risk** (spend, audience, regulated content) and can replay the
decision under the policy in force at the time.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

**Reused, not rebuilt:**

- **Two approval lanes with one projection.** `PendingApproval` kinds
  (`host/approvalService.ts:40-66`; `ApprovalPolicy` = `requiredApprovals`,
  `approverRefs`, `approverGroupRefs`, `approverRoleRefs`, `rejectionPolicy`,
  `:421-438`) and `core.approvalGate` interrupts carrying **the same field names**
  in `interrupt.data` (`bootstrap/nodes.ts:1022-1040`). ADR 0068 projects both
  into one inbox and forbids a third state owner (`host/reviewProjection.ts:1-19`).
- **One eligibility authority.** `host/approverResolution.ts`
  (`resolveEligibleApprovers :61`, `resolveNotificationRecipients :137`,
  `isEligibleApprover :175`, `consumeVoteIdentity :241`); delegations join there
  only (`host/approvalDelegations.ts:1-25`, ADR 0198); quorum ledger
  `host/reviewDecisionLedger.ts:80`; separation of duties
  `host/approvalSelfCheck.ts:32`.
- **SLA ladder** `host/approvalSla.ts:34-45, 122` — **per tenant, PendingApprovals
  only**. Gate interrupts have only an expiry (`executor/approvalGateTimeout.ts:1-24`),
  which RFC 0093 makes a **rejection**: auto-approve on timeout is non-conformant.
- **Who may see an approval**: `host/approvalAudience.ts:75, 157, 204`.
- **Notifications**: `notifications/emitter.ts:303` (`getNotificationEmitter`),
  `host/emailApprovalDelivery.ts`, `host/teamsApprovalDelivery.ts`,
  `notifications/webPush.ts`; addressed escalation `host/escalationNotify.ts:29`.
- **Run-start freezing**: `host/runStartContext.ts:66-110` (ADR 0099 seam;
  merge never overwrites; `derivedFromRun` ⇒ contribute nothing, `:26-45`).
  Reserved keys `host/runDispatch.ts:81`; caller attribution strip `:94-104`.
- **Fork/replay of gates**: never re-executed, inherited deadline
  (`executor/forkInterrupts.ts:1-28`); replay derives the decision from the
  source (`executor/forkReplayResolutions.ts:1-25`, RFC 0223).
- **Side-effect classification is manifest-derived, never config**
  (`executor/sideEffects.ts:1-30`: "config could lie a node pure").
- **Waiting on an external record**: `ctx.suspend({kind:'external-event', key,
  correlation})` after a claim-before-send (`features/claude-code/tasks.ts:178-190`).
- **Audit**: `appendAudit` (`host/auditChainService.ts:188`), hash-chained.
- **Gate type list**: `host/approvalGateTypeIds.ts:20-28`.

**Gaps:**

| Gap | Evidence | Consequence |
|---|---|---|
| G1 No campaign axis | governance is per tenant, agent policy per agent, `ClientAccount.approvalPolicy` per client and one action | "Autopilot for campaign A, review everything for campaign B" is inexpressible |
| G2 No "auto" for an in-graph gate | `core.approvalGate` always suspends | HITL level is a graph edit, not a setting |
| G3 Action class is not declared by nodes | node-pack `PackNode` is `additionalProperties:false` (`schemas/node-pack-manifest.schema.json`); roles only (`side-effect`, `action`, …) | No way to know which node is a budget move vs a send without hard-coding |
| G4 SLA only per tenant, only PendingApprovals | `approvalSla.ts:34-45` | No per-campaign or per-gate SLA; interrupts never remind or escalate |
| G5 Effects reachable outside chokepoints | `packs/vendor.myndhyve.ads-publish-meta/pack.json` (`net.outbound` + secrets); `examples/connection-packs/meta-ads/pack.json:53` (no `adapterOnly`) | A policy enforced only at `adsAdapter` can be bypassed by a pack |
| G6 Child runs lose reserved metadata | `executor/subWorkflowDispatcher.ts:298` strips reserved keys | A sub-chain would re-resolve policy live, diverging from its parent |

## Decision

### D1 — Action classes (closed vocabulary, the ADR 0036/0028 namespace)

| Class | Effect | Enforcement chokepoint (one per class) | Decision lane |
|---|---|---|---|
| `creative.generate` | model/media generation (drafts, never external) | media budget (`governanceService.ts` `mediaBudget`) | interrupt |
| `plan.approve` | accept a plan/kernel/brief output as the basis for spend | the gate node itself | interrupt |
| `creative.review` | one stage of staged creative review (ADR 0947: `internal` → `compliance` → `client`); the gate's config carries `stage`, and rules may differ per stage | the gate node itself; the effect classes after it still check their own chokepoints | interrupt (`client` stage: an ADR 0958 `client-stakeholder` collaborator with a `decide` grant, reached by a grant-backed link or the ADR 0957 portal) |
| `content.publish` | publish a CMS page / funnel step | CMS publish (`content-publish` kind) | PendingApproval `content-publish` |
| `ads.publish` | create ad entities (created PAUSED) | `adsAdapter.ts:1521` | PendingApproval `campaign-spend` |
| `ads.launch` | start delivery (spend begins) | `adsAdapter` (op added by ADR 0952) | PendingApproval `campaign-spend` |
| `ads.budget` | change a budget / reallocate | `adsAdapter.ts:1417` | PendingApproval `campaign-spend` |
| `email.campaign-send` | bulk email send | ADR 0905 send (`email-campaign-send` kind) | PendingApproval `email-campaign-send` |
| `sms.send` | outbound SMS | `host/smsAdapter.ts` | interrupt |
| `social.post` | publish a social post | ADR 0953 adapter | interrupt |
| `experiment.promote` | promote a winner / shift traffic | the `apply-ramp` node of ADR 0950's `experiments.promote` chain; today's `promoteExperiment` (`pageExperimentsService.ts:436`) reads no results and is retired behind this gate | interrupt; `content-publish` when the org's CMS approval gate is on (D5 precedence) |
| `lead.contact` | first automated outbound touch to a lead (SMS, email or call) | ADR 0954 D9 outbound path, after ADR 0955's channel eligibility | interrupt |
| `lead.grade-adjust` | apply an AI band adjustment (`bandAdjustment ≠ 0`) to a lead grade | ADR 0954 `feature.crm.nodes.grade-lead` (the `LeadGrade` CAS write) | interrupt |
| `journey.publish` | publish a lifecycle-journey version (pinned templates + audience definition) | ADR 0955 D8 journey publish in `campaign-journeys` | PendingApproval (kind `journey-publish`, added by ADR 0955) |
| `email.resume-sending` | resume marketing sends for a sender paused by the deliverability breaker | ADR 0955 D7 breaker resume in `features/email` | PendingApproval (kind `email-sending-resume`, added by ADR 0955); the validator refuses `auto` and `notify-after` for this class |
| `report.publish` | publish a client report (snapshot + narrative) to its audience | ADR 0957 `publish-report` node (CAS on `snapshotHash`) | interrupt |
| `asset.accept-vendor` | accept a vendor intake into the DAM so pipelines can use it | ADR 0958 D5 intake accept (`pending → accepted` CAS) | PendingApproval (kind `asset-intake-accept`, added by ADR 0958) |
| `vendor.engage` | assign work to an external collaborator | ADR 0958 `feature.campaign-ops.nodes.assign-vendor-task` | interrupt |
| `playbook.rollout` | start or advance a playbook rollout across clients | ADR 0959 `rolloutService` start and per-client apply | PendingApproval `playbook-rollout` (ADR 0959 D7) |
| `campaign.change-set.apply` | campaign-ops write (ADR 0925) | ADR 0924/0925 | PendingApproval `campaign-change-set` |

> **CORRECTED 2026-10-20 (ruling for ADR 0948 P1b): `content.publish` has TWO
> chokepoints.** Pages → PendingApproval `content-publish`; a funnel →
> PendingApproval `funnel-publish` (owned by funnels, pinned to a digest of slug,
> steps, offers and `campaignId`). Publishing a funnel is its own external effect:
> it is what makes its order bumps and one-click offers chargeable, so the
> per-page rows do not cover it. Same action class, so the vocabulary and every
> preset are unchanged.
> - **The policy decides through `enforceCampaignAction`, not the decide handler
>   alone.** Inside a campaign run, `auto` / `notify-after` publish through the
>   SAME publish function the decide handler calls (one publish path, then the
>   notice after the effect); `approve` queues `funnel-publish` with the policy's
>   approvers (`createFunnelPublishApprovalOnce(…, policy)`); `blocked` refuses.
>   Outside a campaign run (no stamp) the funnels posture stands: always approve.
> - The `step_pages_unpublished` precondition holds on every outcome, so "the
>   owning kind wins" holds: a funnel never publishes its own pages.
> - A waiting node resumes through `resumeRunsAwaitingApproval` (P3a), never a
>   second resume path.


**Twenty classes.** The last seven rows before `campaign.change-set.apply` were
requested by ADRs 0954, 0955, 0957, 0958 and 0959 during program review. Those
ADRs use these exact spellings. A PendingApproval-lane class whose kind does not
exist yet is added by the ADR named in its row, never by this one.

`email.campaign-send` is deliberately not the assistant's `email.send` (one
message). A new class is a code change to this table plus its chokepoint; there
is no free-form class.

### D2 — Policy model and where it lives

`host/autonomyPolicy/` (host, because the chokepoints — `adsAdapter`,
`smsAdapter`, `approvalDecision` — are host modules and must not import a
feature; the ADR 0028/0036 placement). Routes and UI live in
`features/campaign-orchestration` (campaign override) and
`features/campaign-ops` (client default, beside `ClientAccount`).

```ts
type Outcome = 'auto' | 'notify-after' | 'approve' | 'blocked';  // severity order: blocked > approve > notify-after > auto
type RiskFact = 'spendMinor' | 'spendDeltaPct' | 'audienceSize' | 'findingsCritical'
  | 'findingsHigh' | 'regulatedCategory' | 'confidence' | 'firstForDestination';
interface Condition { fact: RiskFact; op: '>=' | '>' | '<=' | '<' | '==' | 'in'; value: number | boolean | string[] }
interface ApproverSpec {
  roleRefs?: string[]; groupRefs?: string[]; subjectRefs?: string[];  // ADR 0075, resolved on the CLIENT org
  clientApprover?: boolean;            // an ADR 0958 client-stakeholder `decide` grant (ADR 0924 D5's token store is replaced); v1 only on campaign.change-set.apply
  requiredApprovals: 1 | 2 | 3; rejectionPolicy?: 'any' | 'majority';
  // Per-party quorum: when set, approval needs `min` votes from EACH listed party, and
  // requiredApprovals is the total. A bare count never stands in for "one of each".
  perParty?: Array<{ party: 'agency' | 'client'; refs: 'roleRefs' | 'clientApprover'; min: 1 | 2 }>;
  delegation: 'allowed' | 'none';      // ADR 0198
  sla?: { remindAfterMs?: number; escalateAfterMs?: number; expireAfterMs?: number }; // expire = reject
  escalateTo?: { roleRefs: string[] };
}
interface NotifySpec { roleRefs?: string[]; subjectRefs?: string[];
  channels: Array<'inbox' | 'email' | 'teams' | 'push'>; digest: 'immediate' | 'daily';
  // Optional veto window (ADR 0950): the effect waits this long after the notice; a veto by a
  // notified role within the window rejects it. Silence proceeds. Minimum 1 h when set.
  vetoWindowMs?: number }
type Decision =
  | { outcome: 'auto' } | { outcome: 'notify-after'; notify: NotifySpec }
  | { outcome: 'approve'; approver: ApproverSpec; notify?: NotifySpec }
  | { outcome: 'blocked'; reason: string };
interface ActionRule { actionClass: ActionClass; stage?: 'internal' | 'compliance' | 'client'; // creative.review only
  default: Decision;
  escalations?: Array<{ when: Condition[] /* AND */; then: Decision }> }  // first match wins
interface AutonomyPolicy {             // immutable per version
  tenantId: string; policyId: string; version: number; name: string;
  basePreset?: 'review-everything@1' | 'guarded@1' | 'autopilot@1';
  rules: ActionRule[];                 // one per class; a missing class ⇒ preset ⇒ 'approve'
  hash: string;                        // sha256(canonicalJSON(rules)), the replay identity
  createdBy: string; createdAt: string;
}
interface AutonomyBinding {            // which policy a client or campaign uses
  tenantId: string; orgId: string; campaignId?: string;  // absent ⇒ client default
  policyId: string; version: number; updatedBy: string; updatedAt: string;
}
```

- Stores: `DurableCollection('autonomy:policy')` keyed `tenant::policyId::version`
  (append-only); `DurableCollection('autonomy:binding')` keyed
  `tenant::orgId::<campaignId|*>`, compare-and-swap updated.
  `MarketingCampaign.autonomy` (ADR 0941 D1) mirrors the campaign binding for
  display; the binding row is authoritative.
- **Validation is closed-world:** known class, fact and op; a value of the
  fact's type; and **an escalation may only be at least as severe as its
  rule's default** — thresholds tighten, never loosen. No expression language.
- **Resolution order at run start:** campaign binding → client-org binding →
  `review-everything@1`. A new client's binding is created as `guarded@1`
  (David, 2026-10-19); `review-everything@1` remains the fallback when no binding
  resolves, so an unbound or unstamped run is never looser than Guarded.
- **Presets** are versioned code constants (numbers approved by David 2026-10-19, Q1):
  - *Review everything*: `creative.generate` auto; every other class approve(client-org admins).
  - *Guarded*: generate auto; `plan.approve` and `creative.review` (every stage) approve; `content.publish` notify-after,
    escalate to approve when `findingsHigh>=1` or `firstForDestination`;
    `ads.budget` auto when `spendDeltaPct<=10` and `spendMinor<50_000`, else approve;
    `ads.publish` notify-after; `ads.launch`, `email.campaign-send`, `social.post`,
    `experiment.promote` approve; `lead.contact` notify-after.
  - *Autopilot*: all auto/notify-after except `creative.review` stage `client` (approve), escalating to approve on
    `spendMinor>=200_000`, `audienceSize>=50_000`, `regulatedCategory==true`,
    `findingsHigh>=1`, or `firstForDestination`.
  - The seven classes added in review (`lead.grade-adjust` … `playbook.rollout`)
    are `approve` in every preset; `email.resume-sending` can never be looser
    than `approve`.

### D3 — Composition: the campaign policy is one input, most restrictive wins

The resolver is pure (`resolveCampaignAction(frozen, actionClass, facts, live) →
{decision, ruleId, reasons[]}`) and returns the **most severe** of:

1. **Hard floors (not configurable):** a `block` finding from content rules
   (ADR 0933 D5) → blocked; client `mode:'preview'` or `status!=='active'`
   (ADR 0921/0926) → blocked; the owner's unconfigured-vendor state → its own
   typed failure (never "auto"). **Product fidelity (ADR 0945)**: a fidelity verdict
   of `needs_review` on any asset the effect carries → approve, **even on
   Autopilot**. `fail` → blocked. Decided here as a non-overridable floor,
   because an AI image that misrepresents the real product is the incident class
   (Meta Advantage+ silent swaps) the program exists to prevent. The D10 rules are
   floors too.
2. **Tenant ceiling** — ADR 0028 governance, read exactly as each chokepoint reads
   it today (`adsAdapter.ts:300-306`): `disabled` → blocked, threshold → approve.
3. **The node's bound agent** (applies once ADR 0943 P0 freezes bindings; until
   then the layer is skipped, and since it only ever tightens, skipping it never
   loosens the other layers) — `permissions.never` → blocked, `hitl` → approve
   (the ADR 0775 P3b "explicit rules only" posture; the autonomy level and
   `withinPolicyActions` stay heartbeat-only). "Bound agent" means the binding
   **ADR 0943 freezes at run start** (its per-client override stamp), never node
   config read live: today `host/agentRunnerNode.ts:65-98` lets run inputs win
   over a node-pinned `agentId`, so node config is not a trustworthy source. The
   agent profile's `never`/`hitl` lists are read from that frozen binding.
4. **The frozen campaign policy** (D4), rule default then escalations.
5. **Live tighten-only overlay** — campaign `paused`/`archived`, an agency
   emergency halt flag. Read live; may only raise severity.

The campaign policy therefore can **never loosen** a tenant ceiling, an agent's
explicit rules or a floor. This keeps ADR 0028's "configure the enforcement points
that already exist; never a second evaluator" and ADR 0036's most-restrictive law.

### D4 — Frozen at run start, stamped for replay and fork

- A run-start contributor registered by `campaign-orchestration` reads the
  host-written `campaignOrchestration.campaignId` (ADR 0941 D2; never caller
  metadata) and stamps **`run.metadata.campaignAutonomy`** = `{policyId, version,
  hash, source:'campaign'|'client'|'default', rules, resolvedAt}` — the compiled
  rules inline, so replay never depends on the policy row surviving.
- `campaignAutonomy` joins `RESERVED_RUN_METADATA_KEYS` (`runDispatch.ts:81`).
- The contributor contributes nothing when `derivedFromRun` (`:fork` copies the
  parent's stamp verbatim, present or absent).
- **Child runs (G6):** `RunStartContext` gains `parentRunId`; the contributor
  copies the parent's stamp verbatim. A child whose parent stamp is unreadable
  gets `review-everything@1`.
- **Fail closed:** contributors are fail-soft (`runStartContext.ts:12-14`), so a
  campaign-bound run with **no** stamp resolves as `review-everything@1`, never
  as "no policy".
- **Policy edits never change a running campaign's ceiling upward.** Tightening
  reaches in-flight runs only through D3 layer 5; loosening applies to runs
  started after it. Replaying a decision shows the policy it ran under.
- Every non-gate decision is recorded in the deciding node's output; gate and
  effect nodes are side-effect-served on replay (`executor/sideEffects.ts`), so a
  replay re-derives nothing from the live overlay.

### D5 — One gate primitive, two existing lanes, no third owner

> **No resume path on `campaign-change-set` (a0, 2026-10-19).** That PendingApproval
> kind gates no waiting run. Its decide handler starts the ADR 0925 execute chain
> after its own CAS, so `resumeRunsAwaitingApproval` is a no-op for it today. If a 0942
> `autonomy-gate` ever suspends on this kind, the gate must NOT also start execution
> on resume: exactly one path starts the execute chain, the decide handler. Adding a
> second one double-executes a change set.

**The gate node** `feature.campaign-orchestration.nodes.autonomy-gate`
(config `{actionClass, factsFrom?}`; role `gate`; added to
`APPROVAL_GATE_TYPE_IDS`) calls `ctx.features['campaign-orchestration']
.autonomy.resolve({actionClass, facts})`, which reads the run's stamp server-side
(never a policy from args):

| Outcome | Interrupt-lane class | PendingApproval-lane class |
|---|---|---|
| `auto` | success `{decision, ruleId}` | same |
| `notify-after` | success; notice emitted on the chokepoint's success, or by the gate when the class has no chokepoint (`plan.approve`) | same |
| `notify-after` with `vetoWindowMs` | suspends as `kind:'approval'` with `data.autonomy.veto = {deadline}`; the sweep resolves it as approved at the deadline unless a notified role vetoed (then failure `autonomy_vetoed`). The deadline is frozen at suspend, so a fork inherits it | same, via the owning kind's approval with an auto-approve deadline |
| `blocked` | failure `autonomy_blocked` (typed, `retryable:false`, reason) | same |
| `approve` | **suspends as `kind:'approval'`** with exactly `core.approvalGate`'s `interrupt.data` fields compiled from `ApproverSpec`, plus `data.autonomy = {actionClass, ruleId, policyHash, factsDigest, sla}` | calls the owning kind's existing `create…Once` with `policy` compiled from the same `ApproverSpec`, then `ctx.suspend({kind:'external-event', key:'approval:'+approvalId})` (the claude-code precedent) |

One compiler (`compileApproverSpec`) produces both the `ApprovalPolicy` and the
interrupt fields, since they share names. **State stays in its owner:** the
interrupt store for interrupt-lane classes, the approval row for kind-backed
classes — the kind's decide-time checks (hash binding, staleness, separation of
duties — ADRs 0905 D3, 0924 D2) stay the authority. The ADR 0068 projection shows
each decision once. For the PendingApproval lane, the kinds' `KIND_DISPATCH`
finalizers call one shared helper, `resumeRunsAwaitingApproval(approvalId,
outcome)`, after their CAS.

**Chokepoints are mandatory; the gate node is optional.** Each chokepoint in D1
calls the same resolver with its **real** facts (amount, audience estimate,
content-rules report). If the outcome is `approve`:
- PendingApproval lane: today's behaviour — find an approved row by the
  fork-stable key (`adsAdapter`'s `spendKey`) or open one; the effect node waits
  as above.
- Interrupt lane: proceed only if this run holds a **covering grant** — a
  resolved approval of an `autonomy-gate` for the same class whose `factsDigest`
  covers the real facts (same content hash; amount ≤ approved amount; audience ≤
  approved size). Otherwise refuse `autonomy_approval_required` and the chain's
  gate re-asks with the real facts.

**Precedence: one gate per effect, the owning kind wins.** When an effect's
owner already enforces its own approval gate (the CMS approval gate on
`content.publish`, ADR 0905's `email-approval-gate` on sends), the policy decides
only **who** approves and **whether** stricter rules apply. It never adds a
second approval on top, and it never downgrades the owner's gate to `auto`. So
with an org's CMS approval gate on, `experiment.promote` cannot be `auto`. The
promote goes through the `content-publish` row, matching ADR 0950's refusal of
full-auto promotion in those orgs.

A mis-declared or missing gate node can therefore delay an approval, never skip
one. Placing gates early (before expensive generation) is a UX choice, not a
safety mechanism.

### D6 — How nodes declare their action class (no per-node hard-coding)

`PackNode` is closed (`additionalProperties:false`), so a manifest field would be
a wire change (see RFC verdict). Instead, the precedent of
`host/approvalGateTypeIds.ts` and `executor/sideEffectFloor.generated.ts`:
- `host/autonomyPolicy/actionClasses.ts` maps **typeId → actionClass | 'none'**
  for every node whose manifest role is `side-effect` or `action` and that is
  reachable from a Campaign Studio chain pack. The builder palette and the 0960
  cockpit read it to show which nodes are gated.
- A ratchet test walks the campaign-family chain packs (`examples/workflow-chain-packs/
  campaign-*`, `packs/feature.campaign-*.nodes`) and fails on any such node
  without an entry, sabotage-witnessed.
- Nodes that egress outside a chokepoint (`vendor.myndhyve.ads-publish-*`) are
  mapped `'refused'`: the chain loader refuses a campaign chain that contains
  them (closes G5 for this program; ADR 0941 P4 adds `adapterOnly`).

The table is for display and pre-gating. Enforcement never trusts it (D5).

### D7 — SLA, escalation, delegation, notification

- **SLA (G4).** `PendingApproval.policy.sla` (additive, per row) overrides the
  tenant ladder in `sweepApprovalSla` (`approvalSla.ts:122`). The same sweep gains
  a second source: open approval interrupts whose `data.autonomy.sla` is set
  (listed through the ADR 0068 interrupt scan). Rungs unchanged: remind →
  escalate (to `escalateTo` roles, else active delegates, else admins) →
  expire = **reject** `sla_expired` (RFC 0093; silence is never consent).
- **Delegation.** `delegation:'none'` becomes a flag on the approver refs read by
  `approverResolution.ts` only (the ADR 0198 single-resolver law). ADR 0854
  hand-offs stay limited to eligible people.
- **Notify.** `approve` notifies `approvalRecipients` (`approvalAudience.ts:204`)
  through the existing emitter and email/Teams/push deliveries;
  `notify-after` resolves `NotifySpec` through `resolveNotificationRecipients`.
  `digest:'daily'` batches through one scheduled chain per tenant, not a new loop.

### D8 — Audit and explanation

Every resolution with an external effect — **including `auto`** — appends
`campaign.autonomy.decision` to the tenant audit chain: `{campaignId, runId,
nodeId, actionClass, factsDigest, policyHash, ruleId, outcome, lane, layers}`,
where `layers` names which D3 input decided. "Why did this ship without me?" is
answered from the chain plus a replay of the run.

### D9 — Editing a policy

**Recovery correction (2026-10-21):** removing an override now CAS-replaces the
exact authorized binding with a retained inheritance marker. A stale editor
cannot delete an admin's concurrent tightening. Logical reads inherit the client
default with `etag: none` and no dangling-policy warning; a later save replaces
the physical marker through the existing CAS. Actual campaign/client deletion
still removes binding rows. Only the winning clear appends a policy-change audit;
as with policy saves, an audit error after the state CAS is surfaced and is not
claimed as a successful audit. This is not a transaction across the independent
client-default row. HTTP/storage-boundary race and repeated-clear witnesses are
added; execution and the canonical gate remain pending.

- Tighten (any change whose every class is at least as severe): `workspace:write`
  on the client org.
- Loosen: `host:members:manage` on the client org; audited; notifies the org's
  admins (Q2 asks whether it also needs a second person).
- Client default: agency admins. A campaign override cannot be looser than the
  client default unless an org admin makes it.
- **ADR 0924 D4 folds in:** `ClientAccount.approvalPolicy` becomes the
  `ApproverSpec` of the client's `campaign.change-set.apply` rule
  (`agency` → org `approvals:respond` roles; `client` → `clientApprover:true`;
  `client_and_agency` → both, with `perParty: [{party:'agency', refs:'roleRefs',
  min:1}, {party:'client', refs:'clientApprover', min:1}]` and `requiredApprovals:2`).
  The field stays readable until 0924's handler reads the rule; one migration writes
  the binding.

  > **Corrected 2026-10-19 (a0 review of #5033).** This line first said
  > `client_and_agency` → `requiredApprovals:2` alone. That does NOT mean "one client
  > and one agency": two agency members reach a quorum of 2 with no client vote. The
  > quorum is now per party, as above. `compileApproverSpec` refuses a
  > `client_and_agency` mapping (or any spec mixing `clientApprover` with role refs)
  > that carries a bare count without `perParty`. The decide path counts votes per
  > party from the quorum ledger. Required test: two agency votes on a
  > `client_and_agency` change set leave it **pending**, and one agency vote plus one
  > client vote approves it. ADR 0924 D4 takes the same correction (a0).

### D10 — Three approval-integrity rules and the fork posture

These are floors (D3 layer 1); no preset or policy can relax them.

1. **Every `approve` names role-based approvers.** `compileApproverSpec` refuses
   an `ApproverSpec` with no `roleRefs`/`groupRefs` (subject refs alone are
   allowed only alongside a role ref), and the policy validator refuses it at
   save. Reason: an approval interrupt that names no approver is decidable by
   any holder of its token, and the MCP MRTR lane resolves exactly those
   (`host/mcpSemantics.ts:298-323`: it refuses only gates where
   `needsNamedApprover(interrupt.data)` is true, `:321`). A gate with named
   approvers is sent to the inbox instead. A ratchet test also fails any
   `autonomy-gate` in a campaign chain pack whose config tries to set approver
   fields (approvers come from the policy only), and the chain loader refuses
   such a chain.
2. **No self-approval.** The requesting principals — the run's `actingUserId`,
   its `owner` (RFC 0165 stamp), and the principal that dispatched the node's
   agent — are passed as `submitters` to `selfApprovalBlockedCore`
   (`host/approvalSelfCheck.ts:32`) on both lanes. **The sole-approver escape is
   disabled for autonomy gates**: if no one else is eligible, the gate escalates
   (D7) and then expires as rejected. It is never self-approved.
3. **Runs started over MCP never cause an external effect unattended.** A run
   carrying the host-written MCP origin (`source:'mcp-server-mount'`,
   `trustBoundary:'untrusted'`, `host/mcpSemantics.ts:404`) gets `approve` as a
   floor for every class in D1 except `creative.generate`, `plan.approve` and `creative.review`.
   Rule 1 makes sure that approval cannot be given back over the same MCP lane.
   P1 confirms that both keys are host-written on every MCP start path, and
   reserves them if not. A caller who forges the marker can only make its own
   run stricter.
4. **`forkPosture`: a branch fork is attended.** A `:fork` with
   `forkMode:'branch'` (`host/forkModes.ts`) inherits the frozen stamp verbatim
   (D4). The stamp also gets `forkPosture:'attended'` (host-written, reserved).
   Under it, every external-effect class has `approve` as a floor, or `blocked`
   where the policy blocks it. Grants from the source run never count as
   covering grants (D5): only the fork's own gate resolutions do. ADR 0751
   re-creates the gates with fresh tokens, so the fork's effect nodes re-enter
   the gate and humans decide again with the fork's real facts. A `replay`
   fork is unaffected, because it serves recorded outcomes and creates no new
   effect (`executor/sideEffects.ts`, RFC 0223). **ADR 0960 keeps "fork from
   here" disabled until this rule ships (P1).**

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Host `host/autonomyPolicy/` (types, presets, resolver, compiler, stores, action-class table). Routes/UI in `features/campaign-orchestration` and `features/campaign-ops`. Core edits: one reserved key, `RunStartContext.parentRunId`, one gate typeId, the SLA sweep's second source, the delegation flag. |
| 2 | Toggle | New sub-toggle `campaign-orchestration.autonomy`, default **OFF**, `bucketUnit:'tenant'`, category Marketing: an `extraToggleDefaults` entry of `campaign-orchestration` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code). The campaign-ops client-default routes check the same id. OFF ⇒ no stamp, gate node behaves as approve (today's posture). A **stamped** run is resolved from its stamp regardless of the toggle (replay never reads toggles). |
| 3 | Workflow surface | `ctx.features['campaign-orchestration'].autonomy.resolve({actionClass, facts})` and `.explain({actionClass})`; both read the run stamp; org-checked. |
| 4 | Node pack | `feature.campaign-orchestration.nodes.autonomy-gate` (role `gate`). The orchestration chain's `kernel-approve` becomes `autonomy-gate {actionClass:'plan.approve'}`. |
| 5 | Envelopes | None. |
| 6 | Agent pack | Strategist gains read tool `campaign-orchestration.get-autonomy` (which steps need whose sign-off). No tool can set or loosen a policy or approve. |
| 7 | Public surface | None new; client approvers use ADR 0924 D5. |
| 8 | RBAC | D9; resolver fails closed; approver roles resolved on the client org. |
| 9 | Replay / fork | D4: frozen, reserved, verbatim on fork and into child runs; recorded outcomes served on replay; branch forks attended (D10.4). |
| 10 | Frontend | Policy editor on the campaign detail page (ADR 0941 D5) and client settings: preset picker, class × outcome grid, threshold rows, approver role pickers, an "effective policy" view naming which D3 layer decides; run timeline badges ("auto — rule ads.budget#1"). 4 locales. |

## Why this is our advantage

It is assembled from primitives only OpenWOP has: durable runs with replay/fork
(the stamp makes every decision replayable under the policy it ran with), human
gates as run steps with role routing, quorum, delegation and SLA (the ADR
0068/0070/0075/0198/0478 stack), named agents per node (agent rules composed in
D3), and the client-org tenancy of ADR 0921. It closes the scan's open gap — "HITL
configured per campaign by risk/spend/audience; role-routed gates as steps inside
agent runs" — that HubSpot (per play), Gumloop (per connector, no replay), Klaviyo
and Braze (one button) and GHL (no approval node) leave open.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0** | Types, presets, closed-world validator, pure resolver (D3), stores, toggle; REST `GET/PUT …/campaign-orchestration/campaigns/:id/autonomy` and `…/campaign-ops/clients/:orgId/autonomy-default` | Resolver table tests (floors, ceilings, tighten-only escalations); route tests for tighten vs loosen authority |
| P1 | Run-start contributor, reserved key, `parentRunId`, missing-stamp fail-closed, `forkPosture`, MCP-origin floor, and the MCP-marker reservation check (D10.3–4) | A fork after a loosen keeps the old policy; a caller-supplied stamp is stripped; a child inherits; a branch fork re-asks before every effect; an MCP-started run cannot auto-send |
| P2 | `autonomy-gate` node, `compileApproverSpec` (role refs required; no self-approval; no sole-approver escape), action-class table + ratchet, `kernel-approve` replaced | The gate's interrupt resolves through the unchanged review inbox and quorum ledger; an MCP `resumeInterrupt` on it is refused; the requester's own vote is refused |
| P3 | Chokepoints: `adsAdapter` (campaign-bound calls only, so non-campaign flows do not flip), CMS publish, ADR 0905 send, ADR 0950 `apply-ramp`, `smsAdapter`; `resumeRunsAwaitingApproval`; covering-grant check; ADR 0924 D4 fold-in | A budget move above the grant re-asks; an auto send is audited; preview client blocked |
| P4 | Per-row SLA, interrupt SLA sweep, `delegation:'none'`, notify-after + daily digest chain | Remind/escalate fire once each across instances; expiry rejects |
| P5 | Frontend editor, explainer, timeline badges | `npm run build`; a11y; 4 locales |
| P6 | Strategist read tool, prompt parity, ADR 0889 eval: the agent never proposes bypassing a gate | Eval green in the campaign scenario pack |

## Alternatives weighed

- **Keep gates as graph nodes only.** Rejected: HITL level becomes a graph edit
  per campaign, and a missing gate is a silent skip.
- **Policy in chain/node config.** Rejected: config can lie (the
  `sideEffects.ts` rule) and is per workflow, not per campaign.
- **A new `campaign-gate` approval kind for everything.** Rejected: a third lane;
  it would bypass the kinds' version-bound decide checks (0905, 0924).
- **Extend `GovernancePolicy`.** Rejected as the store (tenant-only axis); kept as
  the ceiling.
- **Gumloop-style CEL rules.** Rejected: unbounded, hard to validate and explain.
  A closed fact/op grammar covers the scan's risk inputs.
- **Live (unfrozen) policy.** Rejected: non-replayable. Tighten-only live
  overlay keeps emergency stops.

## RFC verdict

**Host extension, no RFC.** Stores, routes, a reserved run-metadata key, a
feature node, host tables. `interrupt.data.autonomy` is host-local data on an
existing interrupt kind. **A portable `actionClass` on `PackNode` would be a wire
change** (closed schema) and needs a new RFC in `../openwop` — optional, not a
blocker, and not recommended by the program; record it only if another host
wants to honour campaign policies. The program's one recommended RFC is ADR
0941 D9's RFC 0013 revision for a node `agent` field.

## Open questions

1. **(David)** Preset thresholds ($500 / $2,000 daily spend, 50,000 audience,
   10% budget delta) and the default for new clients (`review-everything`).
   (The fidelity floor in D3 is decided, not open. David may overturn it.)
   **Decided (2026-10-19, David): Guarded is the default for every new client, with the $500 / $2,000 daily-spend and 50,000-audience thresholds as proposed. Moving above Guarded needs passing evals (ADR 0961).**
2. **(David)** Does loosening a policy need a second person (proposer ≠ approver)?
3. **(David)** Should `:fork` offer "re-run under today's policy" as an explicit
   option, or is that always a new run? Proposed: always a new run.
4. Client approvers on classes other than `campaign.change-set.apply` wait for
   the ADR 0957/0958 portal; until then `clientApprover:true` is rejected there.
5. Should model/media cost be a risk fact for `creative.generate`? Proposed: P4.
6. Digest cadence and channels for `notify-after`.
7. **(David)** Should an MCP-started run ever be allowed `auto` for an external
   effect, for example under a tenant-level "trusted MCP client" grant?
   Proposed: no in v1 (D10.3).
   **Decided (2026-10-19, David): Never. An MCP-started run may never take `auto` or `notify-after` for an external effect; it is a D10 floor, not a policy setting.**
8. No `/architect` review has been invoked on this ADR yet.

> **Correction (2026-10-20, P2b — the org-scoped freeze).** As built through
> P2, the stamp required a `campaignId` and the contributor keyed only on the
> ADR 0941 campaign tag. So a run that acts for one CLIENT but no single
> campaign was unbound, and every gate in it fell to `legacy`: no policy and no
> approvers. That covers a client report across several campaigns
> (`report.publish`), lead grading (0954) and journeys (0955). Found by
> cs-0943 (ADR 0957 P1).
> - **Bound** now means the campaign tag OR the ADR 0921 campaign-ops client
>   stamp (`openwop-app.campaignOps.orgId`, host-written and in
>   `CAMPAIGN_ATTRIBUTION_KEYS`, so a caller cannot supply it) OR an autonomy
>   stamp.
> - A **client-bound run** is stamped by a campaign-ops contributor with the
>   client's default policy (`resolveEffectivePolicy(tenant, org)` with no
>   campaign) and `approverOrgId` = the client, so role-routed approvers resolve
>   on the client org. Its stamp has `orgId` and no `campaignId`.
> - **Precedence is unchanged.** A campaign-tagged run is the campaign arm's:
>   campaign override, then client default, then fallback. A tag and a
>   campaign-ops stamp naming different clients is refused `wrong_client`.
> - **No backfill write.** A client with no binding resolves to the stricter
>   Review-everything fallback, as `clientService` documents for a failed
>   creation-time bind. The contributor is a pure read; writing Guarded here
>   (`bindClientPresetIfAbsent`) would silently loosen that fallback for a client
>   nobody configured. This departs from the build request, deliberately.
> - **Fail-closed.** An unstamped client-bound run whose toggle is ON resolves
>   to the fallback at the gate, never `legacy`.
> - campaign-ops' own change-request and execution runs carry the client stamp,
>   so they are now stamped too. That is inert: their chains have no autonomy
>   gate.

## Implementation record

Built to the design as amended by #5038 (per-party quorum, new clients on
`guarded@1`, the MCP floor decided). `/architect` was run on each phase plan
before building it; its findings are folded in below.

| Phase | What shipped | Tests | Commit / PR |
|---|---|---|---|
| P0 | `host/autonomyPolicy/` (types, presets, closed-world validator, pure D3 resolver, strictness comparator, stores, policy-change service, subject eraser); sub-toggle `campaign-orchestration.autonomy` (OFF, tenant); `GET/PUT/DELETE …/campaign-orchestration/campaigns/:campaignId/autonomy`; `GET/PUT …/campaign-ops/clients/:orgId/autonomy-default`; `createClient` binds `guarded@1`; campaign and client delete cascade their bindings | `test/adr0942-p0-resolver.test.ts`, `test/adr0942-p0-routes.test.ts` (sabotage-witnessed; notes in each file header) | branch `feat/autonomy-0942-p0` |
| P1 | Run-start contributor (`features/campaign-orchestration/autonomyStamp.ts`) over the ADR 0941 run tag; reserved `campaignAutonomy` + `campaignForkPosture`; `RunStartContext.parentRunId` / `forkMode`; children inherit through the ADR 0941 inherited-metadata seam; redrive re-takes inherited stamps from the source row; `runAutonomyOf` reader (hash-verified, fail-closed); MCP origin carried in the stamp | `test/adr0942-p1-run-stamp.test.ts` (sabotage-witnessed) | branch `feat/autonomy-0942-p1` (built on 0941 P0) |
| P2 | `autonomy-gate` node (`feature.campaign-orchestration.nodes` 1.3.0, role `gate`, in `APPROVAL_GATE_TYPE_IDS`); `autonomyResolve` / `autonomyExplain` on the campaign-orchestration surface; host `decideGate`, `compileApproverSpec`, `factsDigest`; no-self-approval in `resolveAndResume` on every vote lane; D6 action-class table + real-loader ratchet; `kernel-approve` replaced (chain pack 1.2.0 + SSoT); campaign runs stamp `approverOrgId`; canvas-invoke children inherit | `test/adr0942-p2-autonomy-gate.test.ts`, `test/adr0942-p2-action-classes.test.ts` (sabotage-witnessed) | branch `feat/autonomy-0942-p2` (stacked on P1) |
| P2b | Org-scoped freeze (cs-0943's gap): a CLIENT-bound run (ADR 0921 campaign-ops stamp, no campaign) freezes the client's default policy. `FrozenAutonomy.campaignId` optional; `clientBoundOrg` + `runAutonomyOf.bound` count the client stamp; campaign-ops contributor `features/campaign-ops/autonomyStamp.ts` (pure read; precedence: a campaign tag is the campaign arm's); one `autonomyToggleOn` helper for both arms | `test/adr0942-p2b-client-bound-freeze.test.ts` (6, two witnesses + a measured redundant guard) | branch `feat/autonomy-0942-p2b` (stacked on P2) |

| P3a | `enforceCampaignAction` (the one chokepoint helper: run stamp + run floors + client floor and campaign status through seams + tenant ceiling; D8 audit of every bound external resolution); ads spend gate decided by the policy for campaign runs (governance threshold folded in as the ceiling; one approval row with policy approvers, requesters and the client org; attended forks namespaced); `campaign-spend` decide-time eligibility for policy rows; the waiter store + `resumeRunsAwaitingApproval`; `ad-budget-update` and `publish-ad-variants` wait on the row; `sms.send` chokepoint with the derived covering-grant check | `test/adr0942-p3-chokepoints.test.ts` (sabotage-witnessed) | branch `feat/autonomy-0942-p3` (stacked on P2, on #5035) |
| P4a | Per-row SLA ladders on PendingApprovals (`ApprovalPolicy.sla` / `escalateTo`, swept through the `approval:sla-row` index even with no tenant ladder; expire rejects `sla_expired` and resumes the waiting run); remind/escalate for autonomy gate interrupts (a second source in the same sweep, `autonomy:interrupt-sla`), expiry as the gate's own `timeoutMs` (the existing RFC 0093 timeout sweep); `delegation:'none'` as `allowDelegation:false`, read only by `approverResolution` through one refs builder (`gateApproverRefs` / `policyApproverRefs`) every lane now uses; notify-after notices after a successful effect (ads, sms) or at the gate (no-chokepoint classes), immediate or queued for the daily digest chain `campaign-autonomy.daily-digest` (chain pack, chain-backed, host-owned per-tenant job) | `test/adr0942-p4-sla-notify.test.ts` (sabotage-witnessed) | branch `feat/autonomy-0942-p4` (stacked on P3a) |
| P5 | The read model carries the class vocabulary and each class's effective rule (`actionClasses`, `effective` per class and review stage from the resolver's own `findRule`, `presets`); `AutonomyPolicyPanel` (lazy chunk) on the campaign detail and, as a modal, from the campaign-ops client bar: levels, a step-by-outcome grid with approvers and escalation thresholds, customize mode (outcomes, thresholds, approver roles), "use the client's default", the always-applies explainer; run-timeline badge `autonomyBadgeOf`; 4 locales | `test/adr0942-p0-routes.test.ts` (read model pinned to `findRule`), `frontend/react/src/features/campaign-orchestration/__tests__/autonomyPolicyPanel.test.tsx`, `frontend/react/src/runs/__tests__/runTimelineAutonomyBadge.test.tsx` (sabotage-witnessed) | branch `feat/autonomy-0942-p5` (stacked on P4a) |
| P6 | `openwop:campaign-orchestration.get-autonomy` (read, untrusted, fail-empty): the Strategist's projection of the SAME `describePolicy` read model (`host/autonomyPolicy/explain.ts` `projectPolicyForModel` + `ALWAYS_APPLIES`, keyed by the resolver's layer rule ids), through ONE access predicate shared with `GET …/campaigns/:id/autonomy` (`features/campaign-orchestration/autonomyAccess.ts`, a `{subject} \| {tenantPrincipal}` union); Strategist pack 1.3.0 (allowlist, prompt rewritten, `evalSuiteRef`); ADR 0889 suite `evals/campaign-strategist.json` (who signs off / asked to skip / asked to loosen) | `test/adr0942-p6-strategist-tool.test.ts`, `test/adr0942-p6-strategist-eval.test.ts` (pass script passes every task, violating script fails every task, each on a different axis), `src/features/campaign-orchestration/__tests__/promptCatalogParity.test.ts` (sabotage-witnessed) | branch `feat/autonomy-0942-p6` (stacked on P5) |
| P4b | The veto window: a notify-after decision with `vetoWindowMs` makes the gate wait on a TIMER (`reason:'duration'`), never an approval; one veto record per gate visit (`host/autonomyPolicy/veto.ts`, get-or-create, frozen recipients, CAS'd terminal states) and an immediate notice; the timer's resume reads it and fails `autonomy_vetoed` or proceeds `{vetoWindow:'elapsed'}`; only the timer sweep may end a window (session and MCP resolves refused); a chokepoint reached with a veto-window decision resolves to approve; `GET/POST …/campaigns/:id/vetoes[/:vetoId]` (recipients only, 404 to others, 409 when closed); a "Waiting out a review window" section on the campaign page (4 locales); eraser covers `vetoedBy` | `test/adr0942-p4b-veto-window.test.ts` (sabotage-witnessed), `frontend/react/src/features/campaign-orchestration/__tests__/vetoWindowsSection.test.tsx` | branch `feat/autonomy-0942-p4b` (stacked on P6) |

### Corrections found while building P4a (2026-10-20)

> **P4 is split at a conformance gate: the veto window moves to P4b, with ADR 0950.**
> As D5 wrote it ("the sweep resolves it as approved at the deadline unless
> vetoed"), the veto window is an auto-approve on timeout of an approval
> interrupt, and RFC 0093 forbids that.
> - **P4b's shape:** a **timer** wait plus a veto record. The step proceeds after
>   the timer unless a notified role vetoed; a veto fails it with
>   `autonomy_vetoed`. It is never an approval that silence approves.
> - **Why P4b:** ADR 0950 is its only consumer. Until P4b ships, a `NotifySpec`
>   with `vetoWindowMs` behaves as plain notify-after; the validator still accepts
>   the field.

> **D7, expiry as built:**
> - **Interrupt lane.** The expire rung is the gate's own deadline: `compileApproverSpec`
>   writes `timeoutMs`, and the existing gate-timeout sweep rejects it with
>   `timeout`. That makes one expiry path per lane; `timeout` is the RFC 0223
>   record-only reason.
> - **PendingApproval lane.** Rows with a per-row ladder reject with `sla_expired`
>   from the autonomy per-row pass. Before this, the tenant ladder never
>   auto-rejected `campaign-spend` (its reject has side effects). The pass then
>   resumes the waiting run, which fails its step.
> - **Ladder state.** It lives in two collections of its own (`approval:sla-row`,
>   `autonomy:interrupt-sla`), so the tenant ladder's prefix hygiene cannot delete
>   it.

> **D7, escalation as built:** the escalate rung goes, in order, to:
> 1. the `escalateTo` roles on the client org;
> 2. else the approvers' active delegates (never when delegation is off);
> 3. else the operator notice.

> **D7, delegation as built:** `delegation:'none'` compiles to
> `allowDelegation:false` on the interrupt data and on `ApprovalPolicy`.
> `resolveEligibleApprovers` is the only reader. Every place that built gate refs by
> hand (both vote lanes, the notification fan-out, the review projection, the
> decision core) now goes through one builder, `gateApproverRefs` or
> `policyApproverRefs`, so the flag cannot be dropped on one lane. While building
> it, `isEligibleApprover` rule 3 was found rebuilding refs without the flag; it is
> fixed and witnessed.

> **D7, notify-after as built:**
> - **Recipients.** The `NotifySpec` roles and subjects on the client org, through
>   the one resolver. Delegates of a named approver are included (ADR 0198
>   fan-out). If nobody resolves, nothing is sent; it is never a broadcast.
> - **Timing.** A notice is emitted only after the effect succeeds (ads `updated`
>   or `published`, SMS `sent`), or by the gate for a class with no wired chokepoint.
>   Never on a replay.
> - **Channels.** The inbox (`campaign.autonomy.notice`) plus device push. The
>   email and Teams deliveries carry approval types only, so those `NotifySpec`
>   channels are **not delivered yet**. That is a recorded residue, not a claim.
> - **The daily digest.**
>   - It is a chain (`campaign-autonomy.daily-digest`, an `internal` chain pack,
>     registered chain-backed same-id).
>   - It runs on a **host-owned** per-tenant schedule (`autonomy-digest:<tenant>`,
>     08:00 UTC, no acting person, gated on `campaign-orchestration` at fire time).
>     The schedule is registered when a saved policy first contains a daily
>     `NotifySpec`.
>   - It sends one notice per person per day, with a deterministic id, and deletes
>     the delivered items.
>   - Queued items are erased with the subject.

### Corrections found while building P3a (2026-10-20)

> **P3 is split at a real gate.** P3a is the chokepoints. P3b is the ADR 0924 D4
> fold-in: per-party counting on `decideChangeSet` needs the client vote identity
> (`client-approver:<id>`) that ADR 0924 P1 (#5043) introduces, and until it
> merges nothing records a client vote to count. P3b follows #5043, with the
> required test: two agency votes on a `client_and_agency` change set leave it
> pending, and one agency vote plus one client vote approves it.

> **D1 / D5, the chokepoints a run can reach today:**
> - **Ads:** `publishAd` (`ads.publish`, created PAUSED) and `updateBudget`
>   (`ads.budget`).
> - **SMS:** `sendSms` (`sms.send`).
>
> **What has no chokepoint yet, and why:**
> - **Launch.** There is no launch operation; ADR 0952 adds `setDeliveryStatus`,
>   and `ads.launch` is wired there.
> - **Email bulk send (ADR 0905) and CMS publish.** Neither is reachable from a
>   run: nodes may only draft or submit, and both are human routes.
> - **`apply-ramp`.** ADR 0950 is not built.
>
> Each calls `enforceCampaignAction` as soon as a run lane reaches it (ADR 0948,
> 0950, 0952, 0955). That keeps D7's sequencing rule ("nothing that creates an
> external effect ships before 0942 P3") enforceable by one helper rather than
> rebuilt per feature.

> **D3, the client floor and the live overlay come through seams.**
> `setAutonomyClientResolver` is registered by campaign-ops, the owner of
> `ClientAccount`. `setAutonomyCampaignStatusResolver` and
> `setAutonomyToggleResolver` are registered by campaign-orchestration.
> - The client floor applies only to an **agency client**, an org with a
>   `ClientAccount`. A campaign in an org that is not a client gets no client floor.
>   Before this correction, "missing" would have blocked every non-agency tenant's
>   campaign effects.
> - Neither seam is read on a replay.

> **D5, ads as built:**
> - **One decision for a campaign run.** The governance threshold is folded in as
>   the tenant ceiling, so a campaign run's spend gets one approval row.
> - **The row's contents.** It carries the policy's compiled approvers, the client
>   `orgId`, and the run's requester (`submitters`).
> - **Approvers narrow.** For campaign runs, a governance-threshold approval now
>   names the policy's approvers (default: the client org's owners and admins)
>   rather than any `approvals:respond` holder. That narrows and never widens.
> - **Non-campaign runs** keep exactly today's gate.
> - **Every budget change asks.** The adapter cannot see the old budget, so
>   `spendDeltaPct` is absent and every preset's spend-increase escalation fires. That
>   is honest and noisy. ADR 0952's approved caps are the route to "moves inside an
>   approved cap stay automatic". The delta is not derived from the dispatch
>   ledger, which is keyed by publish id, not campaign.
> - **Re-asking above the grant.** The spend key hashes the amount, so any
>   different amount opens a new approval. That is witnessed.
> - **Brand compliance stays separate.** The ADR 0354 compliance checker's findings
>   are not fed in as facts yet. Its own approval row (`cmpl:`) stays separate. An
>   absent `findingsHigh` already escalates, so nothing is loosened. Folding the
>   checker into the facts belongs with ADR 0945's fidelity verdicts, which enter as
>   a D3 floor.

> **D10.4, as built for spend:** fork-stable spend keys would have let a branch
> fork reuse its source's approved row, which is exactly what D10.4 forbids. Under
> the attended posture the key is namespaced by the fork's own run (`att:<runId>:`),
> so humans decide again. A replay fork never reaches the adapter, because it is
> side-effect served.

> **D5 / D10.2, the PendingApproval lane, as built:**
> - **Roles were not enforced before this.** `evaluateQuorum` finalized a
>   single-approver row without reading its approver refs. An eligibility check is
>   now registered for `campaign-spend`. It applies **only** to rows that carry
>   policy approver refs (rows the autonomy chokepoint writes):
>   - the decider must be eligible on the row's client org;
>   - the decider may not be the run's requester, **in either direction**. The
>     eligibility seam cannot see the verb, so a requester who wants to stop the
>     spend cancels the run.
> - **Rows without policy approver refs** keep today's rules. That is witnessed.
> - **Waiting runs.** A campaign run waits on its spend row: the core
>   `ad-budget-update` node and the `publish-ad-variants` pack node suspend on
>   `external-event` keyed `approval:<id>`.
>   - **Where the waiting is recorded.** In the waiter store
>     `autonomy:approval-waiter`, one row per waiting run, because a fork-stable row
>     can have several waiting runs.
>   - **What the decision does.** It calls `resumeRunsAwaitingApproval` after the
>     CAS. The node re-runs, and the adapter finds the decided row.
>   - **Non-campaign runs** keep their `requiresApproval` output.
>   - **A pack-side trap, found and fixed.** `publish-ad-variants` suspends outside
>     its catch-all, because the catch-all would have turned the suspend into a
>     failure. That is witnessed.

> **D5, forks inside a spend wait (found by grade-workflows):**
> - **The bug.** ADR 0751 re-creates a fork's open interrupt without re-running the
>   node, so the fork was never registered as a waiter. It stranded when the source's
>   approval was decided.
> - **The fix.** `executor/forkInterrupts.ts` registers the fork when the
>   re-created row is an `approval:` wait. On resume:
>   - a **branch** fork re-runs its chokepoint and asks for its own approval
>     (D10.4);
>   - a **replay** fork fails closed with `replay_source_missing`, because a replay
>     never fires a new effect.
> - **Residue.** A fork created after the approval was already decided is not
>   resumed. The operator cancels or re-runs it. A resume-on-recreate must not race
>   the executor's dispatch, so it is left to a follow-up.

> **D5, the covering grant is derived and not stored:** the run's event log names
> its resolved interrupts, and the interrupt row (the ADR 0068 owner) carries the
> gate's `data.autonomy` block. The gate now also records the `facts` it was asked
> on, plus an optional `contentHash` input.
> - **Coverage:** amounts and audience no larger, no new risk flag, and the same
>   content when the gate bound content.
> - **Forks:** a fork's grants are its own events.

### Corrections found while building P2 (2026-10-20)

> **D5 / matrix row 3, the surface shape:** `FeatureSurface` is a flat map, so
> the workflow surface is `autonomyResolve({actionClass, stage?, facts?})` and
> `autonomyExplain({actionClass, stage?})`, not `.autonomy.resolve`. Both read the
> run row server-side.

> **D5, as built:**
> - **Legacy posture.** An unbound run, or a bound run with no stamp while the
>   toggle is OFF, gets **exactly** today's open approval gate: no approver refs and
>   no `autonomy` block. A stamped run is never legacy.
> - **Notify-after.** `notify-after` returns success with the decision recorded. The
>   notice and the veto window are P4.
> - **PendingApproval-lane classes.** `approve` on such a class is a typed failure,
>   `autonomy_lane_unavailable`, until P3 builds that lane. The D6 ratchet forbids a
>   campaign chain from gating such a class meanwhile.
> - **The node's statuses.** It returns `failure` (the `NodeOutcome` spelling). A
>   rejection fails it with `autonomy_rejected`.

> **D2 / D5, the approver org:** gate eligibility resolves role refs against
> `run.metadata.approverOrgId` (ADR 0075 §D3).
> - The P1 contributor now also stamps it with the run tag's `orgId`, so approvers
>   are resolved on the **client** org.
> - A child derives it from its inherited stamp.
> - `decideGate` refuses (`approver_org_mismatch`) when the two disagree.
> - **A pre-existing gap, reported and not fixed here:** `POST /runs` lets a caller
>   supply `approverOrgId` whenever the host computes none, for example in a
>   multi-org tenant. That chooses the org whose roles approve the run's
>   group/role gates. Campaign runs are unaffected, because their tag cannot come
>   from a caller. ADR 0075 should reserve the key.

> **D4, replay:** the live tighten-only overlay is read only when the run is not
> replaying (`currentEffectContext().replaying`). The verdict is otherwise a pure
> function of the stamp and the facts. A paused campaign blocks a live gate, while
> a replay of the same gate reproduces its recorded decision. Both are witnessed.

> **D10.2, as built:** the check sits in `resolveAndResume` right after vote
> eligibility, so every lane passes through it: a bound user, a capability-token
> voter's `countAs`, and a delegate's `actedBy`.
> - **Requesters** are the run's `actingUserId` and its RFC 0165 owner. The agent
>   dispatcher's principal comes with ADR 0943's frozen binding.
> - **Rejecting is always allowed.**
> - **There is no sole-approver escape.** With the toggle on, a one-admin client
>   cannot approve its own campaign's kernel. That is D10.2 by design; P4's
>   escalation and P5's explainer must say so.

> **D6, as built:** the table covers 22 typeIds, including the three
> `vendor.myndhyve.ads-publish-*` nodes (`ads.publish.{meta,google,tiktok}`),
> mapped `refused`. "The chain loader refuses" is enforced as a real-loader ratchet
> over the committed campaign chain packs. A tenant-authored chain is not
> campaign-family by construction; its runtime cover is P3's chokepoints plus
> ADR 0941 P4's `adapterOnly`.

> **The P1 escape hatch is closed:** canvas-invoked children
> (`host/canvasSurface.ts`) now inherit the registered stamps from the parent row,
> like sub-workflow children.

### Corrections found while building P1 (2026-10-20)

> **D4, the stamp shape:** `run.metadata.campaignAutonomy = {v:1, policyId, version,
> name, basePreset?, hash, rules, source, campaignId, orgId, resolvedAt, mcpOrigin?,
> dangling?}`. The reader (`runAutonomyOf`) re-validates the rules and recomputes
> the hash. A stamp that does not verify counts as absent, so a bound run falls back
> to `review-everything@1`.

> **D4, binding and children:**
> - **Bound runs.** A run is campaign-bound when it carries the ADR 0941 run tag
>   (`campaignOrchestration.{campaignId, orgId}`) or a stamp. An unbound run gets no
>   campaign policy and keeps today's behaviour.
> - **Children.** `RunStartContext.parentRunId` exists, but a child does not
>   re-resolve. The ADR 0941 inherited-metadata seam (`host/inheritedRunMetadata.ts`)
>   copies the parent row's stamp and posture verbatim, and absence is inherited too.
>   The contributor contributes nothing when `parentRunId` is set.

> **D4, dangling tags:** a tag naming a campaign that is not under its org gets a
> fallback stamp (`source:'default'`, `dangling:true`), never "no stamp". That keeps
> the run explainable.

> **D10.4, as built:** the posture lives in its own reserved key,
> `campaignForkPosture:'attended'`. It sits beside the stamp and is not part of it,
> so the stamp stays byte-identical across a fork. It is set on a **branch** fork and
> on a **redrive**: a redrive re-executes nodes as a new run, so its effects are new
> too. The architect review found that redrive was not covered by the ADR.
> - **Belt and braces.** The reader also honours a live `run.forkMode === 'branch'`,
>   which catches a fork whose contributor failed.
> - **Redrive inheritance.** `routes/workflowDebug.ts` re-takes every registered
>   inherited stamp from the stored source row after `buildRunRecord` strips reserved
>   keys. That also fixes the same hole for ADR 0941's `campaignGoal`.

> **D10.3, verified:** `host/mcpSemantics.ts:404` is the only MCP run constructor,
> and it writes `source:'mcp-server-mount'` and `trustBoundary:'untrusted'` as a
> literal, with no caller merge. A source-pin test holds that. The stamp records
> `mcpOrigin:true`, so the floor survives into children, which do not carry
> `source`. A caller who forges the marker only makes its own run stricter. No new
> reservation was needed.

> **Open for P2, found by the P1 review:** only the sub-workflow dispatcher
> inherits. Canvas invoke (`host/canvasSurface.ts`) and the other child constructors
> build children with neither the tag nor the stamp, so such a child is unbound. P2's
> action-class ratchet must refuse non-inheriting child constructors in campaign
> chains, or the 0941 seam must be extended to them.

### Corrections found while building P0 (2026-10-20)

> **D2, presets: the ladder was not monotonic.** As written, *Guarded* was
> provably looser than *Autopilot* on four classes: `content.publish`,
> `ads.publish` and `lead.contact` escalate on fewer facts in Guarded, and
> Guarded's `ads.budget` allowed a ≤10% raise that owner decision 4 forbids
> Autopilot. Switching a campaign from Autopilot to Guarded would then have
> counted as a loosen. **Fix:** Guarded is built on Autopilot. Where Guarded is
> not plain `approve`, it keeps Autopilot's risk escalations as a prefix and
> appends its own tighter thresholds. The preset test proves
> review-everything ≥ guarded ≥ autopilot per class and stage with the D9
> comparator.

> **D2, presets: any spend increase needs approval in every preset.** This applies
> owner decision 4 (ADR 0941) to all three presets, not only to Autopilot, because
> a preset looser than Autopilot breaks the ladder. Pausing and cutting spend
> stay automatic. The 10% `spendDeltaPct` allowance is superseded until ADR 0952's
> approved caps provide "moves inside an approved cap". Guarded's $500 threshold
> stays as an extra escalation.

> **D2, presets are rowless.** A binding names a preset as `policyId:'preset:<name>'`,
> `version:<n>` and stores no policy row. The hash is computed from the code
> constant. Only custom rules get `autonomy:policy` rows. A binding that names a
> missing row or an unknown preset version resolves to `review-everything@1`, and
> the read model says `dangling:true`.

> **D2, operators: `in` is refused.** No `RiskFact` is string-typed, so a
> closed-world validator refuses `in` for every fact. Booleans take `==` only.

> **D2, missing facts:** a condition on a fact the caller did not supply is
> **true**. Escalations only tighten, so an unknown fails toward review. The
> resolver records `fact_missing:<fact>`. P3 chokepoints must therefore supply
> every fact they know, or Autopilot's risk escalations will ask every time.

> **D3, layer 1 and layer 5 scope:** the client-not-live floor, the MCP and
> attended-fork floors, and the live overlay (paused or archived campaign,
> emergency halt) bind **external-effect classes only**. Generation, plan
> approval and creative review still run for a preview client. Content-rules,
> vendor and fidelity floors apply to every class, because the caller supplies
> them only where they are relevant.

> **D3, layer 2 has three states, not two.** The resolver's ceiling input is
> `'none' | 'approve' | 'blocked'`. ADR 0028's `draft-only` is not an autonomy
> outcome; it stays the chokepoint's own posture (P3).

> **D3, ties:** on a severity tie the policy's own decision is kept, because it
> carries the policy's approvers and notify list. A floor that only matches it
> does not replace it with the default approver.

> **D1/D2, `MarketingCampaign.autonomy` is not mirrored yet.** The field belongs to
> ADR 0941 P1, which a peer is building. The binding row is authoritative and
> the GET returns it, so nothing reads the mirror. 0941 P1 adds the field.

> **D9, as built:**
> - **What "loosen" means.** It is decided by a conservative comparator:
>   anything not provably at least as strict, per class and stage after preset
>   fallback, is a loosen. This includes changing who approves, the SLA, the
>   quorum split, or dropping an escalation.
> - **Campaign overrides.** A campaign override is compared against both the
>   policy in force and the client default.
> - **Removing an override** (`DELETE`) is judged the same way.
> - **Client defaults.** Agency admins set them, in either direction.
> - **Notification.** A loosen is audited (`campaign.autonomy.policy-set` or
>   `…policy-cleared`) and notifies the client org's `owner`/`admin` holders by
>   addressed notice only. When recipients cannot be resolved it does **not**
>   broadcast to the workspace, because a client's policy is that client's
>   business.
> - **Concurrency.** A stale `ifMatch` (`<policyId>@<version>` or `none`) is a 409.
> - **Concurrency, residual.** The binding compare-and-swap covers only the scope
>   being saved. A campaign save compares against the client default read in the
>   same request, so a client-default tighten that lands between that read and
>   the campaign's CAS is not seen. This is bounded: only agency admins move the
>   client default, and every save is audited. Accepted.
> - **Gating.** The client-default routes AND-gate `campaign-ops`,
>   `campaign-orchestration` and the sub-toggle (ADR 0941 D5).

> **D10.1, as built:** an approver spec must name role or group refs, or set
> `clientApprover` (on `campaign.change-set.apply` only, Q4). A client approver
> is a grant-backed named stakeholder, not an open gate. Mixing `clientApprover`
> with role refs requires `perParty` for both parties (#5038).

> **Existing clients are not backfilled.** Only clients created after this ships
> are bound to Guarded; older clients resolve to `review-everything@1` (stricter)
> until an agency admin binds them.

### Corrections found while building P5 (2026-10-20)

> **The SPA derives nothing.** The first plan had the panel hold its own class
> list and work out each class's rule from the preset. The review moved both to
> the server. The GET routes return `actionClasses` and `effective`: per class,
> and per review stage for `creative.review`, the rule the resolver would find,
> and where it came from (`policy`, `preset` or `fallback`). The panel shows any
> class the server lists, including ones it has no label for, under "Other steps".
> It never predicts tighten or loosen. A refused save shows the server's
> `loosened` list.

> **A level is applied, not selected.** The plan saved a preset on radio change.
> Arrow keys move through a radio group, so a keyboard user would have saved
> every level they passed. A pick is now staged behind "Apply this level".

> **A customization keeps each row's approvers unless the person changes them.**
> The first build wrote the chosen approver roles onto every approval and notice
> in the policy. That silently changed who approves rows nobody touched. The
> roles are now rewritten only after the checkbox group is changed. Every rule
> is still sent (one per class and stage), because a custom policy is a full rule
> set.

> **Threshold values are editable in P5** (the plan deferred them). Only an
> escalation with one numeric condition gets an input. Compound or boolean
> conditions stay read-only, in plain language.

> **The badge is display-only.** It reads the gate's own outputs
> (`{decision, ruleId}` with the resolver's rule grammar) and its two failure
> codes, from the segment's terminal event. Any node that emitted the same
> outputs would get the same badge. That is accepted, because the badge grants
> nothing. A legacy-mode approval with no `ruleId` shows none.

### Corrections found while building P6 (2026-10-20)

> **The Strategist's prompt had been false since P2.** It said the first thing a
> person sees is the kernel approval and that "nothing proceeds until they approve
> it". P2 made `kernel-approve` the autonomy gate, so whether it waits is the
> policy's call. The prompt now says every gate follows the campaign's review
> policy, and tells the agent to read the policy before it says whether a step
> will wait. `promptCatalogParity.test.ts` pins that the unconditional claim is
> gone.

> **"The campaign scenario pack" is the Strategist's own ADR 0889 suite for now.**
> ADR 0927's scenario runner (`test/campaign-ops/scenarios/`) is its open P1, so
> the P6 exit ("eval green in the campaign scenario pack") is met by
> `evals/campaign-strategist.json`, run through the no-LLM lane as a pass/fail
> pair. The tasks move into 0927's runner when it lands.

> **One access predicate, typed so a missing user cannot mean owner.**
> `resolveEffectiveAccess` grants OWNER when no subject is given, so the shared
> helper takes `{subject} | {tenantPrincipal}` rather than an optional subject.
> The tool can only build `{subject}` (after its acting-user guard); the route
> maps a request with no user to `{tenantPrincipal}`, which is its existing
> behaviour made explicit.

> **The eval does not forbid starting a run when asked to skip approvals.**
> Starting the orchestration is legitimate (its gates still hold). The suite
> forbids reading nothing before answering, offering a way around the gate, and
> starting a run in answer to a loosen request.

### Corrections found while building P4b (2026-10-20)

> **The timer sweep resumes THROUGH `resolveAndResume`.** The plan assumed the sweep
> bypassed it. It CAS-claims the interrupt (`storage.resolveInterrupt`) and then
> resumes with `{preclaimed: true}` and `{elapsed: true, reason: 'timer'}`. The
> early-resolve refusal therefore exempts exactly that shape, which no session or MCP
> caller can produce. The first build refused the sweep too, and the window could
> never end.

> **Who may veto is decided by the eligibility resolver, not the notification one.**
> `resolveNotificationRecipients` answers `null` (broadcast) whenever it cannot map a
> subject. Used as an authorization check, that would have read as "anyone". The veto
> route uses `resolveEligibleApprovers` on the window's FROZEN notify spec, with
> canonical user-id matching, and fails closed on an empty spec.

> **A window this run cannot prove elapsed counts as vetoed.** On resume, a missing
> record, or one naming another run, fails the step (`veto_record_unreadable`); it
> never proceeds.

> **The window is at least one hour.** That is P0's validator floor for
> `vetoWindowMs`. A policy written below it fails the run's stamp check and falls
> back to `review-everything`, which is fail closed.

### Correction: `creative.review` gains an approvals-lane binding for the publish edge (ADR 0945, 2026-10-20)

> ADR 0945 D5's publish gate refuses AI product creative whose brand-accuracy
> verdict is `needs_review` unless a person approved publishing THAT asset at THAT
> verdict. It asks through `registerCreativeReviewApproval`. `factsDigest` cannot
> answer this, because it hashes risk numbers and cannot name an asset. So
> `creative.review` gains a binding on the approvals lane:
> - **Kind `creative-publish-review`**, bound to `sha256(tenant, org, asset,
>   verdict)`. Verdict ids are content-unique, so a new verdict is a new hash and
>   an old approval stops applying.
> - **Approvers** are the client policy's `creative.review` rule at stage
>   `compliance` when it says approve, else the default approver; a `needs_review`
>   always needs a person. The requester is a submitter and is refused (D10.2).
>   Eligibility is the P3a policy-row check, required for this kind (no named
>   approvers fails closed).
> - **Disposition `campaign-spend`.** The claim is the decision, and the gate
>   re-checks.
> - **The check is a point read** of a binding index (`autonomy:creative-review`),
>   re-verifying every field on the approval row. Approvals are never scanned.
> - **Request route:** `POST …/campaign-orchestration/creative-reviews`. The org is
>   resolved from the asset; only an org writer may ask; every other refusal is
>   one 404.
> - **Code:** `features/campaign-orchestration/creativeReview.ts`. **Test:**
>   `test/adr0945-creative-review-binding.test.ts`, end to end through the real gate.
> - **Not yet:** the ADR 0947 review-stage node that asks automatically.

## Planning rows

**ROADMAP (Campaign Studio program, Tier 0, order 2):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| 2 | **Campaign autonomy policy** ([ADR 0942](docs/adr/0942-campaign-autonomy-policy.md)): per-campaign HITL by action class and risk (auto / notify-after / approve(role, quorum, SLA, delegation) / blocked), client default + campaign override, frozen at run start, one gate over both approval lanes, enforced at every chokepoint, audited | `campaign-orchestration.autonomy` (new, OFF, tenant) | 0941, 0028, 0036, 0068, 0070, 0075, 0198, 0478, 0924 | `feature.campaign-orchestration.nodes.autonomy-gate` | Host extension (portable `actionClass` would need an RFC; optional) | 🔵 Proposed |

**FEATURES "Future features" row:**

- **Campaign autonomy policy (ADR 0942, Proposed 2026-10-19)** — each campaign
  says how much HITL it needs: per action class (generate, publish page,
  publish/launch ads, budget change, email/SMS send, social post, promote winner,
  contact lead, lead grade adjustment, journey publish, sender resume, report
  publish, vendor intake and engagement, playbook rollout, campaign-ops change;
  twenty classes) the outcome is auto, notify-after, approve
  (client-org roles, quorum, SLA, escalation, delegation) or blocked, tightened by
  spend, audience, regulated-content and novelty thresholds. Presets: Review
  everything, Guarded, Autopilot. Frozen into the run at start and replayable;
  never looser than tenant governance or the agent's own rules. Toggle
  `campaign-orchestration.autonomy` (OFF, tenant). No RFC.

Recovery correction (2026-10-21): subject erasure re-reads each binding or immutable policy row after a lost CAS, preserves concurrent policy changes, and reports a retryable failure after bounded contention. A lost CAS is never reported as complete erasure. The content hash and policy/version identity remain unchanged.

Recovery correction (2026-10-24): requester identity aliases are denial-only and checked before approver eligibility as well as after delegation resolution. A resolved legacy autonomy gate retains its original posture on re-entry after the feature toggle changes; fresh gates still use the current fail-closed resolver. Spend-cap enforcement is classified as internal safety tightening: its adapter may pause delivery, never launch or increase spend. Targeted executor, requester-key and action-class witnesses cover these composition seams.


## Recovery integration checkpoint (2026-10-25, unvalidated)

The original P3–P6/P4b ancestry is retained with current main. Current campaign
client/causal membership guards, canonical campaign and link reads, binding
erasure CAS and ad-launch one-attempt claims are preserved. The prototype's
unbound launch fast path is not restored: starting paid delivery retains the
host's single-use human approval ceiling, including when a frozen campaign
policy is more permissive. No automatic vendor-launch grant is invented.

The Strategist keeps both campaign and autonomy reads, for four tools rather
than either branch's three. Its changed pack is versioned 1.4.0. New review/veto
controls compose into the existing keyed CampaignDetailPage; the removed inline
detail and stale ledger state owner are not resurrected. The shared host toggle
predicate remains the only owner. These source resolutions are not validation.

Before release: regenerate derived pack/floor/parity/census metadata, verify
current causal self-approval exclusions and terminal approval/fork wakeups,
review timer-only veto admission/publication, then run bounded focused and full
canonical gates. Earlier phase tables and assessments are inherited source
records, not claims that this recovery has passed those checks.


### Recovery review corrections — 2026-10-25 (validation pending)

These corrections preserve the original phase record above. The recovered
P3/P4/P4b/P6 source is not release-qualified until its focused tests and the
canonical app gate pass.

- The current host ceiling still requires a person’s single-use approval before
  `ads.launch`; campaign autonomy never bypasses the existing pre-write claim,
  account/currency/cap checks, or uncertain-outcome refusal.
- A campaign spend approval now references its originating run through the
  host-only `autonomySourceRunId`, distinct from the claim-started `runId`.
  Decide-time checks use the existing `isAutonomyRequester` identity authority
  for the actor (else causing member), delegated aliases, and RFC 0165 owner.
  Every run sharing a pending approval is checked through the existing waiter
  rows. Causes only deny a vote and acquire no notification/credential authority;
  the existing `submitterCauses` field is scrubbed by the campaign-spend eraser.
- The spend-map content key is additionally scoped to the frozen policy,
  client org and effective approver requirement. An older one-person approval
  cannot discharge a later two-person requirement for the same provider payload.
- A finalizer that arrives before the interrupt is persisted keeps its waiter.
  A bounded rotating pass in the existing dispatch daemon checks durable open
  interrupts against terminal owning approvals and uses `resolveAndResume`.
  This also addresses the already-decided-fork residue recorded above, without
  another daemon, queue, approval engine, or direct executor call.
- Veto closure checks the owning run before any write and refuses an unelapsed
  deadline. A contended veto attempt checks the clock again before retrying;
  subject erasure retries and reports exhaustion rather than silently leaving
  attribution behind. Erasure removes the vetoer’s free-text reason too.
- The frozen veto notification spec retains role references; membership is
  resolved at veto time so revoked roles provide no authority. The autonomy
  gate retains its gate role and declares the existing `side-effectful`
  capability so a completed replay serves its recorded outcome rather than
  opening another veto window or sending another notice.
- The canonical keyed CampaignDetailPage owns the editor and veto list. The
  Strategist keeps its existing get-campaign tool alongside get-autonomy,
  status and run; the prompt and allowlist describe all four.

- A veto window cannot elapse until every addressed notice is durable. The
  existing single-notice emitter receives deterministic per-recipient IDs;
  retries fill missing notices, and the veto record records acknowledgement.
  A swallowed best-effort batch failure or an unresolved recipient never
  authorizes a timed step. An unacknowledged window past its deadline fails
  closed and requires a new run rather than promising retroactive review time.
- The policy editor also owns state by campaign/client identity. Changing
  clients drops the previous draft and etag before a save is possible, and
  responses from an unmounted client cannot overwrite the current editor.

- The gate and paid-effect chokepoints share `autonomyOrgOf`: malformed or
  conflicting host-owned scopes cannot resolve approvers tenant-wide. Client-only
  stamps never call the campaign-status resolver with an absent campaign ID.
  A deleted explicit client binding denies live effects, and a malformed frozen
  stamp cannot become legacy just because the toggle is now off.

- Real canonical `user:<hash>` members exposed an existing notification mapping
  defect: the users-owned subject resolver only looked up auth principal IDs.
  It now recognizes an existing canonical user ID directly, including a user
  whose home tenant differs from the workspace. Org/role expansion still owns
  membership, and unknown principals remain unaddressable. The veto route tests
  cover real canonical users, a shared-workspace member and a foreign-org denial.
- A replay fork taken at a previously suspended `ctx.suspend` node must use the
  live continuation style. The existing derived-resolution path was incorrectly
  completing it with `{output: approvalResponse}`, losing the node’s actual
  outputs. It now preserves the recorded re-invoke key and reuses the existing
  scheduler continuation; paid nodes still serve the source outcome before
  execution. Native approval-gate accept/reject/conflict semantics are retained.
  This implements the existing RFC 0223/replay contract; no new wire shape or
  normative rule is introduced.
- Recovered ad-provider fixtures now supply their account currency. The current
  production currency/account fences remain in place; missing currency never
  authorizes a write.


Recovery validation before the canonical merge train:

| Scope | Result |
|---|---|
| Backend types and focused runtime/identity/replay | GREEN, 20 files / 245 cases (`autonomy-recovery-focused-6`); includes the existing RFC 0223 native gate and derivation-race suites |
| Frontend lint and canonical build | GREEN, zero lint warnings and all token/CSS/i18n/bundle checks (`autonomy-frontend-focused-2`) |
| Frontend test types and focused UI | GREEN, 9 files / 71 cases (`autonomy-frontend-tests-1`), including route identity, policy editor, veto list and timeline |
| Generated pack/served metadata | Reviewed: only the three changed campaign packs; three additional served nodes, undischarged 43 and unresolved 0 unchanged; parity adds the two new surface methods without new known drift |
| Resource guard | One heavy job at a time, Node 22, serial lanes, niced, aggregate 8 GiB cap; no swap growth or resource stop |
| Canonical app gate / merge / deploy | PENDING; no live flag, policy, credential or spend setting changed by these checks |


Recovery canonical correction — 2026-10-25: the first full gate passed 2,778
backend files and failed seven checks (zero Tracegate misses). The SLA interval
now enters the existing worker contract explicitly; the orchestration chain
pins autonomy-gate 1.1.0 under chain/pack 1.2.1. The requester-reader inventory
records the enforcer's narrowing-only use. Both older Strategist parity suites
now assert the actual four registered tools. The existing ADR0936 replay test
now checks the node's actual `answers`/`comment` ports, matching its source output,
while retaining both known-secret and credential-shape scrub assertions; it no
longer expects the native-gate wrapper for a ctx.suspend continuation. Types,
pack-version checks and all 13 focused files / 89 cases passed, including every
failed check and the real budget/veto replay suites. Full canonical retry is
still required before merge.


Recovery grant correction — 2026-10-25: a new real-SMS-adapter regression first
failed (`sms_not_connected` instead of `autonomy_approval_required`) when the
resolved approval carried no content hash. The grant matcher now requires the
same content identity, including absence: an unbound approval never covers a
content-bound effect. Backend types and all 13 focused files / 90 cases passed
including that regression, matching-content and changed-content grants,
financial fences, recorded budget replay, veto/timer replay and RFC0223 gates.
The second canonical attempt was stopped only at its task-owned wrapper before
merge so this correction could join the qualified head. No agent was stopped.

P4b scope remains conservative: timer/veto gate completion does not itself
remove the synchronous external chokepoint's separate approval floor. A future
elapsed-window effect grant must bind the run, policy, real facts and content;
this recovery does not treat an arbitrary elapsed timer as effect authority.
P3b client-party quorum, wider effect integration and the remaining ADR phases
remain open; this is not a full autonomy-program completion claim.
