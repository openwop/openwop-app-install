# ADR 0955 — Lifecycle journeys over email and SMS

Status: Accepted (P0/P1/P2a/P2b/P3a/P4a/P4b-warm-up/P5 recovered; qualification pending; P3b, resume-review and test-then-winner open)

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

> **Correction 2026-10-20 (P0 `/architect`): the function lives in `features/crm/channelEligibility.ts`,
> not in `campaign-journeys`.** `campaign-journeys` already imports `email`
> (`journeyService.ts`, `contactSendCount`), so `email`'s broadcast calling into journeys would
> cycle. `crm` owns the two records it reads first (the contact and the suppression overlay) and
> already reads consent, with no reverse edge. `campaign-journeys` exposes it bound to the run's
> client (`checkJourneyChannelEligibility`, the `channel-eligibility` node). **`sendCampaign`
> moves onto it in P2** with the send nodes (it still composes consent, topic, suppression and the
> frequency cap in its loop today); P0 changes no broadcast behaviour.
>
> **Correction 2026-10-20 (P0): suppression keys.** Legacy rows keep `${tenant}::${email}` and read
> as tenant-wide email, so nothing gets less strict and nothing migrates. Every other row (SMS, or
> any client-sender row) lives at `${tenant}::#${channel}:${address}:${senderOrgId|*}` (address first, so every scope of one number is one prefix for the P1 exit guard); readers
> verify the row's own `channel`/`senderOrgId`/`address` after the point get, so a contrived key
> collision can only miss, never misattribute. A check is at most two point reads. Every writer
> shipped before P0 still writes tenant-wide email; P1 (STOP) and P4 (bounces) are the first
> sender-scoped writers. The DSAR leg redacts the `#` rows too.

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

> **Correction 2026-10-20 (P0 `/architect`): who decides `orgId`, and the legacy rows.**
> - The run's client comes from the host-written stamps only: ADR 0921's `openwop-app.campaignOps`
>   (read through `campaign-ops` `runStampOf`) and ADR 0941's run tag `campaignOrchestration.orgId`
>   (read by key until #5050 lands `readCampaignRunTag`; then that one reader replaces it). Either
>   naming another client, or the two disagreeing, is `forbidden_scope / wrong_client`; an unreadable
>   run is refused. A run with a person behind it also needs `workspace:read` on the client.
> - **Residual risk, accepted for v1:** an actorless, unstamped run (an event-triggered journey)
>   takes the chain's `orgId`. The chain was authored by a member with `workspace:write`, but
>   contacts are still tenant-scoped, so nothing yet proves the contact belongs to that client.
>   ADR 0954 D3 (`LeadProfile` per org) closes it.
> - `orgId` resolution: a `ClientAccount` ⇒ that client; the workspace root (the agency's house
>   account) ⇒ `''`; a workspace with **no** client ⇒ `''` whatever org is named (before 0955,
>   `re-engage-contact` passed `orgId` to say where follow-up work lands, so those workspaces keep
>   the ADR 0222 keys byte for byte); otherwise a non-client org is 404 and none is
>   `client_required`.
> - Client keys are `${tenant}::@org::${orgId}::${journey}::${contact}` (and `…::@grp::…` for
>   exclusivity), so they cannot collide with the 3-segment legacy keys. **No double send:** a
>   client enroll first reads the legacy row (and a legacy group incumbent), because a contact
>   enrolled before its workspace had clients would otherwise get the journey twice.
> - The enrollment routes, once a workspace has clients, need `orgId` plus `workspace:read`
>   (list) or `workspace:write` (reset) on that client. They were toggle-only before.

### D3 — SMS consent and STOP handling

> **Decision 2026-10-20 (Campaign Studio decision 6, still open with David): built the strict
> way.** `marketing.sms` joins `STRICT_EXPLICIT_OPT_IN` in P1 exactly as written below; records
> with only the umbrella flag stop permitting SMS. If David chooses grandfathering (Q1), the change
> is a one-time re-permission campaign plus a dated migration, never a looser evaluator.

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

> **Correction 2026-10-20 (P1 `/architect`): what each keyword writes, and to which scope.**
> Consent is ONE record per subject for the whole workspace, while an agency has one Twilio
> number per client. Writing `marketing.sms:false` on a STOP to client A's number would silence
> every client, which contradicts Q3's per-sender proposal. So:
> - **STOP** (UNSUBSCRIBE, CANCEL, END, QUIT) ⇒ a suppression row scoped to that client's
>   sender. No consent write.
> - **STOPALL** ⇒ a workspace-wide SMS suppression row, plus `marketing.sms:false` merged on
>   both subject keys: the number and the contact it resolves to (`cdp:contact-ident`).
> - **START / UNSTOP** ⇒ lifts only that sender's own keyword-written opt-out. It never writes
>   consent (that would widen to every client) and never lifts a STOPALL, a complaint or a
>   manual hold. After a STOPALL only a consent-bearing flow (the preference centre)
>   re-permits. See Q7.
> - **HELP** ⇒ nothing written.
> - The client comes from the stored binding of the `To` number (`crm/smsSenders.ts`, admin
>   routes `…/crm/sms-senders`, `host:members:manage` on the client); an unbound number takes
>   the workspace scope, so a STOP always lands.
> - **No host reply.** Twilio's default opt-out handling already answers STOP, START and HELP
>   on long codes and toll-free numbers; a host reply would send the person two messages. If a
>   sender turns Twilio's handling off, a host reply lane is a later phase.
> - **Replay.** Twilio signs URL + params with no timestamp, so a captured signed STOP or START
>   could be replayed. Each `MessageSid` is applied at most once (`crm:sms-inbound-seen`).
> - **Provider id.** The inbound provider is the connection's own provider id, `twilio` (not a
>   new `twilio-sms` id): an inbound config is keyed by the connection, whose provider it carries.
>   Observer-only and ungated, like `zoom-webinar`.
>
> **Correction 2026-10-20 (P1): the exit guard.** `host/smsAdapter.ts` refuses, for every caller:
> a recipient that is not E.164 (`sms_invalid_recipient`, Twilio needs it and it could not be
> checked), a suppressed recipient (`sms_recipient_opted_out`, checked against the sender's client
> from the `from` binding, or against EVERY scope when `from` is bound to none), and an unreadable
> store (`sms_suppression_unreadable`). Twilio's error 21610 (its own opt-out list) maps to
> `sms_recipient_opted_out`. The generic `sms-send` node still reports a refusal as
> `status:'success'` with `sent:false`; that pre-existing shape is `J955WF-4`.

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

> **Correction 2026-10-20 (P2a `/architect`): how the wait is built.** `core.flow.wait`'s `until`
> reads only static config (`core.openwop.flow/index.mjs` `waitNode`), so it cannot take a
> run-computed `resumeAt`. `next-send-window` therefore suspends ITSELF with the same ADR 0267
> timer (`ctx.suspend({kind:'until', timestamp})`): the deadline is frozen in the interrupt, the
> sweep resumes it, and a `:fork` of the waiting run inherits it (witnessed through the real
> executor). The `resumeKey` carries the deadline, because the executor short-circuits a
> re-suspend with a matching key: a node that re-enters to a NEW deadline (the policy changed
> while it waited) must wait again, not proceed. `send-sms` re-checks the window and waits the
> same way (the "loop back" in D4). The clock reading is the one Intl wrapper,
> `host/localClock.ts`, shared with notification quiet hours (opposite semantics: those fail
> toward delivering, these toward not sending). Unknown zone ⇒ `timezone_unknown`, never a guess.
> Route callers naming an org that is neither a client nor the root get 404 (the run lane keeps
> the client-less mapping only for pre-0955 chains). `send-sms` sends from the client's own
> bound number (the lowest E.164 of that client's bindings), never another client's.
>
> **Decision 2026-10-20 (team-lead, David may override): Q7 = per-client SMS consent.** In the
> agency model each client is a separate sender and brand, and TCPA/CTIA practice ties consent
> to the brand that collected it, so one opt-in must not cover every client. Built in P2b
> through ADR 0905 topics. STOPALL stays the global stop; re-permission after STOPALL is only
> an explicit new opt-in.

> **Correction 2026-10-20 (P2b `/architect`): how per-client SMS consent is built.** ADR 0905
> topics are opt-OUT only (`consent/topicOptOuts.ts`, architect E5): a topic can narrow a
> decision, never grant one. So Q7's per-client consent is an opt-IN record beside them in the
> consent feature, `consent:client-channel` `{tenantId, orgId, subjectKey, channel, granted}`,
> and the decision stays in the ONE evaluator: `isAllowed(…, 'marketing.sms', {client:{orgId}})`
> denies on the erasure tombstone, then a workspace-level `false` (STOPALL / an explicit no),
> then a missing or `false` client grant; topic narrowing still applies after. A
> workspace-level `true` names no brand and never permits a client by itself. The record has
> the topic store's lifecycle (PII-declared, erased with the subject, the ADR 0657 D10 write
> barrier) and a CRM merge rule where a `false` always wins and a `true` lands only where the
> survivor has no row. Writers in P2b: STOP to client A's number withdraws A's grant; START to
> A's number records it (both subject keys) unless a STOPALL stands. **The forms sink is NOT a
> writer yet:** today's forms capture only email consent (`email/formsConsentSink.ts`); SMS
> capture with its disclosure text is the forms-builder work in the matrix's frontend row, and it
> must write the collecting org's grant.
>
> **Correction 2026-10-20 (P2b): SMS templates and the broadcast.** SMS bodies live in the ADR 0905
> store as `format:'sms'` (versions, content hash and pins unchanged), fixed at creation
> (`format_locked`), refused by an email campaign (`template_format`), validated at write and
> again at send (≤ 10 segments, and the opt-out keyword STOP as an uppercase word — "Reply STOP",
> "Responde STOP" — which is how Twilio's opt-out works in every language; the first cut required
> the English "Reply STOP" and would have refused every Spanish or French template). `send-sms`
> takes `{templateId, templateVersion}` (a pinned version) or inline `text`. The email broadcast
> now calls `checkChannelEligibility` instead of composing consent, topic and suppression itself,
> with its old skip reasons unchanged (a topic opt-out is a `consent` skip). The shipped chains'
> gates moved to `channel-eligibility@1.1.0`, whose `email` output keeps their edges.

### D5 — Send-time optimization: deterministic and explainable

`feature.campaign-journeys.nodes.send-time` reads the contact's opens and clicks
from the last 90 days through a **per-contact engagement index** (fixes J8).
With at least 5 events it picks the modal hour-of-week. Otherwise it uses the
client cohort's modal hour, then the template default. It clamps to quiet hours,
delays at most 24 h, and outputs `{sendAt, basis, histogram}`. The output is
recorded, so replay waits for the same instant. No model and no vendor black
box: the operator sees why 10:00 Tuesday was chosen.

> **Correction 2026-10-20 (P3a): the send-time node, and the rung it skips.** Built as
> `send-time` (role `action`): the modal hour-of-WEEK when it is within 24 h, else the modal
> hour-of-DAY (D5 says "delays at most 24 h"; a Friday-only reader on a Tuesday would otherwise
> wait three days), else the default time; ties break to the earliest bucket so the same inputs
> give the same `sendAt`; the window then wins over the preference (quiet hours are a rule, the
> preference is a guess), and the node waits on the same durable timer as `next-send-window`. The
> hours are read in ONE zone (the recipient's, or the first of the country's zones), while the
> window clamp still intersects all of them. **Not built: the "client cohort's modal hour"
> rung.** It needs a per-client engagement rollup that does not exist; computing it per send
> would be the O(tenant) read P0 removed. ADR 0957 owns per-client rollups; when one exists it
> becomes an input of `chooseSendTime`. Until then the basis goes straight to the default.
>
> **Correction 2026-10-20 (P5, J955WF-8): the resume key, and what the node outputs after a
> wait.** P3a keyed the wait `send-window:${sendAt}`. The host re-invokes the node when the timer
> fires, and by then the chosen time has just passed, so the node chose the NEXT one, the key
> never matched, and it re-parked every day forever. The P3a test called the node a second time
> at exactly `sendAt`, which hid it; only the P5 chain witness, re-invoked by the real sweep a
> second later, showed it. The key is now the fixed `send-time`. The explanation `{ sendAt, basis,
> histogram, zone }` is recorded on the suspension (`explain`) BEFORE the wait, because a
> recomputation after it explains a different time (measured: `contact_hour_of_week` became
> `contact_hour_of_day`). After a wait the node outputs `{ sendAt: when it fired, waited: true }`.
>
> **P3b — blocked (2026-10-20).** The split registration through ADR 0949 and the variant-set pin
> (the ADR 0905 D3 amendment) need ADR 0949's engine store (#5073, #5079, #5085) and ADR 0946's
> `VariantSet` (#5088), none merged. The journey split keeps `bucketHoldout` meanwhile (D6's
> stated fallback).

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

> **Correction 2026-10-20 (P4a `/architect`): where the breaker lives, and what is not built.**
> - **Owner:** `crm/senderHealth.ts`, beside the suppression overlay. `checkChannelEligibility`
>   (crm) reads it, and `email` (sends, bounce webhooks) writes it, so no crm→email import
>   (that would cycle).
> - **Counters:** per (tenant, sender org, UTC day). The broadcast adds `sent` once per pass (a
>   lost write under-counts sends, which raises the rates: it fails toward pausing). Each hard
>   bounce or complaint counts once per (org, day, reason, address), so a redelivered webhook
>   batch is idempotent. Bounce webhooks are configured per org, which names the sender.
>   **Journey email sends are not counted** (they go out through the core `email-send` node,
>   not the broadcast); the breaker reads broadcast volume, where a bad list burns a domain.
> - **Pause:** over 7 days, at least 500 sends, complaints > 0.1 % or hard bounces > 2 %
>   (env-tunable) ⇒ a CAS to paused, once, and a notification to the org's owners and admins.
>   Marketing email only (`checkChannelEligibility` ⇒ `deliverability_paused`; the broadcast
>   refuses up front, `409 sending_paused`); receipts and invitations keep flowing.
> - **Resume:** the Email page's "Sending health" card, a person's act (a browser session plus
>   `host:members:manage`), no workflow verb, no agent tool. **The `email-sending-resume`
>   PendingApproval kind and the ADR 0942 `email.resume-sending` class are P4b**: ADR 0942's
>   class registry is unmerged (#5051).
> - **Domain auth:** SPF and DMARC by DNS, cached 24 h, enforced on the broadcast when the
>   `email.sender-auth` sub-toggle (a restriction, OFF) is on; a DNS outage is its own refusal.
>   **DKIM is not checked**: it needs the provider's domain-authentication API and credentials
>   (OPEN for David).
> - Hard bounces stay workspace-wide suppressions (D2 said "a hard bounce to one client's sender
>   suppresses that sender"): a mailbox that does not exist is dead for every sender, so scoping
>   it would only re-send to a dead address.
> - **Warm-up caps are P4b** (per-day deferral in both send lanes).
>
> **Correction 2026-10-20 (P4b): warm-up as built.** Day N of a sender's sending life allows
> `ramp[N]` marketing emails (default 50, 100, 250, 500, 1k, 2.5k, 5k, 10k, 20k, 40k; then no
> ceiling; `OPENWOP_EMAIL_WARMUP_RAMP`). The broadcast caps each pass at today's remaining
> allowance; at the ceiling it refuses `409 warmup_deferred` with `resumeAt` (the next UTC day),
> and the campaign keeps its state, so nothing is dropped or skipped. **Opt-in** (`email.warmup`,
> a restriction, OFF): nothing counted sends before P4a, so turning it on for an established
> sender would throttle it as new. **Journey email sends are not capped** (they are not counted,
> P4a). There is no auto-continue: an operator re-sends the next day (the existing continuation),
> and the health card shows the day's ceiling. The `email-sending-resume` approval-inbox kind
> waits on ADR 0942 (#5051).

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

> **Correction 2026-10-20 (P0): the per-contact engagement index.** `email:engagement-by-contact`
> (key `${tenant}::${contact}::${at}::${id}`) is a denormalized copy written by the one event writer
> (`putEngagementEvent`); the demo seeder, which backdates through its own handle, writes the copy
> too. Rows from before the index are copied once per tenant (a marker written only after the copy
> succeeds). Retention ages the copies with the events; erasure deletes them by contact prefix.
> `checkEngagement` is one prefix read. Found on the way: the demo seeder's cleanup deleted
> engagement rows by bare id, which matched nothing; it now deletes by the real key.

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
| P2a | (split 2026-10-20, `/architect`) the runtime half: send policy, `next-send-window`, `send-sms`, the sub-toggle | the P2 exit criteria above |
| P2b | the record half: SMS templates in the ADR 0905 store (`format:'sms'`, versions and pins), per-client SMS consent (Q7), `sendCampaign` on `checkChannelEligibility`, the shipped chains' gates on `channel-eligibility` (`J955WF-1`) | a START or form opt-in to client A does not permit client B; an SMS template edit reopens review; the broadcast and the journey refuse the same recipient for the same reason |
| P3 | `send-time` node, ADR 0949 registration of splits, variant-set pin (ADR 0905 amendment) | Same inputs give the same `sendAt`; an edit to one variant reopens review |
| P4 | Domain auth precondition, circuit breaker, warm-up caps | Synthetic complaint spike pauses only that sender; resume needs a person |
| P5 | Blueprints (`post-webinar`, `abandoned-signup`, `test-then-winner` with ADR 0950), canvas palette | Blueprints load with zero chain errors and instantiate per client |

> **Correction 2026-10-20 (P5, `/architect`): what P5 builds.** Three blueprints:
> `welcome-email-sms` (the welcome series for a client, with a text a day later at the
> contact's best time), `post-webinar` and `abandoned-signup`. Each takes `orgId`, gates on
> `channel-eligibility`, and reaches a send only through a re-check on the sign-off gate's
> `truthy approved` edge, its address bound from the re-check (the WF-EM shape). **Not built:
> `test-then-winner`.** ADR 0950 has no implementation and its promotion node does not exist; a
> blueprint that cannot promote a winner would claim a capability nobody has. **The palette is
> a group, not a canvas:** every journey node declares `x-paletteCategory: 'journey'` (ADR 0767
> D4), so the existing builder shows a Journey section. ADR 0267's parked journey canvas
> (draft and publish) stays parked.

## Implementation record

| Phase | PR / commit | Tests | Notes |
|---|---|---|---|
| P0 | #5071 (`3683cff64` + this record) | `adr0955-p0-channel-eligibility.test.ts` (20 cases; seven sabotage witnesses in its header), `workflow-chain-campaign-journeys-execution.test.ts` unchanged and green | Stacked on #4933 (ADR 0905 P4: topic narrowing and the transactional purpose). `feature.campaign-journeys.nodes` 1.3.1 → 1.4.0 (`channel-eligibility` node; `enroll` 1.1.0). Parity fixture: literal call sites 296 → 298, asserted pairs 287 → 289 (coverage up, no new spread). |
| P1 | #5075 | `adr0955-p1-sms-stop.test.ts` (12 cases through the signed public route and the real adapter, six sabotage witnesses in its header); `consent-channels`, `consent-erasure-tombstone`, `sms-notification-adapter` updated for strict SMS and E.164; WhatsApp suites unchanged and green | Stacked on #5071. Live Twilio row OPEN for David (Q8). |
| P2a | #5086 | `adr0955-p2-send-window.test.ts` (13 cases: window math incl. +1 intersection and DST, the typed failures, the sub-toggle, the routes, and the exit criteria through the REAL executor and a REAL `:fork` of the waiting run; six sabotage witnesses in its header) | Stacked on #5075. Pack 1.4.0 → 1.5.0 (`next-send-window`, `send-sms`). Served-set floor 352 → 353, served 309 → 310 (`send-sms`). Parity: literal 298 → 300, asserted 289 → 291. |
| P2b | #5096 | `adr0955-p2b-client-consent.test.ts` (6 cases: per-client consent incl. STOPALL, START/STOP through the signed webhook, the CRM merge rule, SMS templates, the broadcast and the journey refusing for the same reason; six sabotage witnesses in its header). `crm-merge-bounded-reads` warms the new index; `workflow-chain-email-reject-witness` allowance renamed to the new gate type. P0 test updated: a client now needs its own grant | Stacked on #5086. Pack 1.5.0 → 1.6.0 (`channel-eligibility` 1.1.0, `send-sms` 1.1.0); chain pack 1.2.3 (welcome-series, re-engage-contact 1.0.3). FE: SMS in the template format select, a segment hint, SMS templates kept out of the email campaign picker. |
| P3a | #5097 | `adr0955-p3-send-time.test.ts` (5 cases: the five-event floor, determinism and ties, the 24 h cap, the window clamp, and the node waiting on the timer then explaining its choice; four sabotage witnesses in its header) | Stacked on #5096. Pack 1.6.0 → 1.7.0 (`send-time`). P3b blocked on ADR 0949/0946. |
| P4a | #5106 | `adr0955-p4-deliverability.test.ts` (6 cases: the floor, the spike pausing only that sender, redelivery counted once, the journey and the broadcast refusing, the person-only resume through HTTP, SPF/DMARC; five sabotage witnesses, and the one gate it cannot witness named in its header); FE `sendingHealth.test.tsx` (3 cases, two witnesses) | Stacked on #5097. New sub-toggle `email.sender-auth` (OFF). P4b: warm-up caps, the resume approval kind with ADR 0942. |
| P4b (warm-up) | #5107 | `adr0955-p4b-warmup.test.ts` (2 cases: off by default; the pass capped, the deferral over the ceiling, the next day's allowance, past the ramp; four sabotage witnesses); FE `sendingHealth.test.tsx` + 1 case | Stacked on #5106. New sub-toggle `email.warmup` (OFF). The resume approval kind waits on ADR 0942. |
| P5 | #5113 | `adr0955-p5-blueprints.test.ts` (5 cases: also `post-webinar` and `abandoned-signup` through the real executor (J955WF-10), an unsubscribe mid-journey ending the run COMPLETED through a "stopped" terminal while a withdrawn consent still fails (J955WF-12); earlier: the three blueprints load with zero chain errors; two clients get two workflows, each bound to its own client; `welcome-email-sms` through the REAL executor: sign-off, the email, a one-day durable timer, the send-time timer, a text from the client's own number via a Twilio stub; four sabotage witnesses in its header). `adr0955-p3-send-time.test.ts` re-entry case rewritten (J955WF-8) | Stacked on #5107. Carries the #5110 fix (`core.flow.wait` failed every run after its wait, J955WF-7; `core.openwop.flow` 1.1.4, a NEW pin drift for release). Node pack 1.7.0 → 1.8.0 (`x-paletteCategory: 'journey'` on every node; `send-time` resume fix). Chain pack 1.2.3 → 1.3.0. FE: a Journey palette group in four locales. Declared ratchet raises (the welcome-series shape, required params with no honest default): `chain-config-conformance` 42 → 50, `seeded-chain-unfilled-params` 127 → 130; census floors 3 → 8 sends and 2 → 5 address-gated chains. |

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
6. ~~No `/architect` pass has been run yet.~~ P0's pass ran 2026-10-20 (corrections under D2
   and D1 above). P1's pass covers D2's exit guard and D3's dual-subject consent merge.
7. ~~**(David, new in P1)**~~ **Decided 2026-10-20 by team-lead (overridable): yes** — see the D4 decision note. Per-client SMS consent. Consent is one record per subject per
   workspace, so a person who sends STOPALL can be re-permitted only through a consent-bearing
   flow, and an explicit SMS opt-in to one client is an opt-in for every client of the agency.
   Proposed: per-client SMS consent through ADR 0905 topics (one SMS topic per client), so a
   START or a form opt-in is recorded for that client only.
8. **(David)** The live Twilio row (a real number, a STOP from a real handset reaching the
   webhook) is OPEN until a Twilio account and number exist (Q4). P1 is witnessed against a
   local stub with Twilio's documented signing and response shapes.

## Planning rows

**ROADMAP (Campaign Studio program table):**
`| 0955 | **Lifecycle journeys over email and SMS** ([ADR 0955](docs/adr/0955-lifecycle-journeys-email-sms.md)) | `campaign-journeys`, `campaign-journeys.sms` | 0941, 0942, 0905, 0222, 0267, 0227, 0394; integrates with 0949 (soft), 0950, 0954 | `feature.campaign-journeys.nodes`, `core.openwop.workflows.campaign-journeys` | Host extension | 🔵 Proposed |`

**FEATURES "Future features":**
`- **Lifecycle journeys over email and SMS (ADR 0955, Proposed 2026-10-19)** — nurture flows as journey chains (the one owner, campaign-journeys; broadcast stays in email), one eligibility check per channel shared by every sender, strict SMS opt-in with inbound STOP/START/HELP and a STOP guard at the SMS adapter, per-client quiet hours as durable waits, deterministic send-time choice, email and SMS tests through ADR 0949, a per-sender deliverability circuit breaker, and ADR 0942 gates at journey publish. Sub-toggle `campaign-journeys.sms` (OFF, tenant). No RFC.`


Recovery composition checkpoint — 2026-10-25 (UNVALIDATED): all original journey
P0–P5 commits are retained on current main. The merge preserves current CRM lead
erasure, campaign-reference checks, suppression identity validation, CAS hold
precedence and SMS autonomy content-bound grants. The scoped suppression reader
extends the existing fail-closed identity check to every channel/sender row;
storage failures are never treated as absent suppression on insert. No dependency
or unfilled-parameter ceiling was raised. Generated floors/manifests/parity and
exact new-chain measurements remain pending until the current gate is finished.

The old P5 flow.wait repair is already present in the approved main artifact.
The entire main core.openwop.flow 1.2.0 pack, schemas and current timer/input
regressions are preserved byte-for-byte; no replacement artifact or pin bump is
proposed for that pack. The original P5 history remains an ancestor.

Before qualification, exercise a START lifting an unsubscribe while a complaint
or manual hold lands concurrently: the recovered removeSuppressionIf still
uses a read then unconditional delete. That path must not erase the newer hold.
Broader send-window, client consent, warm-up and deliverability behavior and all
original witnesses remain unexecuted in this recovery. Live Twilio/SMS requires
its separately authorized provider account, recipient and spend; none was used.

The concurrent complaint/manual-hold START witnesses are now authored UNRUN.
The old failed-STOP fixture has been updated to inject at the storage CAS
boundary used by main's guarded suppression writer; it no longer mocks an
obsolete `put` path. No actual provider call has been made for this recovery.


Recovery correction — 2026-10-25: a signed START could read its previous STOP
and then unconditionally delete a newer complaint/operator hold. Both races
were reproduced through the real signed inbound path and local SMS transport.
The suppression owner now asks DurableCollection to compare-and-delete the
exact row it examined, through Storage.kvCompareAndDelete, a single guarded DELETE in both database
adapters. The existing CAS write contract is unchanged. Losing the comparison
preserves the newer hold and keeps SMS sending refused. Only a successful
removal decrements the suppression count or fires deletion hooks. Conditional
deletes leave tenant index markers to the existing read-side self-healing,
so a post-removal insert cannot have its fresh marker removed by this caller.
No second sender, consent, suppression or storage authority is introduced.
Focused and canonical qualification remain pending; live Twilio and unfinished
journey phases remain explicitly open.


Recovery dependency measurement — 2026-10-25: the sole new undeclared
feature edge is `campaign-journeys → campaign-ops`, classified as a soft
read of the existing client owner. It is already recommended, and the client
store remains readable while that feature's UI is off. The new real enrollment
case verifies both successful client-scoped enrollment and refusal of an absent
client in that posture. The census ceiling advances exactly 113 → 114 with
that identity and reason recorded; no hard disable lock or numeric slack is
added. Native types and all 83 metadata/client-scope cases in seven suites
passed. The separate 79-case boundary run is also green. Full canonical
qualification and live Twilio remain pending.
