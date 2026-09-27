/**
 * Strategy mutation side-channel (ADR 0230 §B1, the ADR 0208 §1/§3 pattern —
 * `features/crm/emit.ts` is the template): every strategy mutation calls
 * `strategyMutated` once — a host event (webhooks + trigger bindings) and a
 * best-effort audit append, both fire-and-forget so they can never fail the
 * mutation. Called from every mutating route handler (the strategy surface is
 * read-only, so routes are the only mutation entry path today).
 */
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';

export type StrategyEntity = 'strategy' | 'links' | 'revision' | 'check-in' | 'kr';

export function strategyMutated(input: {
  entity: StrategyEntity;
  /** created | updated | activated | paused | completed | archived | deleted |
   *  restored | activation-queued | activation-approved | activation-rejected */
  verb: string;
  tenantId: string;
  /** Opaque actor id — a principal for HTTP callers, `run:<runId>` for verbs. */
  actor: string;
  strategyId: string;
  orgId?: string;
  /** Changed top-level field names (ids-only payload discipline — no values). */
  changed?: string[];
  /** ADR 0230 §B3 (architect Q4) — set when a protected-field edit on an
   *  active strategy auto-reverted it to draft. */
  autoRevertedToDraft?: boolean;
}): void {
  const { entity, verb, tenantId, actor, strategyId, orgId, changed, autoRevertedToDraft } = input;
  void emitHostEvent({
    type: `host.strategy.${entity}.${verb}`,
    tenantId,
    payload: {
      entityType: entity,
      strategyId,
      ...(orgId ? { orgId } : {}),
      ...(changed && changed.length > 0 ? { changed } : {}),
      ...(autoRevertedToDraft ? { autoRevertedToDraft: true } : {}),
    },
  });
  // payload.tenantId is REQUIRED — the governance audit view fail-closed
  // filters on it (rows without it are invisible to non-wildcard admins).
  void hostExtStorage()
    .appendAudit({
      timestamp: new Date().toISOString(),
      principalId: actor,
      action: `strategy.${entity}.${verb}`,
      resource: `strategy:${strategyId}`,
      outcome: 'success',
      payload: { tenantId, ...(orgId ? { orgId } : {}), ...(autoRevertedToDraft ? { autoRevertedToDraft: true } : {}) },
    })
    .catch(() => {});
}
