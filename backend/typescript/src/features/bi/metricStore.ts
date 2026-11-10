/**
 * ADR 0417 P1 — the `bi:metric` DurableCollection. Tenant-keyed with the
 * teardown registration (4th arg) so account teardown reaps metric rows.
 * System metrics are NOT stored — they are an in-code const merged into reads
 * (`systemMetrics.ts`), so there is no seed machinery to fold/duplicate.
 *
 * ADR 1052 D0 — each stored metric belongs to ONE org: keyed
 * `tenant:org:metricId` and carrying a top-level `orgId`, so org teardown reaps it
 * with the org. The catalog used to be tenant-wide while every write was authorized
 * in one org, so an admin of org A could redefine or delete org B's metrics. Every
 * read here takes the org; there is no tenant-wide stored-metric read left.
 *
 * The top-level `orgId` also makes a metric an org-scoped row for RI-7: `deleteOrg`
 * REFUSES (409) while an org still holds metrics, as it does for every org-scoped
 * business row; it never deletes them (grade-code M2 — an earlier draft of this
 * comment said it reaped them).
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { MetricDef } from './metricTypes.js';

/** A pre-1052 row carries no `orgId` and keeps its original key `tenant:metricId`, so
 *  the same handle addresses both shapes (BI84WF-12 — a read-only LEGACY metric, see
 *  `listLegacyMetrics`). Every row written since carries its org. */
export const storedMetricKey = (tenantId: string, orgId: string | undefined, metricId: string): string =>
  orgId ? `${tenantId}:${orgId}:${metricId}` : `${tenantId}:${metricId}`;

export const metrics = new DurableCollection<MetricDef>(
  'bi:metric',
  (m) => storedMetricKey(m.tenantId, m.orgId, m.metricId),
  undefined,
  (m) => m.tenantId,
);

export async function listStoredMetrics(tenantId: string, orgId: string): Promise<MetricDef[]> {
  return (await metrics.listForTenantIndexed(tenantId)).filter((m) => m.tenantId === tenantId && m.orgId === orgId);
}

export async function getStoredMetric(tenantId: string, orgId: string, metricId: string): Promise<MetricDef | null> {
  const m = await metrics.get(storedMetricKey(tenantId, orgId, metricId));
  return m && m.tenantId === tenantId && m.orgId === orgId ? m : null;
}

/** ADR 1052 BI84WF-12 — the tenant's pre-1052 metrics (no org). Before ADR 1052 the
 *  catalog was tenant-wide, so an installation that upgrades with stored metrics would
 *  otherwise see them vanish. They stay visible and runnable, READ-ONLY, in every org
 *  of the tenant until a manager adopts each into one org (`adoptMetric`). */
export async function listLegacyMetrics(tenantId: string): Promise<MetricDef[]> {
  return (await metrics.listForTenantIndexed(tenantId)).filter((m) => m.tenantId === tenantId && !m.orgId);
}

export async function getLegacyMetric(tenantId: string, metricId: string): Promise<MetricDef | null> {
  const m = await metrics.get(storedMetricKey(tenantId, undefined, metricId));
  return m && m.tenantId === tenantId && !m.orgId ? m : null;
}

/** ADR 1052 D13 — every stored metric of the tenant, for the DSAR eraser only. */
export async function __metricsForErasure(tenantId: string): Promise<MetricDef[]> {
  return (await metrics.listForTenantIndexed(tenantId)).filter((m) => m.tenantId === tenantId);
}
