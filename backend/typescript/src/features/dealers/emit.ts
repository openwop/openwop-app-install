/**
 * Dealer-network mutation side-channel (ADR 0281) — mirrors territories/commerce
 * emit. Fire-and-forget host event + best-effort audit append; neither can fail
 * the mutation. ids-only payload; `payload.tenantId` REQUIRED (governance audit
 * fail-closed filters on it).
 */
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';

export type DealerEntity = 'dealer' | 'outlet' | 'registration';

export function dealerMutated(input: {
  entity: DealerEntity;
  verb: string;
  tenantId: string;
  orgId: string;
  actor: string;
  entityId: string;
}): void {
  const { entity, verb, tenantId, orgId, actor, entityId } = input;
  void emitHostEvent({
    type: `host.dealer.${entity}.${verb}`,
    tenantId,
    payload: { entityType: entity, entityId, orgId },
  });
  void hostExtStorage()
    .appendAudit({ timestamp: new Date().toISOString(), principalId: actor, action: `dealer.${entity}.${verb}`, resource: `dealer-${entity}:${entityId}`, outcome: 'success', payload: { tenantId, orgId } })
    .catch(() => {});
}
