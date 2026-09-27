/**
 * Cohort SEAT commerce (ADR 0431) — selling a capacity-limited coached cohort.
 *
 * The one place in KickTodo where TWO scarce resources must agree: money (a
 * paid order) and capacity (a finite seat). The ordering is therefore
 * RESERVE → PAY → CONFIRM, never sell-then-reconcile: a refund is not a remedy
 * when a coach's cohort is the scarce good.
 *
 * OWNERSHIP: commerce owns money (this module never learns Stripe), the
 * ACCOUNTABILITY package owns capacity + grants (this module calls its
 * primitives, never a second counter), and the join rides the ADR 0420
 * order-observer inversion — commerce notifies, the seat lane derives.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { getChallenge } from '../kicktodo-core/challengeService.js';
import { getProductInTenant, type Order } from '../commerce/commerceService.js';
import {
  confirmSeat,
  getCohortDetail,
  holdSeat,
  liveHold,
  releaseSeat,
  type SeatHold,
} from '../kicktodo-accountability/cohortService.js';

const log = createLogger('kicktodo.seats');

export interface CohortSeatProduct {
  tenantId: string;
  productId: string;
  circleId: string;
  createdBy: string;
  createdAt: string;
}

const links = new DurableCollection<CohortSeatProduct>(
  'kicktodo-cohort-seat-products',
  (l) => `${l.tenantId}::${l.productId}`,
);

const nowIso = (): string => new Date().toISOString();

export class SeatLinkError extends Error {}

/** Link a Commerce product to a cohort so buying it buys a SEAT. */
export async function linkCohortProduct(
  tenantId: string,
  createdBy: string,
  input: { productId: string; circleId: string },
): Promise<CohortSeatProduct> {
  const detail = await getCohortDetail(tenantId, input.circleId);
  if (!detail) throw new SeatLinkError('That cohort does not exist.');
  const link: CohortSeatProduct = {
    tenantId,
    productId: input.productId,
    circleId: input.circleId,
    createdBy,
    createdAt: nowIso(),
  };
  await links.put(link);
  return link;
}

export async function getSeatLink(tenantId: string, productId: string): Promise<CohortSeatProduct | null> {
  return await links.get(`${tenantId}::${productId}`);
}

/** Reserve a seat before checkout (the RESERVE step). Idempotent per buyer. */
export async function reserveSeat(tenantId: string, buyerSubject: string, productId: string): Promise<SeatHold> {
  const link = await getSeatLink(tenantId, productId);
  if (!link) throw new SeatLinkError('That product is not a cohort seat.');
  return await holdSeat(tenantId, link.circleId, buyerSubject);
}

export interface SeatAvailability {
  capacity: number;
  seatsTaken: number;
  seatsLeft: number;
  heldByYou: boolean;
  /** When the hold expires, so the buyer sees a real countdown rather than a
   *  vague "reserved" state. Absent when nothing is held. */
  holdExpiresAt?: string;
  /** What is actually being bought — a purchase surface that shows only counts
   *  asks someone to pay for an unnamed thing. */
  challengeTitle: string;
  /** §5.10 residue — the id behind the title, so the purchase page can link
   *  back to the challenge being bought instead of naming it inertly. */
  challengeId: string;
  startDateLocal: string;
  /** G4 (chat-first port) — the product's owning org, so the purchase page can
   *  deep-link the buyer to that org's public storefront (`/store/:orgId`) to
   *  actually pay. Absent only when the linked product no longer resolves. */
  orgId?: string;
}

export async function seatAvailability(
  tenantId: string,
  buyerSubject: string,
  productId: string,
): Promise<SeatAvailability | null> {
  const link = await getSeatLink(tenantId, productId);
  if (!link) return null;
  const detail = await getCohortDetail(tenantId, link.circleId);
  if (!detail) return null;
  const hold = await liveHold(tenantId, link.circleId, buyerSubject);
  const challenge = await getChallenge(tenantId, detail.challengeId, detail.challengeVersion);
  // G4 — resolve the product's org so the FE can offer a real checkout CTA (the
  // Pay step otherwise dead-ends). The product is the source of truth for orgId.
  const product = await getProductInTenant(tenantId, productId);
  return {
    capacity: detail.capacity,
    seatsTaken: detail.seatsTaken,
    seatsLeft: Math.max(0, detail.capacity - detail.seatsTaken),
    heldByYou: Boolean(hold),
    ...(hold ? { holdExpiresAt: hold.expiresAt } : {}),
    challengeTitle: challenge?.title ?? '',
    challengeId: detail.challengeId,
    startDateLocal: detail.startDateLocal,
    ...(product ? { orgId: product.orgId } : {}),
  };
}

/**
 * The order-lifecycle observers (registered UNCONDITIONALLY at boot, the
 * ADR 0420 money-truth rule: a refund releases a seat even with the feature
 * toggle OFF). Both are idempotent by `(circleId, buyerSubject)`.
 *
 * `paid` with no live hold and a genuinely full cohort FAILS CLOSED and logs a
 * terminal operator error — the money is neither silently kept nor the cohort
 * silently oversold (PRD §14 reconciliation: durable phases, terminal operator
 * errors, forward repair).
 */
export async function reprocessSeatOrder(order: Order, mode: 'grant' | 'revoke'): Promise<number> {
  let affected = 0;
  for (const line of order.items ?? []) {
    const link = await getSeatLink(order.tenantId, line.productId);
    if (!link) continue;
    if (mode === 'grant') {
      const result = await confirmSeat(order.tenantId, link.circleId, order.createdBy);
      if (result.granted) {
        affected += 1;
      } else {
        log.error('kicktodo_seat_oversold_needs_refund', {
          orderId: order.orderId,
          circleId: link.circleId,
          reason: result.reason ?? 'unknown',
        });
      }
    } else {
      const detail = await getCohortDetail(order.tenantId, link.circleId);
      const today = new Date().toISOString().slice(0, 10);
      const released = await releaseSeat(order.tenantId, link.circleId, order.createdBy, today);
      if (released.released) affected += 1;
      else log.info('kicktodo_seat_refund_after_start', { circleId: link.circleId, startedAt: detail?.startDateLocal });
    }
  }
  return affected;
}
