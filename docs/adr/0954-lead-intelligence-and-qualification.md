# ADR 0954 — Lead intelligence and qualification

Status: Accepted (P0–P3 implemented; P3 merged d62dd21e5, deployment pending approved flow1.2.0 pin; P4a recovered and focused checks green, canonical merge gate pending; P4b open; P5 waits on ADR0955 inbound SMS)

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

> **CORRECTED 2026-10-20 (P0, `/architect` review).**
> - **Engine.** "Evaluated by the same `computePriority` engine" and "v0
>   reproduces today's weights exactly" could not both hold. The engine's three
>   aggregations clamp scores and weights to 1..10 and normalize them
>   (`host/weightedScoring.ts`), so `views × 1 + completions × 5 + orders × 20`
>   cannot be expressed. The resolution is to keep one engine and add one
>   aggregation: `points` = Σ min(raw, cap) × weight over raw counts, with
>   non-negative, unclamped weights and no normalizing. `Criterion` gains an
>   optional `cap`. Priority-matrix cannot select it, because its validator
>   coerces unknown values to `weighted-sum`, and propensity keeps
>   `weighted-sum`. Bands are point floors.
> - **v0.** The v0 model is `V0_CONTENT` in `features/crm/leadIntel/model.ts`.
>   `computeLeadScore` keeps its response shape and adds `truncated`.
> - **Signal catalog (v1).** The catalog holds only the signals that have an
>   honest reader today: funnel views, funnel completions, paid orders and
>   propensity. Form submits, email engagement and bookings are added one reader
>   at a time; `qualifier.*` arrives with P4. The catalog grows additively, and
>   a stored model can never name a signal without a reader.
> - **Model store.**
>   - Version rows (`crm:lead-model`, `tenant::orgId::modelId::version`) are
>     immutable. The insert-if-absent of version N+1 is the concurrency control,
>     so a stale editor gets 409 `model_version_conflict`.
>   - The client's active model is a CAS pointer (`crm:lead-model-active`,
>     `tenant::orgId`). No pointer means v0.
>   - "draft/active/archived" is therefore the pointer, not a field on an
>     immutable row.
>   - Validation (422 naming the field) checks:
>     - the closed catalog, with no duplicate signals;
>     - weights from 0 to 1000 and caps that are not negative;
>     - strictly descending band floors;
>     - unique criteria with closed enum or range answers;
>     - whole-minute SLAs from 1 minute to 7 days.
> - **L3, the per-visitor index.** `features/cdp/visitorEventIndex.ts` keeps
>   `cdp:visitor-event` (`tenant::visitor::eventId`) and a reverse row per event.
>   - Every writer of `cdp:collected-event` indexes: `collectEvent`, and the demo
>     seeder that writes rows directly.
>   - A namespace delete hook on `cdp:collected-event` removes the index row, so
>     the retention purge and the CONS-6 DSAR eraser keep it exact.
>   - Rows that predate the index are indexed once per tenant by a lazy
>     backfill. The marker is written after the rows, so a crash re-runs it.
>   - Reads are one bounded prefix per linked session, capped at 5,000 events
>     each, and a capped read returns `truncated: true`.
>   - No per-contact tenant scan remains. The old one was silently capped at
>     50,000 events.
> - **Toggle.** The sub-toggle `crm.lead-intelligence` is registered now (OFF,
>   `tenant`, an `extraToggleDefaults` entry of `crm`), so P1's routes can gate
>   on it.

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

> **As built (P1, 2026-10-20).**
> - **Binding.** `LeadProfile` (`crm:lead-profile`, `tenant::orgId::contactId`)
>   is created by `POST /crm/clients/:orgId/leads {contactId, source}`.
>   - A contact belongs to **at most one** client: a reverse row
>     `crm:lead-profile-of` (`tenant::contactId`), inserted by CAS, returns 409
>     `lead_bound_to_other_client`, so one person is never graded under two
>     clients' models.
>   - The automatic binding from client surfaces (forms, funnels, the widget)
>     lands with the phases that wire them.
> - **Grade.** `LeadGrade` (`crm:lead-grade`) follows the ADR 0837 A7 rule
>   exactly. `POST …/leads/:contactId/grade` resolves the client's active model,
>   **pins** `{modelId, modelVersion}` into the run's inputs, stamps
>   `pendingRunId` before the run starts (and restores it if the start fails),
>   and starts the same-id chain-backed `crm-ops.grade-lead`. Its one node,
>   `feature.crm.nodes.grade-lead` (a side-effect, served on replay), writes only
>   when the row names this run.
> - **Run stamp.** The run carries a host-written stamp,
>   `crmLeadIntel: {orgId, contactId}`, added to `CAMPAIGN_ATTRIBUTION_KEYS` so
>   callers cannot set it. The `gradeLead` surface op refuses `wrong_client`
>   when the arguments name another client or lead. The surface op is an org
>   writer (`workspace:write` on the client through the seam floor, with the
>   requester as `orgScopeSubject`), and it ANDs the sub-toggle with `crm`.
> - **Routes.**
>   - Routes: `GET/POST …/leads`, `GET/POST …/leads/:contactId/grade`
>     (`?explain=1` recomputes under the same pinned version and reports
>     `stale`), `GET …/leads/models/active`, `GET/POST …/leads/models/:modelId`
>     and `POST …/models/:modelId/activate`.
>   - Gate: `crm` (toggle and plan), then `crm.lead-intelligence`, then scope on
>     the client org. A client the caller cannot read is a uniform 404, and the
>     workspace root is never a client.
>   - Models need `workspace:write` and `host:members:manage`.
> - **Correction.** `authorizeOrgScope` has no toggle-id or `orgId` arguments,
>   and it answers 403 rather than 404, so the lead routes use their own gate
>   (`authorizeLeadClient`, the campaign-ops `authorizeClient` shape).
> - **Not built in P1.** Debounced re-grading on signal events and the nightly
>   re-grade (D2) are not wired yet: a grade is started by the route.

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

> **Correction (2026-10-20, P4a as built; `/architect` review).**
>
> - **Split.** P4 needs two things that are not on main: ADR 0942's
>   `lead.grade-adjust` class with its `autonomy-gate` node, and ADR 0943's Lead
>   Qualifier agent (`vendor.openwop-app.campaign-studio.agents.lead-qualifier`;
>   this ADR wrote `campaign-studio.agents.lead-qualifier`). P4a ships what needs
>   neither. **P4b** will:
>   - give the agent the `lead-evidence` read and a `crm.lead.assess` tool that
>     calls the SAME `validateAssessment`;
>   - add the 0942 gate that decides a pending band adjustment, plus a
>     `NODE_ACTION_CLASSES` entry for it;
>   - add triage's `model` binding (below).
> - **Read before write is structural.** The assessment runs as the internal
>   chain `crm-ops.qualify-lead`: `lead-evidence` → `assess-lead` → `grade-lead`.
>   It is started by `POST …/leads/:contactId/qualify`, which pins the model
>   version and stamps the lead's pending run. `assess-lead` follows the ADR 0923
>   `interpret` shape:
>   - the model answers from the evidence that came over the edge (already inside
>     the host's `<UNTRUSTED>` fence);
>   - the CRM surface validates it closed world;
>   - one error-fed repair, then a typed `assessment_ungrounded` failure.
>
>   A cited ref must be one this run READ and must still resolve. The node passes
>   the refs it read, and the surface resolves each cited ref again (each
>   activity is looked up by id, so a newer activity cannot push an older one out
>   of the 50-item window). The insert is re-checked against the pending run
>   after the write, so a run that lost the stamp mid-write leaves no row behind.
>   A grade falls back first to the assessment the stored grade used, then to
>   the newest one. Assessments are
>   stored once per run, and only by the run the grade row names as pending.
> - **Evidence (v1).**
>   - Included: qualification-relevant contact fields (stage, company, title,
>     lead source), the client's activities for the lead (newest 50), and the
>     visitor's own widget answers.
>   - Excluded: email, phone and address, which qualify nothing.
>   - Not offered: transcript turns, because no conversation is linked to a
>     contact today.
> - **Signals.**
>   - `qualifier.<criterionId>` must name a criterion of the same model.
>   - An enum criterion's signal lists the answers that count (`values`, raw 1).
>   - A range criterion's value is its raw (capped by `cap`).
>   - Raws come only from an accepted assessment: the grading run's own, otherwise
>     the newest under the same model version. The grade records which one
>     (`assessmentRunId`), so it stays reproducible.
> - **Band adjustment.** A non-zero `bandAdjustment` is stored as `pending` and
>   nothing applies it. That stays true until P4b's 0942 gate, so the exit
>   criterion "a band adjustment waits for the 0942 gate" holds vacuously today
>   and is OPEN as a witness.
> - **The widget (D7), corrected.** A held anonymous tool runs with the tenant and
>   run only, never an org (`host/anonymousActor.ts`). A model-supplied org would
>   let the visitor choose the client. So `crm.lead.qualify` does NOT check
>   answers against "the widget's client model", as D7 said. Instead:
>   - It stores the visitor's own statement per contact
>     (`crm:lead-stated-answers`), bounded to 10 answers, a criterion-shaped id,
>     and 200 characters each.
>   - An assessment may cite a statement (`stated:<criterionId>`). A statement is
>     never a signal and never a grade, which makes "the widget cannot write a
>     grade" structural.
>   - It is anonymous-only, like `crm.lead.capture`, and needs both `crm` and
>     `crm.lead-intelligence`.
>   - **Hold-only, enforced (team-lead review).** The email is not verified, so
>     anyone who types a contact's address could attach statements to that
>     contact. The tool declares `anonHitlOnly`, a new `BuiltinTool` field read
>     in two places:
>     - At grant time, a widget grant that pairs it with
>       `rate-limit-session-cap` is refused (400, `anonToolGrant.writeControl`).
>     - At call time, `authorizeAnonTool` always answers `hitl` for it, so a grant
>       saved before the rule still holds the call.
>
>     An operator therefore sees every statement, and the email it is filed
>     under, before anything lands. The evidence also labels it "website visitor
>     said, unverified". Witnessed: an auto-run surface holds the call, and the
>     existing contact gets nothing.
>   - The Lead Concierge pack (1.1.0) lists it, and asks at most four questions,
>     only when its instructions list them.
> - **Erasure.** Stated answers and assessments are deleted on a subject erasure
>   (the CRM key resolver yields the contactId) and on a contact delete.
> - **Triage `model` binding: moved to P4b.** The `crm-ops.triage` chain has ONE
>   scoring node that takes the variant as a parameter, and ADR 0837 D7 pins that
>   shape. A `model` member needs a branch to a reading node, which is a change to
>   0837's witness, not an addition to it. When it lands, no default variant
>   allocates it, so the 50/50 split is untouched.

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

> **As built (P2, 2026-10-20).**
> - **Territories.** `AssignTarget` gains `contact`, and the territories
>   feature owns the change. A `contact` rule may match `stage`, `company`,
>   `owner`, `source`, `band`, `score` and `customFields.*`. `contact` rules are
>   evaluated one lead at a time and are **never** materialized as assignments
>   or used for visibility, which stay company/deal. The territories page offers
>   "Leads (lead routing)" as a rule target, in four locales.
> - **Seam.** CRM may not import territories, because territories depends on
>   CRM. Routing therefore asks through a host seam
>   (`host/leadTerritoryRouting.ts`): territories registers a resolver that
>   reads the client's active territory model and returns the matched
>   territory's members. With the territories toggle off, it returns `null`.
> - **Routing.**
>   - `LeadRoutingPolicy` versions are immutable (`crm:lead-routing`); N+1 is
>     inserted by CAS, and the newest version is the live one.
>   - `routeLead` (`features/crm/leadIntel/routing.ts`) tries rules in order.
>   - `territory` rotates within the matched territory's members.
>     `round-robin` rotates the pool through a CAS pointer row
>     (`crm:lead-rr`), so concurrent arrivals each take a distinct turn.
>     `capacity` picks the least-loaded pool member under `maxOpenLeads`
>     (counting open leads from `LeadProfile.owner` and `status`, Q5), with
>     ties broken by rotation. `named` is one owner.
> - **Eligibility.** Eligibility is `workspace:write` on the client, checked at
>   each assignment. A skipped candidate is recorded with its reason. If nobody
>   is eligible, the lead goes to the client's unassigned queue
>   (`LeadProfile.unassigned`). The assigned owner gets a notification
>   (`crm.lead.assigned`, idempotent per round).
> - **Ledger.** The decision row (`crm:lead-route`, keyed `contactId` +
>   `routingEpoch`) is inserted once, so a re-execution or a fork returns the
>   recorded choice without turning the rotation.
> - **Chain (correction).** Rather than rewriting `crm-ops.route-new-lead` to v2,
>   which would break every tenant whose event binding starts the v1 chain with
>   its `ownerId` parameter, P2 adds a new internal chain,
>   `crm-ops.route-lead` (grade-lead → route-lead). The Leads route
>   `POST …/leads/:contactId/route` starts it with a fresh routing epoch and the
>   model version pinned. v1 stays as it is for tenants without lead
>   intelligence. P3 appends the speed-to-lead sub-chain.
> - **Not built in P2.** Automatic routing when a lead arrives, and the
>   "someone is notified" for the unassigned queue (it is logged, and the queue
>   is visible). Both land with the UI phase.

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

### Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P4a | branch `feat/0954-p4-lead-qualifier` (PR filled on open) | `test/adr0954-p4-lead-qualification.test.ts` (closed-world validation; the real qualify chain records a grounded assessment and grades from it; ungrounded twice ⇒ one fed-back repair then `assessment_ungrounded`, nothing recorded; one repair can succeed; an older run cannot record; a pending band adjustment does not move the band; route 422 without criteria and 404 to a B-only operator; the widget's answers are held under hitl, stored as evidence only and never a signal; erasure; three sabotage witnesses) |
| P3 | branch `feat/0954-p3-speed-to-lead` (PR filled on open) | `test/adr0954-p3-speed-to-lead.test.ts` (business hours across a weekend and DST; deadlines from the recorded decision only; a replay fork suspends on the same deadline; each rung once, also under concurrent executions; an owner activity or a booking stops the clock, another person's activity does not; superseded rounds; opt-in re-route away from the previous owner; recipients re-checked; the real chain fires rungs 1–3 off the timer sweep and ends on a first touch; client-scoped settings routes; three sabotage witnesses) |
| P2 | branch `feat/0954-p2-lead-routing` (PR filled on open) | `test/adr0954-p2-lead-routing.test.ts` (round robin fair under 9 concurrent arrivals; ineligible and cross-client owners skipped; unassigned queue; capacity; ledgered rounds; territory `contact` rules; the real chain end to end; client-scoped routes; three sabotage witnesses) |
| P1 | branch `feat/0954-p1-lead-grade` (PR filled on open) | `test/adr0954-p1-lead-grade.test.ts` (the real chain grades a bound lead; a B-only operator gets 404 on every A route; one client per contact; an older run or a fork cannot overwrite a newer grade; a run for client A cannot grade client B's lead; model RBAC, 422 and the sub-toggle; three sabotage witnesses) |
| P0 | branch `feat/0954-p0-lead-model` (PR filled on open) | `test/adr0954-p0-lead-model.test.ts` (v0 equals the old tenant-scan oracle, including pre-index rows; a deleted event leaves the index; the cap reports `truncated`; `points` engine; 422 validation; version CAS and active pointer; four sabotage witnesses), `test/funnel-d-adjacent.test.ts` (end-to-end route parity with paid orders) |

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
   **Decided (2026-10-19, David): Yes. CRM contacts gain client-org binding app-wide before any agency pilot; cross-client views only by explicit agency-owner role. Start this migration first in Tier 2 prep.**
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

### Recovery correction — model attribution, 2026-10-21

Version content remains immutable, but `createdBy` and the active pointer's
`activatedBy` must follow subject erasure. Saves and activations first CAS their
actual primary row with an erased sentinel and a private receipt containing
tenant-salted actor hashes. Only after publication do they check consent's shared
erasure tombstones and CAS that exact receipt to the actor. A failed/uncertain
attribution write returns the already-committed, conservatively unattributed
result; it never retries selection or overwrites a newer activation. Public
projections omit the private receipt. A crashed writer retains no raw actor.

The existing CRM attribution eraser writes grouped tombstones before enumerating
both authoritative tenant primary prefixes, without the display's 200-version
cap or dependence on secondary markers. Each redaction CAS rereads the current
row and preserves content, hash, version, timestamps and active selection.
Persistent contention is incomplete erasure. Matching is directional: DSAR keys
expand to legacy subject forms, while stored actors preserve their principal
scope; erasing `user:alice` must not affect `agent:alice`.

Eight file-backed failure-boundary witnesses are authored. They have not run;
the canonical train owns the sole monitored validation slot. This correction
covers model attribution only. The CDP visitor-event admission, deduplication and
deletion races still block integration of P0; no broader completion is claimed.

### Recovery correction — CDP admission and erasure, 2026-10-21

The visitor reverse row is now a durable admission/deletion receipt in the
existing collection, written before the plaintext primary. Admission pins the
canonical payload digest, timestamp, schema version and PII classification.
Identical retries can finish an absent primary using that receipt, before newer
schema validation; conflicting pending payloads refuse. Once a primary exists,
replay returns and indexes that stored winner. Forward projections use
tenant-bound visitor hashes and validate current primaries before returning
events. New projections and receipts contain no raw visitor identity; hashes
remain sensitive linkage metadata while an event is live.

Subject erasure writes grouped, normalized shared consent tombstones before
enumerating authoritative receipts and legacy primaries. Deletion CAS-fences
absent and live primaries/forward rows, then removes every old plaintext forward
key and reverse pointer. Minimal opaque deletion fences remain until tenant
teardown; they retain no event payload, visitor, subject hashes or legacy cleanup
keys. Failed cleanup keeps a discoverable deleting receipt, temporarily including
the legacy keys needed to finish. Boot recovery retries that work and pending
index publication, reports incomplete recovery without logging identities, and
never invents a missing payload. Retention and demo seeding use the same owner.

Old unversioned backfill markers are upgraded by reindexing canonical primaries.
Forward-only legacy rows are cleaned independently: deleting visitor A's obsolete
projection cannot fence visitor B's current canonical event. Readers exclude
deletion markers before applying the per-visitor cap. Identity matching remains
limited to declared identity/ingest-classified fields and uses the same phone
normalization for admission, erasure and legacy cleanup; the existing unknown-key
and unresolved-identity limitations remain.

Deployment must drain old revisions before treating these CAS guarantees as
complete: an old binary's unconditional writer does not honor the new owner.
There is no lease expiry, automatic readmission, or exactly-once side-effect claim.
Opaque fences are not a substitute for erasing other features' data. The existing
CDP eraser is the authority for the primary and both projection collections;
its cleanup is incomplete if any strict storage operation fails.

Twenty file-backed ownership cases are authored, covering physical CAS races,
restart before/after primary publication, pinned schema receipts, cleanup faults,
legacy migration/orphans, phone identity, tenant separation, actual erasure
fanout, cap behavior and tenant teardown. They have not executed: the canonical
train owns the sole monitored validation slot. Source review found no additional
P0/P1 blocker in this repair, but executable validation and the complete P0 gate
remain required before integration. This supersedes the preceding CDP-blocker
note only for source review, not for merge readiness or later lead phases.

### Correction — P1 lifecycle and dispatch authority (2026-10-24 recovery)

The original P1 implementation reserved only `pendingRunId` and restored an older
row after a failed start. It also trusted node-supplied model arguments and did
not fence lead companions against contact deletion/erasure. Those assumptions
are corrected together, before P1 is released:

- The existing reverse binding is the durable binding receipt. Its generation
  identifies one contact/client binding; closure is permanent. Contact erasure
  closes admission first, then CAS-writes PII-free fences to profile and grade
  primaries, including absent companions. Delayed inserts and updates cannot
  land after completed cleanup. Recreating a contact at its old id cannot revive
  that binding; a new contact incarnation is needed. Ordinary CRM deletion uses
  the existing best-effort lifecycle hook; the DSAR eraser performs strict,
  retryable cleanup and reports contention. Read paths also check the live
  contact and binding. No timer or missing secondary marker reopens authority.
- Binder attribution starts as `ERASED` plus a tenant-salted receipt on the same
  profile CAS row. Grouped consent tombstones and a fresh-row attribution CAS
  prevent a paused binder from republishing an erased subject. The existing CRM
  eraser scans authoritative tenant prefixes, including missing-index rows.
- A grade dispatch durably reserves the run id, binding generation, immutable
  model id/version/content hash, trusted chain definition hash and a salted
  requester receipt before insertion. The trusted chain is resolved through
  `getChainBackedWorkflow` and `startWorkflowRun`'s `expectedDefinitionHash` seam.
  The run carries the same host-written pin; missing node arguments use that
  pin, and conflicting arguments fail closed. Live explanation remains separate.
- A definitive no-start clears only its matching pending reservation, preserving
  completed results. It never restores older pending authority. An uncertain
  insert/acknowledgement retains the reservation; retry reconciles the same run,
  inputs, requester and host stamp before reporting it started. A completed
  grade clears the pending reservation. A stale or forked run cannot record.

These are host-extension storage/run-stamp corrections; no OpenWOP wire shape,
capability or normative protocol contract changes. The existing CRM eraser,
CRM lifecycle seam, DurableCollection CAS and run starter remain their owners.
File-backed CAS/restart, raw-attribution, model-pin and failed-start witnesses
are being validated in recovery; this note does not claim a completed gate.

The grading POST also accepts the standard `Idempotency-Key` through the existing
ADR 0549 HTTP ledger, with a closed endpoint identity and a digest bound to the
authorized client/contact/requester. The run starter forwards the existing
`InsertRunOptions.idempotencyCommit`: the cached 202 response, run and outbox
commit atomically. A retry therefore recovers its original run/model even after
the grade has completed and cleared the pending projection. A distinct request
key cannot adopt another in-flight reservation. Authorization, toggles and the
live lead check precede replay. Requests without a key retain their prior
behavior; they do not receive a cross-request exactly-once promise.

Model routes register before the generic lead-grading routes, so a model named
`grade` cannot be shadowed by `/:contactId/grade`. The explicit
`/models/:modelId/versions` read makes every permitted model id addressable,
including `active`; `/models/active` retains its active-selection meaning and
the existing shorter version-list alias remains available for other names.


### Recovery checkpoint — P2 source retained, not validated (2026-10-24)

Original P2 head30797b258 is being integrated above the hardened recovered P1.
The P1 binding/erasure fences, model/definition/cause reservations and uncertain
start handling take precedence over the older overlapping implementations.
Original P1 ancestry is retained without reverting these fixes. No P2 runtime
validation is claimed at this checkpoint. Generated floor/parity/served records
remain pending official regeneration after the active independent gate.

P2 must not ship until assignment reconciles a recorded decision after an
interrupted profile/contact write, old routing epochs cannot overwrite newer
ones, capacity reservations withstand concurrency, and the route starter uses
the same frozen admission and uncertain-start semantics as grading. Primary
profile writes must preserve internal binding receipts instead of comparing a
public projection. New routing data also needs the existing contact/subject
erasure fences and ownership closure. The original source and tests remain
available while these corrections are completed.


The recovery source now separates the raw live profile used for mutation CAS
from its public projection. Routing epoch and owner writes retain private
binding/attribution receipts, refuse closed bindings and compare the expected
routing epoch before assigning. Four file-backed SQLite witnesses are authored
for retained binding across restart, stale-owner refusal and erasure crossing
either primary CAS. They are not yet executed while the independent app gate
occupies the sole heavy slot. Cross-owner decision/contact completion, strict
capacity reservation and route-run admission remain blockers.

### Recovery decision — P2 assignment primary (2026-10-25, implementation in progress)

The unmerged routing prototype wrote `crm:lead-route`, `LeadProfile.owner` and
then the tenant-wide `Contact.owner` independently. Returning the first record
on retry could strand the assignment; the client-scoped workflow could also
replace a general CRM contact owner after a newer routing round won.

Keep client lead assignment and its routing decision together on the existing
raw `LeadProfile` primary, under the same binding/closure/epoch CAS. Historical
routing decisions remain private companions in that primary and are read only
through the live binding. A closed primary fences both assignment and history
atomically. Do not mirror client routing into the tenant-wide Contact owner;
territory matching of a lead uses its client lead owner. Existing general CRM
contact ownership remains owned by contactsService. This removes a second write
owner rather than adding another transaction/receipt system. The legacy
`crm:lead-route` source is retained in original merge ancestry; its unmerged
dev rows confer no current assignment authority.

This decision resolves the interrupted decision/assignment boundary and the
old-round Contact overwrite. It does **not** by itself resolve concurrent
capacity reservation, dispatch ownership, policy/history subject erasure or
notification acknowledgement. These remain release blockers. In particular,
the private history needs a bounded size policy and the existing staged
attribution/tombstone pattern before P2 can ship. No runtime validation is
claimed while the separate foundations/experiments gate owns the heavy slot.

Route dispatch reuses the grading starter/response path. Its additional epoch
and frozen reservation belong to the same raw LeadProfile CAS; the grade row is
only the existing scoring projection. A retry reuses the reserved run, model,
definition and cause, including after an uncertain start acknowledgement.
Routing keeps its grading reservation through assignment/run completion.
Terminal or definitively absent-chain cleanup clears only its own reservation,
never rewinds the epoch or resurrects an older dispatch. The host's existing
HTTP idempotency ledger gains the route endpoint; no new queue or daemon.
Implementation and HTTP interleaving validation remain in progress.

Capacity source uses tenant-salted owner/contact reservation hashes in the
existing `crm:lead-rr` routing pointer owner, not a second lead store. Every
strategy reserves pending capacity before the primary assignment. Capacity
admission CAS counts the union of actual open owners and pending reservations,
deduplicated by contact. A reservation never expires on time or on a thrown
commit acknowledgement; only a newer primary epoch, closure or a different
committed assignment proves it stale. Concurrent last-slot and restart witnesses
remain required. No local capacity test has run yet; this remains unvalidated.

Source now stages hashed routing participants on the same profile before the
owner/history publication CAS. Subject erasure redacts committed owner/history
and removes staged receipts; a late writer either sees the tombstone or loses
that exact CAS. Policy saves use the same staged-primary pattern with safe
empty content, and fail closed while publication is incomplete. Erasure removes
recipients from authored rules and seals a staged policy. These redactions are
the explicit privacy exception to immutable policy versions. Private history
refuses new writes above256 rounds or1MiB, retaining all existing records rather
than truncating them. No source is claimed validated yet. Direct bare owner
writes were removed; the only routing owner write also records its decision.

Prepared HTTP witnesses now cover both grading and routing on the same existing
app fixture: before/after-insert uncertainty with active-model changes,
exact keyed response replay, real durable outbox recovery, frozen-model branch
forks, metadata-spoof rejection and grading after a completed route. Routing
clears only its own grade projection reservation after its primary decision
commits; a replay reconciles that cleanup. A later grade reconciles a terminal
route reservation instead of requiring an extra routing round. Runtime/type and
generated-source validation still await the free heavy slot.

Recovery focused validation (2026-10-25): backend types and pack/surface parity
passed;93cases in8files passed, including13file-backed SQLite profile/policy
cases and actual HTTP/outbox/fork/spoof and last-slot capacity witnesses. The
served-set generator adds only the new replay-served route node (floor355→356,
served312→313); undischarged43/unresolved0 and known parity drift remain unchanged.
The wider composition, frontend gates and complete canonical CI are pending.


### Recovery review and validation — P2 (2026-10-25)

Correction to the in-progress blocker list above: assignment notifications use
this host's existing best-effort notification emitter. The primary assignment
and immutable routing decision are the product authority; notification delivery
is not a prerequisite for retaining that assignment. A deterministic notification
id limits duplicates where the emitter supports it, but a process exit between
assignment and emission can lose that notice. This phase does not promise a
notification acknowledgement or introduce a second outbox. P3's SLA escalation
and reroute acknowledgement gaps remain separate, unintegrated blockers.

The primary/epoch/start/capacity/privacy blockers above are now covered by actual
runtime witnesses. Backend types and93cases across8files passed, including13
file-backed SQLite cases. The full foundations/experiments/routing composition
then passed227cases across26files, frontend lint, the canonical frontend build,
frontend test types, feature dependencies and regenerated floor/parity/served
checks. A final27-case run passed the SQLite/census/routing files and types after
repairing same-round duplicate executors: both return the immutable winning
owner, and a losing owner's capacity claim is released even while the primary
round is still pending. Nine distinct concurrent arrivals still rotate fairly;
two distinct leads cannot both consume the final capacity slot.

The chain loader measured248chains, exactly131whole-value unfilled parameter
chains and36embedded cases. The newly admitted internal route chain has a real
starter/executor witness: empty inputs fail at its first grade node with typed
validation_error, never execute the route node and change no lead profile. This
accounts for one actual internal chain and does not waive an existing chain.

Combined generated floor364/served321 retains undischarged43/unresolved0 and the
existing known parity drift. No test skip, budget widening, forced Tracegate
enforcement or runtime disable was added. Canonical full CI on current main,
merge verification and deployment are still required. The original P2 ancestry
and earlier checkpoint notes are retained; P3/P4 source remains unintegrated.


### Recovery checkpoint — P3 source composition (2026-10-25)

Original P3 headc90be0ad1 is retained above the P2 recovery candidate in an
isolated branch. Overlapping raw-profile, dispatch, epoch and surface guards
retain P2's stronger implementation. This source is NOT validated or ready:
routeRun still needs the single shared frozen admission recipe and durable
same-child reroute reconciliation; settings need concurrent partial-write CAS
and recipient attribution erasure; rung publication must confirm actual durable
notification delivery, retain uncertain acknowledgements and fence forks,
closed bindings and subject/contact erasure. Generated snapshots await the sole
heavy slot. Original P3 fixture assumptions require updating to real frozen
routing reservations. P2's canonical candidate remains unchanged in its own
train; no P3 code is included in that gate or a ready PR.


P3 settings source repair prepared (not executed): partial edits now compare the
actual settings primary and retry stale reads; a distinct in-flight save gets a
typed conflict instead of a lost update. New recipient/editor attribution stages
hashed receipts on the same primary before tombstone reads and raw publication.
CRM's existing subject-erasure pass redacts committed fields or seals an
in-flight publication. Five real SQLite cases are authored for disjoint edits,
stage-ack loss/restart and erasure crossing either physical CAS. These and the
remaining P3 dispatch/rung repairs are not validated while the independent P2
train owns the sole heavy slot.


P3 admission refactor prepared (not executed): the P2 HTTP admission body has
been moved mechanically into one `admitLeadDispatch` helper, preserving the
existing HTTP response ledger and run/outbox commit. The older P3 independent
bump/stamp/start/unconditional-undo recipe is removed. Manual route admission
reuses this helper. SLA reroute explicitly refuses until a stable child
reservation on the existing primary is implemented; it must not silently take
the older unsafe path. This branch is WIP, not a functioning or ready P3 release.

P2 canonical gate4 completed2761passing backend files/22963passing cases with
exactly2audit failures and0Tracegate misses: the new frozen verifier needed its
narrowing-only reader registration, and the ledger tripwire incorrectly assumed
one endpoint per module. The repaired audit requires exactly one reviewed owner
for every endpoint plus an exact owner set and a real header read per owner.
The lead route now uses the scanner's canonical header accessor. No namespace,
allowlist wildcard or exemption was added. Backend types and65focused cases
across7files pass after repair. A new actual assignment-CAS/access-loss witness
also proves a late notice is suppressed; notices carry only an opaque lead
reference, without contact names, and recheck the live owner and write access.
Canonical retry5 is required before merge. Peak focusedRSS3.15GiB, no swap growth.

P3 also retains P2 canonical retry5 source6298a8fe6 and its private late-notice/access fence. P3 remains unvalidated and is not in that running candidate.


P3 reroute decision (implementation begins, unvalidated): derive one stable
child run id from the primary's recorded source run and routing epoch. The
existing profile CAS reserves the next epoch only from that exact source, or
returns the already reserved same child. The same frozen admission helper
starts/reconciles it, retaining authority on ambiguous acknowledgement. A
persisted child is a fact even after another operator advances the lead; retry
must not mislabel its own admitted child as a never-started superseded action.
The old assigned owner is excluded by a tenant-salted hash derived from the
source decision inside that CAS; callers cannot supply recipient identities or
an exclusion grant. Host-stamped parent frame/hash inputs are verified on every
new routing effect. No new queue, daemon or transaction store is introduced.


P3 child-admission source prepared (not executed): the existing profile CAS now
returns the same reserved source child and winning frozen model under contention,
compares the exact recorded parent, and refuses a newer manual epoch or closed
binding. Three SQLite witnesses are authored for those boundaries. Child run ids
are deterministic and an existing persisted child is reconciled before changing
primary admission. Parent/exclusion hashes are host metadata, not caller params;
route effects verify those same hashes. Grading and a fresh manual Route can
supersede only the completed assignment portion while its old clock waits. The
old clock must then stop on the changed epoch. Actual HTTP/outbox/clock witnesses,
notification-rung acknowledgement/erasure fences, generated records and all
executable validation remain required; this is still not a ready P3 release.

### P3 recovery correction — pending effects and inbox receipts (2026-10-25)

The original rung prototype claimed a final result before notifying. A crash
between the two permanently lost the notice. Rungs now reserve a pending
state containing only a salted recipient hash; the existing notification
owner's unique id is the durable delivery receipt. A failed write stays
pending; an uncertain acknowledgement is reconciled by reading that exact
inbox row before final CAS. Concurrent attempts converge on the same row.
SSE, push and email retain the existing best-effort delivery contract; the
claim is one durable inbox row, not exactly-once external delivery. Copy is
generic and contains opaque client/lead references, never contact names.
The existing CRM subject eraser seals pending hashed recipients; a writer
that crosses erasure rechecks its primary and removes its inbox row.

The same shared frozen admission owner serves HTTP grade/route and SLA child
runs. A child id derives from its recorded parent and epoch; uncertain child
admission reconciles that same run even after another manual routing round.
The primary LeadProfile CAS, actual run stamp and live cause authorization
remain the authority. No second queue, transaction store or polling worker.

Validation pending: new SQLite inbox/CAS recovery witnesses plus actual chain,
HTTP admission, clock and fork tests; do not treat this source note as a pass.

P3 graph correction: a conditional tail ending only at rung3 left every terminal
node skipped for a client without an SLA or after a successful first touch,
which the existing scheduler correctly reports as no successful terminal. The
chain now joins every lifecycle node with `none_failed` before a pure projection
of its recorded route outcome. It waits for all branches, accepts intentional
skips and refuses actual predecessor failures. No scheduler change or second
clock is introduced. The primary route result is preserved at completion.

Scheduler correction required by the P3 join: `releaseDownstream` used a
visited set for pending nodes. It examined the join before a skipped tail
settled, then refused to reconsider it in that same propagation pass, leaving
a ready join pending and failing the run as stalled. Remove that visited bit;
terminal node state deduplicates propagation, and each skipped node enqueues
its outgoing edges only once. The four-node regression demonstrably fails
before this change (pending instead of ready); its real-failure leg remains
skipped/failed. Full scheduler and app gates remain required.

Fork terminology correction (P3): the original test said a *replay* fork before
an unresolved timer creates the same timer. Strict replay must never create an
unrecorded side effect; an unresolved source wait has no completed outcome,
so the accepted replay guard correctly refuses it with replay_source_missing.
The supported continuation is a *branch* fork whose inherited prefix includes
the recorded deadline, then creates its own future timer at that exact instant.
The integration witness now asserts BOTH the strict replay refusal (no new
interrupt) and this prefix-based branch continuation. No replay exception or
wire change is introduced.

P3 deadline transport correction: a branch cut after deadline computation
restores node outputs but intentionally does not replay private variable-bag
mutations (the executor's documented HVMAP-2 limit). Therefore SLA deadlines
now flow over explicit DAG edges into an optional timestamp input on the
EXISTING core.flow.wait primitive. Its config timestamp remains the backwards
compatible fallback. core.openwop.flow1.2.0 adds this optional input; no new
timer owner or interrupt type. Rungs return their immutable source SLA snapshot
to the next pure deadline calculation. The chain no longer declares or mutates
produced deadline variables. Publication and directly approved production pin
change are required before deploying this pack version.

P3 focused validation completed2026-10-25: backend types GREEN; pack/surface
parity6/6, full focused13files172cases GREEN, including real HTTP admission,
SLA timer/fork/strict-replay, same-child outbox recovery, SQLite inbox/settings/
routing CAS and erasure, complete scheduler suite and flow timestamp fallback/
validation. The scheduler regression was observed RED before its repair.
Official trust/floor/served/dependency records regenerated;785nodes scanned,
floor365/served322/undischarged43/unresolved0, no parity debt added. Peak3.37GiB,
no resource stop. Full canonical merge gate and flow1.2.0 publication/pin approval
still required before release. Other unfinished ADR0954 phases remain open.

Canonical P3 gate1 found a security interaction in existing chains: revisiting
waiting joins exposed that the scheduler treated a skipped approval following
a FAILED producer as the same state as an intentionally untaken conditional
branch. A completed data sibling could then release all_success/none_failed
work without the gate. The repair derives unrecovered failure through only
skipped predecessors from the existing graph/state. Those two success rules
refuse that failure; an actually completed error handler ends propagation.
Intentional conditional skips and explicit all_complete/any_failed recovery
retain their behavior. No new trigger rule, status, event field or capability.
The existing whole-chain gate-bypass census must pass without added exemptions.
New small scheduler witnesses cover both blocked approval bypass and a genuine
completed recovery boundary. The first fullbackend gate had2762passedfiles,
4failedfiles/5cases,23001passedcases and0Tracegate misses; it merged nothing.
The other reds required classifying the new CRM pre-reservation guards under
the existing run/inbox seams and exposing wait.timestamp in the schema-response
witness. Full canonical retry remains required.


Recovery checkpoint (2026-10-25): the original P4a commit is being integrated with the later frozen-admission and erasure repairs. Its historical P4 claims above are not a current release claim. P4 is unvalidated until its evidence authority, primary publication and widget attribution corrections pass focused behavior tests and canonical CI. P1–P3 repairs remain intact.

### P4 recovery correction: evidence retention and replay ownership

The prototype put raw contact/activity/visitor evidence in `node.completed`,
then treated its combined AI/assessment node as if the ordinary side-effect
fast path served it. That is incompatible with both contact erasure and the
existing ADR0326 invocation-log replay owner. The source review and focused
tests caught this before release; no P4 source has merged or deployed.

The qualification read is a declared side effect: it freezes evidence once on
the existing grade primary, beside the admitted run/model/definition/cause pin.
The same primary closure CAS removes its text and prevents late publication.
Its event output carries only opaque references/fingerprints and model metadata.
It is served by the normal side-effect fast path, so forks never re-read and
silently change that snapshot. The assessor obtains the erasable snapshot through
the CRM read surface; neither caller-supplied evidence nor a claimed read set
grants authority. Live acceptance requires the cited content still to match.

The AI calling node remains on ADR0326's invocation-log path. A strict replay
may read the source qualification snapshot using its stored admission pin and
actual parent run, and may resolve its recorded assessment without a new write.
A branch fork has no admission to publish another assessment. Erasure makes
the source unavailable; it never grants authority to reconstruct erased text.
An immutable event is not rewritten or extended, and no protocol capability or
event shape changes. Histories are bounded and refuse overflow while retaining
all previous records. Both a successful source and a source requiring one repair
need real starter/executor replay witnesses before this correction is released.

Implementation status: prepared; focused behavior/erasure/replay witnesses,
generated metadata and canonical CI remain required. No new exemption, forced
Tracegate mode or arbitrary census ceiling is authorized by this correction.


### Recovery validation checkpoint — 2026-10-25

P3 is independently verified merged as d62dd21e5; its tree equals the full
canonical gate (22b9ca3deddff79a340e74dbc2ba2de13eec7c3e). The current P4a
candidate retains the original b358218f6 commit as merge ancestry and every
P1–P3 ownership repair. P4b's agent/adjustment approval and later UI/provider
work remain open; this record does not mark the entire ADR implemented.

P4a validation: backend TypeScript green; 19 focused regression files /175cases
passed, then the final changed fixtures/types/parity passed31cases. The final
cases also cover previously unbound visitor contacts, a failed assessment's
strict replay, successful and repair replay plus replay-of-replay without a new
provider dispatch or divergence, actual SQLite lost-ack/restart and crossed
publication/erasure, and a param-less internal chain's first-node refusal.

The generated census scans787nodes: floor367, served324, undischarged43,
unresolved0. The ordinary fast path serves the evidence-freeze writer; the AI
node uses the existing invocation log. Pack/surface parity has0knownDrift and
12opaque methods, unchanged from the gated P3 baseline. The one new internal
chain is explicitly accounted131→132 with its real no-effect witness; no
existing chain's regression or general ceiling waiver is admitted. Canonical
CI and merge verification remain required before release.

P4a canonical preflight correction (2026-10-25): integration initially restored
three obsolete SLA produced-variable declarations from the old P4 branch.
Removed them: P3's recorded edge inputs remain the deadline authority, and
`crm-ops.route-lead` is byte-semantically unchanged from merged main. The new
qualification chain is reached through its client-scoped endpoint; no new
Leads-tab action is claimed by this backend phase. Full canonical CI remains
required before merge.

P4a canonical schema correction (2026-10-25): the anonymous qualification tool
returns only a write acknowledgement, so its schema-carrying classification is
false. Its answer values are bounded text, matching durable statement storage;
a numeric answer is expressed as text. This removes an unrepresentable Gemini
string/number union without growing the free-form-schema allowance or adding
a result-compaction exemption. Canonical audit failures are retained.
