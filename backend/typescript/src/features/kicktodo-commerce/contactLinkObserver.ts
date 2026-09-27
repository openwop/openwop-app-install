/**
 * ADR 0449 P2 — the paid-order → participant⇄contact link observer.
 *
 * When a paid order bought a KickTodo product (a challenge product link OR a
 * cohort-seat product) AND the order carries a checkout `contactId`, link the
 * buyer subject (`order.createdBy`) to that Contact. Scoped to KickTodo orders
 * only — a plain commerce buyer with no challenge/seat line is never linked.
 * Best-effort: a link failure never affects fulfilment (this runs as one of the
 * best-effort paid observers, after entitlement/seat/share effects).
 */

import type { Order } from '../commerce/commerceService.js';
import { linkSubjectToContact } from '../kicktodo-core/contactBridgeService.js';
import { getLinkByProduct } from './entitlementService.js';
import { getSeatLink } from './seatService.js';

/** True when any line of the order bought a KickTodo challenge or cohort seat. */
async function isKicktodoOrder(order: Order): Promise<boolean> {
  for (const line of order.items ?? []) {
    if (await getLinkByProduct(order.tenantId, line.productId)) return true;
    if (await getSeatLink(order.tenantId, line.productId)) return true;
  }
  return false;
}

export async function linkKicktodoBuyerContact(order: Order): Promise<void> {
  if (!order.contactId || !order.createdBy) return; // no consented contact, or no subject
  if (!(await isKicktodoOrder(order))) return; // not a KickTodo purchase — out of scope
  await linkSubjectToContact(order.tenantId, order.createdBy, order.contactId, 'paid-checkout');
}
