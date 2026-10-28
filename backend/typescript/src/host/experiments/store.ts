/**
 * ADR 0949 D1 — the experiment store: `experiments:experiment`, keyed
 * `tenant::orgId::experimentId`, with a tenant index. Every read is scoped to a
 * tenant and an org (a prefix on the key, never a cross-tenant scan), and a
 * by-id read in the wrong org is the same `null` as a missing row (ADR 0921 D3).
 */
import { DurableCollection } from '../hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import type { Experiment } from './types.js';

const key = (tenantId: string, orgId: string, experimentId: string): string => `${tenantId}::${orgId}::${experimentId}`;

const experiments = new DurableCollection<Experiment>(
  'experiments:experiment',
  (e) => key(e.tenantId, e.orgId, e.experimentId),
  undefined,
  (e) => e.tenantId,
);

export async function getExperimentRow(tenantId: string, orgId: string, experimentId: string): Promise<Experiment | null> {
  const e = await experiments.get(key(tenantId, orgId, experimentId));
  return e && e.tenantId === tenantId && e.orgId === orgId ? e : null;
}

/** One org's experiments, optionally on one surface. */
export async function listExperimentRows(tenantId: string, orgId: string, surface?: { kind: string; ref?: string }): Promise<Experiment[]> {
  const rows = await experiments.listByPrefix(`${tenantId}::${orgId}::`);
  return rows.filter((e) => e.tenantId === tenantId && e.orgId === orgId
    && (!surface || (e.surface.kind === surface.kind && (surface.ref === undefined || e.surface.ref === surface.ref))));
}

/** Every experiment of a tenant (tenant index; for erasure and export). */
export async function listTenantExperimentRows(tenantId: string): Promise<Experiment[]> {
  return (await experiments.listForTenantIndexed(tenantId)).filter((e) => e.tenantId === tenantId);
}

export async function putExperimentRow(e: Experiment): Promise<void> {
  await experiments.put(e);
}

/** Insert only when absent (a migration must never overwrite a newer row). */
export async function insertExperimentRowIfAbsent(e: Experiment): Promise<boolean> {
  return experiments.putIfAbsent(e);
}

export async function deleteExperimentRow(tenantId: string, orgId: string, experimentId: string): Promise<boolean> {
  return experiments.delete(key(tenantId, orgId, experimentId));
}

/**
 * Read-modify-write under compare-and-swap (ADR 0949 P2a). `fn` returns the next
 * row, or `null` to leave the row as it is; it may throw a typed refusal. Null
 * when the row does not exist in this org. A lost race re-reads and re-applies.
 */
export async function mutateExperimentRow(
  tenantId: string, orgId: string, experimentId: string,
  fn: (current: Experiment) => Experiment | null,
): Promise<Experiment | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await getExperimentRow(tenantId, orgId, experimentId);
    if (!current) return null;
    const next = fn(current);
    if (!next) return current;
    if (await experiments.compareAndSwap(current, next)) return next;
  }
  throw new OpenwopError('conflict', 'The experiment changed while this update ran. Try again.', 409, { reason: 'concurrent_update' });
}
