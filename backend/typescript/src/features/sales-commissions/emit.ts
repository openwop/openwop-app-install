/**
 * Sales-commissions mutation side-channel (ADR 0280) — mirrors `territories/
 * emit.ts`. Every plan/statement mutation fires `commissionMutated` once: a
 * fire-and-forget host event (webhooks + trigger bindings) AND a best-effort
 * audit append, neither able to fail the mutation. ids-only payload discipline;
 * `payload.tenantId` is REQUIRED (the governance audit view fail-closed filters
 * on it).
 */
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';

export type CommissionEntity = 'plan' | 'statement';

export function commissionMutated(input: {
  entity: CommissionEntity;
  verb: string;
  tenantId: string;
  orgId: string;
  /** Opaque actor id — a principal for HTTP callers, `run:<runId>` for verbs. */
  actor: string;
  entityId: string;
  changed?: string[];
}): void {
  const { entity, verb, tenantId, orgId, actor, entityId, changed } = input;
  void emitHostEvent({
    type: `host.commission.${entity}.${verb}`,
    tenantId,
    payload: {
      entityType: entity,
      entityId,
      orgId,
      ...(changed && changed.length > 0 ? { changed } : {}),
    },
  });
  void hostExtStorage()
    .appendAudit({
      timestamp: new Date().toISOString(),
      principalId: actor,
      action: `commission.${entity}.${verb}`,
      resource: `commission-${entity}:${entityId}`,
      outcome: 'success',
      payload: { tenantId, orgId },
    })
    .catch(() => {});
}
