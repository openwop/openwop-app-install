/**
 * feature.campaign-journeys.nodes (ADR 0222) — the two guard verbs journey
 * chains compose over ctx.features['campaign-journeys']. Contact resolution
 * order: explicit input, else the triggering event's payload (ADR 0208 —
 * `ctx.triggerData.payload.contactId`), so an event-bound chain needs no
 * input plumbing. Pure-JS, Node-20 stdlib only.
 */

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
  const elig = await cj.checkEligibility({ contactId });
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
  const r = await cj.bucketHoldout({ contactId, experimentId: str(i.experimentId), holdoutPct });
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
  'feature.campaign-journeys.nodes.engagement': engagement,
  'feature.campaign-journeys.nodes.frequency-gate': frequencyGate,
  'feature.campaign-journeys.nodes.segment-members': segmentMembers,
  'feature.campaign-journeys.nodes.segment-winback-plan': segmentWinbackPlan,
  'feature.campaign-journeys.nodes.split': split,
};

export default nodes;
