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
 * user → listLiveEntities), applies the metric's stored filters + the
 * caller's bounded params (org, range, groupBy/bucket) with ONE in-service
 * matcher for both paths, and aggregates. The model never passes a filter AST —
 * only a metricId + the bounded params (the ADR 0397 closed-world philosophy).
 *
 * ADR 1052 — a wrong number is a typed failure, a partial one says so:
 *  - the catalog is per org (D0);
 *  - the stored definition is RE-VALIDATED against the live type on every run and
 *    every catalog read, with the write path's own predicates (D1). A field, enum
 *    option or type that went away is `metric_stale`, never an aggregate over
 *    `undefined` (where a `neq` filter matched every row);
 *  - no row cap (the kernel caps a type at 10,000 and every row was already loaded
 *    before the old 5,000 slice); org scope is decided by the type class (D2);
 *  - the group cap is reported (D3); dates are strict, undated rows are counted
 *    rather than bucketed, and a bounded count/sum series is zero-filled (D4).
 */
import { OpenwopError } from '../../types.js';
import type { EntityRecord, EntityTypeRecord } from '../entities/entitiesService.js';
import { getEntityType, listSystemEntities, listLiveEntities } from '../entities/entitiesService.js';
import { isStrictDate, type FieldSpec } from '../../host/customFields/index.js';
import {
  AGGREGATES, METRIC_FILTER_OPS, KERNEL_METRIC_TYPES, KERNEL_METRIC_ROW_FILTER, TIME_BUCKETS,
  type KernelMetricType,
  type Aggregate, type MetricCatalogEntry, type MetricDef, type MetricFilter, type MetricSeriesPoint,
  type MetricStale, type RunMetricParams, type RunMetricResult, type TimeBucket,
} from './metricTypes.js';
import { listStoredMetrics, getStoredMetric, listLegacyMetrics, getLegacyMetric, metrics as metricStore } from './metricStore.js';
import { systemMetricsFor, isSystemMetricId } from './systemMetrics.js';
import { filterVisibleCrmKernelRows } from '../../host/crmRecordVisibility.js';

/** Grouped output is capped WELL under the chart renderer's 1000-point cap. */
const MAX_GROUPS = 100;
const MAX_FILTERS = 8;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isKernelName = (name: string): boolean => (KERNEL_METRIC_TYPES as readonly string[]).includes(name);

function requireOrg(orgId: string): void {
  // ADR 1052 D6 — the evaluator is the exit: an empty org must never read as "every org".
  if (!orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 422, { field: 'orgId' });
}

// ── closed-world checks (ONE set, used at write AND at run) ─────────────────

function fieldOf(type: EntityTypeRecord, key: string): FieldSpec | undefined {
  return type.fields.find((f) => f.key === key);
}

/** The scalar kind a filter value must have on field `f` (ADR 1052 D7, grade-code H1).
 *  `null` = a kind no filter can compare (extension kinds never live in `values`). */
function valueKindOf(f: FieldSpec): 'number' | 'string' | 'boolean' | null {
  switch (f.type) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'string': case 'enum': case 'date': case 'reference': case 'media': return 'string';
    default: return null;
  }
}

/** Does `value` fit `op` on field `f`? Every op compares like with like: a value of
 *  another kind would match nothing (`eq`) or everything (`neq`), which is the
 *  wrong-number failure this ADR closes, so it is refused at write and is stale at
 *  run. Enum values must be current options (ADR 1052 D7). */
function filterValueProblem(f: FieldSpec, op: string, value: unknown): string | null {
  const kind = valueKindOf(f);
  if (!kind) return `\`${f.key}\` cannot be filtered`;
  const values: unknown[] = op === 'in' ? (Array.isArray(value) ? value : []) : [value];
  if (op === 'in' && values.length === 0) return 'value for `in` must be a non-empty array';
  if (op !== 'in' && Array.isArray(value)) return 'value must be a single value';
  const wrong = values.find((v) => typeof v !== kind);
  if (wrong !== undefined || values.some((v) => v === undefined)) return `values on \`${f.key}\` must be ${kind}s`;
  if (op === 'contains' && kind !== 'string') return '`contains` needs a text field';
  if (kind === 'boolean' && op !== 'eq' && op !== 'neq') return `\`${op}\` does not apply to a yes/no field`;
  if (f.type === 'enum' && (op === 'eq' || op === 'neq' || op === 'in')) {
    const options = f.options ?? [];
    const missing = values.find((v) => !options.includes(v as string));
    if (missing !== undefined) return `\`${String(missing)}\` is not an option of \`${f.key}\``;
  }
  return null;
}

/** ADR 1052 D1 — the first definition key that no longer fits the live type, or null.
 *  The same predicates the write path applies; run on every run and catalog read. */
function staleField(def: Pick<MetricDef, 'aggregate' | 'field' | 'filters' | 'groupBy' | 'timeField'>, type: EntityTypeRecord): string | null {
  if (def.aggregate !== 'count') {
    const f = def.field ? fieldOf(type, def.field) : undefined;
    if (!f || f.type !== 'number') return def.field ?? 'field';
  }
  for (const flt of def.filters ?? []) {
    const f = fieldOf(type, flt.key);
    if (!f || filterValueProblem(f, flt.op, flt.value)) return flt.key;
  }
  if (def.groupBy && !fieldOf(type, def.groupBy)) return def.groupBy;
  if (def.timeField) {
    const f = fieldOf(type, def.timeField);
    if (!f || (f.type !== 'date' && f.type !== 'string')) return def.timeField;
  }
  return null;
}

/** ADR 1052 D1 — the stale verdict for a stored definition against its live type
 *  (`null` = no type row). A missing KERNEL type the tenant never minted is not
 *  stale: its feature simply has no rows yet. A missing USER type was deleted
 *  (architect B1), and a dotted name off the kernel allowlist never runs. */
function verdictFor(def: MetricDef, type: EntityTypeRecord | null): MetricStale | undefined {
  if (def.entityType.includes('.') && !isKernelName(def.entityType)) return { field: 'entityType' };
  if (!type) return isKernelName(def.entityType) ? undefined : { field: 'entityType' };
  if (type.system && !isKernelName(type.name)) return { field: 'entityType' };
  const field = staleField(def, type);
  return field ? { field } : undefined;
}

function staleError(metricId: string, field: string): OpenwopError {
  return new OpenwopError(
    'validation_error',
    `Metric \`${metricId}\` no longer fits its entity type: \`${field}\` changed or was removed. Edit the metric.`,
    422,
    { reason: 'metric_stale', metricId, field },
  );
}

// ── catalog reads ───────────────────────────────────────────────────────────

/** The org's catalog: the in-code system metrics plus the org's own (ADR 1052 D0). */
export async function listMetrics(tenantId: string, orgId: string): Promise<MetricDef[]> {
  requireOrg(orgId);
  const stored = await listStoredMetrics(tenantId, orgId);
  // BI84WF-12 — pre-1052 tenant-wide metrics stay listed (read-only) in every org until
  // adopted; an org's own metric of the same id wins.
  const own = new Set(stored.map((m) => m.metricId));
  const legacy = (await listLegacyMetrics(tenantId)).filter((m) => !own.has(m.metricId));
  return [...systemMetricsFor(tenantId), ...[...stored, ...legacy].sort((a, b) => a.title.localeCompare(b.title))];
}

export async function getMetric(tenantId: string, orgId: string, metricId: string): Promise<MetricDef | null> {
  requireOrg(orgId);
  const sys = systemMetricsFor(tenantId).find((m) => m.metricId === metricId);
  return sys ?? (await getStoredMetric(tenantId, orgId, metricId)) ?? (await getLegacyMetric(tenantId, metricId));
}

/** BI84WF-12 — a legacy metric is read-only: editing it in one org would change it in
 *  every org that still lists it. */
async function refuseLegacyWrite(tenantId: string, metricId: string): Promise<void> {
  if (await getLegacyMetric(tenantId, metricId)) {
    throw new OpenwopError('conflict', 'This metric predates per-organization metrics. Move it to this organization before editing it.', 409, { metricId, reason: 'metric_legacy' });
  }
}

/** BI84WF-12 — move a pre-1052 tenant-wide metric into ONE org's catalog. It then leaves
 *  every other org's list (the ADR 1052 D0 rule). Insert-if-absent, then compare-and-
 *  delete the legacy row; if that row changed meanwhile, the insert is undone. */
export async function adoptMetric(tenantId: string, orgId: string, metricId: string): Promise<MetricDef> {
  requireOrg(orgId);
  const legacy = await getLegacyMetric(tenantId, metricId);
  if (!legacy) throw new OpenwopError('not_found', 'Metric not found.', 404, { metricId });
  if (await getStoredMetric(tenantId, orgId, metricId)) {
    throw new OpenwopError('conflict', `This organization already has a metric \`${metricId}\`.`, 409, { metricId });
  }
  const adopted: MetricDef = { ...legacy, orgId, updatedAt: new Date().toISOString() };
  if (!(await metricStore.putIfAbsent(adopted))) {
    throw new OpenwopError('conflict', `This organization already has a metric \`${metricId}\`.`, 409, { metricId });
  }
  if (!(await metricStore.compareAndDelete(legacy))) {
    await metricStore.compareAndDelete(adopted);
    throw new OpenwopError('conflict', 'This metric was changed meanwhile. Reload and try again.', 409, { metricId, reason: 'metric_changed' });
  }
  return adopted;
}

/** ADR 1052 D9 — the ONE projection every lane lists: the definition (field and
 *  filters included, so a reader can say what a metric measures) plus its live stale
 *  verdict; never `createdBy`, `tenantId` or timestamps. One type read per distinct
 *  entity type. */
export async function projectCatalog(tenantId: string, defs: MetricDef[]): Promise<MetricCatalogEntry[]> {
  const typeReads = new Map<string, Promise<EntityTypeRecord | null>>();
  const out: MetricCatalogEntry[] = [];
  for (const m of defs) {
    let read = typeReads.get(m.entityType);
    if (!read) { read = getEntityType(tenantId, undefined, m.entityType); typeReads.set(m.entityType, read); }
    const stale = verdictFor(m, await read);
    out.push({
      metricId: m.metricId,
      title: m.title,
      ...(m.description ? { description: m.description } : {}),
      entityType: m.entityType,
      aggregate: m.aggregate,
      ...(m.field ? { field: m.field } : {}),
      ...(m.filters?.length ? { filters: m.filters } : {}),
      ...(m.groupBy ? { groupBy: m.groupBy } : {}),
      ...(m.timeField ? { timeField: m.timeField } : {}),
      system: m.system === true,
      ...(!m.system && !m.orgId ? { legacy: true as const } : {}),
      ...(stale ? { stale } : {}),
    });
  }
  return out;
}

// ── write-time validation (closed-world) ────────────────────────────────────

export interface MetricInput {
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
    if (!isKernelName(entityType)) {
      throw new OpenwopError('validation_error', `System type \`${entityType}\` is not metric-enabled.`, 422, { field: 'entityType' });
    }
    return type;
  }
  if (type) return type;
  throw new OpenwopError('validation_error', `Unknown entity type \`${entityType}\` for this workspace.`, 422, { field: 'entityType' });
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
    const spec = key ? fieldOf(type, key) : undefined;
    if (!spec) throw new OpenwopError('validation_error', `filters[${i}].key must be a field of \`${type.name}\`.`, 422, { field: 'filters', index: i });
    if (!(METRIC_FILTER_OPS as readonly string[]).includes(op)) {
      throw new OpenwopError('validation_error', `filters[${i}].op must be one of: ${METRIC_FILTER_OPS.join(', ')}.`, 422, { field: 'filters', index: i });
    }
    const problem = filterValueProblem(spec, op, o.value);
    if (problem) throw new OpenwopError('validation_error', `filters[${i}]: ${problem}.`, 422, { field: 'filters', index: i });
    return { key, op: op as MetricFilter['op'], value: o.value as MetricFilter['value'] };
  });
}

/** Validate + normalize a metric definition (create/update paths). */
export async function validateMetricInput(tenantId: string, input: MetricInput): Promise<Omit<MetricDef, 'metricId' | 'tenantId' | 'orgId' | 'createdBy' | 'createdAt' | 'updatedAt'>> {
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
  if (input.timeField) {
    requireField(type, input.timeField, 'timeField');
    const kind = fieldOf(type, input.timeField)!.type;
    if (kind !== 'date' && kind !== 'string') {
      throw new OpenwopError('validation_error', `Field \`${input.timeField}\` is \`${kind}\` — a time field must be a date or string field.`, 422, { field: 'timeField' });
    }
  }
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

export async function createMetric(tenantId: string, orgId: string, createdBy: string, metricId: string, input: MetricInput): Promise<MetricDef> {
  requireOrg(orgId);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(metricId)) {
    throw new OpenwopError('validation_error', 'Field `metricId` must be kebab-case (2-64 chars).', 422, { field: 'metricId' });
  }
  const conflict = (): OpenwopError => new OpenwopError('conflict', `Metric \`${metricId}\` already exists.`, 409, { metricId });
  if (isSystemMetricId(metricId)) throw conflict();
  const body = await validateMetricInput(tenantId, input);
  const now = new Date().toISOString();
  const def: MetricDef = { metricId, tenantId, orgId, ...body, createdBy, createdAt: now, updatedAt: now };
  // ADR 1052 D8 — insert-if-absent: two racing creates of one id cannot both succeed.
  if (!(await metricStore.putIfAbsent(def))) throw conflict();
  return def;
}

export async function updateMetric(
  tenantId: string, orgId: string, metricId: string, input: MetricInput,
  /** ADR 1052 D8 — the version the editor loaded; a newer row is a 409, not overwritten. */
  expectedUpdatedAt?: string,
): Promise<MetricDef> {
  requireOrg(orgId);
  if (isSystemMetricId(metricId)) throw new OpenwopError('forbidden', 'System metrics are read-only.', 403, { metricId });
  const prev = await getStoredMetric(tenantId, orgId, metricId);
  if (!prev) { await refuseLegacyWrite(tenantId, metricId); throw new OpenwopError('not_found', 'Metric not found.', 404, { metricId }); }
  const changed = (): OpenwopError => new OpenwopError('conflict', 'This metric was changed by someone else. Reload it and edit again.', 409, { metricId, reason: 'metric_changed' });
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== prev.updatedAt) throw changed();
  const body = await validateMetricInput(tenantId, input);
  // REPLACE the definition (identity fields kept) — merging would resurrect
  // optionals (filters/groupBy/timeField) the caller deliberately removed.
  const now = new Date().toISOString();
  const def: MetricDef = {
    metricId: prev.metricId, tenantId: prev.tenantId, orgId: prev.orgId,
    createdBy: prev.createdBy, createdAt: prev.createdAt,
    ...body,
    // Strictly newer than the version it replaces, so a same-millisecond save still
    // moves the version a second editor holds.
    updatedAt: now > prev.updatedAt ? now : new Date(Date.parse(prev.updatedAt) + 1).toISOString(),
  };
  // Single attempt: a retry would re-apply this edit over a newer one (ADR 0845).
  if (!(await metricStore.compareAndSwap(prev, def))) throw changed();
  return def;
}

export async function deleteMetric(tenantId: string, orgId: string, metricId: string): Promise<void> {
  requireOrg(orgId);
  if (isSystemMetricId(metricId)) throw new OpenwopError('forbidden', 'System metrics are read-only.', 403, { metricId });
  const prev = await getStoredMetric(tenantId, orgId, metricId);
  if (!prev) { await refuseLegacyWrite(tenantId, metricId); throw new OpenwopError('not_found', 'Metric not found.', 404, { metricId }); }
  // The exact row read: a concurrent re-create is never removed (ADR 1052 D8).
  if (!(await metricStore.compareAndDelete(prev))) {
    throw new OpenwopError('conflict', 'This metric was changed by someone else. Reload and try again.', 409, { metricId, reason: 'metric_changed' });
  }
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

const DAY_MS = 86_400_000;

/** ADR 1052 D4 — a strict ISO date (`YYYY-MM-DD`) or datetime (`YYYY-MM-DDTHH:MM…`),
 *  as epoch ms plus whether it carried a time. Anything else is not a date. */
function parseInstant(v: string): { ms: number; dateOnly: boolean } | null {
  if (!isStrictDate(v.slice(0, 10))) return null;
  if (v.length === 10) return { ms: Date.parse(`${v}T00:00:00.000Z`), dateOnly: true };
  if (v[10] !== 'T' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
}

function parseBound(raw: string | undefined, which: 'since' | 'until'): number | undefined {
  if (raw === undefined) return undefined;
  const p = parseInstant(raw);
  if (!p) throw new OpenwopError('validation_error', `Field \`${which}\` must be an ISO date (YYYY-MM-DD) or datetime.`, 422, { field: which });
  // A date-only `until` covers that whole day.
  return which === 'until' && p.dateOnly ? p.ms + DAY_MS - 1 : p.ms;
}

function bucketKey(ms: number, bucket: TimeBucket): string {
  const iso = new Date(ms).toISOString();
  if (bucket === 'day') return iso.slice(0, 10);
  if (bucket === 'month') return iso.slice(0, 7);
  // ISO week: Thursday of the row's week identifies the ISO year+week.
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY_MS - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Every bucket key from `since` to `until`, in order (zero-fill, ADR 1052 D4). Bounded
 *  by the caller's range; the group cap still applies after. */
/** A bounded series longer than this many buckets is refused rather than silently
 *  cut short (grade-code M4): ~27 years of days. */
const MAX_SERIES_BUCKETS = 10_000;

function bucketKeysBetween(since: number, until: number, bucket: TimeBucket): string[] {
  const keys: string[] = [];
  const step = bucket === 'month' ? 0 : bucket === 'week' ? 7 * DAY_MS : DAY_MS;
  let cursor = since;
  while (cursor <= until) {
    if (keys.length >= MAX_SERIES_BUCKETS) {
      throw new OpenwopError('validation_error', `That range holds more than ${MAX_SERIES_BUCKETS} ${bucket} buckets — use a larger bucket or a shorter range.`, 422, { field: 'bucket' });
    }
    const key = bucketKey(cursor, bucket);
    if (keys[keys.length - 1] !== key) keys.push(key);
    if (bucket === 'month') {
      const d = new Date(cursor);
      cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    } else {
      cursor += step;
    }
  }
  // A week stepped from mid-week can jump past `until` before reaching its week.
  const last = bucketKey(until, bucket);
  if (keys[keys.length - 1] !== last) keys.push(last);
  return keys;
}

/** Run a metric with bounded caller params (the ONLY run-time inputs a model
 *  or route may pass — never a filter AST). */
export async function runMetric(
  tenantId: string,
  metricId: string,
  params: RunMetricParams,
  /** ADR 0846 D2 — who the rows are read AS. REQUIRED, so no caller can reach the
   *  aggregate without deciding: a human caller passes their id and gets only rows
   *  the owning feature would show them; `undefined` is a system read (unfiltered,
   *  the `filterVisibleCrmRecords` contract). */
  viewer: string | undefined,
): Promise<RunMetricResult> {
  requireOrg(params.orgId);
  const metric = await getMetric(tenantId, params.orgId, metricId);
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
  const since = parseBound(params.since, 'since');
  const until = parseBound(params.until, 'until');
  if (since !== undefined && until !== undefined && since > until) {
    throw new OpenwopError('validation_error', '`since` is after `until`.', 422, { field: 'since' });
  }

  // ADR 1052 D1 — the stored definition must still fit the live type.
  const type = await getEntityType(tenantId, undefined, metric.entityType);
  const stale = verdictFor(metric, type);
  if (stale) throw staleError(metricId, stale.field);
  const kernel = isKernelName(metric.entityType);
  const scope: RunMetricResult['scope'] = kernel ? 'org' : 'tenant';
  if (!type) {
    // A kernel type the tenant never minted: its feature has no rows yet — an honest
    // empty result, not an error (a deleted USER type is stale, above).
    return { metricId, title: metric.title, aggregate: metric.aggregate, entityType: metric.entityType, points: [], scope, totalRows: 0 };
  }
  const groupBy = params.groupBy ?? (params.bucket ? undefined : metric.groupBy);
  if (groupBy && !type.fields.some((f) => f.key === groupBy)) {
    throw new OpenwopError('validation_error', `Field \`${groupBy}\` does not exist on \`${type.name}\`.`, 422, { field: 'groupBy' });
  }

  let rows: EntityRecord[];
  if (kernel) {
    // ADR 1052 D2 — kernel rows are org-scoped on the column every kernel schema
    // declares (pinned by test), then filtered by the owning feature's row ACL.
    rows = (await listSystemEntities(tenantId, type.name)).filter((r) => r.values.org_id === params.orgId);
    if (KERNEL_METRIC_ROW_FILTER[type.name as KernelMetricType] === 'crm-visibility') {
      rows = await filterVisibleCrmKernelRows({ tenantId, typeName: type.name, callerSubject: viewer, rows });
    }
  } else {
    // User types are tenant-scoped, as the entities read is (`workspace:read`, root
    // namespace — ADR 0847). A user field named `org_id` is ordinary data, not a scope.
    rows = await listLiveEntities(tenantId, type.name);
  }
  const totalRows = rows.length;
  for (const f of metric.filters ?? []) rows = rows.filter((r) => matches(r.values, f));

  const tf = metric.timeField;
  const instantOf = (r: EntityRecord): number | null => {
    if (!tf) return null;
    const p = parseInstant(str(r.values[tf]));
    return p ? p.ms : null;
  };
  let undatedRows = 0;
  if (tf && (params.bucket || since !== undefined || until !== undefined)) {
    rows = rows.filter((r) => {
      const ms = instantOf(r);
      if (ms === null) { undatedRows += 1; return false; }
      if (since !== undefined && ms < since) return false;
      if (until !== undefined && ms > until) return false;
      return true;
    });
  }

  const groups = new Map<string, { sum: number; n: number; min: number; max: number }>();
  const keyFor = (r: EntityRecord): string => {
    if (params.bucket) return bucketKey(instantOf(r)!, params.bucket);
    if (groupBy) return String(r.values[groupBy] ?? '(none)');
    return 'all';
  };
  for (const r of rows) {
    const key = keyFor(r);
    const raw = metric.field !== undefined ? r.values[metric.field] : 1;
    const num = typeof raw === 'number' ? raw : metric.aggregate === 'count' ? 1 : null;
    if (num === null) continue; // a row with no value for the field — excluded from numeric aggregates (`n` shows it)
    const g = groups.get(key) ?? { sum: 0, n: 0, min: Infinity, max: -Infinity };
    g.sum += metric.aggregate === 'count' ? 1 : num;
    g.n += 1;
    g.min = Math.min(g.min, num);
    g.max = Math.max(g.max, num);
    groups.set(key, g);
  }
  // D4 — a bounded count/sum series is zero-filled, so consecutive points are
  // consecutive periods. (An avg/min/max of nothing is not 0, so those stay sparse.)
  if (params.bucket && since !== undefined && until !== undefined && (metric.aggregate === 'count' || metric.aggregate === 'sum')) {
    for (const key of bucketKeysBetween(since, until, params.bucket)) {
      if (!groups.has(key)) groups.set(key, { sum: 0, n: 0, min: Infinity, max: -Infinity });
    }
  }
  let entries = [...groups.entries()];
  const overCap = entries.length > MAX_GROUPS;
  if (overCap) {
    // D3 — a series keeps its most recent buckets; a grouping keeps the groups with the
    // most rows (key ascending on ties), whatever the aggregate.
    entries = params.bucket
      ? entries.sort((a, b) => a[0].localeCompare(b[0])).slice(-MAX_GROUPS)
      : entries.sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, MAX_GROUPS);
  }
  // Only groups that held rows count as "left out" (grade-code L5): a zero-filled empty
  // bucket outside the kept window drops nothing.
  const kept = new Set(entries.map(([k]) => k));
  const droppedGroups = overCap ? [...groups.entries()].filter(([k, g]) => !kept.has(k) && g.n > 0).length : 0;
  const points: MetricSeriesPoint[] = entries
    .map(([key, g]): MetricSeriesPoint => ({
      key,
      n: g.n,
      value:
        metric.aggregate === 'count' || metric.aggregate === 'sum' ? g.sum
        : metric.aggregate === 'avg' ? (g.n ? g.sum / g.n : 0)
        : metric.aggregate === 'min' ? (g.n ? g.min : 0)
        : g.n ? g.max : 0,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    metricId, title: metric.title, aggregate: metric.aggregate, entityType: metric.entityType,
    points, scope, totalRows,
    // Flagged whenever the cap cut the series, even if only empty buckets went: the
    // points then start later than the range asked for.
    ...(overCap ? { groupsTruncated: true as const, droppedGroups } : {}),
    ...(params.bucket ? { undatedRows } : {}),
    ...(groupBy ? { groupedBy: groupBy } : {}),
    ...(params.bucket ? { bucket: params.bucket } : {}),
  };
}
