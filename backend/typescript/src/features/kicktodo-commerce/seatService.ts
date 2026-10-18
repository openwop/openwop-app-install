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
import { getProductInTenant, listTenantOrdersByStatus, type Order } from '../commerce/commerceService.js';
import {
  confirmSeat,
  getCohortDetail,
  holdSeat,
  liveHold,
  releaseSeat,
  seatCircleForOrder,
  type SeatHold,
} from '../kicktodo-accountability/cohortService.js';
import { grantRowExists } from '../kicktodo-accountability/circleService.js';

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

/** KTO-5 — the product already sells seats in a DIFFERENT cohort. */
export class SeatLinkConflictError extends Error {
  constructor(readonly existing: CohortSeatProduct) {
    super(`Product already sells seats in cohort ${existing.circleId}; use a new product for another cohort.`);
  }
}

/** Link a Commerce product to a cohort so buying it buys a SEAT.
 *
 *  KTO-5 — first-link-wins (insert-if-absent), never a silent overwrite. Re-linking
 *  the SAME cohort is idempotent and returns the stored link; a DIFFERENT cohort is
 *  refused with `SeatLinkConflictError`. Unlike a challenge link (where `replace` is
 *  safe because revocation keys off the order, KTCOM-D1), every seat effect
 *  resolves the product's CURRENT link: `reprocessSeatOrder` confirms a paid order
 *  into it and RELEASES a refunded order's seat from it. A product re-pointed from
 *  cohort A to B therefore refunds A-buyers out of B (freeing a seat they never
 *  held, while their A seat stays taken) and confirms in-flight A-holds into B,
 *  overselling capacity. That holds whether the overwrite was concurrent or not, so
 *  there is no `replace` escape hatch: another cohort needs another product. */
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
  // Seat links are never deleted, so a lost insert always finds the winner; the
  // bounded loop only guards the theoretical vanish-between-reads case.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await links.compareAndSwap(null, link)) return link;
    const existing = await links.get(`${tenantId}::${input.productId}`);
    if (!existing) continue;
    if (existing.circleId === input.circleId) return existing;
    throw new SeatLinkConflictError(existing);
  }
  throw new SeatLinkError('Could not link the product; retry.');
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
  // KTCOM-4 — the seat this order bought, from the seat ledger. A refund releases
  // THAT cohort's seat (not whatever the product links to today), and only when the
  // seat records this order. A seat from before KTCOM-4 records none, so the
  // product's link stays the fallback for it.
  const boughtCircle = mode === 'revoke' ? await seatCircleForOrder(order.tenantId, order.createdBy, order.orderId) : null;
  for (const line of order.items ?? []) {
    const link = await getSeatLink(order.tenantId, line.productId);
    if (!link) continue;
    if (mode === 'grant') {
      const result = await confirmSeat(order.tenantId, link.circleId, order.createdBy, undefined, { orderId: order.orderId });
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
      const circleId = boughtCircle ?? link.circleId;
      const detail = await getCohortDetail(order.tenantId, circleId);
      const today = new Date().toISOString().slice(0, 10);
      const released = await releaseSeat(order.tenantId, circleId, order.createdBy, today, { orderId: order.orderId });
      if (released.released) affected += 1;
      else log.info('kicktodo_seat_refund_not_released', { circleId, startedAt: detail?.startDateLocal });
    }
  }
  return affected;
}

/**
 * KTCOM-4 — the seat half of the operator `/reconcile` (it repaired entitlements and
 * shares, never seats). The order observers are best-effort, so this re-derives seat
 * effects from the tenant's terminal orders:
 *  - a paid/fulfilled order whose buyer has NO grant row in the cohort at all (the
 *    paid observer never reached them) is confirmed — only BEFORE the cohort starts,
 *    and never over an existing row, so an owner's revocation is never undone;
 *  - a refunded/canceled order releases the seat it bought (`releaseSeat` already
 *    refuses after the start, and refuses a seat another order paid for).
 * Idempotent: a healthy tenant repairs zero seats. Bounded by the tenant order index.
 */
export async function reconcileSeatOrders(tenantId: string, now: Date = new Date()): Promise<{ seatsRepaired: number }> {
  let seatsRepaired = 0;
  const today = now.toISOString().slice(0, 10);
  for (const status of ['paid', 'fulfilled'] as const) {
    for (const order of await listTenantOrdersByStatus(tenantId, status)) {
      for (const line of order.items ?? []) {
        const link = await getSeatLink(tenantId, line.productId);
        if (!link) continue;
        const detail = await getCohortDetail(tenantId, link.circleId);
        if (!detail || !(today < detail.startDateLocal)) continue;
        if (await grantRowExists(tenantId, link.circleId, order.createdBy)) continue;
        const result = await confirmSeat(tenantId, link.circleId, order.createdBy, undefined, { orderId: order.orderId });
        if (result.granted && result.reason === undefined) seatsRepaired += 1;
        else if (!result.granted) log.error('kicktodo_seat_oversold_needs_refund', { orderId: order.orderId, circleId: link.circleId, reason: result.reason ?? 'unknown' });
      }
    }
  }
  for (const status of ['refunded', 'canceled'] as const) {
    for (const order of await listTenantOrdersByStatus(tenantId, status)) {
      seatsRepaired += await reprocessSeatOrder(order, 'revoke');
    }
  }
  if (seatsRepaired > 0) log.info('kicktodo_seats_reconciled_from_orders', { tenantId, seatsRepaired });
  return { seatsRepaired };
}
