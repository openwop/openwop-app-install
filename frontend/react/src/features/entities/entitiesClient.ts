/**
 * Entities feature client (ADR 0386 Phase 1, host-extension, non-normative).
 * Wraps /host/openwop-app/entities/*. 404s when the `entities` toggle is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type EntityFieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'reference' | 'media';

export interface EntityFieldSpec {
  key: string;
  label: string;
  type: EntityFieldType;
  required: boolean;
  options?: string[];
  /** reference only — the target type's machine name. */
  refEntityType?: string;
  /** ADR 0406 — string fields only; the value may carry per-locale overlays. */
  localizable?: boolean;
}

/** ADR 0406 — the workspace locale context (the backend's ONE resolver). */
export interface EntityLocaleContext {
  enabled: boolean;
  baseLocale?: string;
  supportedLocales?: string[];
}

export interface EntityType {
  typeId: string;
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string;
  description?: string;
  fields: EntityFieldSpec[];
  status: 'draft' | 'published';
  /** ADR 0407 — anonymous public-read opt-in (type-admin flip; absent = closed). */
  publicRead?: boolean;
  /** ADR 0408 — a code-owned SYSTEM type (e.g. cms.page): read-only here. */
  system?: true;
  createdAt: string;
  updatedAt: string;
}

export type EntityValues = Record<string, string | number | boolean>;

export interface EntityRow {
  entityId: string;
  typeId: string;
  values: EntityValues;
  termIds?: string[];
  /** ADR 0407 — entry-level draft; ABSENT = live (delivered publicly when the type is public). */
  status?: 'draft';
  /** ADR 0406 — sparse per-locale overlays over localizable string fields. */
  localizations?: Record<string, Record<string, string>>;
  createdAt: string;
  updatedAt: string;
}

export interface Taxonomy {
  taxonomyId: string;
  name: string;
  displayName: string;
}

export interface Term {
  termId: string;
  taxonomyId: string;
  slug: string;
  label: string;
  order: number;
  parentId?: string;
}

export interface Relationship {
  relId: string;
  fromTypeId: string;
  toTypeId: string;
  cardinality: 'one-one' | 'one-many' | 'many-many';
  onDelete: 'restrict' | 'cascade' | 'set-null';
}

export interface EntityPage {
  entities: EntityRow[];
  nextCursor?: string;
}

const base = `${config.baseUrl}/host/openwop-app/entities`;

const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listEntityTypes(): Promise<EntityType[]> {
  const res = await fetch(`${base}/types`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ types: EntityType[] }>(res, 'listEntityTypes')).types;
}

export async function createEntityType(input: {
  name: string;
  displayName?: string;
  description?: string;
  fields: Array<Omit<EntityFieldSpec, 'label'> & { label?: string }>;
}): Promise<EntityType> {
  const res = await fetch(`${base}/types`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<EntityType>(res, 'createEntityType');
}

export async function updateEntityType(
  name: string,
  patch: { displayName?: string; description?: string | null; fields?: EntityFieldSpec[]; status?: 'draft' | 'published'; publicRead?: boolean },
): Promise<EntityType> {
  const res = await fetch(
    `${base}/types/${encodeURIComponent(name)}`,
    fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }),
  );
  return asJson<EntityType>(res, 'updateEntityType');
}

export async function deleteEntityType(name: string): Promise<void> {
  const res = await fetch(`${base}/types/${encodeURIComponent(name)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `deleteEntityType returned ${res.status}`);
  }
}

export async function listEntities(typeName: string, opts?: { limit?: number; cursor?: string }): Promise<EntityPage> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.cursor) params.set('cursor', opts.cursor);
  const qs = params.toString();
  const res = await fetch(
    `${base}/types/${encodeURIComponent(typeName)}/entities${qs ? `?${qs}` : ''}`,
    fetchOpts({ headers: authedHeaders() }),
  );
  return asJson<EntityPage>(res, 'listEntities');
}

export async function createEntity(
  typeName: string,
  values: Record<string, unknown>,
  termIds?: string[],
  localizations?: Record<string, Record<string, string>>,
): Promise<EntityRow> {
  const res = await fetch(
    `${base}/types/${encodeURIComponent(typeName)}/entities`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ values, ...(termIds ? { termIds } : {}), ...(localizations ? { localizations } : {}) }) }),
  );
  return asJson<EntityRow>(res, 'createEntity');
}

/** ADR 0406 — the workspace's entity locale context (toggle + primary-org settings, one backend resolver). */
export async function getEntityLocaleContext(): Promise<EntityLocaleContext> {
  const res = await fetch(`${base}/locale-context`, fetchOpts({ headers: authedHeaders() }));
  return asJson<EntityLocaleContext>(res, 'getEntityLocaleContext');
}

export async function updateEntity(
  typeName: string,
  entityId: string,
  values: Record<string, unknown>,
  termIds?: string[],
  status?: 'draft' | 'live',
  localizations?: Record<string, Record<string, string>>,
): Promise<EntityRow> {
  const res = await fetch(
    `${base}/types/${encodeURIComponent(typeName)}/entities/${encodeURIComponent(entityId)}`,
    fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ values, ...(termIds ? { termIds } : {}), ...(status ? { status } : {}), ...(localizations ? { localizations } : {}) }) }),
  );
  return asJson<EntityRow>(res, 'updateEntity');
}

// ---- Query / import / export (Phase 3) ----

export type QueryOp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

export interface QueryFilter {
  key: string;
  op: QueryOp;
  value: unknown;
}

export async function queryEntities(
  typeName: string,
  input: { filters?: QueryFilter[]; sort?: { key: string; dir?: 'asc' | 'desc' }; termId?: string; limit?: number; cursor?: string },
): Promise<EntityPage & { total: number }> {
  const res = await fetch(
    `${base}/types/${encodeURIComponent(typeName)}/query`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }),
  );
  return asJson<EntityPage & { total: number }>(res, 'queryEntities');
}

/** The authed export URL — opened directly for download. */
export function exportUrl(typeName: string): string {
  return `${base}/types/${encodeURIComponent(typeName)}/export`;
}

export async function importEntities(typeName: string, ndjson: string): Promise<{ created: number; existing: number; errors: Array<{ line: number; message: string }> }> {
  const res = await fetch(
    `${base}/types/${encodeURIComponent(typeName)}/import`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ndjson }) }),
  );
  return asJson<{ created: number; existing: number; errors: Array<{ line: number; message: string }> }>(res, 'importEntities');
}

// ---- Taxonomies + terms (Phase 2) ----

export async function listTaxonomies(): Promise<Taxonomy[]> {
  const res = await fetch(`${base}/taxonomies`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ taxonomies: Taxonomy[] }>(res, 'listTaxonomies')).taxonomies;
}

export async function createTaxonomy(name: string, displayName?: string): Promise<Taxonomy> {
  const res = await fetch(
    `${base}/taxonomies`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...(displayName ? { displayName } : {}) }) }),
  );
  return asJson<Taxonomy>(res, 'createTaxonomy');
}

export async function deleteTaxonomy(name: string): Promise<void> {
  const res = await fetch(`${base}/taxonomies/${encodeURIComponent(name)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(await errDetail(res, 'deleteTaxonomy'));
}

export async function listTerms(taxonomyName: string): Promise<Term[]> {
  const res = await fetch(`${base}/taxonomies/${encodeURIComponent(taxonomyName)}/terms`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ terms: Term[] }>(res, 'listTerms')).terms;
}

export async function createTerm(taxonomyName: string, slug: string, opts?: { label?: string; parentId?: string }): Promise<Term> {
  const res = await fetch(
    `${base}/taxonomies/${encodeURIComponent(taxonomyName)}/terms`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ slug, ...(opts?.label ? { label: opts.label } : {}), ...(opts?.parentId ? { parentId: opts.parentId } : {}) }) }),
  );
  return asJson<Term>(res, 'createTerm');
}

export async function deleteTerm(taxonomyName: string, slug: string): Promise<void> {
  const res = await fetch(
    `${base}/taxonomies/${encodeURIComponent(taxonomyName)}/terms/${encodeURIComponent(slug)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok && res.status !== 204) throw new Error(await errDetail(res, 'deleteTerm'));
}

export async function reorderTerms(taxonomyName: string, orderedSlugs: string[]): Promise<Term[]> {
  const res = await fetch(
    `${base}/taxonomies/${encodeURIComponent(taxonomyName)}/terms/reorder`,
    fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ orderedSlugs }) }),
  );
  return (await asJson<{ terms: Term[] }>(res, 'reorderTerms')).terms;
}

// ---- Relationships (Phase 2) ----

export async function listRelationships(): Promise<Relationship[]> {
  const res = await fetch(`${base}/relationships`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ relationships: Relationship[] }>(res, 'listRelationships')).relationships;
}

export async function createRelationship(input: {
  fromTypeName: string;
  toTypeName: string;
  cardinality?: Relationship['cardinality'];
  onDelete?: Relationship['onDelete'];
}): Promise<Relationship> {
  const res = await fetch(
    `${base}/relationships`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }),
  );
  return asJson<Relationship>(res, 'createRelationship');
}

export async function deleteRelationship(fromTypeName: string, toTypeName: string): Promise<void> {
  const res = await fetch(
    `${base}/relationships/${encodeURIComponent(fromTypeName)}/${encodeURIComponent(toTypeName)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok && res.status !== 204) throw new Error(await errDetail(res, 'deleteRelationship'));
}

async function errDetail(res: Response, ctx: string): Promise<string> {
  try {
    return ((await res.json()) as { message?: string })?.message ?? `${ctx} returned ${res.status}`;
  } catch {
    return `${ctx} returned ${res.status}`;
  }
}

export async function deleteEntity(typeName: string, entityId: string): Promise<void> {
  const res = await fetch(
    `${base}/types/${encodeURIComponent(typeName)}/entities/${encodeURIComponent(entityId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok && res.status !== 204) throw new Error(`deleteEntity returned ${res.status}`);
}
