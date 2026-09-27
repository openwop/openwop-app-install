/**
 * Priority Matrix mutation side-channel (ADR 0230 §B1, the ADR 0208 §1/§3
 * pattern — `features/crm/emit.ts` is the template): every list/idea/session
 * mutation calls `priorityMutated` once — a host event (webhooks + trigger
 * bindings) and a best-effort audit append, both fire-and-forget so they can
 * never fail the mutation. Called from every mutating route handler AND every
 * mutating `ctx.features['priority-matrix']` verb — the two entry paths.
 */
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';

export type PriorityEntity = 'list' | 'idea' | 'session';

export function priorityMutated(input: {
  entity: PriorityEntity;
  /** list: created | updated | deleted · idea: submitted | status-moved |
   *  scored | scheduled | schedule-cleared · session: created | updated */
  verb: string;
  tenantId: string;
  /** Opaque actor id — a principal for HTTP callers, `run:<runId>` for verbs. */
  actor: string;
  /** The priority list the mutation belongs to (the aggregate root). */
  listId: string;
  /** The idea card / session the mutation targeted, when applicable. */
  entityId?: string;
  orgId?: string;
}): void {
  const { entity, verb, tenantId, actor, listId, entityId, orgId } = input;
  void emitHostEvent({
    type: `host.priority.${entity}.${verb}`,
    tenantId,
    payload: {
      entityType: entity,
      listId,
      ...(entityId ? { entityId } : {}),
      ...(orgId ? { orgId } : {}),
    },
  });
  // payload.tenantId is REQUIRED — the governance audit view fail-closed
  // filters on it (rows without it are invisible to non-wildcard admins).
  void hostExtStorage()
    .appendAudit({
      timestamp: new Date().toISOString(),
      principalId: actor,
      action: `priority.${entity}.${verb}`,
      resource: `priority-${entity}:${entityId ?? listId}`,
      outcome: 'success',
      payload: { tenantId, listId, ...(orgId ? { orgId } : {}) },
    })
    .catch(() => {});
}
