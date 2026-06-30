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
import { LOCALE_RE, negotiateLocale, resolveSection, hostDefaultLocale } from '../../host/i18n/index.js';

const MAX = {
  title: 160,
  heading: 200,
  text: 5000,
  markdown: 20_000, // richText body (plain text / markdown, not HTML)
  url: 2048,
  label: 120,
  alt: 200,
  token: 256,
  eyebrow: 80,    // mono overline above a section heading (ADR 0027 front page)
  caption: 240,
  lede: 280,      // one-line orienting blurb under a section heading (ADR 0027)
  slug: 40,       // a short opaque token, e.g. a card `icon` slug (ADR 0027)
  sections: 50,
  columns: 12,
  perOrgPages: 2000,
} as const;

/** Section layout for `columns` — how the public renderer lays the items out. */
const COLUMN_LAYOUTS = ['cards', 'steps', 'stats'] as const;

export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export const PAGE_STATUSES: PageStatus[] = ['draft', 'in_review', 'published', 'archived'];

export type SectionType = 'hero' | 'richText' | 'image' | 'cta' | 'columns';
export const SECTION_TYPES: SectionType[] = ['hero', 'richText', 'image', 'cta', 'columns'];

export interface Section {
  sectionId: string;
  type: SectionType;
  /** Base/default-locale fields. */
  data: Record<string, unknown>;
  /**
   * Sparse per-locale field overrides (RFC 0103 / ADR 0064). Keys are BCP-47
   * tags (`^[a-z]{2}(-[A-Z]{2})?$`), never the base locale; each value is a
   * partial overlay of `data`, sanitized identically to `data`. Optional +
   * backward-compatible: a section without it deserializes unchanged.
   */
  localizations?: Record<string, Record<string, unknown>>;
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

/** A CTA target: an internal app path (`/agents`) — a single leading slash, NOT
 *  `//` or `/\` (both normalize to a protocol-relative EXTERNAL URL in a browser →
 *  open-redirect shape) — OR an EXPLICIT-scheme http(s)/mailto URL. `safeUrl`
 *  alone is too loose: it accepts protocol-relative `//host`, so require an
 *  explicit scheme on the non-internal branch. */
function safeLink(v: unknown, max: number): string {
  const s = (optionalCleanString(v, max) ?? '').trim();
  if (/^\/(?![/\\])/.test(s)) return s;
  const u = safeUrl(v, max);
  return /^(https?:|mailto:)/i.test(u) ? u : '';
}

/**
 * Build a section's cleaned field set from a raw object. `partial: false` (the
 * base `data`) enforces required fields; `partial: true` (a per-locale overlay,
 * ADR 0064) skips required-field throws and includes only the fields PRESENT —
 * but cleans/bounds/safe-links every field IDENTICALLY, so a localization can
 * never become a stored-XSS or open-redirect vector that the base couldn't.
 */
function buildSectionData(type: SectionType, d: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  // Optional `eyebrow`/`heading` shared by the marketing blocks (ADR 0027).
  const opt = (k: 'eyebrow' | 'heading' | 'lede', max: number): Record<string, string> => {
    const v = optionalCleanString(d[k], max);
    return v ? { [k]: v } : {};
  };
  const has = (k: string): boolean => d[k] !== undefined;
  switch (type) {
    case 'hero': {
      const heading = cleanString(d.heading, MAX.heading);
      if (!partial && !heading) throw new OpenwopError('validation_error', 'hero.heading is required.', 400, {});
      const cta1 = optionalCleanString(d.ctaLabel, MAX.label);
      const cta2 = optionalCleanString(d.ctaLabel2, MAX.label);
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...(heading ? { heading } : {}),
        ...(optionalCleanString(d.subheading, MAX.text) ? { subheading: optionalCleanString(d.subheading, MAX.text) } : {}),
        ...(optionalCleanString(d.imageToken, MAX.token) ? { imageToken: optionalCleanString(d.imageToken, MAX.token) } : {}),
        ...(cta1 ? { ctaLabel: cta1, ctaUrl: safeLink(d.ctaUrl, MAX.url) } : {}),
        ...(cta2 ? { ctaLabel2: cta2, ctaUrl2: safeLink(d.ctaUrl2, MAX.url) } : {}),
      };
    }
    case 'richText': {
      // Stored as PLAIN TEXT / markdown — NOT raw HTML. The renderer treats it as
      // text, so there is no stored-XSS surface to sanitize. Bounded + scrubbed.
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(!partial || has('text') ? { text: cleanString(d.text, MAX.markdown) } : {}),
      };
    }
    case 'image': {
      const token = cleanString(d.token, MAX.token);
      if (!partial && !token) throw new OpenwopError('validation_error', 'image.token is required.', 400, {});
      return {
        ...(token ? { token } : {}),
        ...(optionalCleanString(d.alt, MAX.alt) ? { alt: optionalCleanString(d.alt, MAX.alt) } : {}),
        ...(optionalCleanString(d.caption, MAX.caption) ? { caption: optionalCleanString(d.caption, MAX.caption) } : {}),
      };
    }
    case 'cta': {
      const label = cleanString(d.label, MAX.label);
      if (!partial && !label) throw new OpenwopError('validation_error', 'cta.label is required.', 400, {});
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(optionalCleanString(d.subheading, MAX.text) ? { subheading: optionalCleanString(d.subheading, MAX.text) } : {}),
        ...(label ? { label } : {}),
        ...(!partial || has('url') ? { url: safeLink(d.url, MAX.url) } : {}),
      };
    }
    case 'columns': {
      const cols = Array.isArray(d.columns) ? d.columns : [];
      const layout = COLUMN_LAYOUTS.includes(d.layout as typeof COLUMN_LAYOUTS[number]) ? (d.layout as string) : 'cards';
      const mapped = cols.slice(0, MAX.columns).map((c) => {
        const cc = c as { title?: unknown; text?: unknown; href?: unknown; icon?: unknown; optional?: unknown };
        const title = optionalCleanString(cc.title, MAX.label);
        // Optional per-card link target → the whole card renders as a link
        // (cards layout, #414). `safeLink` guards open-redirect / non-http(s).
        const href = safeLink(cc.href, MAX.url);
        // Optional per-card icon slug (ADR 0027) — an opaque token the public
        // renderer maps to a glyph (ICON_BY_SLUG), unknown slugs falling back to
        // the node motif. Bounded + cleaned; never interpreted server-side.
        const icon = optionalCleanString(cc.icon, MAX.slug);
        return {
          ...(title ? { title } : {}),
          text: cleanString(cc.text, MAX.text),
          ...(href ? { href } : {}),
          ...(icon ? { icon } : {}),
          ...(cc.optional === true ? { optional: true } : {}),
        };
      });
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(!partial || has('layout') ? { layout } : {}),
        ...(!partial || has('columns') ? { columns: mapped } : {}),
      };
    }
    default:
      throw new OpenwopError('validation_error', 'Unknown section type.', 400, {});
  }
}

/** Validate + sanitize the sparse per-locale overlay map (ADR 0064). Keys must
 *  be BCP-47 tags and MUST NOT equal the base locale; each value is cleaned
 *  through the SAME per-type builder as `data` (partial mode). */
function validateLocalizations(type: SectionType, raw: unknown, baseLocale: string): Record<string, Record<string, unknown>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', 'section.localizations must be an object.', 400, {});
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [locale, overlay] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_RE.test(locale)) {
      throw new OpenwopError('validation_error', `Invalid localization locale \`${locale}\` (expected BCP-47, e.g. "es", "pt-BR").`, 400, { locale });
    }
    if (locale === baseLocale) {
      throw new OpenwopError('validation_error', 'A localization key MUST NOT be the base locale (the base lives in `data`).', 400, { locale });
    }
    if (typeof overlay !== 'object' || overlay === null || Array.isArray(overlay)) {
      throw new OpenwopError('validation_error', `localizations["${locale}"] must be an object.`, 400, { locale });
    }
    out[locale] = buildSectionData(type, overlay as Record<string, unknown>, true);
  }
  return out;
}

/** Sanitize an arbitrary object as a per-locale overlay (ADR 0064 Phase 3) —
 *  the same partial-mode field cleaning as a stored localization, so an AI
 *  translation's output can never carry stored-XSS or an open-redirect. */
export function sanitizeSectionOverlay(type: SectionType, raw: Record<string, unknown>): Record<string, unknown> {
  return buildSectionData(type, raw, true);
}

/** Validate + clean one section against its type schema. Throws on an unknown
 *  type or a missing required field. `baseLocale` scopes localization-key
 *  validation (ADR 0064) — defaults to `'en'` for callers without settings. */
export function validateSection(raw: unknown, baseLocale = 'en'): Section {
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
  const data = buildSectionData(type, d, false);
  const localizations = validateLocalizations(type, r.localizations, baseLocale);
  return { sectionId, type, data, ...(localizations && Object.keys(localizations).length > 0 ? { localizations } : {}) };
}

export function validateSections(raw: unknown, baseLocale = 'en'): Section[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', '`sections` must be an array.', 400, { field: 'sections' });
  return raw.slice(0, MAX.sections).map((s) => validateSection(s, baseLocale));
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

export async function createPage(input: { tenantId: string; orgId: string; title: string; slug?: string; sections?: unknown; createdBy: string; pageId?: string; baseLocale?: string }): Promise<Page> {
  // A FIXED pageId (host-level seeds, ADR 0027) makes creation idempotent: if the
  // row already exists, return it — so a concurrent cross-instance first-boot seed
  // converges on ONE page instead of a `home` + `home-2` duplicate.
  if (input.pageId) {
    const prior = await getPage(input.tenantId, input.orgId, input.pageId);
    if (prior) return prior;
  }
  const existing = await listPages(input.tenantId, input.orgId);
  if (existing.length >= MAX.perOrgPages) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgPages} pages.`, 409, { max: MAX.perOrgPages });
  }
  const title = cleanString(input.title, MAX.title, 'Untitled page');
  const taken = new Set(existing.map((p) => p.slug));
  const slug = uniqueSlug(input.slug ? slugify(input.slug) : title, taken, 'page');
  const ts = nowIso();
  const page: Page = {
    pageId: input.pageId ?? `page:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title,
    slug,
    status: 'draft',
    sections: validateSections(input.sections, input.baseLocale ?? 'en'),
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
  patch: { title?: string; slug?: string; sections?: unknown; baseLocale?: string },
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
  if (patch.sections !== undefined) next.sections = validateSections(patch.sections, patch.baseLocale ?? 'en');
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

// ── Content language settings + localized delivery (ADR 0064) ───────────────

/** Per-(tenant, org) content-locale configuration (RFC 0103 §A). Invariant:
 *  `baseLocale ∉ supportedLocales`. */
export interface ContentLanguageSettings {
  tenantId: string;
  orgId: string;
  baseLocale: string;
  /** Authored non-base locales (excludes baseLocale). */
  supportedLocales: string[];
  autoTranslateOnPublish: boolean;
  updatedAt: string;
  updatedBy: string;
}

const langSettings = new DurableCollection<ContentLanguageSettings>(
  'cms:langsettings',
  (s) => `${s.tenantId}:${s.orgId}`,
);

/** The org's content-locale settings, or a host-default skeleton (NOT persisted
 *  on read — an org that never configured localization has empty
 *  `supportedLocales`, so delivery is byte-identical to the non-localized CMS). */
export async function getContentLanguageSettings(tenantId: string, orgId: string): Promise<ContentLanguageSettings> {
  const stored = await langSettings.get(`${tenantId}:${orgId}`);
  if (stored && stored.tenantId === tenantId && stored.orgId === orgId) return stored;
  return {
    tenantId,
    orgId,
    baseLocale: hostDefaultLocale(),
    supportedLocales: [],
    autoTranslateOnPublish: false,
    updatedAt: nowIso(),
    updatedBy: 'system',
  };
}

/** Update the org's content-locale settings, enforcing the §A invariant
 *  (`baseLocale ∉ supportedLocales`) and BCP-47 validity. */
export async function updateContentLanguageSettings(
  tenantId: string,
  orgId: string,
  patch: { baseLocale?: unknown; supportedLocales?: unknown; autoTranslateOnPublish?: unknown },
  updatedBy: string,
): Promise<ContentLanguageSettings> {
  const cur = await getContentLanguageSettings(tenantId, orgId);
  let baseLocale = cur.baseLocale;
  if (patch.baseLocale !== undefined) {
    const b = String(patch.baseLocale);
    if (!LOCALE_RE.test(b)) throw new OpenwopError('validation_error', `Invalid baseLocale \`${b}\`.`, 400, { baseLocale: b });
    baseLocale = b;
  }
  let supportedLocales = cur.supportedLocales;
  if (patch.supportedLocales !== undefined) {
    if (!Array.isArray(patch.supportedLocales)) {
      throw new OpenwopError('validation_error', '`supportedLocales` must be an array.', 400, {});
    }
    const seen = new Set<string>();
    supportedLocales = [];
    for (const raw of patch.supportedLocales) {
      const l = String(raw);
      if (!LOCALE_RE.test(l)) throw new OpenwopError('validation_error', `Invalid locale \`${l}\` (expected BCP-47).`, 400, { locale: l });
      if (!seen.has(l)) { seen.add(l); supportedLocales.push(l); }
    }
  }
  // §A invariant: the base locale is never one of the authored translations.
  if (supportedLocales.includes(baseLocale)) {
    throw new OpenwopError('validation_error', 'baseLocale MUST NOT appear in supportedLocales.', 400, { baseLocale });
  }
  const next: ContentLanguageSettings = {
    tenantId,
    orgId,
    baseLocale,
    supportedLocales,
    autoTranslateOnPublish:
      patch.autoTranslateOnPublish !== undefined ? Boolean(patch.autoTranslateOnPublish) : cur.autoTranslateOnPublish,
    updatedAt: nowIso(),
    updatedBy,
  };
  await langSettings.put(next);
  return next;
}

/** A delivery-shaped section: base+overlay resolved to one locale; `localizations`
 *  stripped (public delivery never exposes other locales). */
export interface DeliverySection {
  sectionId: string;
  type: SectionType;
  data: Record<string, unknown>;
}

/**
 * Resolve a page's sections for delivery in the locale negotiated from
 * `Accept-Language` (RFC 0103 / ADR 0064). When the org has authored no
 * `supportedLocales`, this negotiates to the base and returns base `data` —
 * byte-identical to the non-localized CMS. Returns the page with resolved
 * sections + the locale actually used (for `Content-Language`).
 */
export function localizePage(
  page: Page,
  acceptLanguage: string | undefined | null,
  settings: ContentLanguageSettings,
): { page: Omit<Page, 'sections'> & { sections: DeliverySection[] }; locale: string } {
  const supported = [settings.baseLocale, ...settings.supportedLocales];
  const locale = supported.length > 1
    ? negotiateLocale(acceptLanguage, supported, settings.baseLocale)
    : settings.baseLocale;
  const sections: DeliverySection[] = page.sections.map((s) => ({
    sectionId: s.sectionId,
    type: s.type,
    data: resolveSection(s, locale, settings.baseLocale),
  }));
  return { page: { ...page, sections }, locale };
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetCms(): Promise<void> {
  await pages.__clear();
  await versions.__clear();
  await redirects.__clear();
  await langSettings.__clear();
}
