/**
 * ADR 0417 P1 — the semantic metric catalog's types + closed worlds.
 *
 * A metric is a GOVERNED definition of a business number over ONE entity type.
 * Everything a model can pass at run time is bounded (metricId + range/groupBy/
 * bucket); everything structural (type, field, filters) is validated closed-
 * world at WRITE time against the entities registry — never trusted from a
 * model, never stored-then-failing.
 */

export const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

/** The evaluator's closed filter-op vocabulary — mirrors the entities QueryOp
 *  set so a metric filter never expresses more than `entities.query` can. */
export const METRIC_FILTER_OPS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
export type MetricFilterOp = (typeof METRIC_FILTER_OPS)[number];

export interface MetricFilter {
  key: string;
  op: MetricFilterOp;
  value: string | number | boolean | Array<string | number>;
}

export const TIME_BUCKETS = ['day', 'week', 'month'] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

/** The KERNEL system types BI may read (an explicit allowlist — the entities
 *  surface's user-type gate stays intact; BI reads system rows via the service
 *  layer behind its own org-scoped gate; ADR 0417 correction note). */
export const KERNEL_METRIC_TYPES = ['crm.deal', 'commerce.product', 'crm.company', 'cms.page', 'servicedesk.ticket'] as const;

export interface MetricDef {
  metricId: string;
  tenantId: string;
  title: string;
  description?: string;
  /** A kernel type from KERNEL_METRIC_TYPES or a published user type. */
  entityType: string;
  aggregate: Aggregate;
  /** Required (and must be a numeric field) for every aggregate except count. */
  field?: string;
  /** Structural filters, validated against the type's fields at write time. */
  filters?: MetricFilter[];
  /** Default group-by field (a run may override with another VALIDATED field). */
  groupBy?: string;
  /** A date/string field enabling range + bucket runs. */
  timeField?: string;
  /** In-code system metric — merged into reads, never stored/edited/deleted. */
  system?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunMetricParams {
  orgId: string;
  /** Override the metric's default groupBy (validated like the stored one). */
  groupBy?: string;
  /** ISO range applied to `timeField` (requires the metric to declare one). */
  since?: string;
  until?: string;
  /** Time-series bucketing over `timeField` (mutually exclusive w/ groupBy). */
  bucket?: TimeBucket;
}

export interface MetricSeriesPoint {
  key: string;
  value: number;
  /** Row count feeding the point (for avg transparency). */
  n: number;
}

export interface RunMetricResult {
  metricId: string;
  title: string;
  aggregate: Aggregate;
  entityType: string;
  /** Ungrouped runs return a single point keyed 'all'. */
  points: MetricSeriesPoint[];
  groupedBy?: string;
  bucket?: TimeBucket;
  totalRows: number;
}
