# ADR 0942 — Campaign autonomy policy: per-campaign HITL, frozen at run start

Status: Proposed
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
  `review-everything@1`. New clients default to `review-everything@1`.
- **Presets** are versioned code constants (proposed numbers are David's call, Q1):
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

- Tighten (any change whose every class is at least as severe): `workspace:write`
  on the client org.
- Loosen: `host:members:manage` on the client org; audited; notifies the org's
  admins (Q2 asks whether it also needs a second person).
- Client default: agency admins. A campaign override cannot be looser than the
  client default unless an org admin makes it.
- **ADR 0924 D4 folds in:** `ClientAccount.approvalPolicy` becomes the
  `ApproverSpec` of the client's `campaign.change-set.apply` rule
  (`agency` → org `approvals:respond` roles; `client` → `clientApprover:true`;
  `client_and_agency` → both, `requiredApprovals:2`). The field stays readable
  until 0924's handler reads the rule; one migration writes the binding.

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
8. No `/architect` review has been invoked on this ADR yet.

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
