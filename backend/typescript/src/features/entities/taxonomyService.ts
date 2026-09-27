/**
 * Taxonomies + terms (ADR 0386 Phase 2) — named classification schemes with
 * ordered, optionally nested terms. Same storage discipline as entitiesService:
 * deterministic keys make slug-uniqueness structural (CAS-from-null), and every
 * read is bounded (per-tenant index or a key-prefix slice, never a scan).
 *
 *   entity:taxonomy — keyed `${tenantId}:${projectKey}:${name}`
 *   entity:term     — keyed `${taxonomyId}:${slug}` (slug unique per taxonomy)
 */
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { requireProjectNamespace, normalizeTypeName } from './common.js';

export interface TaxonomyRecord {
  taxonomyId: string; // `${tenantId}:${projectKey}:${name}`
  tenantId: string;
  projectId: string;
  name: string; // slug, immutable
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface TermRecord {
  termId: string; // `${taxonomyId}:${slug}`
  taxonomyId: string;
  tenantId: string;
  slug: string; // unique per taxonomy, immutable
  label: string;
  /** Sibling sort position (dense re-writes on reorder). */
  order: number;
  /** Optional parent term (same taxonomy) for nesting. */
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}

const taxonomies = new DurableCollection<TaxonomyRecord>('entity:taxonomy', (x) => x.taxonomyId, undefined, (x) => x.tenantId);
const terms = new DurableCollection<TermRecord>('entity:term', (x) => x.termId, undefined, (x) => x.tenantId);

export const TAXONOMY_CAP_PER_TENANT = 100;
export const TERM_CAP_PER_TAXONOMY = 500;

const projectKeyOf = (projectId: string | undefined): string => projectId ?? '';
const taxonomyKeyOf = (tenantId: string, projectId: string | undefined, name: string): string =>
  `${tenantId}:${projectKeyOf(projectId)}:${name}`;

export async function createTaxonomy(input: {
  tenantId: string;
  projectId?: string;
  name: string;
  displayName?: string;
}): Promise<TaxonomyRecord> {
  const projectId = await requireProjectNamespace(input.tenantId, input.projectId);
  const name = normalizeTypeName(input.name);
  const existing = await taxonomies.listForTenantIndexed(input.tenantId);
  if (existing.length >= TAXONOMY_CAP_PER_TENANT) {
    throw new OpenwopError('conflict', `Taxonomy cap reached (${TAXONOMY_CAP_PER_TENANT} per workspace).`, 409, {});
  }
  const now = new Date().toISOString();
  const rec: TaxonomyRecord = {
    taxonomyId: taxonomyKeyOf(input.tenantId, projectId, name),
    tenantId: input.tenantId,
    projectId,
    name,
    displayName: input.displayName?.trim() || name,
    createdAt: now,
    updatedAt: now,
  };
  const won = await taxonomies.compareAndSwap(null, rec);
  if (!won) throw new OpenwopError('conflict', `A taxonomy named \`${name}\` already exists in this scope.`, 409, { name });
  return rec;
}

export async function listTaxonomies(tenantId: string, projectId?: string): Promise<TaxonomyRecord[]> {
  const all = await taxonomies.listForTenantIndexed(tenantId);
  const filtered = projectId === undefined ? all : all.filter((x) => x.projectId === projectKeyOf(projectId));
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTaxonomy(tenantId: string, projectId: string | undefined, name: string): Promise<TaxonomyRecord | null> {
  const rec = await taxonomies.get(taxonomyKeyOf(tenantId, projectId, name));
  return rec && rec.tenantId === tenantId ? rec : null;
}

export async function deleteTaxonomy(input: { tenantId: string; projectId?: string; name: string }): Promise<boolean> {
  const rec = await getTaxonomy(input.tenantId, input.projectId, input.name);
  if (!rec) return false;
  const existing = await listTerms(input.tenantId, input.projectId, input.name);
  if (existing.length > 0) {
    throw new OpenwopError('conflict', 'Taxonomy still has terms — delete them first.', 409, { count: existing.length });
  }
  return taxonomies.delete(rec.taxonomyId);
}

export async function createTerm(input: {
  tenantId: string;
  projectId?: string;
  taxonomyName: string;
  slug: string;
  label?: string;
  parentId?: string;
}): Promise<TermRecord> {
  const tax = await getTaxonomy(input.tenantId, input.projectId, input.taxonomyName);
  if (!tax) throw new OpenwopError('not_found', 'Taxonomy not found.', 404, { taxonomyName: input.taxonomyName });
  const slug = normalizeTypeName(input.slug);
  const siblings = await terms.listByPrefix(`${tax.taxonomyId}:`);
  if (siblings.length >= TERM_CAP_PER_TAXONOMY) {
    throw new OpenwopError('conflict', `Term cap reached (${TERM_CAP_PER_TAXONOMY} per taxonomy).`, 409, {});
  }
  if (input.parentId !== undefined) {
    const parent = await terms.get(input.parentId);
    if (!parent || parent.tenantId !== input.tenantId || parent.taxonomyId !== tax.taxonomyId) {
      throw new OpenwopError('validation_error', '`parentId` must name a term of the same taxonomy.', 400, { parentId: input.parentId });
    }
  }
  const now = new Date().toISOString();
  const rec: TermRecord = {
    termId: `${tax.taxonomyId}:${slug}`,
    taxonomyId: tax.taxonomyId,
    tenantId: input.tenantId,
    slug,
    label: input.label?.trim() || slug,
    order: siblings.length,
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const won = await terms.compareAndSwap(null, rec);
  if (!won) throw new OpenwopError('conflict', `A term \`${slug}\` already exists in this taxonomy.`, 409, { slug });
  return rec;
}

export async function listTerms(tenantId: string, projectId: string | undefined, taxonomyName: string): Promise<TermRecord[]> {
  const tax = await getTaxonomy(tenantId, projectId, taxonomyName);
  if (!tax) throw new OpenwopError('not_found', 'Taxonomy not found.', 404, { taxonomyName });
  const rows = await terms.listByPrefix(`${tax.taxonomyId}:`);
  return rows.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** Tenant-guarded point lookup used by entity term-membership validation. */
export async function getTermById(tenantId: string, termId: string): Promise<TermRecord | null> {
  const rec = await terms.get(termId);
  return rec && rec.tenantId === tenantId ? rec : null;
}

export async function updateTerm(input: {
  tenantId: string;
  projectId?: string;
  taxonomyName: string;
  slug: string;
  patch: { label?: string; parentId?: string | null };
}): Promise<TermRecord | null> {
  const tax = await getTaxonomy(input.tenantId, input.projectId, input.taxonomyName);
  if (!tax) return null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await terms.get(`${tax.taxonomyId}:${input.slug}`);
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const next: TermRecord = { ...existing, updatedAt: new Date().toISOString() };
    if (input.patch.label !== undefined) next.label = input.patch.label.trim() || existing.label;
    if (input.patch.parentId !== undefined) {
      if (input.patch.parentId === null) {
        delete next.parentId;
      } else {
        if (input.patch.parentId === existing.termId) {
          throw new OpenwopError('validation_error', 'A term cannot parent itself.', 400, { parentId: input.patch.parentId });
        }
        const parent = await terms.get(input.patch.parentId);
        if (!parent || parent.tenantId !== input.tenantId || parent.taxonomyId !== tax.taxonomyId) {
          throw new OpenwopError('validation_error', '`parentId` must name a term of the same taxonomy.', 400, { parentId: input.patch.parentId });
        }
        next.parentId = input.patch.parentId;
      }
    }
    if (await terms.compareAndSwap(existing, next)) return next;
  }
  throw new OpenwopError('conflict', 'Concurrent term update — retry.', 409, { slug: input.slug });
}

/** Re-write sibling order to match `orderedSlugs` (dense 0..n). Unlisted terms keep
 *  their relative order after the listed ones. */
export async function reorderTerms(input: {
  tenantId: string;
  projectId?: string;
  taxonomyName: string;
  orderedSlugs: string[];
}): Promise<TermRecord[]> {
  const all = await listTerms(input.tenantId, input.projectId, input.taxonomyName);
  const bySlug = new Map(all.map((x) => [x.slug, x]));
  const listed = input.orderedSlugs.filter((s) => bySlug.has(s));
  const rest = all.filter((x) => !listed.includes(x.slug)).map((x) => x.slug);
  const finalOrder = [...listed, ...rest];
  const now = new Date().toISOString();
  const out: TermRecord[] = [];
  for (let i = 0; i < finalOrder.length; i += 1) {
    const rec = bySlug.get(finalOrder[i] ?? '');
    if (!rec) continue;
    if (rec.order !== i) {
      const next = { ...rec, order: i, updatedAt: now };
      await terms.put(next);
      out.push(next);
    } else {
      out.push(rec);
    }
  }
  return out;
}

export async function deleteTerm(input: {
  tenantId: string;
  projectId?: string;
  taxonomyName: string;
  slug: string;
  /** Injected by the caller (entitiesService owns the membership index). */
  isTermInUse: (termId: string) => Promise<boolean>;
}): Promise<boolean> {
  const tax = await getTaxonomy(input.tenantId, input.projectId, input.taxonomyName);
  if (!tax) return false;
  const termId = `${tax.taxonomyId}:${input.slug}`;
  const rec = await terms.get(termId);
  if (!rec || rec.tenantId !== input.tenantId) return false;
  const children = (await terms.listByPrefix(`${tax.taxonomyId}:`)).filter((x) => x.parentId === termId);
  if (children.length > 0) {
    throw new OpenwopError('conflict', 'Term still has child terms — delete or re-parent them first.', 409, { children: children.length });
  }
  if (await input.isTermInUse(termId)) {
    throw new OpenwopError('conflict', 'Term is still assigned to entities — unassign it first.', 409, { termId });
  }
  return terms.delete(termId);
}
