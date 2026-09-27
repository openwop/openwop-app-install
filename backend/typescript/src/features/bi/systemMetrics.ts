/**
 * ADR 0417 P1 — the in-code system metrics for the kernel types. A static
 * const merged into reads: deterministic, tenant-independent, no store writes
 * (so no seed/fold machinery can ever duplicate them — the grade-data GEN
 * lesson applied by construction). `tenantId`/`createdAt` are stamped at read
 * time by the service; the definitions themselves are trusted (in-repo), so
 * they do not pass write-time validation — the evaluator still applies the
 * same closed-world execution to them.
 */
import type { MetricDef } from './metricTypes.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

type SystemMetricSpec = Omit<MetricDef, 'tenantId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'system'>;

const SPECS: SystemMetricSpec[] = [
  {
    metricId: 'sys-deal-count',
    title: 'Open deals',
    description: 'Count of CRM deals (all stages).',
    entityType: 'crm.deal',
    aggregate: 'count',
    groupBy: 'stage_id',
  },
  {
    metricId: 'sys-pipeline-value',
    title: 'Pipeline value',
    description: 'Sum of deal amounts across the pipeline.',
    entityType: 'crm.deal',
    aggregate: 'sum',
    field: 'amount',
    groupBy: 'stage_id',
    timeField: 'close_date',
  },
  {
    metricId: 'sys-avg-deal-size',
    title: 'Average deal size',
    description: 'Average deal amount.',
    entityType: 'crm.deal',
    aggregate: 'avg',
    field: 'amount',
    timeField: 'close_date',
  },
  {
    metricId: 'sys-company-count',
    title: 'Companies',
    description: 'Count of CRM companies.',
    entityType: 'crm.company',
    aggregate: 'count',
  },
  {
    metricId: 'sys-product-count',
    title: 'Products',
    description: 'Count of catalog products.',
    entityType: 'commerce.product',
    aggregate: 'count',
    groupBy: 'type',
  },
  {
    metricId: 'sys-catalog-value',
    title: 'Catalog list value',
    description: 'Sum of product list prices.',
    entityType: 'commerce.product',
    aggregate: 'sum',
    field: 'price',
  },
];

/** System metrics projected for a tenant (read-time stamp; never stored). */
export function systemMetricsFor(tenantId: string): MetricDef[] {
  return SPECS.map((s) => ({
    ...s,
    tenantId,
    system: true,
    createdBy: 'system',
    createdAt: EPOCH,
    updatedAt: EPOCH,
  }));
}

export function isSystemMetricId(metricId: string): boolean {
  return SPECS.some((s) => s.metricId === metricId);
}
