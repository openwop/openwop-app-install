/**
 * CMS pages + sections (ADR 0009). Org-scoped, tenant+org IDOR-guarded. Owns
 * page content (typed sections), versions (Phase 3), and slug redirects
 * (Phase 3). Section assets are media-asset TOKENS (ADR 0007), stored as opaque
 * references. Section `html`/`url` are sanitized on write (no stored XSS via
 * page content — the media-review lesson applied to content).
 *
 * @see docs/adr/0009-cms-page-builder.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString, safeUrl } from '../../host/boundedStrings.js';
import { uniqueSlug, slugify } from '../../host/slug.js';

const MAX = {
  title: 160,
  heading: 200,
  text: 5000,
  markdown: 20_000, // richText body (plain text / markdown, not HTML)
  url: 2048,
  label: 120,
  alt: 200,
  token: 256,
  sections: 50,
  columns: 12,
  perOrgPages: 2000,
} as const;

export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export const PAGE_STATUSES: PageStatus[] = ['draft', 'in_review', 'published', 'archived'];

export type SectionType = 'hero' | 'richText' | 'image' | 'cta' | 'columns';
export const SECTION_TYPES: SectionType[] = ['hero', 'richText', 'image', 'cta', 'columns'];

export interface Section {
  sectionId: string;
  type: SectionType;
  data: Record<string, unknown>;
}

export interface Page {
  pageId: string;
  tenantId: string;
  orgId: string;
  title: string;
  slug: string;
  status: PageStatus;
  sections: Section[];
  version: number;
  publishedVersion?: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const pages = new DurableCollection<Page>('cms:page', (p) => p.pageId);

function nowIso(): string {
  return new Date().toISOString();
}

// ── Content sanitization ─────────────────────────────────────────────────────

/** Validate + clean one section against its type schema. Throws on an unknown
 *  type or a missing required field. */
export function validateSection(raw: unknown): Section {
  if (typeof raw !== 'object' || raw === null) {
    throw new OpenwopError('validation_error', 'Each section must be an object.', 400, {});
  }
  const r = raw as Record<string, unknown>;
  const type = r.type as SectionType;
  if (!SECTION_TYPES.includes(type)) {
    throw new OpenwopError('validation_error', `section.type must be one of: ${SECTION_TYPES.join(', ')}`, 400, { type: r.type });
  }
  const d = (typeof r.data === 'object' && r.data !== null ? r.data : {}) as Record<string, unknown>;
  const sectionId = typeof r.sectionId === 'string' && r.sectionId.startsWith('sec:') ? r.sectionId : `sec:${randomUUID()}`;
  let data: Record<string, unknown>;
  switch (type) {
    case 'hero': {
      const heading = cleanString(d.heading, MAX.heading);
      if (!heading) throw new OpenwopError('validation_error', 'hero.heading is required.', 400, {});
      data = {
        heading,
        ...(optionalCleanString(d.subheading, MAX.text) ? { subheading: optionalCleanString(d.subheading, MAX.text) } : {}),
        ...(optionalCleanString(d.imageToken, MAX.token) ? { imageToken: optionalCleanString(d.imageToken, MAX.token) } : {}),
      };
      break;
    }
    case 'richText': {
      // Stored as PLAIN TEXT / markdown — NOT raw HTML. The renderer treats it as
      // text, so there is no stored-XSS surface to sanitize (the fragile regex
      // sanitizer is gone; code-review #2). Bounded + secret-scrubbed.
      data = { text: cleanString(d.text, MAX.markdown) };
      break;
    }
    case 'image': {
      const token = cleanString(d.token, MAX.token);
      if (!token) throw new OpenwopError('validation_error', 'image.token is required.', 400, {});
      data = { token, ...(optionalCleanString(d.alt, MAX.alt) ? { alt: optionalCleanString(d.alt, MAX.alt) } : {}) };
      break;
    }
    case 'cta': {
      const label = cleanString(d.label, MAX.label);
      if (!label) throw new OpenwopError('validation_error', 'cta.label is required.', 400, {});
      data = { label, url: safeUrl(d.url, MAX.url) };
      break;
    }
    case 'columns': {
      const cols = Array.isArray(d.columns) ? d.columns : [];
      data = { columns: cols.slice(0, MAX.columns).map((c) => ({ text: cleanString((c as { text?: unknown })?.text, MAX.text) })) };
      break;
    }
    default:
      throw new OpenwopError('validation_error', 'Unknown section type.', 400, {});
  }
  return { sectionId, type, data };
}

function validateSections(raw: unknown): Section[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', '`sections` must be an array.', 400, { field: 'sections' });
  return raw.slice(0, MAX.sections).map(validateSection);
}

// ── Pages ─────────────────────────────────────────────────────────────────

export async function listPages(tenantId: string, orgId: string): Promise<Page[]> {
  return (await pages.list()).filter((p) => p.tenantId === tenantId && p.orgId === orgId);
}

export async function getPage(tenantId: string, orgId: string, pageId: string): Promise<Page | null> {
  const p = await pages.get(pageId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

async function slugSet(tenantId: string, orgId: string, exceptPageId?: string): Promise<Set<string>> {
  const all = await listPages(tenantId, orgId);
  return new Set(all.filter((p) => p.pageId !== exceptPageId).map((p) => p.slug));
}

export async function createPage(input: { tenantId: string; orgId: string; title: string; slug?: string; sections?: unknown; createdBy: string }): Promise<Page> {
  const existing = await listPages(input.tenantId, input.orgId);
  if (existing.length >= MAX.perOrgPages) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgPages} pages.`, 409, { max: MAX.perOrgPages });
  }
  const title = cleanString(input.title, MAX.title, 'Untitled page');
  const taken = new Set(existing.map((p) => p.slug));
  const slug = uniqueSlug(input.slug ? slugify(input.slug) : title, taken, 'page');
  const ts = nowIso();
  const page: Page = {
    pageId: `page:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title,
    slug,
    status: 'draft',
    sections: validateSections(input.sections),
    version: 1,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await pages.put(page);
  return page;
}

export async function updatePage(
  tenantId: string,
  orgId: string,
  pageId: string,
  patch: { title?: string; slug?: string; sections?: unknown },
  updatedBy: string,
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  const next: Page = { ...p, updatedBy, updatedAt: nowIso(), version: p.version + 1 };
  if (patch.title !== undefined) next.title = cleanString(patch.title, MAX.title, p.title);
  if (patch.slug !== undefined) {
    const desired = slugify(patch.slug);
    const taken = await slugSet(tenantId, orgId, pageId);
    next.slug = uniqueSlug(desired, taken, 'page');
    // Renaming a PUBLISHED page's slug leaves a redirect so old links survive.
    // COLLAPSE CHAINS (code-review #4): repoint any redirect that pointed at the
    // OLD slug to the new one (so a multi-rename A→B→C still resolves A in one
    // hop), and drop a stale redirect whose fromSlug now equals the new slug.
    if (next.slug !== p.slug && p.status === 'published') {
      const all = await redirects.list();
      for (const r of all) {
        if (r.tenantId !== tenantId || r.orgId !== orgId) continue;
        if (r.toSlug === p.slug) await redirects.put({ ...r, toSlug: next.slug });
        if (r.fromSlug === next.slug) await redirects.delete(r.redirectId);
      }
      await redirects.put({
        redirectId: `redir:${randomUUID()}`,
        tenantId,
        orgId,
        fromSlug: p.slug,
        toSlug: next.slug,
        createdAt: nowIso(),
      });
    }
  }
  if (patch.sections !== undefined) next.sections = validateSections(patch.sections);
  await pages.put(next);
  return next;
}

export async function deletePage(tenantId: string, orgId: string, pageId: string): Promise<boolean> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return false;
  await pages.delete(pageId);
  return true;
}

// ── Versions + redirects (Phase 3) ──────────────────────────────────────────

export interface PageVersion {
  versionId: string;
  tenantId: string;
  orgId: string;
  pageId: string;
  version: number;
  snapshot: { title: string; slug: string; sections: Section[] };
  publishedBy: string;
  publishedAt: string;
  /** Monotonic snapshot sequence — a stable newest-first tiebreaker for snapshots
   *  taken in the same millisecond. */
  seq: number;
}
export interface Redirect {
  redirectId: string;
  tenantId: string;
  orgId: string;
  fromSlug: string;
  toSlug: string;
  createdAt: string;
}

const versions = new DurableCollection<PageVersion>('cms:pageversion', (v) => v.versionId);
const redirects = new DurableCollection<Redirect>('cms:redirect', (r) => r.redirectId);
const MAX_VERSIONS = 50;
let versionSeq = 0;

/** Newest-first by `publishedAt` (RESTART-SAFE — persisted), with the in-process
 *  monotonic `seq` as a same-millisecond tiebreaker only (code-review #3). */
function byNewest(a: { publishedAt: string; seq: number }, b: { publishedAt: string; seq: number }): number {
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
  return (b.seq ?? 0) - (a.seq ?? 0);
}

async function snapshotPage(page: Page, publishedBy: string): Promise<void> {
  const v: PageVersion = {
    versionId: `pver:${randomUUID()}`,
    tenantId: page.tenantId,
    orgId: page.orgId,
    pageId: page.pageId,
    version: page.version,
    snapshot: { title: page.title, slug: page.slug, sections: page.sections },
    publishedBy,
    publishedAt: nowIso(),
    seq: ++versionSeq,
  };
  await versions.put(v);
  // Cap history per page (drop the oldest beyond MAX_VERSIONS).
  const mine = (await versions.list()).filter((x) => x.pageId === page.pageId).sort(byNewest);
  for (const old of mine.slice(MAX_VERSIONS)) await versions.delete(old.versionId);
}

export async function listVersions(tenantId: string, orgId: string, pageId: string): Promise<PageVersion[]> {
  return (await versions.list())
    .filter((v) => v.tenantId === tenantId && v.orgId === orgId && v.pageId === pageId)
    .sort(byNewest); // newest first — createdAt primary (restart-safe), seq tiebreaker
}

/** Restore a past version's content into the page's DRAFT (does not publish). */
export async function restoreVersion(tenantId: string, orgId: string, pageId: string, versionId: string, actor: string): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  const v = await versions.get(versionId);
  if (!v || v.pageId !== pageId || v.tenantId !== tenantId || v.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Version not found for this page.', 404, { versionId });
  }
  const next: Page = { ...p, title: v.snapshot.title, sections: v.snapshot.sections, status: 'draft', version: p.version + 1, updatedBy: actor, updatedAt: nowIso() };
  await pages.put(next);
  return next;
}

// ── Editorial workflow (Phase 2) ────────────────────────────────────────────

export type WorkflowAction = 'submit' | 'approve' | 'reject' | 'publish' | 'archive' | 'unpublish';

/** Legal `from → to` per action; the ROUTE enforces the SCOPE (submit =
 *  workspace:write; the rest = host:members:manage). `unpublish` (and the exit
 *  from `archived`) is how a published/archived page returns to draft to be
 *  edited through the gate again — there is no other path back to draft except
 *  restoreVersion (code-review #1/#5: closes the archived dead-end + gives a
 *  clean re-edit path so live content isn't patched in place). */
const TRANSITIONS: Record<WorkflowAction, { from: PageStatus[]; to: PageStatus }> = {
  submit: { from: ['draft'], to: 'in_review' },
  approve: { from: ['in_review'], to: 'published' },
  reject: { from: ['in_review'], to: 'draft' },
  publish: { from: ['draft', 'in_review'], to: 'published' }, // admin direct-publish
  archive: { from: ['published'], to: 'archived' },
  unpublish: { from: ['published', 'archived'], to: 'draft' }, // back to draft to re-edit
};

export async function transitionPage(tenantId: string, orgId: string, pageId: string, action: WorkflowAction, actor: string): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(p.status)) {
    throw new OpenwopError('validation_error', `Cannot ${action} a page in status \`${p.status}\`.`, 409, { status: p.status, action });
  }
  const next: Page = { ...p, status: rule.to, updatedBy: actor, updatedAt: nowIso() };
  if (rule.to === 'published') {
    next.publishedVersion = next.version;
    await snapshotPage(next, actor); // capture the published snapshot (Phase 3)
  }
  await pages.put(next);
  return next;
}

/** Resolve a slug to a PUBLISHED page, following at most one redirect hop. Drafts
 *  / in-review / archived pages are invisible by slug. */
export async function getPublishedBySlug(tenantId: string, orgId: string, slug: string): Promise<{ page: Page; redirectedFrom?: string } | null> {
  const all = await listPages(tenantId, orgId);
  const direct = all.find((p) => p.slug === slug && p.status === 'published');
  if (direct) return { page: direct };
  const redirect = (await redirects.list()).find((r) => r.tenantId === tenantId && r.orgId === orgId && r.fromSlug === slug);
  if (redirect) {
    const target = all.find((p) => p.slug === redirect.toSlug && p.status === 'published');
    if (target) return { page: target, redirectedFrom: slug };
  }
  return null;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetCms(): Promise<void> {
  await pages.__clear();
  await versions.__clear();
  await redirects.__clear();
}
