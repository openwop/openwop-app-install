/**
 * Feature-toggle change audit (ADR 0819 §4).
 *
 * Every admin flip, revert and per-tenant provisioning write appends ONE row to
 * the host's existing global audit stream (`Storage.appendAudit`, the
 * `governanceDecisionLog` precedent), never a second audit store. Before this, a
 * save was a `log.info` line and `updatedBy` held the TENANT, so "who turned
 * this off, and what did it look like before" had no durable answer.
 *
 * The payload is deliberately a SHAPE, not a copy of the row. `audit_log` has no
 * tenant column, no subject eraser and no retention purger, so anything written
 * here is permanent. `betaCohort` holds person ids (a SAML subject can be an
 * email address), so cohorts are recorded as a size, and the per-tenant override
 * keys that changed are recorded as digests salted with the toggle id. The
 * operator's own `principalId` is kept: accountability for a host-wide switch
 * is the point of the row.
 *
 * Best-effort, like the governance log: an audit-store failure is logged and
 * does not fail the flip. An operator killing a feature mid-incident must not
 * be blocked by a degraded audit store.
 */
import { createHash } from 'node:crypto';
import { hostExtStorage } from '../hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import type { ToggleConfig } from './types.js';

const log = createLogger('host.featureToggles.audit');

export type ToggleAuditAction = 'feature-toggle.saved' | 'feature-toggle.reverted' | 'feature-toggle.tenant-enabled' | 'feature-toggle.tenant-disabled';

/** The admin CHOICES of a stored row, reduced to what may live forever. */
function choicesOf(cfg: ToggleConfig | null): Record<string, unknown> | null {
  if (!cfg) return null;
  return {
    status: cfg.status,
    killed: cfg.killed === true,
    variants: (cfg.variants ?? []).map((v) => ({ key: v.key, weight: v.weight })),
    betaCohortSize: cfg.betaCohort?.length ?? 0,
    tenantOverrideCount: Object.keys(cfg.tenantOverrides ?? {}).length,
  };
}

/** Digests of the tenant ids whose override differs between the two rows. */
function changedTenantDigests(id: string, before: ToggleConfig | null, after: ToggleConfig | null): string[] {
  const a = before?.tenantOverrides ?? {};
  const b = after?.tenantOverrides ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [...keys].filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).sort();
  return changed.map((t) => digestTenant(id, t));
}

function digestTenant(id: string, tenantId: string): string {
  return createHash('sha256').update(`${id}:${tenantId}`).digest('hex').slice(0, 16);
}

export async function recordToggleChange(input: {
  action: ToggleAuditAction;
  id: string;
  /** The acting principal (the person), never the tenant. */
  principalId: string;
  /** The workspace the actor was acting in when they made the change. */
  actingTenantId: string;
  before: ToggleConfig | null;
  after: ToggleConfig | null;
  /** Why the change was made, when it came from a larger action (ADR 0892:
   *  `bundle:<id>`). A static label, never person data: this row is permanent. */
  reason?: string;
}): Promise<void> {
  try {
    await hostExtStorage().appendAudit({
      timestamp: new Date().toISOString(),
      principalId: input.principalId,
      action: input.action,
      resource: input.id,
      outcome: 'success',
      payload: {
        // Digested like the override keys: for a provisioning row the acting
        // tenant IS the changed tenant, so a raw id here would undo the digest.
        actingTenant: digestTenant(input.id, input.actingTenantId),
        before: choicesOf(input.before),
        after: choicesOf(input.after),
        changedTenantOverrides: changedTenantDigests(input.id, input.before, input.after),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
  } catch (err) {
    log.warn('feature_toggle_audit_failed', { id: input.id, action: input.action, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The audit rows for one toggle, newest first (the admin history route). */
export async function listToggleChanges(id: string, limit = 50): Promise<Array<{ at: string; action: string; principalId?: string; payload: unknown }>> {
  const rows = await hostExtStorage().listAudit({ actionPrefix: 'feature-toggle.', resource: id, limit });
  return rows.map((r) => ({ at: r.timestamp, action: r.action, ...(r.principalId ? { principalId: r.principalId } : {}), payload: r.payload }));
}
