/**
 * ADR 0948 D4 — the routing outcome of a `webinar` or `application` step is derived on
 * the SERVER, never taken from the visitor (a public `next?outcome=accepted` would let
 * anyone pick their own branch). Routing is navigation, not authorization: what a
 * branch unlocks (a booking link, an offer) carries its own gate.
 *
 * - **webinar.** Attendance arrives later from the provider (`webinarProcessor.ts`
 *   records the CRM activity `act:webinar:<providerEventId>:<contactId>:attended`).
 *   So this only answers on a RETURN visit after the event has started, for the
 *   visitor's own registration: the submission must be on the event's form, carry
 *   this funnel and step as its embed context, not be held, and name a contact.
 *   Attended → `accepted`; otherwise `declined`. Before the event, or with nothing
 *   attributable, the outcome is unknown and routing stays sequential.
 * - **application.** The verdict is ADR 0954's (qualification). Until it exposes a
 *   verdict read, there is none: `undefined`, routing stays sequential.
 * - **upsell / downsell** (ADR 0948 P2c). The buyer's recorded decision on that step
 *   (`offerDecisions.ts`), read only with the purchase's offer capability, which the
 *   viewer sends in headers (never the URL). No capability, no outcome.
 */
import type { Funnel, FunnelStep } from './funnelsService.js';
import type { StepOutcome } from './funnelRouting.js';
import { getMarketingEvent } from '../webinars/entities/marketingEvent.js';
import { getSubmission, isSubmissionHeld } from '../forms/formsService.js';
import { getActivity } from '../crm/entities/activities.js';
import { offerRoutingOutcome } from './offerDecisions.js';

export async function resolveServerOutcome(
  tenantId: string,
  orgId: string,
  funnel: Funnel,
  step: FunnelStep,
  opts: { submissionId?: string; nowMs?: number; offer?: { orderId: string; token: string } },
): Promise<StepOutcome | undefined> {
  // ADR 0948 P2c — an upsell/downsell routes on the buyer's recorded decision, read
  // only with that purchase's offer capability.
  if (step.kind === 'upsell' || step.kind === 'downsell') {
    return opts.offer ? offerRoutingOutcome(tenantId, orgId, funnel, step, opts.offer.orderId, opts.offer.token) : undefined;
  }
  if (step.kind !== 'webinar' || !step.webinar || !opts.submissionId) return undefined;
  const event = await getMarketingEvent(tenantId, orgId, step.webinar.marketingEventId);
  if (!event?.formId) return undefined;
  // Before the event starts there is nothing to route on (the registration visit itself).
  const startsMs = event.startsAt ? Date.parse(event.startsAt) : NaN;
  if (!Number.isFinite(startsMs) || startsMs > (opts.nowMs ?? Date.now())) return undefined;
  const sub = await getSubmission(tenantId, orgId, event.formId, opts.submissionId);
  if (!sub || !sub.contactId) return undefined;
  const ctx = sub.meta?.context ?? {};
  if (ctx.funnelId !== funnel.funnelId || ctx.stepId !== step.stepId) return undefined;
  if (await isSubmissionHeld(tenantId, sub.submissionId)) return undefined;
  const attended = await getActivity(tenantId, orgId, `act:webinar:${event.providerEventId}:${sub.contactId}:attended`);
  return attended ? 'accepted' : 'declined';
}
