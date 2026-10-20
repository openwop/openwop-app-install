# ADR 0955 — Lifecycle journeys over email and SMS

Status: Proposed

Date: 2026-10-19. Program: Campaign Studio (ADRs 0941–0962), Tier 2 — channels.
Net-new feature planned with `/feature-refinement`; not a MyndHyve port.
Depends on: 0941 (canonical campaign), 0942 (autonomy policy and the one gate),
0905 (email templates, send approval, topics). **Integrates with, not depends on**
(ADR 0941 D7): 0949 (D6 experiments, P3; the program's known soft dependency —
until 0949 lands the journey split keeps today's `bucketHoldout`), 0950 (the
`test-then-winner` blueprint, P5) and 0954 (D1 lead binding). Feeds 0954 (SMS
conversations, the one eligibility function), 0956 (attribution), 0957 (reports).
Composes: 0222 and 0267 (journeys), 0227 and 0394 (consent channels), 0217 and
0241 (suppression, bounces), 0619 (egress ledger), 0921 (agency = workspace,
client = org).

## Context

Campaigns need nurture: welcome, abandoned-signup, post-webinar and re-engagement
flows over email and SMS. Each flow needs consent, quiet hours, STOP handling,
send-time choice, testing and deliverability protection. Klaviyo, Braze and
GoHighLevel ship these as a proprietary flow builder. In those builders, an AI
step's output goes straight to the send, and a flow cannot be replayed.

The brief asked this ADR to pick ONE owner between "workflow-chain journeys" and
"CDP journeys (ADR 0267)" and not to create a third.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `packs/` or
`docs/`.

**There is already one journey owner. The brief's two candidates are the same
thing.** ADR 0222 (implemented) decided "Journeys ARE workflow chains" in the
`campaign-journeys` feature: an enrollment ledger plus an eligibility composite,
and everything else is shipped nodes (`docs/adr/0222-campaign-journey-chains.md`).
ADR 0267 (CDP-E) extends **the same feature and executor**: the durable timer,
the segment-entered trigger, holdout and frequency. Its text says "no second
engine". The code agrees. `features/campaign-journeys/feature.ts:16-34` is one
toggle. `surface.ts:40-55` exposes `enroll`, `checkEligibility`,
`checkEngagement`, `checkFrequency`, `resolveSegment` and `bucketHoldout`.
`holdoutArm` (`surface.ts:17-21`) uses the shared `bucketOf`
(`host/variantAssignment.ts:35`).

**The real second lane is broadcast email.** ADR 0905 keeps the campaign blast
as "a host route, not a run" (`email-campaign-send` approval kind,
`features/email/sendApproval.ts:283`). That is a correct split, broadcast versus
journey, but the two lanes must share gates.

**Gaps:**

| Gap | Evidence | Consequence if ignored |
|---|---|---|
| J1 SMS eligibility needs an email | `checkEligibility` takes `channel` but returns `no_email` before consent (`journeyService.ts:202-217`) | A phone-only contact can never receive a journey SMS |
| J2 Suppression is email-keyed and tenant-wide | `isSuppressed(tenantId, email)` (`features/crm/suppressionService.ts:113, 155`) | No SMS suppression. In an agency, a bounce for client A also suppresses client B |
| J3 `marketing.sms` is not strict opt-in | `STRICT_EXPLICIT_OPT_IN` holds only WhatsApp (`features/consent/consentService.ts:56`); the toggle off means permissive (`:909`) | Marketing SMS could go out on an opt-out default or an umbrella `marketing` flag, which fails TCPA's prior-express-written-consent rule |
| J4 The generic SMS node ignores consent | `smsSend` calls `ctx.messaging.sendSms` directly (`packs/core.openwop.integration/index.mjs:184-193`); the adapter checks only the WhatsApp prefix and the idempotency ledger (`host/smsAdapter.ts:47-108`) | Any chain can text anyone, including someone who sent STOP |
| J5 No inbound SMS, so no STOP | `InboundProvider` has no SMS member (`features/connections/inboundWebhooks.ts:65`). The keyword ladder exists only for WhatsApp, keyed on the phone number (`features/whatsapp/compliance.ts:78-118`) | A STOP reply is lost. Journeys key consent on `contactId`, WhatsApp on the number: two subject keys |
| J6 No quiet hours for marketing, no contact timezone | Quiet hours exist only for notifications (`host/notificationPolicy.ts:56`); `Contact` has no timezone (`features/crm/contactsService.ts:79-120`) | 2 a.m. texts |
| J7 Frequency counts email only | `contactSendCount` (`features/email/emailService.ts:673`) used by `checkFrequency` (`journeyService.ts:236-245`) | SMS sends do not count against the cap |
| J8 Engagement reads scan the tenant | `checkEngagement` → `listEngagement(tenantId)`, then filters (`journeyService.ts:227-233`; `engagementService.ts:537`) | Per-contact branching and send-time optimization would be O(tenant) |
| J9 Enrollment carries no client | key `${tenant}::${journey}::${contact}` (ADR 0222) | Client A's journey run can act on any contact in the agency workspace |
| J10 No deliverability circuit breaker | Hard bounces and complaints suppress addresses one by one (`features/email/bounceWebhooks.ts:1-16, 205-260`); no rate-based pause | A bad list burns the client's sending domain before anyone notices |

Journey reads are live by design (`journeyService.ts:218-224`): a journey is a
live marketing flow, and enrollment CAS is the idempotency guard. This ADR keeps
that, and freezes only the decisions that steer branches (D5, D6) in node
outputs.

## Decision

### D1 — One owner: `campaign-journeys` chains. Broadcast stays in `email`.

- **Lifecycle flows** (anything with a trigger, waits, branches or per-contact
  state) are chain packs run by `campaign-journeys`. CDP-E is that same feature,
  not a peer. Journey blueprints ship as chain packs (`core.openwop.workflows.campaign-journeys`
  plus Campaign Studio blueprints, ADR 0959). A client gets a tenant-owned,
  builder-editable copy through `…/workflows/from-chain`.
- **One-off blasts** stay ADR 0905's `sendCampaign`.
- **No third lane.** A "flow builder" UI is the builder canvas scoped to the
  journey palette (ADR 0267 §4), not a new editor.
- **Client binding (J9).** Every journey run is stamped `orgId` (ADR 0921 D3).
  The enrollment key becomes `${tenant}::${orgId}::${journey}::${contact}`. Legacy
  rows read as `orgId: ''`, allowed only in tenants with no `ClientAccount`. The
  surface refuses `wrong_client` when a node's `orgId` differs from the run
  stamp. When ADR 0954's `crm.lead-intelligence` is on, the contact must also
  carry a `LeadProfile` for that org (ADR 0954 D3); before 0954 lands, the
  enrollment's `orgId` comes from the enrolling surface (form, funnel, campaign).

### D2 — One eligibility function per channel, enforced again at the exit

`checkChannelEligibility(tenantId, orgId, contactId, channel, {purpose, topicId?})`
replaces the email-shaped composite. Its reasons are a closed set:
`contact_not_found | no_address | consent | consent_unreadable | suppressed |
suppression_unreadable | topic_opt_out | quiet_hours | frequency_cap |
deliverability_paused`.

- **Address by channel.** Email uses `contact.email`. SMS uses the E.164 phone
  identifier (`contact.identifiers`, ADR 0383). This fixes J1.
- **Consent** goes through `consentService.isAllowed(…, marketing.<channel>,
  {topicId})`, which is the ADR 0905 D7 narrowing. There is still one evaluator.
- **Suppression gains a channel and a sender scope (J2).** Entries become
  `{channel: 'email'|'sms', address, senderOrgId?, reason}`. A hard bounce or a
  STOP to one client's sender suppresses that sender. A complaint or STOPALL
  suppresses tenant-wide. Existing rows read as `email` and tenant-wide, so
  nothing gets less strict.
- `sendCampaign` (broadcast), the journey send nodes and the ADR 0954
  outbound-contact path all call this one function.
- **The exit guard (J4).** `host/smsAdapter.ts` refuses a send to an
  SMS-suppressed number (`sms_recipient_opted_out`) for every caller, marketing
  or not. A STOP is absolute. The guard sits at the exit because a writer-side
  check only covers the writers someone remembered. The generic `sms-send` node
  stays consent-agnostic for transactional use. Marketing SMS uses the new
  `feature.campaign-journeys.nodes.send-sms`, which runs eligibility first.

### D3 — SMS consent and STOP handling

- **`marketing.sms` joins `STRICT_EXPLICIT_OPT_IN` (J3).** Only a recorded
  explicit `true` permits it: no umbrella fallback and no opt-out default, the
  same as WhatsApp (ADR 0394). Consent is captured through the forms consent
  sink (`features/email/formsConsentSink.ts`) with the disclosure text version,
  timestamp, source and number. Records written before this change that have
  only the umbrella flag stop permitting SMS. See Q1.
- **Inbound SMS (J5).** A new `twilio-sms` `InboundProvider` in
  `connections/inboundWebhooks.ts`, verified by the `X-Twilio-Signature` header,
  with the tenant and org resolved from the stored number binding, never from
  the request.
- **One keyword ladder.** `applyInboundKeyword` moves from `whatsapp/compliance.ts`
  to `features/consent/keywordLadder.ts`, taking a channel parameter.
  WhatsApp keeps its behaviour. The SMS keywords are STOP, STOPALL, UNSUBSCRIBE,
  CANCEL, END and QUIT (opt out); START and UNSTOP (opt in); HELP (help text). It
  sends one confirmation reply through the transactional lane. Opting out writes
  a CAS consent merge on **both** subjects (the number and every contact
  resolved through `contactIdentityService`), which reconciles J5's two keys.
  It also writes an SMS suppression entry and emits `host.sms.consent.opt-out`.
  Active enrollments stop at their next eligibility re-check (ADR 0222's
  re-check after every wait).
- Keyword handling runs in an **observer**, ungated by plan or toggle (the
  WhatsApp rule): an opt-out applies even when the feature is off. Non-keyword
  messages go to ADR 0954 D7's conversation lane.

### D4 — Quiet hours

A per-client `ChannelSendPolicy` (`campaign-journeys:send-policy`, key
`tenant::orgId`): `{defaultTimezone, windows: {sms: {start:'09:00', end:'20:00'},
email?: …}, regionOverrides}`. The recipient's timezone comes from, in order: a
contact `timezone` custom field, the phone number's country or area code, then
the client default. When the source is ambiguous, the window is the
intersection (the conservative choice). `next-send-window` computes `resumeAt`,
then `core.flow.wait until` (the ADR 0267 durable timer). The send node checks
again and refuses `quiet_hours` if the window has passed, which loops back to
the wait. The legal default table (TCPA 8–21 h, stricter state rules) is
configuration with conservative defaults. See Q2.

### D5 — Send-time optimization: deterministic and explainable

`feature.campaign-journeys.nodes.send-time` reads the contact's opens and clicks
from the last 90 days through a **per-contact engagement index** (fixes J8).
With at least 5 events it picks the modal hour-of-week. Otherwise it uses the
client cohort's modal hour, then the template default. It clamps to quiet hours,
delays at most 24 h, and outputs `{sendAt, basis, histogram}`. The output is
recorded, so replay waits for the same instant. No model and no vendor black
box: the operator sees why 10:00 Tuesday was chosen.

### D6 — Experiments through ADR 0949, not beside it

- The journey split (`bucketHoldout`) and email subject or content variants
  register as **ADR 0949 experiments**: one experiment record, one bucketing
  primitive (`bucketOf`), pre-registered primary metric and guardrails
  (unsubscribe rate, complaint rate, SMS opt-out rate). The arm is recorded in
  the node output.
- A variant email is a set of ADR 0905 template versions. The approval pin
  becomes a **variant-set pin** `{variantId → (templateVersion, contentHash)}`.
  An edit to any variant reopens review. This amends ADR 0905 D3. It is not a
  new kind.
- "Test on 20 %, then send the winner" is a chain: split, send, wait, then
  ADR 0950's promotion node. That node owns the decision rules. This ADR only
  supplies the arms and the metrics.

### D7 — Deliverability guardrails (J10)

- **Domain auth precondition.** A marketing email send needs a verified sender
  (`listVerifiedSenders`, `emailService.ts:217`) whose domain passes SPF, DKIM
  and DMARC. **No such check exists today** (a repo grep for DKIM finds
  nothing, and ADR 0906 covers edge certificates, not mail auth). P4 adds
  `features/email/senderAuth.ts`: DNS TXT reads for SPF and DMARC, plus the
  provider's own domain-authentication status for DKIM, cached for 24 h. A
  failure is refused `sender_unauthenticated`.
- **Circuit breaker per client sender.** Over a rolling window of at least 500
  sends: complaints above 0.1 % or hard bounces above 2 % pause marketing sends
  for that sender (`deliverability_paused`). The pause notifies the client's
  operators and needs a person to resume (ADR 0942 class `email.resume-sending`, never
  `auto`; ADR 0942 D1, PendingApproval kind `email-sending-resume` added by this ADR). It is computed from the bounce-webhook rows and the send ledger.
- **Warm-up caps.** A new sender gets a daily ceiling that grows along a
  configured ramp. Over the ceiling, sends defer to the next day; they are not
  dropped.
- **Bulk-sender basics.** The RFC 8058 one-click unsubscribe headers that
  already ship (`host/emailAdapter.ts`, `host/smtpSend.ts`) are required on
  every marketing send. SMS opt-out rate is tracked as a guardrail
  under D6.

### D8 — Templates and the ADR 0942 gates

- Journey email nodes reference `{templateId, templateVersion}`, pinned when the
  journey is published (ADR 0267 §4 draft/publish). They never render the live
  template. SMS bodies are versioned in the same template store with
  `format: 'sms'`. The 160/70-character segment count and the opt-out footer are
  validated at write. A body without "Reply STOP to opt out" on the first
  marketing message to a number is refused.
- **The gate happens at publish, then within limits.** Publishing a journey
  version is ADR 0942 action class `journey.publish` (ADR 0942 D1; PendingApproval kind
  `journey-publish`, added by this ADR), resolved from the client's policy (an absent policy means
  `approve`). Each send still passes its own chokepoint class (`sms.send` at
  `smsAdapter`, ADR 0942 D1), which a published, approved journey version
  normally resolves `auto` within caps under the policy frozen at run start.
  Approval covers the pinned content plus the audience definition (ADR 0905's
  hash-the-definition rule). Each send then proceeds automatically inside hard
  caps (sends per day per client, per contact frequency) that hold whatever an
  approver did. `notify-after` digests list what was sent.
- The Lifecycle Marketer agent (ADR 0943) drafts templates (ADR 0905
  `submit-for-review`) and journey drafts (the workflow-author draft → validate
  → persist trio). It has no send tool.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `features/campaign-journeys/` (eligibility, send policy, send-time, SMS send node surface), `features/consent/` (strict SMS, keyword ladder), `features/crm/suppressionService.ts` (channel and sender scope), `features/connections/inboundWebhooks.ts` (`twilio-sms`) and `features/email/` (variant-set pin, breaker). The `host/smsAdapter.ts` exit guard is the one core touch, a refusal branch. |
| 2 | Toggle | `campaign-journeys` stays (OFF, tenant). New sub-toggle `campaign-journeys.sms` (OFF, tenant), an `extraToggleDefaults` entry of `campaign-journeys` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `campaign-journeys` and `consent`), gates SMS journey sends. The keyword observer and the adapter's STOP guard are **never** toggle-gated. |
| 3 | Workflow surface | `ctx.features.campaignJourneys`: `checkChannelEligibility`, `nextSendWindow`, `sendTime`, `sendSms`; every method takes `orgId` and checks the run tag (ADR 0941 D2b). |
| 4 | Node pack | `feature.campaign-journeys.nodes` gains `channel-eligibility`, `next-send-window`, `send-time` and `send-sms` (side-effect, ADR 0619 key). Chain pack blueprints: `welcome-series` v2 (email + SMS), `post-webinar`, `abandoned-signup`, `test-then-winner`. |
| 5 | AI chat and envelopes | No envelope. The agent's tools are ADR 0905's draft tools plus the journey draft trio. |
| 6 | Agent pack | ADR 0943 Lifecycle Marketer. Its prompt states "you cannot send or approve", and that line is test-pinned. |
| 7 | Public surface | The inbound SMS webhook (signature is the credential, uniform 401/404, tenant from the number binding). The preference centre gains SMS topics (the existing ADR 0905 public route). |
| 8 | RBAC | Send policy and breaker resume need `host:members:manage` on the client org. Journey publish goes through the ADR 0942 gate. Suppression edits need `workspace:write` on the client org. |
| 9 | Replay / fork | Arms, `sendAt` and `resumeAt` are recorded in node outputs. Sends are ledger-idempotent. Eligibility stays live, so a fork re-checks consent and never sends to someone who opted out since. |
| 10 | Frontend | The journey canvas palette (ADR 0267 §4) gains SMS, send-time, quiet-hours and experiment-split nodes. A client sending-health card (bounce and complaint rates, breaker state, warm-up). SMS consent capture in the forms builder. Four locales. |

## Why this is our advantage

- **Replayable journeys.** Every contact's path is a run. "Why did Ana get the
  SMS at 10:04?" is answered by replay: the arm, the send-time histogram, the
  quiet-hours window and the eligibility verdict.
- **Gate at publish, limits at runtime.** A journey runs only at the autonomy
  the client chose (ADR 0942), the approval names the exact content versions,
  and caps hold regardless of who approved. Klaviyo's "nothing goes live without
  approval" stops at launch. Braze's per-user decisions are "hard to trace".
- **Compliance as structure.** STOP is enforced at the adapter, SMS needs
  explicit consent, and quiet hours are a durable wait. None of it is a setting
  someone can forget.
- **Per-client deliverability.** One client's bad list pauses that client's
  sender, not the agency.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `checkChannelEligibility`, channel- and sender-scoped suppression, enrollment `orgId`, per-contact engagement index | Phone-only contact passes SMS eligibility; a client-B enrollment from a client-A run is refused; no tenant scan in `checkEngagement` |
| P1 | Strict `marketing.sms`, `twilio-sms` inbound, shared keyword ladder, adapter STOP guard | A STOP blocks the next send from every caller, including the generic node; WhatsApp ladder tests unchanged |
| P2 | `ChannelSendPolicy`, `next-send-window`, `send-sms` node, `campaign-journeys.sms` toggle, SMS template format | A send outside the window waits and resumes; a fork before the wait inherits `resumeAt` |
| P3 | `send-time` node, ADR 0949 registration of splits, variant-set pin (ADR 0905 amendment) | Same inputs give the same `sendAt`; an edit to one variant reopens review |
| P4 | Domain auth precondition, circuit breaker, warm-up caps | Synthetic complaint spike pauses only that sender; resume needs a person |
| P5 | Blueprints (`post-webinar`, `abandoned-signup`, `test-then-winner` with ADR 0950), canvas palette | Blueprints load with zero chain errors and instantiate per client |

## Alternatives weighed

- **Make CDP journeys a separate engine from chain journeys.** Rejected. They are
  already one feature on one executor (ADR 0222, 0267). Splitting them would
  create the third lane the brief forbids.
- **Move broadcast into a journey chain.** Rejected for v1. ADR 0905's send
  route, pin and batch resume are shipped and correct. Both lanes share D2
  instead.
- **Enforce STOP only in the journey node.** Rejected. Every other SMS writer
  would bypass it (J4). The exit owns it.
- **ML send-time optimization.** Rejected for v1. It cannot be explained or
  replayed, and per-client data is thin.

## RFC verdict

**Host extension, no RFC.** The inbound webhook, consent, suppression and nodes
are host-side or pack-scoped. The durable timer and chains ride RFC 0013 and the
ADR 0267 host extension. Nothing is advertised.

## Open questions

1. **(David)** Strict SMS opt-in drops SMS permission for contacts who have only
   an umbrella `marketing: true`. Accept that (proposed: yes, the TCPA-safe
   reading), or grandfather with a one-time re-permission campaign?
2. **(David)** Legal posture for quiet hours and consent wording: ship
   conservative defaults (9–20 h local, intersect when unsure) and treat them as
   operator-editable configuration, not legal advice? Proposed: yes, with a
   counsel review before the first live US client.
3. **(David)** Suppression scope in an agency: per-client sender for bounces and
   STOP, tenant-wide for complaints and STOPALL (proposed), or fully per client?
4. **(David)** Twilio number provisioning per client is a vendor account and
   spend. It ships disabled with an honest "not configured" state until David
   provides credentials.
5. Breaker thresholds (0.1 % complaints, 2 % hard bounces, window of 500) are
   first guesses from mailbox-provider guidance. Revisit after real sends.
6. No `/architect` pass has been run yet. Run it before Accepted, focused on D2's
   exit guard and D3's dual-subject consent merge.

## Planning rows

**ROADMAP (Campaign Studio program table):**
`| 0955 | **Lifecycle journeys over email and SMS** ([ADR 0955](docs/adr/0955-lifecycle-journeys-email-sms.md)) | `campaign-journeys`, `campaign-journeys.sms` | 0941, 0942, 0905, 0222, 0267, 0227, 0394; integrates with 0949 (soft), 0950, 0954 | `feature.campaign-journeys.nodes`, `core.openwop.workflows.campaign-journeys` | Host extension | 🔵 Proposed |`

**FEATURES "Future features":**
`- **Lifecycle journeys over email and SMS (ADR 0955, Proposed 2026-10-19)** — nurture flows as journey chains (the one owner, campaign-journeys; broadcast stays in email), one eligibility check per channel shared by every sender, strict SMS opt-in with inbound STOP/START/HELP and a STOP guard at the SMS adapter, per-client quiet hours as durable waits, deterministic send-time choice, email and SMS tests through ADR 0949, a per-sender deliverability circuit breaker, and ADR 0942 gates at journey publish. Sub-toggle `campaign-journeys.sms` (OFF, tenant). No RFC.`
