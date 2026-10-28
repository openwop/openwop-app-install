/**
 * ADR 0948 P2c — the post-purchase offer steps of a funnel (upsell, downsell).
 *
 * After a funnel checkout is paid, the buyer's browser holds a FUNNEL OFFER TOKEN
 * (`ft`): an HMAC over (tenant, org, parent order, funnel), domain-separated and
 * length-prefixed like `commerce/oneClickToken.ts`. It is not the storefront's `oc`:
 * a funnel purchase can only be extended through the funnel's own steps, once each.
 *
 * Guarantees, each enforced here and used by the commerce one-click and decline
 * routes and by the public `next` route:
 *  - **Bound and short-lived.** The token names the order AND the funnel; the parent
 *    must be paid, stamped with that funnel, and within FUNNEL_OFFER_WINDOW_MS of
 *    `paidAt` (server-side, so a slow Stripe checkout cannot expire it early).
 *  - **One decision per step.** A decision row per (tenant, parent, funnel, step) is
 *    created with `putIfAbsent` BEFORE any charge, so a replay, a double click or an
 *    accept after a decline cannot claim the step again.
 *  - **Only the step the funnel's own routing reaches.** `currentOfferStep` walks the
 *    funnel's rules from the checkout step, following the recorded decisions; a claim
 *    on any other step is refused. With per-step claims this also serialises the
 *    chain: a downsell is not reachable while its upsell is undecided or charging.
 *  - **Routing from decisions, never from the visitor.** `charging` and `accepted`
 *    route as accepted (the offer ended; never a silent downsell after a possible
 *    charge); `declined` routes as declined.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { readSessionSecret } from '../../middleware/cookieSession.js';
import { registerDefaultWindowSweep } from '../../host/retentionPurger.js';
import { resolveNextStepIx, type StepOutcome } from './funnelRouting.js';
import type { Funnel, FunnelStep } from './funnelsService.js';

const DOMAIN = 'funnel-offer:v1:';
/** How long after the parent is PAID its offer steps can be decided. */
export const FUNNEL_OFFER_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Decision rows are kept this long for support, then swept. */
const DECISION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const OFFER_STEP_KINDS: readonly FunnelStep['kind'][] = ['upsell', 'downsell'];

function message(tenantId: string, orgId: string, orderId: string, funnelId: string): string {
  return `${DOMAIN}${tenantId.length}:${tenantId}${orgId.length}:${orgId}${orderId.length}:${orderId}${funnelId.length}:${funnelId}`;
}

export function mintFunnelOfferToken(tenantId: string, orgId: string, orderId: string, funnelId: string): string {
  return createHmac('sha256', readSessionSecret()).update(message(tenantId, orgId, orderId, funnelId)).digest('base64url');
}

export function verifyFunnelOfferToken(tenantId: string, orgId: string, orderId: string, funnelId: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return false;
  const expected = Buffer.from(mintFunnelOfferToken(tenantId, orgId, orderId, funnelId));
  const got = Buffer.from(token);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** The parent order fields the offer checks read (commerce's Order, structurally). */
export interface OfferParent {
  orderId: string;
  status: string;
  paidAt?: string;
  funnelRef?: { funnelId: string; stepId: string };
}

/** A parent whose offers are open now, for this funnel and token. */
export function offerParentValid(tenantId: string, orgId: string, parent: OfferParent | null, funnelId: string, token: unknown, nowMs = Date.now()): parent is OfferParent & { funnelRef: { funnelId: string; stepId: string } } {
  if (!parent || parent.status !== 'paid' || !parent.paidAt || !parent.funnelRef) return false;
  if (parent.funnelRef.funnelId !== funnelId) return false;
  const paid = Date.parse(parent.paidAt);
  if (!Number.isFinite(paid) || nowMs - paid > FUNNEL_OFFER_WINDOW_MS) return false;
  return verifyFunnelOfferToken(tenantId, orgId, parent.orderId, funnelId, token);
}

export type OfferDecisionState = 'charging' | 'accepted' | 'declined';
export interface OfferDecision {
  key: string;
  tenantId: string;
  orgId: string;
  parentOrderId: string;
  funnelId: string;
  stepId: string;
  decision: OfferDecisionState;
  childOrderId?: string;
  createdAt: string;
  updatedAt: string;
}

const decisions = new DurableCollection<OfferDecision>('funnels:offer-decision', (d) => d.key, undefined, (d) => d.tenantId);
const keyOf = (tenantId: string, parentOrderId: string, funnelId: string, stepId: string): string =>
  `${tenantId}::${parentOrderId}::${funnelId}::${stepId}`;

export async function getOfferDecision(tenantId: string, parentOrderId: string, funnelId: string, stepId: string): Promise<OfferDecision | null> {
  return decisions.get(keyOf(tenantId, parentOrderId, funnelId, stepId));
}

/** Claim a step's ONE decision. `false` when the step was already decided (or claimed). */
export async function claimOfferDecision(
  tenantId: string, orgId: string, parentOrderId: string, funnelId: string, stepId: string, decision: OfferDecisionState,
): Promise<OfferDecision | null> {
  const now = new Date().toISOString();
  const row: OfferDecision = { key: keyOf(tenantId, parentOrderId, funnelId, stepId), tenantId, orgId, parentOrderId, funnelId, stepId, decision, createdAt: now, updatedAt: now };
  return (await decisions.putIfAbsent(row)) ? row : null;
}

/** Move a claimed decision on (CAS from the row the caller holds). */
export async function settleOfferDecision(prev: OfferDecision, decision: OfferDecisionState, childOrderId?: string): Promise<boolean> {
  return decisions.compareAndSwap(prev, { ...prev, decision, ...(childOrderId ? { childOrderId } : {}), updatedAt: new Date().toISOString() });
}

export function routingOutcomeOf(d: OfferDecision | null): StepOutcome | undefined {
  if (!d) return undefined;
  return d.decision === 'declined' ? 'declined' : 'accepted';
}

/**
 * The ONE offer step the buyer may decide now: walk the funnel's own routing from
 * the checkout step (no UTM context: a claim the server cannot place is refused,
 * which fails closed), following recorded decisions; the first upsell/downsell
 * without a decision. `null` when the path ends, or reaches no undecided offer.
 */
export async function currentOfferStep(tenantId: string, funnel: Pick<Funnel, 'funnelId' | 'steps'>, checkoutStepId: string, parentOrderId: string): Promise<FunnelStep | null> {
  let from = checkoutStepId;
  let outcome: StepOutcome | undefined;
  for (let guard = 0; guard <= funnel.steps.length; guard++) {
    const r = resolveNextStepIx(funnel.steps, from, outcome ? { outcome } : {});
    if (!('ix' in r)) return null;
    const step = funnel.steps[r.ix]!;
    if (OFFER_STEP_KINDS.includes(step.kind)) {
      const d = await getOfferDecision(tenantId, parentOrderId, funnel.funnelId, step.stepId);
      if (!d) return step;
      outcome = routingOutcomeOf(d);
    } else {
      outcome = undefined;
    }
    from = step.stepId;
  }
  return null;
}

type ParentReader = (tenantId: string, orgId: string, orderId: string) => Promise<OfferParent | null>;
let parentReader: ParentReader | null = null;
/** Commerce lends its order read at boot (it owns orders; funnels never imports it). */
export function registerOfferParentReader(fn: ParentReader): void { parentReader = fn; }

/**
 * The routing outcome of an upsell/downsell step for the public `next` route: the
 * recorded decision, read only for a valid offer capability. Anything else is
 * `undefined` (sequential routing), never an error: navigation is not authorization,
 * and a refusal here would be an oracle for which orders exist.
 */
export async function offerRoutingOutcome(
  tenantId: string, orgId: string, funnel: Pick<Funnel, 'funnelId'>, step: FunnelStep, orderId: string | undefined, token: unknown,
): Promise<StepOutcome | undefined> {
  if (!parentReader || !orderId || !OFFER_STEP_KINDS.includes(step.kind)) return undefined;
  const parent = await parentReader(tenantId, orgId, orderId);
  if (!offerParentValid(tenantId, orgId, parent, funnel.funnelId, token)) return undefined;
  return routingOutcomeOf(await getOfferDecision(tenantId, parent.orderId, funnel.funnelId, step.stepId));
}

/** Retention: decision rows carry ids only; swept after DECISION_RETENTION_MS. */
export async function sweepOfferDecisions(nowMs: number): Promise<{ deleted: number; failed: number }> {
  let deleted = 0; let failed = 0;
  for (const d of await decisions.list()) {
    if (nowMs - Date.parse(d.createdAt) <= DECISION_RETENTION_MS) continue;
    try { if (await decisions.delete(d.key)) deleted += 1; } catch { failed += 1; }
  }
  return { deleted, failed };
}
registerDefaultWindowSweep({ feature: 'funnels-offer-decisions', sweep: sweepOfferDecisions });
