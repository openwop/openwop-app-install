# ADR 0954 — Lead intelligence and qualification

Status: Proposed

Date: 2026-10-19. Program: Campaign Studio (ADRs 0941–0962), Tier 2 — channels.
Net-new feature planned with `/feature-refinement`; not a MyndHyve port.
Depends on: 0941 (canonical campaign), 0942 (autonomy policy and the one gate),
0943 (agent team: Lead Qualifier), 0944 (per-client memory), 0955 (SMS channel,
inbound SMS, STOP handling). Composes: CRM 0008, 0297 D3 (lead score), 0265
(propensity), 0272 (territories), 0837 (triage dispatch), 0402 (booking), 0470
(anonymous lead capture), 0138 (live voice), 0267 (durable timer), 0921 (agency
= workspace, client = org).

## Context

Campaign Studio fills funnels with leads. An agency needs four things after a
lead arrives: a grade the client agrees with, an owner chosen by the client's
rules, a first touch inside a time limit, and a qualifying conversation that
does not need a person. GoHighLevel, HubSpot and Salesforce sell parts of this.
In each of them the score is either a fixed formula or a model nobody can
inspect, routing is a separate rules screen, and the "AI SDR" sends messages
with no gate between its output and the customer. This ADR fits grading,
routing, SLA and qualification onto what already ships: no fourth scorer, no
second routing engine, no second chat.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `packs/`,
`examples/`, `docs/` or `frontend/`.

**Three scorers already exist. This ADR adds no fourth.**

- **Lead score (ADR 0297 D3).** `features/crm/leadScoreService.ts:17` fixes the
  weights (`view:1, completion:5, paidOrder:20`). `computeLeadScore` (`:31-56`)
  computes on read and returns every part, which is what makes it explainable.
  It reads `listCollectedEvents(tenantId, 50_000)` for **each contact**
  (`:36`): a full tenant scan per call, and a silent cap at 50,000 events with
  no `truncated` flag. Served by `GET …/crm/contacts/:contactId/score`
  (`features/crm/routes.ts:202-222`), which re-checks the org for the order
  count (`:208-220`).
- **Propensity (ADR 0265).** `features/crm/propensityService.ts:17-24` is a
  `CriteriaSet` evaluated by the priority-matrix `computePriority` (`:35-43`),
  "the ONE weighted-sum engine" (ADR 0262). It feeds segments
  (`features/crm/segmentsService.ts:240, 336`).
- **Triage priority (ADR 0837 D7).** The `crm-ops.triage` chain scores with a
  toggle-selected node from a closed set (`features/crm/triageDispatch.ts:27-45`)
  and stamps `lastTriage` on the contact (`features/crm/contactsService.ts:89-93`;
  route `features/crm/routes.ts:515-590`). It exists to witness variant
  dispatch, not to grade leads.

**Routing.** `crm-ops.route-new-lead`
(`examples/workflow-chain-packs/crm-ops/pack.json`) sets one configured owner
"unconditionally" on every new contact. Territories (ADR 0272) own an
assignment-rule engine (`features/territories/entities/assignment.ts:200-212`,
`orderRules` / `firstMatch` / `evaluateRecord`) whose `AssignTarget` is
`company | deal` only. A territory holds `memberSubjectIds` and
`managerSubjectId` (ADR 0272 §4.1).

**Conversation.** The public widget (ADR 0127, `features/chat-widget/`) runs the
Lead Concierge pack (`packs/core.openwop.agents.lead-concierge/pack.json`,
allowlist `knowledge.search` + `crm.lead.capture`). `openwop:crm.lead.capture`
(`features/crm/agentTools.ts:56, 393`) has a closed schema of email, name and
note. There are no qualification fields, deliberately (ADR 0470 D1). In-app live
voice exists for signed-in users (ADR 0138, `features/voice/feature.ts`).
Telephone calls do not: `voiceCallPlace` says the host capability is "latent
today" (`packs/core.openwop.integration/index.mjs:195-203`). No inbound SMS
provider exists (`features/connections/inboundWebhooks.ts:65` lists slack,
discord, telegram, whatsapp-twilio, whatsapp-cloud, zoom-webinar).

**SLA.** The approval SLA ladder (`host/approvalSla.ts:1-17`) is the pattern:
remind, escalate, expire, with each rung fired once through a CAS. Nothing
times a lead's first touch.

**Booking (ADR 0402).** `claimSlot` (`features/crm/bookingService.ts:199`),
`assertBookingOwnerEligible` (`:381`), and the `feature.crm.nodes.booking-create-link`
node already exist.

**Gaps:**

| Gap | Evidence | Consequence if ignored |
|---|---|---|
| L1 Contacts are tenant-scoped | `contactsService.ts:79-120`; "Contacts are tenant-scoped: no orgId" (`:823`) | In an agency workspace (ADR 0921), every operator with CRM read sees every client's leads |
| L2 CRM visibility has one slot, owned by territories, and no `contact` target | `host/crmRecordVisibility.ts:22, 42-48` | A client-binding filter cannot be added without displacing territories |
| L3 Per-contact tenant event scan | `leadScoreService.ts:36` | A graded lead list is O(contacts × tenant events); the cap is silent |
| L4 Routing sets a fixed owner | `crm-ops.route-new-lead` | No round robin, capacity or client rules; an ineligible owner still gets the lead |
| L5 No inbound SMS, no telephony | `inboundWebhooks.ts:65`; `index.mjs:195-203` | SMS and phone qualification cannot be honest today |

## Decision

### D1 — One scoring owner: a per-client scoring model on the existing engine

CRM stays the owner of lead scoring (ADR 0297 D3). A new sub-module
`features/crm/leadIntel/` adds a **versioned scoring model per client org**:

```ts
interface LeadScoringModel {            // crm:lead-model, key tenant::orgId::modelId
  tenantId: string; orgId: string; modelId: string;
  version: number; contentHash: string; // immutable version rows, CAS on expectedVersion (the ADR 0905 D1 shape)
  status: 'draft' | 'active' | 'archived';
  signals: Array<{ signalId: SignalId; weight: number; cap?: number }>; // SignalId ∈ SIGNAL_CATALOG
  bands: { A: number; B: number; C: number; D: number; E: number };     // score floors, strictly descending; below E = F
  criteria: QualificationCriterion[];   // D4, closed per model
  sla: Partial<Record<Band, { firstTouchMinutes: number }>>;            // D6
}
```

- `SIGNAL_CATALOG` is closed and code-owned. Each signal names its reader:
  funnel views and completions, paid orders (ADR 0297 readers), form submits
  (`features/forms`), email opens and clicks (ADR 0905 engagement), booking made
  (ADR 0402), propensity traits (ADR 0265), and `qualifier.<criterionId>`
  answers (D4). Writing a model with an unknown signal or a non-monotone band
  table is a 422 at write time.
- The model is evaluated by the same `computePriority` weighted-sum engine that
  propensity uses. No ML in v1.
- **No model ⇒ v0.** v0 reproduces today's fixed weights exactly, so
  `GET …/contacts/:id/score` is unchanged for tenants that never write a model.
- Propensity stays a segment trait (ADR 0265) and triage stays the ADR 0837
  variant witness. Both are read as signals and neither becomes a grader. P4
  adds a `model` member to triage's closed binding set so the triage chain can
  call this evaluator, which converges the scorers without changing ADR 0837's
  dispatch.

### D2 — Computed on read stays the truth; a grade projection is stamped by the run

The explanation is always recomputed live. A list of graded leads cannot rescan
per row (L3), and band changes must trigger routing and SLA. A projection row
is therefore written:

```ts
interface LeadGrade {                   // crm:lead-grade, key tenant::orgId::contactId
  tenantId: string; orgId: string; contactId: string;
  modelId: string; modelVersion: number;
  score: number; band: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  parts: Record<SignalId, { raw: number; weighted: number }>;
  inputsDigest: string;                 // sha256 of the signal inputs read
  assessment?: QualificationAssessment; // D4
  runId: string; computedAt: string;
  pendingRunId?: string;                // set when a grading run is dispatched; only that run may write (ADR 0837 A7)
}
```

- It is written **only** by the `feature.crm.nodes.grade-lead` side-effect node.
  The write is a CAS conditioned on the run that the row's `pendingRunId` names,
  so an older run or a fork never overwrites a newer grade. This is the ADR 0837
  A7 `lastTriage` rule. The run is the provenance source of truth; the row is a
  sortable projection with `computedAt` shown.
- `GET …/leads/:contactId/grade?explain=1` recomputes live and shows any
  difference from the projection ("stale since …").
- Re-grading runs on signal events (debounced per contact, 60 s) and nightly
  per client. L3 is fixed in P0: the evaluator reads events through a
  per-visitor index, and any cap returns `truncated: true`.

### D3 — Client binding for leads (and the L1 blocker)

A `LeadProfile` sidecar (`crm:lead-profile`, key `tenant::orgId::contactId`)
binds a contact to a client org. It is created when a lead arrives through a
surface that belongs to a client (a form, funnel or widget whose `orgId` is a
`ClientAccount`, or a campaign carrying `orgId`). All grades, routing decisions
and SLA state key on `(orgId, contactId)`. Every lead-intel route is
`/v1/host/openwop-app/crm/clients/:orgId/leads/…` behind
`authorizeOrgScope(req, 'crm.lead-intelligence', orgId, scope)`, with the
uniform-404 loader (ADR 0921 D3).

**L1 is a program blocker, handed to ADR 0941 and the accessControl owner. It
is not fixed here.** The contact row itself remains readable tenant-wide through
`/crm/contacts`. The recommended fix is to give `crmRecordVisibility` a
`contact` target and turn its single slot into an intersection of registered
narrowers (territories plus client binding). That changes every CRM reader and
needs its own review. Until then, Campaign Studio onboarding states plainly
that agency operators with a root role can read every client's contacts in the
CRM tab.

### D4 — Explainable AI grading: assessments, not grades

The Lead Qualifier (ADR 0943 roster, bound per client, memory per client org
through ADR 0944) never sets a grade. It produces an assessment of the model's
closed qualification criteria:

```ts
interface QualificationCriterion { criterionId: string; label: string;
  answer: { kind: 'enum'; values: string[] } | { kind: 'range'; min: number; max: number } }
interface QualificationAssessment {
  modelVersion: number;
  answers: Array<{ criterionId: string; value: string | number; confidence: number;
    evidence: Array<{ kind: 'transcript-turn' | 'form-field' | 'contact-field' | 'activity'; ref: string }> }>;
  summary: string;                      // ≤ 400 chars, shown to humans, never scored
  bandAdjustment: -1 | 0 | 1; adjustmentReason?: string;
}
```

- **Read before write.** The agent must call `feature.crm.nodes.lead-evidence`
  first. That node returns the transcript turns, form fields and activities with
  their refs.
- **Closed-world validation.** Every `criterionId` must exist in the model,
  every value must be in its enum or range, and every answer needs at least one
  evidence ref that resolves in the evidence the agent read. Otherwise the
  result is a typed failure, `assessment_ungrounded`, with one error-fed repair,
  then the run fails. There is never a success with an empty assessment.
- Answers enter the deterministic score as `qualifier.*` signals, so the grade
  stays reproducible from its inputs. `bandAdjustment ≠ 0` is action class
  `lead.grade-adjust` (ADR 0942 D1). Its default is `approve(role: sales-lead)`, so an
  adjustment applies only after a person agrees, unless the client's policy says
  `auto`.
- "Why is this lead an A?" is answered by replaying the grading run: inputs,
  weights, the assessment and its evidence.

### D5 — Routing extends territories; it is not a second engine

- ADR 0272's `AssignTarget` gains `contact`. Territory rules gain the lead
  fields (band, source, campaignId, `customFields`). The territories feature
  owns the change.
- A `LeadRoutingPolicy` per client org (`crm:lead-routing`, versioned) lists
  ordered rules `{match, strategy, pool}`. The strategies are `territory` (first
  match, then the territory's own strategy), `round-robin` (a CAS pointer row
  `crm:lead-rr:tenant::orgId::poolId`), `capacity` (the least-loaded pool member
  under `maxOpenLeads`, ties broken by round robin) and `named`.
- **Eligibility is checked at each assignment, not when the policy is saved.**
  Each candidate must still hold `workspace:write` on the client org
  (`assertOrgScope`). Ineligible candidates are skipped. If nobody is eligible
  the lead goes to the client's `unassigned` queue and someone is notified. It is
  **never** routed to an owner outside the client.
- The `feature.crm.nodes.route-lead` side-effect node is ledgered on
  `(contactId, routingEpoch)`. It records `{policyVersion, ruleId, strategy,
  candidates, skipped, chosen, pointerBefore}`, and replay serves the recorded
  outcome. `crm-ops.route-new-lead` v2 runs grade-lead → route-lead →
  speed-to-lead (sub-chain) and replaces the unconditional owner write.

### D6 — Speed-to-lead SLA as a chain

`crm-ops.speed-to-lead` (a sub-chain) uses the ADR 0267 durable timer:

1. Compute the deadline from the band's `firstTouchMinutes` and the client's
   business hours. The deadline is frozen in the node output.
2. `core.flow.wait until deadline`.
3. `check-first-touch`: any owner activity since `assignedAt` (call, email,
   SMS, meeting, booking) ends the chain.
4. Rung 1 reminds the owner. Rung 2 either re-routes, excluding the prior owner,
   or escalates to the territory manager, per policy. Rung 3 tells the agency
   lead after the fact.

Each rung is a node, so it runs at most once per run (no daemon, no second
ladder). Time-to-first-touch is recorded for reporting (ADR 0957) and for
attribution (ADR 0956).

### D7 — Conversational qualification on the one chat

- **Website.** The chat widget and the Lead Concierge pack gain
  `openwop:crm.lead.qualify`. It is anonymous-safe with a closed schema
  `{criterionId, value}` checked against the widget's client model, and it adds
  to the held capture (ADR 0469/0470 hold-then-approve). It cannot set a grade,
  price or offer. The value-first, four-question limit stays. Per-client
  persona, brand voice and knowledge come from ADR 0943 binding and ADR 0944
  memory. The public Concierge only collects answers; it is not the ADR 0943
  Lead Qualifier. The Lead Qualifier (`campaign-studio.agents.lead-qualifier`)
  is the in-run grader of D4, never exposed on the anonymous widget, so the
  widget's allowlist stays two tools plus `crm.lead.qualify`.
- **In app.** "Qualify this lead" deep-links `/?agent=<lead-qualifier>&conversation=…`
  or renders `EmbeddedChatPanel` (`frontend/react/src/chat/EmbeddedChatPanel.tsx:43`)
  in the lead drawer. There is no new panel.
- **SMS (P5).** Inbound turns arrive through the `twilio-sms` provider that ADR
  0955 D3 adds. Keyword handling (STOP, HELP) runs first. Other messages become
  turns on the one conversation primitive (RFC 0005), recorded with channel
  `sms` in host metadata. Outbound replies are gated under D9.
- **Voice.** Signed-in live voice (ADR 0138) can run the qualifier for
  operators. Phone and inbound-call qualification need `ctx.voice`, which is
  latent, so they are **deferred and not advertised**.

### D8 — Booking handoff

When the band reaches the policy's `bookAt` threshold, the qualifier offers the
**assigned owner's** booking link. It is created or reused through
`booking-create-link`, after `assertBookingOwnerEligible`. A `claimSlot`
booking emits an event that counts as the first touch (it stops D6) and moves
the contact's stage. Offering a link is a read. The booking itself is the
visitor's own act, which ADR 0402 already governs.

### D9 — Outbound contact is gated

Any automated outbound message to a lead (an agent-sent SMS, email or call, or an
auto-reply outside the open widget conversation) is ADR 0942 action class
`lead.contact`. The class is resolved from the policy frozen at run start, and
an absent frozen policy means `approve` (fail closed: the run-start contributor
is fail-soft, `host/runStartContext.ts:12-14`). Channel eligibility (consent,
STOP, quiet hours, frequency) is ADR 0955's one eligibility function. Lead
intelligence never re-implements it.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `features/crm/` with `leadIntel/` (model, grade, profile, routing policy, SLA reads). The `AssignTarget` change is made in `features/territories/`. No core edits. |
| 2 | Toggle | New sub-toggle `crm.lead-intelligence` (default OFF, `bucketUnit: 'tenant'`), an `extraToggleDefaults` entry of `crm` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `crm`); it works best with `territories`, `chat-widget` and `campaign-ops` ON (stated in the toggle description, since a sub-toggle has no `recommends`). `crm` is unchanged. v0 scoring stays live with the sub-toggle off. |
| 3 | Workflow surface | `ctx.features.crm` gains `gradeLead`, `leadEvidence`, `routeLead`, `checkFirstTouch`. Every method takes `orgId` and re-checks the run tag's client (ADR 0941 D2b; the ADR 0921 D3 check). |
| 4 | Node pack | `feature.crm.nodes` gains `grade-lead` (side-effect, CAS), `lead-evidence` (read), `route-lead` (side-effect, ledgered), `check-first-touch` (read) and `sla-deadline` (pure). Chain pack `crm-ops` v2: `route-new-lead`, new `speed-to-lead` and `grade-lead`. |
| 5 | AI chat and envelopes | No envelope. The tool `openwop:crm.lead.qualify` (anonymous-safe, pack-allowlisted, not in the ADR 0315 baseline). The assessment is a validated tool result. |
| 6 | Agent pack | `core.openwop.agents.lead-concierge` 1.1 (adds `crm.lead.qualify`). The ADR 0943 Lead Qualifier is a separate in-run manifest (D4); the Concierge stays the public persona. Its prompt states "you cannot set a grade or promise price", and that line is test-pinned. |
| 7 | Public surface | Only the existing widget gateway. No new public route. |
| 8 | RBAC | Models and policies need `workspace:write` plus `host:members:manage` on the client org. Reads need `workspace:read` on the client org. Uniform 404 on the wrong client. Routing eligibility is re-checked at each assignment. |
| 9 | Replay / fork | Grade, route and SLA rungs are side-effect nodes with recorded outcomes. Deadlines are frozen in node output. The model version is pinned in the grade node's input. Toggle state is not read at replay. |
| 10 | Frontend | A Leads tab in the `/campaign-studio` hub: a graded list (band chips, `computedAt`), a lead drawer (explanation, assessment evidence, routing record, SLA clock, embedded qualifier chat), and model/policy editors with a dry-run preview (ADR 0272's preview pattern). Strings in four locales. |

## Why this is our advantage

- **Durable graph, named agent per node.** Grade → route → SLA is one replayable
  chain. Each grade can be explained by replaying it, and a fork can answer
  "what if this lead had been routed under last week's policy" without touching
  production.
- **Governed AI grading.** The model fills in evidence-cited criteria, and a
  person (or the client's explicit policy) approves any change of band.
  HubSpot's and Salesforce's predictive scores are opaque. GHL's AI Employee has
  no approval node.
- **Per-client isolation.** Models, routing and memory are per client org inside
  one agency workspace. No incumbent keeps one client's scoring rules and
  memory away from another's under one agency login.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `leadIntel` model store (versions, CAS), the evaluator on `computePriority`, v0 parity, the per-visitor event index and `truncated` | v0 equals today's `computeLeadScore` on fixtures; a model with an unknown signal is a 422; no per-contact tenant scan remains |
| P1 | `LeadProfile`, `LeadGrade`, the `grade-lead` node, the `crm-ops.grade-lead` chain, org-gated routes | Witness: a grade for client A is 404 to a client-B-only operator; an older run cannot overwrite a newer grade |
| P2 | `AssignTarget: contact`, `LeadRoutingPolicy`, the `route-lead` node, `route-new-lead` v2 | Round robin is fair under concurrent arrivals (CAS witness); an ineligible owner is skipped; no cross-client assignment |
| P3 | The `speed-to-lead` chain and business-hours deadlines | A fork before the deadline inherits it; each rung fires once; a booking stops the clock |
| P4 | The `lead-evidence` node, the Lead Qualifier assessment and its validator, `crm.lead.qualify` in the widget, triage `model` binding | Ungrounded evidence gives a typed failure; a band adjustment waits for the 0942 gate; the widget cannot write a grade |
| P5 | SMS qualification on ADR 0955's inbound provider | A STOP never reaches the agent; outbound replies pass D9 |

## Alternatives weighed

- **A predictive ML score.** Rejected for v1. Per-client data is small, and the
  thesis is explainability. Learned weights can later be proposed as a model
  version a person approves.
- **Persist the score as the source of truth.** Rejected. It breaks ADR 0297's
  "no new store of truth" ruling. The projection is a stamped cache with the
  live recompute beside it.
- **A routing engine inside CRM.** Rejected. Territories already own ordered
  first-match rules, preview and materialization.
- **A dedicated "AI SDR" chat or SMS bot.** Rejected. CLAUDE.md's one-chat rule
  applies: an agent pack plus node pack, driven through the existing widget and
  chat.
- **Let the agent output the grade.** Rejected. It cannot be reproduced and it
  invites persuasion ("I'm a VIP, grade me A").

## RFC verdict

**Host extension, no RFC.** Routes are under `/v1/host/openwop-app/crm/clients/:orgId/leads/*`.
Nodes and tools are pack-scoped. The SMS channel marker on conversation turns
is host metadata, not an RFC 0005 field. Nothing is advertised at
`/.well-known/openwop`.

## Open questions

1. **(David)** L1: should CRM contacts gain client binding app-wide (a
   `crmRecordVisibility` contact target with composed narrowers), as a
   precondition for agencies using the CRM tab? Proposed: yes, as a 0941
   program blocker before any agency pilot.
2. **(David)** Default SLA targets per band (proposed A 5 min, B 1 h, C 1
   business day) and whether a missed SLA re-routes or only escalates by
   default. Proposed: escalate.
3. **(David)** Can a client's policy set `lead.grade-adjust: auto`, so the AI's band
   adjustment applies without review? Proposed: allowed, off by default,
   recorded per adjustment.
4. Is an auto-reply inside an inbound SMS conversation `lead.contact` or
   transactional? Proposed: an in-thread reply within 24 h of the lead's
   message is transactional; anything else is `lead.contact`. Confirm with
   ADR 0955's legal posture.
5. `capacity`: where does the open-lead count come from (`LeadProfile` status
   versus contact owner)? Proposed: `LeadProfile.status ∈ {new, working}`.
6. No `/architect` pass has been run yet. Run it before Accepted, focused on D3
   and D5.

## Planning rows

**ROADMAP (Campaign Studio program table):**
`| 0954 | **Lead intelligence and qualification** ([ADR 0954](docs/adr/0954-lead-intelligence-and-qualification.md)) | `crm.lead-intelligence` | 0941, 0942, 0943, 0944, 0955, 0272, 0297, 0402, 0470 | `feature.crm.nodes`, `crm-ops` chain pack, `core.openwop.agents.lead-concierge` | Host extension | 🔵 Proposed (blocked on 0941 L1 decision for agency pilots) |`

**FEATURES "Future features":**
`- **Lead intelligence and qualification (ADR 0954, Proposed 2026-10-19)** — per-client lead scoring models with A–F bands on the one weighted-sum engine (computed live, stamped by the grading run), an AI Lead Qualifier that fills evidence-cited criteria but never sets a grade, routing (territory, round robin, capacity) built on territories, a speed-to-lead SLA chain on the durable timer, qualification in the existing widget and chat (SMS later via ADR 0955), and a handoff to the assigned owner's booking link. Outbound contact is gated by ADR 0942. Sub-toggle `crm.lead-intelligence` (OFF, tenant). No RFC.`
