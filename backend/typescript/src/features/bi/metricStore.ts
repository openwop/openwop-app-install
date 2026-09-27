/**
 * ADR 0417 P1 — the `bi:metric` DurableCollection. Tenant-keyed with the
 * teardown registration (4th arg) so account teardown reaps metric rows.
 * System metrics are NOT stored — they are an in-code const merged into reads
 * (`systemMetrics.ts`), so there is no seed machinery to fold/duplicate.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { MetricDef } from './metricTypes.js';

export const metrics = new DurableCollection<MetricDef>(
  'bi:metric',
  (m) => `${m.tenantId}:${m.metricId}`,
  undefined,
  (m) => m.tenantId,
);

export async function listStoredMetrics(tenantId: string): Promise<MetricDef[]> {
  return metrics.listForTenantIndexed(tenantId);
}

export async function getStoredMetric(tenantId: string, metricId: string): Promise<MetricDef | null> {
  const m = await metrics.get(`${tenantId}:${metricId}`);
  return m && m.tenantId === tenantId ? m : null;
}
