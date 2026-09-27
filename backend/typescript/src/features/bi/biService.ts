/**
 * ADR 0417 P1 — metric validation (write-time, closed-world) + the evaluator.
 *
 * Validation: a metric's entityType/field/filters/groupBy/timeField are checked
 * against the entities type registry BEFORE storage — unknown anything is a
 * typed 422, never a stored-then-failing metric. Kernel system types come from
 * an explicit allowlist (`KERNEL_METRIC_TYPES`); the entities SURFACE's
 * user-type-only gate stays intact because BI reads system rows via the
 * service layer behind its own org-scoped route/tool gate (ADR correction).
 *
 * Evaluation: `runMetric` fetches the type's rows (system → listSystemEntities;
 * user → queryEntities cursor loop), applies the metric's stored filters + the
 * caller's bounded params (org, range, groupBy/bucket) with ONE in-service
 * matcher for both paths, and aggregates. The model never passes a filter AST —
 * only a metricId + the bounded params (the ADR 0397 closed-world philosophy).
 */
import { OpenwopError } from '../../types.js';
import type { EntityRecord, EntityTypeRecord } from '../entities/entitiesService.js';
import { getEntityType, listSystemEntities, queryEntities } from '../entities/entitiesService.js';
import type { FieldSpec } from '../../host/customFields/index.js';
import {
  AGGREGATES, METRIC_FILTER_OPS, KERNEL_METRIC_TYPES, TIME_BUCKETS,
  type Aggregate, type MetricDef, type MetricFilter, type MetricSeriesPoint,
  type RunMetricParams, type RunMetricResult, type TimeBucket,
} from './metricTypes.js';
import { listStoredMetrics, getStoredMetric, metrics as metricStore } from './metricStore.js';
import { systemMetricsFor, isSystemMetricId } from './systemMetrics.js';

/** Aggregation reads at most this many rows; results carry no silent cap — a
 *  truncated run is reported via `totalRows` vs the fetched ceiling. */
const MAX_ROWS = 5000;
/** Grouped output is capped WELL under the chart renderer's 1000-point cap. */
const MAX_GROUPS = 100;
const MAX_FILTERS = 8;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ── catalog reads ───────────────────────────────────────────────────────────

export async function listMetrics(tenantId: string): Promise<MetricDef[]> {
  const stored = await listStoredMetrics(tenantId);
  return [...systemMetricsFor(tenantId), ...stored.sort((a, b) => a.title.localeCompare(b.title))];
}

export async function getMetric(tenantId: string, metricId: string): Promise<MetricDef | null> {
  const sys = systemMetricsFor(tenantId).find((m) => m.metricId === metricId);
  return sys ?? (await getStoredMetric(tenantId, metricId));
}

// ── write-time validation (closed-world) ────────────────────────────────────

interface MetricInput {
  title: string;
  description?: string;
  entityType: string;
  aggregate: string;
  field?: string;
  filters?: unknown;
  groupBy?: string;
  timeField?: string;
}

async function resolveTypeForMetric(tenantId: string, entityType: string): Promise<EntityTypeRecord> {
  const type = await getEntityType(tenantId, undefined, entityType);
  if (type?.system) {
    if (!(KERNEL_METRIC_TYPES as readonly string[]).includes(entityType)) {
      throw new OpenwopError('validation_error', `System type \`${entityType}\` is not metric-enabled.`, 422, { field: 'entityType' });
    }
    return type;
  }
  if (type) return type;
  throw new OpenwopError('validation_error', `Unknown entity type \`${entityType}\` for this workspace.`, 422, { field: 'entityType' });
}

function fieldOf(type: EntityTypeRecord, key: string): FieldSpec | undefined {
  return type.fields.find((f) => f.key === key);
}

function requireField(type: EntityTypeRecord, key: string, where: string, numeric = false): void {
  const f = fieldOf(type, key);
  if (!f) throw new OpenwopError('validation_error', `Field \`${key}\` does not exist on \`${type.name}\`.`, 422, { field: where });
  if (numeric && f.type !== 'number') {
    throw new OpenwopError('validation_error', `Field \`${key}\` is \`${f.type}\` — a ${where} aggregate needs a number field.`, 422, { field: where });
  }
}

function parseFilters(type: EntityTypeRecord, raw: unknown): MetricFilter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', 'Field `filters` must be an array.', 422, { field: 'filters' });
  if (raw.length > MAX_FILTERS) throw new OpenwopError('validation_error', `At most ${MAX_FILTERS} filters.`, 422, { field: 'filters' });
  return raw.map((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const key = str(o.key);
    const op = str(o.op);
    if (!key || !fieldOf(type, key)) throw new OpenwopError('validation_error', `filters[${i}].key must be a field of \`${type.name}\`.`, 422, { field: 'filters' });
    if (!(METRIC_FILTER_OPS as readonly string[]).includes(op)) {
      throw new OpenwopError('validation_error', `filters[${i}].op must be one of: ${METRIC_FILTER_OPS.join(', ')}.`, 422, { field: 'filters' });
    }
    const value = o.value;
    const scalar = (v: unknown): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v);
    if (op === 'in') {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' || typeof v === 'number')) {
        throw new OpenwopError('validation_error', `filters[${i}].value for \`in\` must be an array of scalars.`, 422, { field: 'filters' });
      }
    } else if (!scalar(value)) {
      throw new OpenwopError('validation_error', `filters[${i}].value must be a scalar.`, 422, { field: 'filters' });
    }
    return { key, op: op as MetricFilter['op'], value: value as MetricFilter['value'] };
  });
}

/** Validate + normalize a metric definition (create/update paths). */
export async function validateMetricInput(tenantId: string, input: MetricInput): Promise<Omit<MetricDef, 'metricId' | 'tenantId' | 'createdBy' | 'createdAt' | 'updatedAt'>> {
  const title = input.title.trim();
  if (!title) throw new OpenwopError('validation_error', 'Field `title` is required.', 422, { field: 'title' });
  if (!(AGGREGATES as readonly string[]).includes(input.aggregate)) {
    throw new OpenwopError('validation_error', `Field \`aggregate\` must be one of: ${AGGREGATES.join(', ')}.`, 422, { field: 'aggregate' });
  }
  const aggregate = input.aggregate as Aggregate;
  const type = await resolveTypeForMetric(tenantId, input.entityType);
  if (aggregate !== 'count') {
    if (!input.field) throw new OpenwopError('validation_error', `A \`${aggregate}\` metric needs a \`field\`.`, 422, { field: 'field' });
    requireField(type, input.field, 'field', true);
  }
  if (input.groupBy) requireField(type, input.groupBy, 'groupBy');
  if (input.timeField) requireField(type, input.timeField, 'timeField');
  const filters = parseFilters(type, input.filters);
  return {
    title,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    entityType: type.name,
    aggregate,
    ...(aggregate !== 'count' && input.field ? { field: input.field } : {}),
    ...(filters.length ? { filters } : {}),
    ...(input.groupBy ? { groupBy: input.groupBy } : {}),
    ...(input.timeField ? { timeField: input.timeField } : {}),
  };
}

// ── CRUD over stored metrics (system metrics are read-only) ─────────────────

export async function createMetric(tenantId: string, createdBy: string, metricId: string, input: MetricInput): Promise<MetricDef> {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(metricId)) {
    throw new OpenwopError('validation_error', 'Field `metricId` must be kebab-case (2-64 chars).', 422, { field: 'metricId' });
  }
  if (isSystemMetricId(metricId) || (await getStoredMetric(tenantId, metricId))) {
    throw new OpenwopError('conflict', `Metric \`${metricId}\` already exists.`, 409, { metricId });
  }
  const body = await validateMetricInput(tenantId, input);
  const now = new Date().toISOString();
  const def: MetricDef = { metricId, tenantId, ...body, createdBy, createdAt: now, updatedAt: now };
  await metricStore.put(def);
  return def;
}

export async function updateMetric(tenantId: string, metricId: string, input: MetricInput): Promise<MetricDef> {
  if (isSystemMetricId(metricId)) throw new OpenwopError('forbidden', 'System metrics are read-only.', 403, { metricId });
  const prev = await getStoredMetric(tenantId, metricId);
  if (!prev) throw new OpenwopError('not_found', 'Metric not found.', 404, { metricId });
  const body = await validateMetricInput(tenantId, input);
  // REPLACE the definition (identity fields kept) — merging would resurrect
  // optionals (filters/groupBy/timeField) the caller deliberately removed.
  const def: MetricDef = {
    metricId: prev.metricId, tenantId: prev.tenantId,
    createdBy: prev.createdBy, createdAt: prev.createdAt,
    ...body, updatedAt: new Date().toISOString(),
  };
  await metricStore.put(def);
  return def;
}

export async function deleteMetric(tenantId: string, metricId: string): Promise<void> {
  if (isSystemMetricId(metricId)) throw new OpenwopError('forbidden', 'System metrics are read-only.', 403, { metricId });
  const prev = await getStoredMetric(tenantId, metricId);
  if (!prev) throw new OpenwopError('not_found', 'Metric not found.', 404, { metricId });
  await metricStore.delete(`${tenantId}:${metricId}`);
}

// ── evaluation ──────────────────────────────────────────────────────────────

function matches(values: Record<string, unknown>, f: MetricFilter): boolean {
  const v = values[f.key];
  switch (f.op) {
    case 'eq': return v === f.value;
    case 'neq': return v !== f.value;
    case 'in': return Array.isArray(f.value) && (f.value as Array<string | number>).some((x) => x === v);
    case 'gt': return typeof v === 'number' && typeof f.value === 'number' ? v > f.value : String(v ?? '') > String(f.value);
    case 'gte': return typeof v === 'number' && typeof f.value === 'number' ? v >= f.value : String(v ?? '') >= String(f.value);
    case 'lt': return typeof v === 'number' && typeof f.value === 'number' ? v < f.value : String(v ?? '') < String(f.value);
    case 'lte': return typeof v === 'number' && typeof f.value === 'number' ? v <= f.value : String(v ?? '') <= String(f.value);
    case 'contains': return typeof v === 'string' && typeof f.value === 'string' && v.toLowerCase().includes(f.value.toLowerCase());
  }
}

async function fetchRows(tenantId: string, type: EntityTypeRecord): Promise<EntityRecord[]> {
  if (type.system) return (await listSystemEntities(tenantId, type.name)).slice(0, MAX_ROWS);
  const out: EntityRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await queryEntities({ tenantId, typeName: type.name, limit: 500, ...(cursor ? { cursor } : {}) });
    out.push(...page.entities);
    if (!page.nextCursor || out.length >= MAX_ROWS) return out.slice(0, MAX_ROWS);
    cursor = page.nextCursor;
  }
}

function bucketKey(iso: string, bucket: TimeBucket): string {
  if (bucket === 'day') return iso.slice(0, 10);
  if (bucket === 'month') return iso.slice(0, 7);
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return 'invalid';
  // ISO week: Thursday of the row's week identifies the ISO year+week.
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Run a metric with bounded caller params (the ONLY run-time inputs a model
 *  or route may pass — never a filter AST). */
export async function runMetric(tenantId: string, metricId: string, params: RunMetricParams): Promise<RunMetricResult> {
  const metric = await getMetric(tenantId, metricId);
  if (!metric) throw new OpenwopError('not_found', 'Metric not found.', 404, { metricId });
  // Param validation FIRST — a bad request is a 422 even when the tenant has
  // no rows yet (the type-missing early return below must not mask it).
  if (params.bucket && !(TIME_BUCKETS as readonly string[]).includes(params.bucket)) {
    throw new OpenwopError('validation_error', `Field \`bucket\` must be one of: ${TIME_BUCKETS.join(', ')}.`, 422, { field: 'bucket' });
  }
  if (params.bucket && params.groupBy) {
    throw new OpenwopError('validation_error', 'Pass `groupBy` OR `bucket`, not both.', 422, { field: 'bucket' });
  }
  if ((params.bucket || params.since || params.until) && !metric.timeField) {
    throw new OpenwopError('validation_error', 'This metric declares no `timeField` — range/bucket runs are not available.', 422, { field: 'bucket' });
  }
  const type = await getEntityType(tenantId, undefined, metric.entityType);
  if (!type) {
    // The kernel type has not been minted for this tenant yet — an honest empty
    // result, not an error (the feature simply has no rows to measure).
    return { metricId, title: metric.title, aggregate: metric.aggregate, entityType: metric.entityType, points: [], totalRows: 0 };
  }
  const groupBy = params.groupBy ?? (params.bucket ? undefined : metric.groupBy);
  if (groupBy && !type.fields.some((f) => f.key === groupBy)) {
    throw new OpenwopError('validation_error', `Field \`${groupBy}\` does not exist on \`${type.name}\`.`, 422, { field: 'groupBy' });
  }

  let rows = await fetchRows(tenantId, type);
  const totalFetched = rows.length;
  // Org scoping — applied whenever the type carries an org column.
  if (params.orgId && type.fields.some((f) => f.key === 'org_id')) {
    rows = rows.filter((r) => r.values.org_id === params.orgId);
  }
  for (const f of metric.filters ?? []) rows = rows.filter((r) => matches(r.values, f));
  if (metric.timeField && (params.since || params.until)) {
    const tf = metric.timeField;
    rows = rows.filter((r) => {
      const v = str(r.values[tf]);
      if (!v) return false;
      if (params.since && v < params.since) return false;
      if (params.until && v > params.until) return false;
      return true;
    });
  }

  const groups = new Map<string, { sum: number; n: number; min: number; max: number }>();
  const keyFor = (r: EntityRecord): string => {
    if (params.bucket && metric.timeField) {
      const v = str(r.values[metric.timeField]);
      return v ? bucketKey(v, params.bucket) : 'undated';
    }
    if (groupBy) return String(r.values[groupBy] ?? '(none)');
    return 'all';
  };
  for (const r of rows) {
    const key = keyFor(r);
    const raw = metric.field !== undefined ? r.values[metric.field] : 1;
    const num = typeof raw === 'number' ? raw : metric.aggregate === 'count' ? 1 : null;
    if (num === null) continue; // non-numeric cell — excluded from numeric aggregates
    const g = groups.get(key) ?? { sum: 0, n: 0, min: Infinity, max: -Infinity };
    g.sum += metric.aggregate === 'count' ? 1 : num;
    g.n += 1;
    g.min = Math.min(g.min, num);
    g.max = Math.max(g.max, num);
    groups.set(key, g);
  }
  const points: MetricSeriesPoint[] = [...groups.entries()]
    .map(([key, g]): MetricSeriesPoint => ({
      key,
      n: g.n,
      value:
        metric.aggregate === 'count' || metric.aggregate === 'sum' ? g.sum
        : metric.aggregate === 'avg' ? (g.n ? g.sum / g.n : 0)
        : metric.aggregate === 'min' ? (g.n ? g.min : 0)
        : g.n ? g.max : 0,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, MAX_GROUPS);

  return {
    metricId, title: metric.title, aggregate: metric.aggregate, entityType: metric.entityType,
    points, totalRows: totalFetched,
    ...(groupBy ? { groupedBy: groupBy } : {}),
    ...(params.bucket ? { bucket: params.bucket } : {}),
  };
}
