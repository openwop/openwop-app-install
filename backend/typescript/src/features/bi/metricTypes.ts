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
export type KernelMetricType = (typeof KERNEL_METRIC_TYPES)[number];

/** ADR 0846 D2 — the row-level read filter each kernel type's rows pass through
 *  before a metric aggregates them, so a metric never sums rows the owning
 *  feature's own list would hide from the same viewer. Exhaustive by type: adding
 *  a type to the allowlist without deciding its filter is a compile error.
 *  - `crm-visibility` — the CRM record-visibility seam (territories, ADR 0272 P4).
 *  - `org-only` — the owning feature's list read is org-scoped with no row ACL
 *    (service-desk `listTickets`, the CMS page list, the commerce product list).
 *  A row ACL added to one of those later MUST change its entry here. */
export const KERNEL_METRIC_ROW_FILTER: { readonly [T in KernelMetricType]: 'crm-visibility' | 'org-only' } = {
  'crm.deal': 'crm-visibility',
  'crm.company': 'crm-visibility',
  'commerce.product': 'org-only',
  'cms.page': 'org-only',
  'servicedesk.ticket': 'org-only',
};

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
  /** Rows this caller may read in the requested org (before the metric's own filters). */
  totalRows: number;
  /** ADR 0846 — the fetch hit the per-run row ceiling, so the aggregate is partial. */
  truncated?: boolean;
}
