/**
 * ADR 0417 — BI client: the governed-metric reads the dashboard tile (P3) and
 * the metrics admin page (P4) ride. Mirrors the crmReportsClient shape.
 */
import { config, authedHeaders, fetchOpts } from '../../client/config.js';
import { readErrorMessage, readErrorDetail } from '../../client/errorEnvelope.js';

const orgBase = (orgId: string): string => `${config.baseUrl}/host/openwop-app/bi/orgs/${encodeURIComponent(orgId)}`;

/** The closed filter-op vocabulary (mirrors the backend `METRIC_FILTER_OPS`, which
 *  validates authoritatively). */
export const METRIC_FILTER_OPS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
export type MetricFilterOp = (typeof METRIC_FILTER_OPS)[number];
export interface MetricFilter { key: string; op: MetricFilterOp; value: string | number | boolean | Array<string | number> }

export interface MetricSummary {
  metricId: string;
  title: string;
  description?: string;
  entityType: string;
  aggregate: string;
  field?: string;
  /** ADR 1052 D12 — round-tripped by the editor, so a save keeps what the metric measures. */
  filters?: MetricFilter[];
  groupBy?: string;
  timeField?: string;
  system?: boolean;
  /** BI84WF-12 — a pre-1052 workspace-wide metric: read-only until moved into one org. */
  legacy?: boolean;
  /** ADR 1052 D1 — the definition no longer fits its entity type; it cannot run. */
  stale?: { field: string };
  /** ADR 1052 D8 — the version an edit is made against (stored metrics only). */
  updatedAt?: string;
}

/** ADR 1052 D11 — what this caller may do with the org's catalog (a projection; the
 *  server re-checks every write). */
export interface MetricCatalog { metrics: MetricSummary[]; viewer: { canManage: boolean } }

export interface MetricRunPoint { key: string; value: number; n: number }
export interface MetricRunResult {
  metricId: string;
  title: string;
  aggregate: string;
  entityType: string;
  points: MetricRunPoint[];
  groupedBy?: string;
  bucket?: string;
  /** ADR 1052 D2 — kernel types read one org's rows; custom types the whole workspace. */
  scope?: 'org' | 'tenant';
  totalRows: number;
  /** ADR 1052 D3 — only the largest groups (or the latest buckets) are shown. */
  groupsTruncated?: boolean;
  droppedGroups?: number;
  /** ADR 1052 D4 — rows a bucketed run could not place in time. */
  undatedRows?: number;
}

/**
 * BI-G1 — this client was reading `error.message` from a body whose `error` is a
 * STRING code. The wire envelope is `{ error: <code>, message, details }`
 * (`ErrorEnvelope`, @openwop/openwop), so `body.error?.message` was ALWAYS
 * undefined and every message fell through to `"createBiMetric returned 422"`.
 * The page's own docstring claims it "surfaces the typed 422s rather than
 * duplicating the registry rules" — it surfaced none of them: the validator's
 * "Field `amount` is `string` — a sum aggregate needs a number field" reached
 * the user as a status code.
 *
 * The validator also LOCATES each rejection (`details.field` names the offending
 * input: entityType / field / groupBy / timeField / filters), which the form can
 * now put ON the control instead of in one detached notice.
 */
export interface BiRequestError extends Error {
  field?: string;
  /** ADR 1052 — `details.reason`: `metric_stale` (the definition no longer fits its
   *  type) or `metric_changed` (someone saved it since it was loaded). */
  reason?: string;
  /** `details.index` — which filter the server refused. */
  index?: number;
  status?: number;
}

/** Parse an ErrorEnvelope body into a message + the field it blames. */
export async function biErrorFrom(res: Response, ctx: string): Promise<BiRequestError> {
  let detail = '';
  let field: string | undefined;
  let reason: string | undefined;
  let index: number | undefined;
  try {
    // H27 — through the ONE shared envelope reader, so this client tolerates a
    // nested body from an older peer for the deprecation window instead of
    // silently falling back to the bare status (which is the exact failure the
    // note above describes, in its other direction).
    const body: unknown = await res.json();
    detail = readErrorMessage(body) ?? detail;
    const blamed = readErrorDetail(body, 'field');
    if (typeof blamed === 'string') field = blamed;
    const why = readErrorDetail(body, 'reason');
    if (typeof why === 'string') reason = why;
    const at = readErrorDetail(body, 'index');
    if (typeof at === 'number') index = at;
  } catch { /* non-JSON */ }
  const err: BiRequestError = new Error(detail || `${ctx} returned ${res.status}`);
  if (field) err.field = field;
  if (reason) err.reason = reason;
  if (index !== undefined) err.index = index;
  err.status = res.status;
  return err;
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw await biErrorFrom(res, ctx);
  return (await res.json()) as T;
}

export async function listBiMetrics(orgId: string): Promise<MetricCatalog> {
  const res = await fetch(`${orgBase(orgId)}/metrics`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ metrics: MetricSummary[]; viewer?: { canManage?: boolean } }>(res, 'listBiMetrics');
  // An older server sends no `viewer`: offer no writes rather than writes that 403.
  return { metrics: body.metrics, viewer: { canManage: body.viewer?.canManage === true } };
}

export async function runBiMetric(
  orgId: string,
  metricId: string,
  params: { groupBy?: string; since?: string; until?: string; bucket?: 'day' | 'week' | 'month' } = {},
): Promise<MetricRunResult> {
  const res = await fetch(`${orgBase(orgId)}/metrics/${encodeURIComponent(metricId)}/run`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(params),
  }));
  return (await asJson<{ result: MetricRunResult }>(res, 'runBiMetric')).result;
}

/** The kernel system types metric definitions may target (mirrors the backend
 *  allowlist — validated authoritatively server-side). */
export const KERNEL_METRIC_TYPES = ['crm.deal', 'commerce.product', 'crm.company', 'cms.page', 'servicedesk.ticket'] as const;

export interface MetricBody {
  title: string;
  description?: string;
  entityType: string;
  aggregate: string;
  field?: string;
  filters?: MetricFilter[];
  groupBy?: string;
  timeField?: string;
  /** ADR 1052 D8 — updates only: the version loaded; a newer row answers 409. */
  expectedUpdatedAt?: string;
}

export async function createBiMetric(orgId: string, metricId: string, body: MetricBody): Promise<MetricSummary> {
  const res = await fetch(`${orgBase(orgId)}/metrics`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ metricId, ...body }),
  }));
  return (await asJson<{ metric: MetricSummary }>(res, 'createBiMetric')).metric;
}

export async function updateBiMetric(orgId: string, metricId: string, body: MetricBody): Promise<MetricSummary> {
  const res = await fetch(`${orgBase(orgId)}/metrics/${encodeURIComponent(metricId)}`, fetchOpts({
    method: 'PATCH',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return (await asJson<{ metric: MetricSummary }>(res, 'updateBiMetric')).metric;
}

export async function deleteBiMetric(orgId: string, metricId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/metrics/${encodeURIComponent(metricId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // One parse, not a second copy of it (this inline one carried the same bug).
  if (!res.ok) throw await biErrorFrom(res, 'deleteBiMetric');
}

/** BI84WF-12 — move a pre-1052 workspace-wide metric into this organization. */
export async function adoptBiMetric(orgId: string, metricId: string): Promise<MetricSummary> {
  const res = await fetch(`${orgBase(orgId)}/metrics/${encodeURIComponent(metricId)}/adopt`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return (await asJson<{ metric: MetricSummary }>(res, 'adoptBiMetric')).metric;
}
