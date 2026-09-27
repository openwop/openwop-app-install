/**
 * Commerce audit + lifecycle-event helper (ADR 0221 / gap plan §5B B1/B2 — the
 * recordCmsAction / recordAdsAction precedent). ONE helper shared by
 * commerceService and affiliate.ts (which commerceService imports — this module
 * exists so the ledger can audit without an import cycle): an audit row for
 * EVERY mutation (`payload.tenantId` REQUIRED — the governance read withholds
 * rows without it) plus, for the order lifecycle + low-stock, a host event
 * through `emitHostEvent` (ADR 0208): signed-webhook fanout AND event→workflow
 * trigger bindings in one call. Payloads carry ids/status/amounts only — never
 * a card datum, never a contact email. Best-effort: a telemetry failure never
 * blocks a commerce mutation.
 */
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';

const log = createLogger('commerce.telemetry');
const nowIso = (): string => new Date().toISOString();

const COMMERCE_EVENT_FOR_ACTION: Record<string, string> = {
  'order.created': 'host.commerce.order.created',
  'order.paid': 'host.commerce.order.paid',
  'order.refunded': 'host.commerce.order.refunded',
  'order.canceled': 'host.commerce.order.canceled',
  'order.fulfillment-updated': 'host.commerce.order.fulfillment-updated',
  'inventory.low-stock': 'host.commerce.inventory.low-stock',
};

export function recordCommerceAction(
  action: string,
  scope: { tenantId: string; orgId: string },
  actor: string,
  fields: Record<string, unknown>,
): void {
  const at = nowIso();
  const payload = { tenantId: scope.tenantId, orgId: scope.orgId, actor, at, ...fields };
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `commerce.${action}`, resource: String(fields.orderId ?? fields.productId ?? fields.couponId ?? fields.affiliateId ?? fields.payoutId ?? ''), outcome: 'success', payload })
      .catch((err) => log.warn('commerce audit append failed', { action, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  const eventType = COMMERCE_EVENT_FOR_ACTION[action];
  if (eventType) {
    void emitHostEvent({ type: eventType, tenantId: scope.tenantId, payload });
  }
}
