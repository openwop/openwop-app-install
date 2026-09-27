/**
 * Territory mutation side-channel (ADR 0272 — observability) — mirrors
 * `crm/emit.ts`'s `crmMutated`: every high-impact territory mutation emits a host
 * event (webhooks + trigger bindings) and a best-effort audit append, both
 * fire-and-forget so they can never fail the mutation.
 *
 * Model activation is the security-critical one to audit: it changes CRM record
 * visibility + forecasting for the whole org, so "who activated which model when"
 * MUST be on the audit trail — the same discipline CRM record writes follow.
 *
 * ids-only payload discipline (no record values), and `payload.tenantId` is
 * REQUIRED — the governance audit view fail-closed filters on it.
 */
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';

export type TerritoryEntity = 'model' | 'territory' | 'rule' | 'quota' | 'assignment';

/** Emit + audit one territory mutation. `verb` examples: activated | archived |
 *  created | updated | deleted | reassigned | quota-set. */
export function territoryMutated(input: {
  entity: TerritoryEntity;
  verb: string;
  tenantId: string;
  orgId: string;
  /** Opaque actor id — a principal for HTTP callers. */
  actor: string;
  /** The primary id the mutation targets (modelId / territoryId / ruleId / …). */
  entityId: string;
  /** Optional extra ids (never values) — e.g. the previously-active model on activate. */
  changed?: string[];
}): void {
  const { entity, verb, tenantId, orgId, actor, entityId, changed } = input;
  void emitHostEvent({
    type: `host.territory.${entity}.${verb}`,
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
      action: `territory.${entity}.${verb}`,
      resource: `territory-${entity}:${entityId}`,
      outcome: 'success',
      payload: { tenantId, orgId },
    })
    .catch(() => {});
}
