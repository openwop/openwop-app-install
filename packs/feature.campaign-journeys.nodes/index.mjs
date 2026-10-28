/**
 * feature.campaign-journeys.nodes (ADR 0222) — the two guard verbs journey
 * chains compose over ctx.features['campaign-journeys']. Contact resolution
 * order: explicit input, else the triggering event's payload (ADR 0208 —
 * `ctx.triggerData.payload.contactId`), so an event-bound chain needs no
 * input plumbing. Pure-JS, Node-20 stdlib only.
 */

import { createHash } from 'node:crypto';

function ensureJourneys(ctx) {
  const cj = ctx.features && ctx.features['campaign-journeys'];
  if (!cj || typeof cj.enroll !== 'function' || typeof cj.checkEligibility !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['campaign-journeys'] — enable the Campaign Journeys feature (ADR 0222)"),
      { code: 'host_capability_missing', capability: 'host.sample.campaign-journeys' },
    );
  }
  return cj;
}

function str(v) { return typeof v === 'string' ? v : ''; }

/** ADR 0955 — the client/channel args of a scoped check, or null for a legacy chain. */
function scopedArgs(i) {
  const orgId = str(i.orgId);
  const channel = str(i.channel);
  if (!orgId && !channel) return null;
  return { orgId: orgId || undefined, channel: channel || 'email', purpose: str(i.purpose) || undefined, topicId: str(i.topicId) || undefined };
}

function contactIdOf(ctx) {
  const i = ctx.inputs ?? {};
  return str(i.contactId)
    || str(ctx.triggerData && ctx.triggerData.payload && ctx.triggerData.payload.contactId);
}

/** Idempotent enrollment guard: enrolled:false ⇒ FAIL the run with
 *  `already_enrolled` — the honest stop that prevents double-sends on event
 *  redelivery or manual re-fires. */
export async function enroll(ctx) {
  const cj = ensureJourneys(ctx);
  const i = ctx.inputs ?? {};
  const journeyId = str(i.journeyId);
  const contactId = contactIdOf(ctx);
  if (!journeyId || !contactId) {
    return { status: 'failed', error: { code: 'validation_error', message: 'journeyId and contactId (input or trigger payload) are required.' } };
  }
  // JRNY-1: check eligibility BEFORE claiming the irreversible enrollment ledger.
  // Enrollment is a one-per-(journey, contact) CAS that a later eligibility gate
  // cannot undo — so an ineligible contact reached here (redelivered event,
  // manual re-fire) would be stranded "enrolled" and blocked from re-running the
  // journey once they DO become eligible, until a manual reset. Gating the claim
  // on eligibility keeps the ledger truthful. The downstream eligibility gate
  // still runs (it also feeds the send node its `to`/`name`); this is a cheap
  // pre-check, not a replacement.
  // ADR 0955 D1/D2 — a client journey (`orgId`) or a non-email one (`channel`) pre-checks
  // through the one per-channel verb, bound to the run's client; a legacy chain keeps the
  // ADR 0222 email composite.
  const scoped = scopedArgs(i);
  const elig = scoped
    ? await cj.checkChannelEligibility({ contactId, orgId: scoped.orgId, channel: scoped.channel, purpose: scoped.purpose, topicId: scoped.topicId })
    : await cj.checkEligibility({ contactId });
  if (!elig.eligible) {
    return { status: 'failed', error: { code: 'not_eligible', message: `Contact ${contactId} is not eligible: ${elig.reason}.` } };
  }
  // ADR 0299: optional cross-journey arbitration. `priority` (higher wins) +
  // `exclusivityGroup` come from the journey config; absent ⇒ the unchanged
  // ADR 0222 one-per-(journey, contact) guard.
  const priority = (typeof i.priority === 'number' && Number.isFinite(i.priority)) ? i.priority : undefined;
  const exclusivityGroup = str(i.exclusivityGroup) || undefined;
  const r = await cj.enroll({
    journeyId, contactId,
    ...(scoped && scoped.orgId ? { orgId: scoped.orgId } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(exclusivityGroup ? { exclusivityGroup } : {}),
  });
  if (!r.enrolled) {
    // `superseded` (ADR 0299) ⇒ a higher-priority journey holds the exclusivity
    // group; this one is skipped, honestly and stably (not a double-send).
    if (r.reason === 'superseded') {
      return { status: 'failed', error: { code: 'superseded', message: `Contact ${contactId} is held by a higher-priority journey in exclusivity group "${exclusivityGroup}" — journey ${journeyId} is skipped.` } };
    }
    return { status: 'failed', error: { code: 'already_enrolled', message: `Contact ${contactId} already ran journey ${journeyId} (${r.enrolledAt}). Reset the enrollment to re-run.` } };
  }
  return { status: 'success', outputs: { enrolled: true, journeyId, contactId, ...(r.displacedJourneyId ? { displacedJourneyId: r.displacedJourneyId } : {}) } };
}

/** Consent + suppression + has-email composite. Ineligible ⇒ FAIL with the
 *  reason — the chain stops before any send. Eligible ⇒ outputs {email, name}
 *  for the downstream send step. */
export async function eligibility(ctx) {
  const cj = ensureJourneys(ctx);
  const contactId = contactIdOf(ctx);
  if (!contactId) {
    return { status: 'failed', error: { code: 'validation_error', message: 'contactId (input or trigger payload) is required.' } };
  }
  const r = await cj.checkEligibility({ contactId });
  if (!r.eligible) {
    return { status: 'failed', error: { code: 'not_eligible', message: `Contact ${contactId} is not eligible: ${r.reason}.` } };
  }
  // `to` rides the edge into a downstream email-send node's input port.
  return { status: 'success', outputs: { eligible: true, contactId, email: r.email, to: r.email, name: r.name } };
}

/** ADR 0955 D2 — the one per-channel check for a client's send: address (email, or the
 *  contact's E.164 phone for SMS), consent (and the topic opt-out), and channel- and
 *  sender-scoped suppression. Ineligible ⇒ FAIL with the reason; eligible ⇒ outputs
 *  { channel, address, to, name } for the send step. Inputs: { orgId (the client; omit only
 *  in a workspace with no clients), channel ('email' | 'sms'), purpose? ('marketing' |
 *  'transactional'), topicId?, contactId? (else trigger payload) }. */
export async function channelEligibility(ctx) {
  const cj = ensureJourneys(ctx);
  if (typeof cj.checkChannelEligibility !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['campaign-journeys'].checkChannelEligibility unavailable — update the host (ADR 0955)." } };
  }
  const i = ctx.inputs ?? {};
  const contactId = contactIdOf(ctx);
  if (!contactId) return { status: 'failed', error: { code: 'validation_error', message: 'contactId (input or trigger payload) is required.' } };
  const r = await cj.checkChannelEligibility({ contactId, orgId: str(i.orgId) || undefined, channel: str(i.channel) || 'email', purpose: str(i.purpose) || undefined, topicId: str(i.topicId) || undefined });
  if (!r.eligible) {
    // J955WF-12 — a contact who unsubscribed (or was suppressed) between the journey's start and
    // this re-check is a CORRECT end of the journey, not a failure: with `stopOnSuppressed`, that
    // ONE reason succeeds with `{ eligible: false, stopped: 'suppressed' }` so the chain can branch
    // to a clean terminal. Every other reason (consent, no address, unreadable stores…) still fails.
    if (r.reason === 'suppressed' && i.stopOnSuppressed === true) {
      return { status: 'success', outputs: { eligible: false, stopped: 'suppressed', contactId, channel: r.channel } };
    }
    return { status: 'failed', error: { code: 'not_eligible', message: `Contact ${contactId} is not eligible for ${r.channel}: ${r.reason}.` } };
  }
  // `email` (email channel only) keeps the legacy `eligibility` node's output name, so a chain
  // that moves its gates here keeps its edges (ADR 0955 J955WF-1).
  return { status: 'success', outputs: { eligible: true, contactId, channel: r.channel, address: r.address, to: r.address, name: r.name, ...(r.channel === 'email' ? { email: r.address } : {}) } };
}

/** Wait until the timer for `resumeAt`, keyed BY the deadline: a later re-entry that finds a
 *  NEW deadline (the policy changed while waiting) suspends again instead of short-circuiting
 *  on the old resolution (architect P2 finding 1). The deadline is frozen in the interrupt, so a
 *  fork taken while waiting inherits it (ADR 0267 timer). */
async function waitUntil(ctx, resumeAt) {
  if (typeof ctx.suspend !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'host does not support suspend (needed to wait for the send window).' } };
  }
  await ctx.suspend({ kind: 'until', timestamp: resumeAt, resumeKey: `send-window:${resumeAt}` });
  return null;
}

/** ADR 0955 D4 — wait for the client's send window. Inside it: outputs `{sendAt, zones, basis}`
 *  at once. Outside it: suspends until the next instant inside the window in every zone the
 *  recipient may be in (a durable timer), then outputs on re-entry. Typed failures:
 *  `timezone_unknown` (no contact zone, no client default, unknown country — set a default),
 *  `window_unreachable`, `contact_not_found`. Inputs: { orgId, channel? ('sms'), contactId? }. */
export async function nextSendWindow(ctx) {
  const cj = ensureJourneys(ctx);
  if (typeof cj.checkSendWindow !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['campaign-journeys'].checkSendWindow unavailable — update the host (ADR 0955)." } };
  }
  const i = ctx.inputs ?? {};
  const contactId = contactIdOf(ctx);
  if (!contactId) return { status: 'failed', error: { code: 'validation_error', message: 'contactId (input or trigger payload) is required.' } };
  const w = await cj.checkSendWindow({ contactId, orgId: str(i.orgId) || undefined, channel: str(i.channel) || 'sms' });
  if (w.reason) return { status: 'failed', error: { code: w.reason, message: `No send window for contact ${contactId}: ${w.reason}.` } };
  if (!w.inWindow) {
    const failed = await waitUntil(ctx, w.resumeAt);
    if (failed) return failed;
  }
  return { status: 'success', outputs: { sendAt: w.resumeAt, zones: w.zones, basis: w.basis, contactId } };
}

/** ADR 0955 D5 — pick the contact's send time (their modal hour-of-week from 90 days of opens
 *  and clicks, else their modal hour, else `defaultTime`), clamped into the client's window,
 *  at most 24 h out; then WAIT until it (a durable timer, as `next-send-window`). Outputs the
 *  explanation, recorded so replay waits for the same instant: { sendAt, basis, histogram,
 *  zone }. Inputs: { orgId, channel? ('email' | 'sms'), defaultTime? ('HH:MM', 10:00),
 *  contactId? (else trigger payload) }. */
export async function sendTime(ctx) {
  const cj = ensureJourneys(ctx);
  if (typeof cj.sendTime !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['campaign-journeys'].sendTime unavailable — update the host (ADR 0955)." } };
  }
  const i = ctx.inputs ?? {};
  const contactId = contactIdOf(ctx);
  if (!contactId) return { status: 'failed', error: { code: 'validation_error', message: 'contactId (input or trigger payload) is required.' } };
  const r = await cj.sendTime({ contactId, orgId: str(i.orgId) || undefined, channel: str(i.channel) || 'email', defaultTime: str(i.defaultTime) || undefined });
  if (!r.ok) return { status: 'failed', error: { code: r.code, message: `No send time for contact ${contactId}: ${r.code}.` } };
  if (Date.parse(r.sendAt) > Date.now()) {
    if (typeof ctx.suspend !== 'function') {
      return { status: 'failed', error: { code: 'host_capability_missing', message: 'host does not support suspend (needed to wait for the send time).' } };
    }
    // ONE fixed resume key, not one derived from `sendAt` (J955WF-8). The host re-invokes this
    // node when the timer fires, and by then "the contact's 10:00" has just passed, so a
    // recomputed time is tomorrow's: a time-derived key would never match and the node would
    // re-park every day, forever. With a fixed key the re-entry returns here, and the time it
    // fired IS the send time. The explanation is the one made BEFORE the wait, recorded on the
    // suspension (`explain`); a recomputation after it would explain a different time.
    await ctx.suspend({ kind: 'until', timestamp: r.sendAt, resumeKey: 'send-time', explain: { sendAt: r.sendAt, basis: r.basis, histogram: r.histogram, zone: r.zone } });
    return { status: 'success', outputs: { sendAt: new Date().toISOString(), waited: true, contactId } };
  }
  return { status: 'success', outputs: { sendAt: r.sendAt, basis: r.basis, histogram: r.histogram, zone: r.zone, contactId } };
}

/** GSM-7 basic set (approximate, the common characters) — anything else is UCS-2. */
const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|€]*$/;
export function smsSegments(text) {
  const gsm = GSM7.test(text);
  const len = [...text].length;
  if (gsm) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}
const MAX_SEGMENTS = 10;

/** ADR 0955 D2/D4/D8 — send one journey SMS from the CLIENT's own number. Order: the
 *  `campaign-journeys.sms` sub-toggle, the one eligibility check (SMS consent, topic opt-out,
 *  STOP), the send window (outside it the node WAITS, then re-checks everything), the client's
 *  bound number, the body (marketing: a "Reply STOP" instruction, ≤ 10 segments), then
 *  ctx.messaging.sendSms with a fork-stable key. Every refusal is a TYPED FAILURE, never
 *  success with `sent:false` (J955WF-4). Inputs: { orgId, text, purpose? ('marketing' |
 *  'transactional'), topicId?, contactId? (else trigger payload) }. */
export async function sendSms(ctx) {
  const cj = ensureJourneys(ctx);
  if (typeof cj.smsSendContext !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['campaign-journeys'].smsSendContext unavailable — update the host (ADR 0955)." } };
  }
  if (typeof ctx.messaging?.sendSms !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: 'host does not implement ctx.messaging.sendSms' } };
  }
  const i = ctx.inputs ?? {};
  const contactId = contactIdOf(ctx);
  const purpose = str(i.purpose) || 'marketing';
  // ADR 0955 D8 — the body is either inline `text` or a PINNED SMS template version.
  let text = str(i.text);
  let template = null;
  if (!text && str(i.templateId)) {
    if (typeof cj.smsTemplateBody !== 'function') {
      return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['campaign-journeys'].smsTemplateBody unavailable — update the host (ADR 0955)." } };
    }
    const t = await cj.smsTemplateBody({ orgId: str(i.orgId) || undefined, templateId: str(i.templateId), templateVersion: typeof i.templateVersion === 'number' ? i.templateVersion : 0 });
    if (!t.ok) return { status: 'failed', error: { code: t.code, message: t.message } };
    text = t.text;
    template = { templateId: str(i.templateId), templateVersion: t.templateVersion, contentHash: t.contentHash };
  }
  if (!contactId || !text) return { status: 'failed', error: { code: 'validation_error', message: 'contactId (input or trigger payload) and either text or {templateId, templateVersion} are required.' } };
  if (purpose === 'marketing' && !/\bSTOP\b/.test(text)) {
    return { status: 'failed', error: { code: 'sms_body_invalid', message: 'A marketing text must tell the person how to opt out, with the word STOP (e.g. "Reply STOP to opt out").' } };
  }
  if (smsSegments(text) > MAX_SEGMENTS) {
    return { status: 'failed', error: { code: 'sms_body_invalid', message: `The text is ${smsSegments(text)} segments; the limit is ${MAX_SEGMENTS}.` } };
  }
  const c = await cj.smsSendContext({ contactId, orgId: str(i.orgId) || undefined, purpose, topicId: str(i.topicId) || undefined });
  if (!c.ok) {
    if (c.code === 'quiet_hours' && c.resumeAt) {
      // Drifted out of the window (or no window node before this one): wait, then the node
      // re-runs from the top on re-entry and re-checks consent, STOP and the window.
      const failed = await waitUntil(ctx, c.resumeAt);
      if (failed) return failed;
    }
    return { status: 'failed', error: { code: c.code, message: c.reason ? `Contact ${contactId} is not eligible for SMS: ${c.reason}.` : `SMS not sent: ${c.code}.` } };
  }
  const idempotencyKey = createHash('sha256').update(JSON.stringify([String(ctx.runId), String(ctx.nodeId), c.to, text])).digest('hex');
  const r = await ctx.messaging.sendSms({ to: c.to, from: c.from, text, idempotencyKey });
  if (!r || !r.sent) {
    return { status: 'failed', error: { code: (r && r.error) || 'sms_send_failed', message: `SMS not sent: ${(r && r.error) || 'unknown'}.` } };
  }
  return { status: 'success', outputs: { sent: true, channel: 'sms', sid: r.sid ?? '', contactId, ...(template ? { template } : {}) } };
}

/** ADR 0243 — behavioral branching: outputs {opened, clicked, …} for an
 *  EdgeCondition (`{path:'opened', op:'truthy'}`) to gate the next send. */
export async function engagement(ctx) {
  const cj = ensureJourneys(ctx);
  const i = ctx.inputs ?? {};
  const contactId = contactIdOf(ctx);
  if (!contactId) return { status: 'failed', error: { code: 'validation_error', message: 'contactId is required.' } };
  const r = await cj.checkEngagement({ contactId, ...(str(i.campaignId) ? { campaignId: str(i.campaignId) } : {}) });
  return { status: 'success', outputs: { ...r, contactId } };
}

/** ADR 0243 — frequency cap: outputs {withinCap, sentCount}; an EdgeCondition
 *  `{path:'withinCap', op:'truthy'}` gates the send so a capped contact is skipped. */
export async function frequencyGate(ctx) {
  const cj = ensureJourneys(ctx);
  const i = ctx.inputs ?? {};
  const contactId = contactIdOf(ctx);
  if (!contactId) return { status: 'failed', error: { code: 'validation_error', message: 'contactId is required.' } };
  const windowDays = typeof i.windowDays === 'number' ? i.windowDays : 30;
  const maxSends = typeof i.maxSends === 'number' ? i.maxSends : 1;
  const r = await cj.checkFrequency({ contactId, windowDays, maxSends });
  return { status: 'success', outputs: { ...r, contactId } };
}

/** ADR 0243 — segment fan-out source: outputs {contactIds, total, truncated} for
 *  a downstream `core.dispatch` node to fan out over (each → a per-member journey
 *  child run). Capped — never a silent 50k fan-out. */
export async function segmentMembers(ctx) {
  const cj = ensureJourneys(ctx);
  const i = ctx.inputs ?? {};
  const segmentId = str(i.segmentId);
  if (!segmentId) return { status: 'failed', error: { code: 'validation_error', message: 'segmentId is required.' } };
  const r = await cj.resolveSegment({ segmentId });
  return { status: 'success', outputs: { ...r } };
}

/** ADR 0267 / CDP-E — experiment/holdout SPLIT. Deterministically buckets the
 *  contact into `control`/`treatment` (via ctx.features bucketHoldout — the shared
 *  variantAssignment primitive, keyed on contactId → replay-stable). Outputs
 *  { arm, control, treatment, bucket } so an EdgeCondition ({path:'control',
 *  op:'truthy'}) routes the two arms. Inputs: { contactId? (else trigger payload),
 *  experimentId?, holdoutPct? (10) }. */
export async function split(ctx) {
  const cj = ensureJourneys(ctx);
  if (typeof cj.bucketHoldout !== 'function') {
    return { status: 'failed', error: { code: 'host_capability_missing', message: "ctx.features['campaign-journeys'].bucketHoldout unavailable — enable Campaign Journeys (ADR 0267)." } };
  }
  const i = ctx.inputs ?? {};
  const contactId = contactIdOf(ctx);
  if (!contactId) return { status: 'failed', error: { code: 'validation_error', message: 'contactId is required.' } };
  const holdoutPct = typeof i.holdoutPct === 'number' ? i.holdoutPct : 10;
  // ADR 0949 P3b — `orgId` lets an engine experiment (an `exp:` id) assign; a
  // holdout split ignores it, and an engine split without it is refused.
  const r = await cj.bucketHoldout({ contactId, experimentId: str(i.experimentId), holdoutPct, orgId: str(i.orgId) });
  return { status: 'success', outputs: { ...r, contactId } };
}

/** ADR 0255 / RFC 0126 — the data-driven segment-winback SUPERVISOR. Projects a
 *  resolved segment's `contactIds` (from an upstream `segment-members` node) into a
 *  `next-worker` OrchestratorDecision that fans ONE child workflow out over N
 *  contacts, each child receiving its own `contactId` via RFC 0126 `nextWorkerInputs`
 *  (plus any shared per-child params passed through verbatim). Output shape mirrors
 *  `core.orchestrator.supervisor` (`{decisions, agentId}`), so a downstream
 *  `core.dispatch` (`fanOutPolicy:'parallel'`, `perItemInput`) consumes it
 *  identically. Pure + deterministic → replay-stable; the child journey's enroll-CAS
 *  makes a re-dispatched sweep idempotent. Empty segment → a clean terminate. */
export async function segmentWinbackPlan(ctx) {
  const cfg = ctx.config ?? {};
  const inputs = ctx.inputs ?? {};
  // contactIds are the RUNTIME segment (from the upstream segment-members edge);
  // config is a fallback for direct/agent drive.
  const rawIds = Array.isArray(inputs.contactIds) ? inputs.contactIds : (Array.isArray(cfg.contactIds) ? cfg.contactIds : []);
  const contactIds = rawIds.filter((x) => typeof x === 'string' && x.length > 0);
  const childWorkflowId = str(cfg.childWorkflowId) || str(inputs.childWorkflowId);
  if (!childWorkflowId) {
    return { status: 'failed', error: { code: 'validation_error', message: 'segment-winback-plan requires childWorkflowId (the per-contact workflow to fan out to).' } };
  }
  // Shared per-child params come from CONFIG (the chain-authored child params) — NOT
  // the runtime inputs, so segment-members metadata (total/truncated) never leaks into
  // a child. Forwarded verbatim to every child; the per-item contactId wins on collision.
  const shared = {};
  for (const k of Object.keys(cfg)) {
    if (k === 'contactIds' || k === 'childWorkflowId' || k === 'contactId') continue;
    shared[k] = cfg[k];
  }
  const agentId = `segment-winback-${ctx.nodeId}`;
  if (contactIds.length === 0) {
    return { status: 'success', outputs: { decisions: [{ kind: 'terminate', reason: 'segment-empty' }], agentId, dispatched: 0 } };
  }
  const decisions = [
    {
      kind: 'next-worker',
      nextWorkerIds: contactIds.map(() => childWorkflowId),
      nextWorkerInputs: contactIds.map((contactId) => ({ ...shared, contactId })),
    },
    { kind: 'terminate', reason: 'segment-dispatched' },
  ];
  return { status: 'success', outputs: { decisions, agentId, dispatched: contactIds.length } };
}

export const nodes = {
  'feature.campaign-journeys.nodes.enroll': enroll,
  'feature.campaign-journeys.nodes.eligibility': eligibility,
  'feature.campaign-journeys.nodes.channel-eligibility': channelEligibility,
  'feature.campaign-journeys.nodes.next-send-window': nextSendWindow,
  'feature.campaign-journeys.nodes.send-sms': sendSms,
  'feature.campaign-journeys.nodes.send-time': sendTime,
  'feature.campaign-journeys.nodes.engagement': engagement,
  'feature.campaign-journeys.nodes.frequency-gate': frequencyGate,
  'feature.campaign-journeys.nodes.segment-members': segmentMembers,
  'feature.campaign-journeys.nodes.segment-winback-plan': segmentWinbackPlan,
  'feature.campaign-journeys.nodes.split': split,
};

export default nodes;
