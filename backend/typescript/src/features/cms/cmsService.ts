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
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
// Same-feature sibling (cms/). Used only inside `deletePage` (call-time), so the
// pageExperiments→cms import cycle stays runtime-safe — never referenced at module init.
import { listExperiments, deleteExperiment, erasePageExperimentSubject, findRunningExperiment } from './pageExperimentsService.js';
import { cleanOpaqueToken, cleanString, cleanTagList, optionalCleanString, safeUrl } from '../../host/boundedStrings.js';
import { uniqueSlug, slugify } from '../../host/slug.js';
import { LOCALE_RE, negotiateLocale, resolveSection } from '../../host/i18n/index.js';
import { registerFieldKindValidator } from '../../host/customFields/index.js';
// ADR 0408 Phase C — the CMS façade composes the CONTENT KERNEL (the entities
// engine) for page storage. A DECLARED one-directional feature dependency
// (cms → entities): the kernel is the app's single content store and never
// imports cms back (guard-tested in cms-kernel-pages.test.ts).
import { mintSystemType } from '../entities/entitiesService.js';
import { makeKernelAdapter } from '../entities/kernelAdapter.js';
import { clearUsageForRef, syncUsageRefs } from '../media/mediaService.js';
// ADR 0592 §4 (CMSLWF-1) — CMS lifecycle events ride the ADR 0208 dispatcher
// (`emitHostEvent`), NOT `deliverHostExtEvent` directly: the dispatcher's
// webhook leg rides the same delivery seam (delivery stays single), and its
// binding-match + startWorkflowRun leg is what makes an operator's
// "on host.cms.page.published → start my workflow" binding actually fire.
// CMS was the ONLY feature emitting around the dispatcher (class enumerated
// 2026-08-20: every other emitter already calls emitHostEvent).
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
// ADR 0593 D2 — the pending-review cascade. Direction is feature → core (core
// never imports back), the same edge `contentApproval.ts` already uses.
import { rejectPendingApprovalForPage } from '../../host/approvalService.js';
import { fireCmsPageLifecycle, type CmsContentCollection } from '../../host/cmsPageLifecycle.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import type { SubjectEraseReport } from '../../host/subjectErasure.js';
import { eraseContentLanguageSettingsSubject } from '../../host/contentLocales.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.cms');

const MAX = {
  title: 160,
  tag: 40,
  tags: 12,
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
  slugChars: 64,  // ADR 0748 — `slugify`'s own cap, stated so the protocol 400 can name it
  slug: 40,       // a short opaque token, e.g. a card `icon` slug (ADR 0027)
  sections: 50,
  columns: 12,
  compareCols: 8,   // named products/families a `comparison` matrix may span (ADR 0485)
  compareRows: 24,  // capability rows a `comparison` matrix may hold (ADR 0485)
  faqItems: 20,     // Q/A pairs a `faq` section may hold (UX_UPGRADE-site R2-G10)
  quoteItems: 12,   // testimonials a `quotes` section may hold (R2-G10)
  answer: 2000,     // one FAQ answer (plain text, richText model)
  quote: 600,       // one testimonial quote (plain text)
  cell: 80,         // one comparison cell — a short authored status token, e.g. "✓" / "Leaders only" (ADR 0485)
  fieldKeys: 40,    // named fields a `fields` section may hold (ADR 0748)
  perOrgPages: 2000,
} as const;

/** Section layout for `columns` — how the public renderer lays the items out. */
const COLUMN_LAYOUTS = ['cards', 'steps', 'stats', 'showcase', 'rows'] as const;
/** Optional hero art direction. Absent preserves the original workflow motif. */
const HERO_VISUALS = ['workflow', 'journey', 'run', 'image', 'none'] as const;

export type PageStatus = 'draft' | 'in_review' | 'published' | 'archived';
export const PAGE_STATUSES: PageStatus[] = ['draft', 'in_review', 'published', 'archived'];

export type SectionType = 'hero' | 'richText' | 'image' | 'cta' | 'columns' | 'productGrid' | 'form' | 'pricing' | 'entityList' | 'entityDetail' | 'comparison' | 'faq' | 'quotes' | 'fields';
export const SECTION_TYPES: SectionType[] = ['hero', 'richText', 'image', 'cta', 'columns', 'productGrid', 'form', 'pricing', 'entityList', 'entityDetail', 'comparison', 'faq', 'quotes', 'fields'];

/** ADR 0748 — a `fields` section's key grammar and ceiling (the protocol's open
 *  section body, held as flat named text fields). */
export const FIELDS_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** ADR 0391 (b) — the closed set of plan tiers a `pricing` section may name (a
 *  subset of the billing `PlanTier` catalog; the section carries only WHICH
 *  tiers to show — never prices, which the client reads live from billing). */
const PRICING_TIER_IDS = ['free', 'pro', 'team', 'enterprise'] as const;

export interface Section {
  sectionId: string;
  type: SectionType;
  /** Base/default-locale fields. */
  data: Record<string, unknown>;
  /**
   * Sparse per-locale field overrides (RFC 0103 / ADR 0064). Keys are BCP-47
   * tags (RFC 0206 grammar — `host/i18n/locale.ts` LOCALE_RE), never the base locale; each value is a
   * partial overlay of `data`, sanitized identically to `data`. Optional +
   * backward-compatible: a section without it deserializes unchanged.
   */
  localizations?: Record<string, Record<string, unknown>>;
  /**
   * Shared-section reference (ADR 0204 C4, inherit-only v1): when set, this
   * section renders the SHARED section's content at delivery time; its own
   * `data`/`localizations` are ignored (kept empty). Detach = copy the shared
   * content into `data` and drop the ref (an editor action, not a state).
   */
  ref?: { sharedSectionId: string };
  /**
   * ADR 0592 §3 (CMSL-10/CMSLU-4/CMSLWF-8) — durable AI-authorship provenance:
   * locale → ISO instant the overlay was MACHINE-drafted (the submit-time
   * auto-translate sweep, the editor's translate-from-base, or a run/agent
   * `updateSectionDraft`). Absent key = human-authored (or pre-fix row — NO
   * backfill; absence makes no claim). Cleared when a human edits the overlay.
   * ADVISORY metadata for reviewers/audit, not a security boundary — the
   * mandatory human gate remains the control; a stamp entry is kept only while
   * the overlay it describes exists (validate drops orphaned keys).
   */
  aiDrafted?: Record<string, string>;
}

export interface Page {
  pageId: string;
  tenantId: string;
  orgId: string;
  title: string;
  slug: string;
  status: PageStatus;
  sections: Section[];
  /** Editor-facing labels for list filtering (ADR 0206 / gap-analysis B3) —
   *  cleaned via the shared tag cleaner (media-asset precedent), capped. */
  tags?: string[];
  /** ADR 0391 (a) — post-type discriminator. Absent ⇒ an ordinary `page`
   *  (backward compatible, the ADR 0383 additive-KV pattern). `'post'` makes
   *  the page a blog post: it appears in the public blog list + blog feed. */
  kind?: 'page' | 'post';
  /** ADR 0391 (a) — byline principal (a user id resolved to a profile display
   *  name at read time; falls back to `createdBy`). Posts only; never a
   *  freeform author string (profiles stay the one owner of display names).
   *
   *  SOFT REF, deliberately NOT existence-checked at write (P0PUB-1): CMS does
   *  not reach into the identity directory to validate a user id — the same
   *  posture as the never-validated `createdBy`. It is display-only and resolves
   *  best-effort through the TENANT-SCOPED `subjectDisplay` seam, which degrades
   *  an unknown or foreign-tenant principal to a humanized id (a cross-tenant id
   *  cannot resolve to another tenant's name — no leak). The value is still
   *  bounded + sanitized as an opaque token by `cleanPostFacets`. A hard check
   *  would couple cms→user-directory for a cosmetic byline; not worth it. */
  authorId?: string;
  /** ADR 0391 (a) — the single primary section (slugified), powering the
   *  `/blog/category/:cat` archive. Distinct from the many cross-cutting tags. */
  category?: string;
  /** One-shot scheduled publish time (ISO, ADR 0204 C2) — set only while the
   *  page is draft/in_review and the approval gate is OFF; cleared on publish
   *  or cancel. The publish sweep fires it. */
  scheduledPublishAt?: string;
  /** One-shot scheduled UNPUBLISH time (ISO, ADR 0204 C2b — the embargo-end
   *  half of the Contentful/Sanity publish-at/unpublish-at pair). Set while
   *  published, or alongside a pending publish schedule (then it must be
   *  later). Cleared when the page leaves `published` (manual unpublish /
   *  archive) or on cancel. The sweep's unpublish lane fires it. */
  scheduledUnpublishAt?: string;
  /**
   * Per-locale publish state (ADR 0205 D2). ONLY non-base locales appear; an
   * ABSENT key means published-with-the-page (backward compatible — existing
   * pages behave exactly as before). A `'draft'` locale is withheld from
   * delivery: its overlay is skipped and negotiation falls through the
   * existing RFC 0103 chain (already-normative fallback — no wire change).
   */
  localePublishState?: Record<string, 'draft' | 'published'>;
  /**
   * Content collection discriminator (ADR 0392). Absent = a regular marketing/
   * site page (the default, backward-compatible). `'docs'` marks a reference-docs
   * page: authored + published through the SAME editorial state machine, served
   * publicly, but EXCLUDED from the marketing sitemap/RSS/nav and instead
   * enumerated by the docs feature's own nav tree. An additive blob field — no
   * migration (the DurableCollection<Page> KV store tolerates it).
   */
  collection?: CmsContentCollection;
  /** Ordering key within the docs nav tree (ADR 0392); a slash path allows
   *  grouping later (`getting-started/10`). Only meaningful when collection='docs'. */
  docsNav?: string;
  version: number;
  publishedVersion?: number;
  /** ADR 0391 (a) — the timestamp of the LAST publish transition (approve /
   *  publish). Additive-KV: ABSENT on legacy rows + never-published pages, so
   *  public-surface ordering falls back to `updatedAt` (`publishedAt ?? updatedAt`).
   *  Stamped ONLY on the status→published transition, so editing a published
   *  page (an `updatePage` that bumps `updatedAt`) does NOT re-float the post in
   *  the blog list or reset its RSS `<pubDate>`. */
  publishedAt?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * ADR 0408 Phase C — pages live in the CONTENT KERNEL (the entities engine).
 * `cms.page` is a system-reserved entity type; this adapter is the façade's
 * page store (id-preserving: pageId = entityId, so versions/redirects/
 * experiments keep their keys). Mapping:
 *   - queryable scalars → kernel `values` (orgId/title/slug/workflowStatus/
 *     kind/authorUserId) — the convergence payoff: entityList/query see pages;
 *   - sections → `ext.blocks` (validated by the registered `blocks` kind —
 *     the SAME validateSections sanitizer, second line of defense);
 *   - the remaining Page fields → `ext.page` (façade-owned domain metadata,
 *     stored blind by the kernel; the façade owns page semantics).
 * Kernel entry `status` derives from the workflow status (published ⇒ live),
 * so every kernel consumer sees pages through the same publish gate as any
 * other type. The LEGACY `cms:page` collection remains declared read-dark for
 * one release (the migration's rollback window) — nothing reads it here.
 */
const legacyPages = new DurableCollection<Page>('cms:page', (p) => p.pageId);
export const CMS_PAGE_TYPE = 'cms.page';

// Kernel field keys are seam-normalized (lowercase + underscores) — the
// snake_case here IS the queryable vocabulary (entityList/query over pages).
const PAGE_TYPE_FIELDS = [
  { key: 'org_id', label: 'Org', type: 'string', required: true },
  { key: 'title', label: 'Title', type: 'string', required: true },
  { key: 'slug', label: 'Slug', type: 'string', required: true },
  { key: 'workflow_status', label: 'Workflow status', type: 'enum', required: true, options: ['draft', 'in_review', 'published', 'archived'] },
  { key: 'kind', label: 'Kind', type: 'enum', required: false, options: ['page', 'post'] },
  { key: 'author_user_id', label: 'Author', type: 'string', required: false },
  { key: 'blocks', label: 'Blocks', type: 'blocks', required: false },
];

// ADR 0408 D2 — cms registers the `blocks` extension kind INTO the core
// field-kind registry at MODULE SCOPE (features register into core, never the
// reverse; module scope so the kernel page store has it wherever cmsService
// loads — bare-harness tests and the boot migration included). validate = the
// SAME validateSections sanitizer the routes use (the kernel's second line of
// defense on system-row writes; baseLocale '' keeps this a STRUCTURE check —
// org-aware locale semantics are the façade's first-line validation).
// resolveLocale = the per-section overlay merge (ADR 0406: one localization
// model, kind-scoped depth).
registerFieldKindValidator('blocks', {
  validate: (value) => validateSections(value, ''),
  resolveLocale: (value, locale, baseLocale) =>
    Array.isArray(value)
      ? (value as Section[]).map((s) => ({ sectionId: s.sectionId, type: s.type, data: resolveSection(s, locale, baseLocale) }))
      : value,
});

async function ensurePageType(tenantId: string): Promise<void> {
  // No process-level memo: storage can reset under a live process (test
  // harnesses); the mint is idempotent and one point-read when present.
  await mintSystemType({
    tenantId,
    name: CMS_PAGE_TYPE,
    displayName: 'Page',
    description: 'CMS pages (system type — managed by the CMS façade; ADR 0408).',
    fields: PAGE_TYPE_FIELDS,
    extensionKinds: ['blocks'],
    actor: 'system:cms',
  });
}

/** Page → kernel row (lossless: everything non-scalar rides ext.page). */
function pageToKernel(page: Page): { values: Record<string, unknown>; ext: Record<string, unknown>; status?: 'draft' } {
  const { sections, ...rest } = page;
  return {
    values: {
      org_id: page.orgId,
      title: page.title,
      slug: page.slug,
      workflow_status: page.status,
      ...(page.kind !== undefined ? { kind: page.kind } : {}),
      ...(page.authorId !== undefined ? { author_user_id: page.authorId } : {}),
    },
    ext: { blocks: sections, page: rest },
    ...(page.status === 'published' ? {} : { status: 'draft' as const }),
  };
}

/** Kernel row → Page (ext.page is the domain truth; blocks reattach). */
function kernelToPage(rec: { ext?: Record<string, unknown> }): Page {
  const base = (rec.ext?.page ?? {}) as Omit<Page, 'sections'>;
  const sections = (rec.ext?.blocks ?? []) as Section[];
  return { ...base, sections } as Page;
}

/** The kernel-backed page store (KERNEL-5 shared factory). `toKernel` forwards
 *  a concrete `status` ('draft' when the page isn't published, else 'live') —
 *  reproducing the previous `mapped.status ?? 'live'` default. Top-level
 *  `orgId` is stamped so the RI-7 org-delete guard (`jsonOrgId`, which probes
 *  the TOP-LEVEL `orgId`) sees the row — parity with crm.company / crm.deal /
 *  commerce.product. `cas` comes along as a capability (unused by cms today). */
const pages = makeKernelAdapter<Page>({
  typeName: CMS_PAGE_TYPE,
  ensureType: ensurePageType,
  toKernel: (page) => {
    const mapped = pageToKernel(page);
    return { values: mapped.values, ext: mapped.ext, status: mapped.status ?? 'live' };
  },
  fromKernel: (rec) => kernelToPage(rec),
  idOf: (p) => p.pageId,
  tenantOf: (p) => p.tenantId,
  orgOf: (p) => p.orgId,
  actorOf: (p) => p.updatedBy,
  updatedAtOf: (p) => p.updatedAt,
  legacy: legacyPages,
});

/**
 * ADR 0408 D5 — the id-preserving APP_MIGRATION body: every legacy `cms:page`
 * row becomes a `cms.page` kernel row (pageId = entityId; versions/redirects/
 * experiments keys untouched). Idempotent + concurrency-tolerant: an already-
 * migrated page is skipped; the kernel write is CAS-guarded. Legacy rows stay
 * READ-DARK for one release (the rollback window) — nothing reads them; the
 * following release's cleanup migration removes them. Also seeds scheduled
 * MARKERS for pages with a pending scheduled publish.
 */
export async function migratePagesToKernel(): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  for (const page of await legacyPages.list()) {
    // Custom loop (not the factory's migrate) because pages ALSO seed a
    // scheduled-publish marker on the move. pages.get ensures the type + reads
    // the kernel; skip-if-present is id-preserving + idempotent.
    if (await pages.get(page.tenantId, page.pageId)) {
      skipped += 1;
      continue;
    }
    await pages.put(page);
    if (page.scheduledPublishAt && (page.status === 'draft' || page.status === 'in_review')) {
      await scheduledMarkers.put({ pageId: page.pageId, tenantId: page.tenantId, orgId: page.orgId, at: page.scheduledPublishAt });
    }
    migrated += 1;
  }
  if (migrated > 0) log.info('cms_pages_migrated_to_kernel', { migrated, skipped });
  return { migrated, skipped };
}

/** ADR 0408 — scheduled-publish MARKER rows so the minute sweep reads a tiny
 *  dedicated set instead of scanning pages (cheaper than the pre-kernel
 *  cross-tenant page scan; markers self-heal on read). */
interface ScheduledMarker { pageId: string; tenantId: string; orgId: string; at: string }
const scheduledMarkers = new DurableCollection<ScheduledMarker>('cms:scheduled', (m) => m.pageId);
/** ADR 0204 C2b — a SEPARATE marker lane for scheduled unpublish. The publish
 *  markers are keyed by pageId alone, so the embargo pair (publish 09:00 +
 *  unpublish 17:00 on ONE page) would collide in one collection — two lanes,
 *  same shape, same self-heal discipline. No subject data (pageId/tenant/org/
 *  at only), same DSAR class as `cms:scheduled`. */
const scheduledUnpublishMarkers = new DurableCollection<ScheduledMarker>('cms:scheduled-unpublish', (m) => m.pageId);

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
      const visual = HERO_VISUALS.includes(d.visual as typeof HERO_VISUALS[number])
        ? (d.visual as typeof HERO_VISUALS[number])
        : undefined;
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...(heading ? { heading } : {}),
        ...(optionalCleanString(d.subheading, MAX.text) ? { subheading: optionalCleanString(d.subheading, MAX.text) } : {}),
        // Opaque media REFERENCE — charset-validated, NOT secret-scrubbed
        // (cleanString redacts 40+-char blobs, destroying serve tokens; ADR 0206).
        ...(cleanOpaqueToken(d.imageToken, MAX.token) ? { imageToken: cleanOpaqueToken(d.imageToken, MAX.token) } : {}),
        ...(optionalCleanString(d.alt, MAX.alt) ? { alt: optionalCleanString(d.alt, MAX.alt) } : {}),
        ...(visual ? { visual } : {}),
        ...(cta1 ? { ctaLabel: cta1, ctaUrl: safeLink(d.ctaUrl, MAX.url) } : {}),
        ...(cta2 ? { ctaLabel2: cta2, ctaUrl2: safeLink(d.ctaUrl2, MAX.url) } : {}),
      };
    }
    case 'productGrid': {
      // C7 (ecommerce gap plan) — content-commerce composition: VALIDATED PRODUCT
      // REFERENCES, never copied product data. The renderer resolves live
      // name/price/image through the public-store read at view time; a missing/
      // archived product renders the fallback (skipped), never stale data.
      // Structural validation here (bounded id list, one org's storefront);
      // existence is a render-time concern by design (products churn under pages).
      const productIds = Array.isArray(d.productIds)
        ? (d.productIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80).slice(0, 24)
        : [];
      if (!partial && productIds.length === 0) throw new OpenwopError('validation_error', 'productGrid.productIds needs at least one product id.', 400, {});
      const storeOrgId = optionalCleanString(d.storeOrgId, 120);
      if (!partial && !storeOrgId) throw new OpenwopError('validation_error', 'productGrid.storeOrgId is required (whose storefront to resolve against).', 400, {});
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(productIds.length > 0 ? { productIds } : {}),
        ...(storeOrgId ? { storeOrgId } : {}),
      };
    }
    case 'form': {
      // ADR 0331 §D2 — content-capture composition: a VALIDATED FORM REFERENCE
      // ({ formId }; orgId kept as editor convenience), never copied fields.
      // The renderer resolves the public render schema live at view time; a
      // missing/unpublished/toggled-off form renders nothing (uniform 404
      // honesty) — existence is a render-time concern (the productGrid model).
      const formId = cleanOpaqueToken(d.formId, 128);
      if (!partial && !formId) throw new OpenwopError('validation_error', 'form.formId is required (which form to render).', 400, {});
      const formOrgId = optionalCleanString(d.orgId, 120);
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(formId ? { formId } : {}),
        ...(formOrgId ? { orgId: formOrgId } : {}),
      };
    }
    case 'entityList': {
      // ADR 0407 D1 — entity-backed section: a VALIDATED QUERY REFERENCE
      // (tenant + type + bounded presentation config), never copied entity
      // data. The renderer resolves live rows through the ANONYMOUS
      // public-entities read at view time (publicRead types only — the section
      // can never surface anything the anonymous wire wouldn't); a missing/
      // non-public type renders the fallback. Structural validation here;
      // existence is a render-time concern (the productGrid model). The
      // stored query spec EXECUTES only in the entities feature (ADR 0386
      // correction-note boundary) — cms never grows a query engine.
      const tenantId = optionalCleanString(d.tenantId, 120);
      if (!partial && !tenantId) throw new OpenwopError('validation_error', 'entityList.tenantId is required (whose workspace to resolve against).', 400, {});
      const typeName = optionalCleanString(d.typeName, 120);
      if (!partial && !typeName) throw new OpenwopError('validation_error', 'entityList.typeName is required (which entity type to list).', 400, {});
      const titleField = optionalCleanString(d.titleField, 80);
      if (!partial && !titleField) throw new OpenwopError('validation_error', 'entityList.titleField is required (which field titles each card).', 400, {});
      const limitRaw = typeof d.limit === 'number' && Number.isFinite(d.limit) ? Math.floor(d.limit) : undefined;
      const sortDir = d.sortDir === 'asc' || d.sortDir === 'desc' ? d.sortDir : undefined;
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(tenantId ? { tenantId } : {}),
        ...(typeName ? { typeName } : {}),
        ...(titleField ? { titleField } : {}),
        ...(optionalCleanString(d.bodyField, 80) ? { bodyField: optionalCleanString(d.bodyField, 80) } : {}),
        ...(limitRaw !== undefined ? { limit: Math.min(Math.max(limitRaw, 1), 24) } : {}),
        ...(optionalCleanString(d.sortKey, 80) ? { sortKey: optionalCleanString(d.sortKey, 80) } : {}),
        ...(sortDir ? { sortDir } : {}),
        // ADR 0407 Phase 3 — optional taxonomy-term narrowing (an opaque term
        // reference; membership resolves in the entities feature at render).
        ...(cleanOpaqueToken(d.termId, 128) ? { termId: cleanOpaqueToken(d.termId, 128) } : {}),
        // ADR 0408 Phase D — ONE bounded equality pair (e.g. kind=post for an
        // entityList over cms.page). Still a carried spec: the query executes
        // in the entities feature, validated closed-world against the type.
        ...(optionalCleanString(d.filterKey, 80) && optionalCleanString(d.filterValue, 200)
          ? { filterKey: optionalCleanString(d.filterKey, 80), filterValue: optionalCleanString(d.filterValue, 200) }
          : {}),
      };
    }
    case 'entityDetail': {
      // ADR 0407 D1 — a single-entity reference (the entityList rules, one row).
      const tenantId = optionalCleanString(d.tenantId, 120);
      if (!partial && !tenantId) throw new OpenwopError('validation_error', 'entityDetail.tenantId is required.', 400, {});
      const typeName = optionalCleanString(d.typeName, 120);
      if (!partial && !typeName) throw new OpenwopError('validation_error', 'entityDetail.typeName is required.', 400, {});
      const entityId = cleanOpaqueToken(d.entityId, 128);
      if (!partial && !entityId) throw new OpenwopError('validation_error', 'entityDetail.entityId is required (which entity to render).', 400, {});
      const titleField = optionalCleanString(d.titleField, 80);
      if (!partial && !titleField) throw new OpenwopError('validation_error', 'entityDetail.titleField is required.', 400, {});
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(tenantId ? { tenantId } : {}),
        ...(typeName ? { typeName } : {}),
        ...(entityId ? { entityId } : {}),
        ...(titleField ? { titleField } : {}),
        ...(optionalCleanString(d.bodyField, 80) ? { bodyField: optionalCleanString(d.bodyField, 80) } : {}),
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
      // Opaque media REFERENCE — charset-validated, NOT secret-scrubbed (see hero).
      const token = cleanOpaqueToken(d.token, MAX.token);
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
    case 'pricing': {
      // ADR 0391 (b) — a marketing wrapper around the plan tiers. It names WHICH
      // tiers to show (a closed-enum subset) + copy + a CTA; it carries NO prices
      // (the client resolves the display-safe tier catalog live from the
      // `/public/pricing` billing read). All fields optional — an empty pricing
      // section still renders the tier grid client-side.
      const tiers = Array.isArray(d.tiers)
        ? [...new Set((d.tiers as unknown[]).filter((t): t is typeof PRICING_TIER_IDS[number] => PRICING_TIER_IDS.includes(t as typeof PRICING_TIER_IDS[number])))]
        : [];
      const ctaLabel = optionalCleanString(d.ctaLabel, MAX.label);
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...(optionalCleanString(d.blurb, MAX.text) ? { blurb: optionalCleanString(d.blurb, MAX.text) } : {}),
        ...(tiers.length > 0 ? { tiers } : {}),
        ...(ctaLabel ? { ctaLabel, ctaUrl: safeLink(d.ctaUrl, MAX.url) } : {}),
      };
    }
    case 'comparison': {
      // ADR 0485 — a capability comparison MATRIX (rows = capabilities, columns =
      // named products/families). Every cell is a SHORT authored status string
      // ("✓" / "~" / "✗" / "Leaders only"); the renderer treats each cell as TEXT
      // (no HTML, no links) so there is no stored-XSS surface — the richText model.
      // Bounded on both axes; all authored, in-repo content (no live references to
      // resolve). `highlightColumn` marks the column the renderer emphasizes
      // (our own column); `legend`/`note` carry the key + a dated methodology line.
      const rawCols = Array.isArray(d.columns) ? d.columns : [];
      const columns = rawCols.slice(0, MAX.compareCols)
        .map((c) => cleanString(c, MAX.label))
        .filter((c) => c.length > 0);
      if (!partial && columns.length === 0) {
        throw new OpenwopError('validation_error', 'comparison.columns needs at least one column header.', 400, {});
      }
      const rawRows = Array.isArray(d.rows) ? d.rows : [];
      const rows = rawRows.slice(0, MAX.compareRows).map((r) => {
        const rr = r as { label?: unknown; cells?: unknown };
        const cells = (Array.isArray(rr.cells) ? rr.cells : [])
          .slice(0, MAX.compareCols)
          // Non-string cells coerce to empty (never "[object Object]"): cells are
          // short authored status tokens, not arbitrary data.
          .map((x) => (typeof x === 'string' ? cleanString(x, MAX.cell) : ''));
        return { label: cleanString(rr.label, MAX.label), cells };
      }).filter((r) => r.label.length > 0);
      if (!partial && rows.length === 0) {
        throw new OpenwopError('validation_error', 'comparison.rows needs at least one capability row.', 400, {});
      }
      const hcRaw = typeof d.highlightColumn === 'number' && Number.isFinite(d.highlightColumn) ? Math.floor(d.highlightColumn) : undefined;
      const highlightColumn = hcRaw !== undefined && hcRaw >= 0 && hcRaw < columns.length ? hcRaw : undefined;
      const legend = optionalCleanString(d.legend, MAX.text);
      const note = optionalCleanString(d.note, MAX.text);
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(legend ? { legend } : {}),
        ...(note ? { note } : {}),
        ...(!partial || has('columns') ? { columns } : {}),
        ...(!partial || has('rows') ? { rows } : {}),
        ...(highlightColumn !== undefined ? { highlightColumn } : {}),
      };
    }
    case 'faq': {
      // R2-G10 (UX_UPGRADE-site round 2) — an authored Q/A block (2026 pricing/
      // compare/home practice; named-competitor FAQs are what LLM search cites).
      // Plain-text Q/A pairs on the richText model: no HTML, no links, bounded
      // on both axes. The public renderer uses native <details>/<summary>, and
      // the prerender additionally emits a FAQPage JSON-LD block from the SAME
      // validated data.
      const rawItems = Array.isArray(d.items) ? d.items : [];
      const items = rawItems.slice(0, MAX.faqItems).map((it) => {
        const ii = it as { q?: unknown; a?: unknown };
        // Non-string fields coerce to empty (never "[object Object]") — the
        // comparison-cell rule.
        return {
          q: typeof ii.q === 'string' ? cleanString(ii.q, MAX.heading) : '',
          a: typeof ii.a === 'string' ? cleanString(ii.a, MAX.answer) : '',
        };
      }).filter((it) => it.q.length > 0 && it.a.length > 0);
      if (!partial && items.length === 0) {
        throw new OpenwopError('validation_error', 'faq.items needs at least one question with an answer.', 400, {});
      }
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(!partial || has('items') ? { items } : {}),
      };
    }
    case 'quotes': {
      // R2-G10 — attributed social proof (testimonials). Every 2026 leader puts
      // quantified, ATTRIBUTED quotes near the hero; the fields push authors
      // toward attribution (name/role) without inventing it — an unattributed
      // quote still renders, it just carries no byline. Plain text, bounded.
      const rawItems = Array.isArray(d.items) ? d.items : [];
      const items = rawItems.slice(0, MAX.quoteItems).map((it) => {
        const ii = it as { quote?: unknown; name?: unknown; role?: unknown };
        const name = typeof ii.name === 'string' ? optionalCleanString(ii.name, MAX.label) : undefined;
        const role = typeof ii.role === 'string' ? optionalCleanString(ii.role, MAX.label) : undefined;
        return {
          // Non-string quote coerces to empty (never "[object Object]").
          quote: typeof ii.quote === 'string' ? cleanString(ii.quote, MAX.quote) : '',
          ...(name ? { name } : {}),
          ...(role ? { role } : {}),
        };
      }).filter((it) => it.quote.length > 0);
      if (!partial && items.length === 0) {
        throw new OpenwopError('validation_error', 'quotes.items needs at least one quote.', 400, {});
      }
      return {
        ...opt('eyebrow', MAX.eyebrow),
        ...opt('heading', MAX.heading),
        ...opt('lede', MAX.lede),
        ...(!partial || has('items') ? { items } : {}),
      };
    }
    case 'fields': {
      // ADR 0748 — the protocol's open section body (`localized-content.md` §B:
      // "body field shapes are host/section-type-defined") held in the one
      // kernel as flat NAMED TEXT fields. Scalars only, rendered as text
      // everywhere (never HTML, never a link), so an open body on a public page
      // is no wider an injection surface than a `faq` answer. A shape outside
      // that is a 400 — never silently dropped, because the caller chose the
      // keys and must learn which ones this host cannot hold.
      const entries = Object.entries(d);
      if (entries.length > MAX.fieldKeys) {
        throw new OpenwopError('validation_error', `A \`fields\` section holds at most ${MAX.fieldKeys} fields.`, 400, { max: MAX.fieldKeys });
      }
      const out: Record<string, string | number | boolean> = {};
      for (const [k, v] of entries) {
        if (!FIELDS_KEY_RE.test(k)) {
          throw new OpenwopError('validation_error', `Field name \`${k.slice(0, 80)}\` is not allowed (letters, digits and _, starting with a letter).`, 400, { field: k.slice(0, 80) });
        }
        if (typeof v === 'string') out[k] = cleanString(v, MAX.text);
        else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'boolean') out[k] = v;
        else {
          throw new OpenwopError('validation_error', `Field \`${k}\` must be text, a number or true/false.`, 400, { field: k });
        }
      }
      return out;
    }
    default:
      throw new OpenwopError('validation_error', 'Unknown section type.', 400, {});
  }
}

/** Validate + sanitize the sparse per-locale overlay map (ADR 0064). Keys must
 *  be BCP-47 tags and MUST NOT equal the base locale; each value is cleaned
 *  through the SAME per-type builder as `data` (partial mode). */
/**
 * ADR 0668 D1 (CMSLWF-13) — `pageTenantId` is REQUIRED, not optional, and that is
 * load-bearing.
 *
 * The ADR 0593 §C9 cross-tenant guard was applied to a section's base `data` and NOT to its
 * localization overlays, two lines apart in `validateSection`. An overlay preserves
 * `tenantId` verbatim in partial mode and `resolveSection` merges `{...base, ...exact}`, so
 * the same foreign value the base axis REFUSED was accepted in an `es` overlay and WON at
 * delivery — a reader sending `Accept-Language: es` was served another workspace's entity
 * query.
 *
 * An OPTIONAL parameter would have fixed the page lane and silently no-opped on the
 * shared-section lane, which calls this function directly and passes no tenant. Requiring it
 * makes the COMPILER enumerate the call sites: the ADR's hand-written audit found two, the
 * type system found four. A caller with genuinely no page tenant passes `undefined`
 * explicitly and says why.
 */
function validateLocalizations(type: SectionType, raw: unknown, baseLocale: string, pageTenantId: string | undefined): Record<string, Record<string, unknown>> | undefined {
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
    // Same rule as the base axis — equal-or-absent. An overlay naming no `tenantId`
    // inherits the base (the common case, still legal); one that names it must name this
    // page's. Parity, deliberately: a rule stricter than the one it mirrors is its own hazard.
    assertSectionTenant(type, overlay as Record<string, unknown>, pageTenantId);
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
export function validateSection(raw: unknown, baseLocale = 'en', pageTenantId?: string): Section {
  if (typeof raw !== 'object' || raw === null) {
    throw new OpenwopError('validation_error', 'Each section must be an object.', 400, {});
  }
  const r = raw as Record<string, unknown>;
  const type = r.type as SectionType;
  if (!SECTION_TYPES.includes(type)) {
    throw new OpenwopError('validation_error', `section.type must be one of: ${SECTION_TYPES.join(', ')}`, 400, { type: r.type });
  }
  const sectionId = typeof r.sectionId === 'string' && r.sectionId.startsWith('sec:') ? r.sectionId : `sec:${randomUUID()}`;
  // Shared-section reference (ADR 0204 C4): a ref section carries NO own
  // content — its data/localizations come from the shared section at delivery.
  const rawRef = r.ref as { sharedSectionId?: unknown } | undefined;
  if (rawRef && typeof rawRef === 'object') {
    const sharedSectionId = cleanOpaqueToken(rawRef.sharedSectionId, MAX.token);
    if (!sharedSectionId.startsWith('shsec:')) {
      throw new OpenwopError('validation_error', 'section.ref.sharedSectionId must be a `shsec:` id.', 400, {});
    }
    return { sectionId, type, data: {}, ref: { sharedSectionId } };
  }
  const d = (typeof r.data === 'object' && r.data !== null ? r.data : {}) as Record<string, unknown>;
  assertSectionTenant(type, d, pageTenantId); // ADR 0593 §C9 (CMSA-12)
  const data = buildSectionData(type, d, false);
  const localizations = validateLocalizations(type, r.localizations, baseLocale, pageTenantId);
  const hasLoc = !!localizations && Object.keys(localizations).length > 0;
  const aiDrafted = cleanAiDrafted(r.aiDrafted, hasLoc ? localizations : undefined);
  return {
    sectionId, type, data,
    ...(hasLoc ? { localizations } : {}),
    ...(aiDrafted ? { aiDrafted } : {}),
  };
}

/** ADR 0592 §3 — sanitize the per-locale AI-provenance map: locale keys must be
 *  valid BCP-47 AND describe an overlay that actually exists (an orphaned stamp
 *  is dropped, so clearing an overlay clears its provenance for free); values
 *  are bounded opaque strings (ISO instants in practice — not trusted as
 *  anything more). Invalid shapes are DROPPED, never fatal: provenance is
 *  advisory metadata and must not brick a save. */
function cleanAiDrafted(
  raw: unknown,
  localizations: Record<string, Record<string, unknown>> | undefined,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !localizations) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, at] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOCALE_RE.test(locale)) continue;
    if (!localizations[locale]) continue; // stamp without an overlay — meaningless
    const v = cleanOpaqueToken(at, 64);
    if (v) out[locale] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function validateSections(raw: unknown, baseLocale = 'en', pageTenantId?: string): Section[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', '`sections` must be an array.', 400, { field: 'sections' });
  return raw.slice(0, MAX.sections).map((s) => validateSection(s, baseLocale, pageTenantId));
}

/**
 * ADR 0593 §C9 (`CMSA-12` cross-tenant half) — an entity-reference section may
 * only name its OWN page's tenant.
 *
 * `data.tenantId` is editor-controlled at `workspace:write`, and BOTH delivery
 * lanes take the tenant from it: the prerenderer resolves it server-side into
 * crawler HTML + JSON-LD, and the SPA fetches it client-side straight from the
 * section. A read-side guard alone would therefore close the crawler lane and
 * leave the human one open — crawler ≠ human, which is the cloaking mismatch
 * the resolver's own comment says it exists to avoid. Refusing at the WRITE
 * closes both with one rule, and costs nothing in entity authority: the
 * entities feature keeps every bit of its own published/publicRead gating.
 *
 * Applied only where a page tenant is known (create/update). The ADR 0408
 * kernel field-validator path has no page context and is unchanged — recorded
 * because an unstated exemption is how the last three of these got missed.
 */
function assertSectionTenant(type: SectionType, data: Record<string, unknown>, pageTenantId?: string): void {
  if (!pageTenantId) return;
  if (type !== 'entityList' && type !== 'entityDetail') return;
  const named = data.tenantId;
  if (typeof named !== 'string' || named === '' || named === pageTenantId) return;
  throw new OpenwopError(
    'validation_error',
    `A \`${type}\` section may only reference its own workspace — \`tenantId\` must be this page's workspace.`,
    400,
    { field: 'tenantId', section: type },
  );
}

// ── Pages ─────────────────────────────────────────────────────────────────

export interface PageListFilter {
  /** Case-insensitive substring match on title + slug. */
  q?: string;
  tag?: string;
  status?: PageStatus;
  /** ADR 0391 — narrow to posts (`'post'`) or ordinary pages (`'page'`,
   *  which matches the absent-field legacy rows). Narrows, never widens. */
  kind?: 'page' | 'post';
  /** ADR 0391 — narrow to one primary category (posts). */
  category?: string;
  /** ADR 0391 — narrow to one byline principal (posts). */
  authorId?: string;
  /** ADR 0392 — narrow to a content collection. `'docs'` = docs pages only;
   *  `'site'` = everything that is NOT a docs page (the marketing/site default
   *  set); absent = all pages. Never widens visibility (still tenant+org-scoped). */
  collection?: CmsContentCollection | 'site';
}

/** List an org's pages. `filter` only NARROWS the already tenant+org-scoped set
 *  (ADR 0206 B3) — filtering never widens visibility, so there is no IDOR
 *  surface in the query params. */
export async function listPages(tenantId: string, orgId: string, filter?: PageListFilter): Promise<Page[]> {
  // Kernel-backed: a per-type per-tenant slice, no longer a cross-tenant scan.
  let out = (await pages.listForTenant(tenantId)).filter((p) => p.tenantId === tenantId && p.orgId === orgId);
  if (filter?.status) out = out.filter((p) => p.status === filter.status);
  if (filter?.kind) {
    // Absent `kind` means an ordinary page (legacy rows predate the facet).
    out = out.filter((p) => (p.kind ?? 'page') === filter.kind);
  }
  if (filter?.category) out = out.filter((p) => p.category === filter.category);
  if (filter?.authorId) out = out.filter((p) => (p.authorId ?? p.createdBy) === filter.authorId);
  if (filter?.collection === 'docs') out = out.filter((p) => p.collection === 'docs');
  else if (filter?.collection === 'site') out = out.filter((p) => p.collection !== 'docs');
  if (filter?.tag) {
    const tag = filter.tag.toLowerCase();
    out = out.filter((p) => (p.tags ?? []).includes(tag));
  }
  if (filter?.q) {
    const q = filter.q.toLowerCase();
    out = out.filter((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
  }
  return out;
}

/** Clean an incoming `tags` value like the media library does (shared cleaner):
 *  lowercased, bounded, deduped, capped. */
export function cleanPageTags(raw: unknown): string[] {
  return cleanTagList(raw, { maxTags: MAX.tags, maxLen: MAX.tag });
}

/** ADR 0391 — validate the optional post facets. `kind` is a closed enum;
 *  `authorId` an opaque principal token; `category` slugified (it is a URL
 *  segment on the public archive). Invalid values are a 400, never coerced. */
export function cleanPostFacets(raw: { kind?: unknown; authorId?: unknown; category?: unknown }): Pick<Page, 'kind' | 'authorId' | 'category'> {
  const out: Pick<Page, 'kind' | 'authorId' | 'category'> = {};
  if (raw.kind !== undefined) {
    if (raw.kind !== 'page' && raw.kind !== 'post') {
      throw new OpenwopError('validation_error', "`kind` must be 'page' or 'post'.", 400, { kind: raw.kind });
    }
    out.kind = raw.kind;
  }
  if (raw.authorId !== undefined) {
    const cleaned = cleanOpaqueToken(raw.authorId, MAX.token);
    if (cleaned) out.authorId = cleaned;
  }
  if (raw.category !== undefined) {
    const cleaned = slugify(typeof raw.category === 'string' ? raw.category : '');
    if (cleaned) out.category = cleaned;
  }
  return out;
}

export async function getPage(tenantId: string, orgId: string, pageId: string): Promise<Page | null> {
  const p = await pages.get(tenantId, pageId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

async function slugSet(tenantId: string, orgId: string, exceptPageId?: string): Promise<Set<string>> {
  const all = await listPages(tenantId, orgId);
  return new Set(all.filter((p) => p.pageId !== exceptPageId).map((p) => p.slug));
}

export async function createPage(input: { tenantId: string; orgId: string; title: string; slug?: string; sections?: unknown; tags?: unknown; createdBy: string; pageId?: string; baseLocale?: string; kind?: unknown; authorId?: unknown; category?: unknown; collection?: 'docs'; docsNav?: string; createOnly?: boolean }): Promise<Page> {
  // A FIXED pageId (host-level seeds, ADR 0027) makes creation idempotent: if the
  // row already exists, return it — so a concurrent cross-instance first-boot seed
  // converges on ONE page instead of a `home` + `home-2` duplicate.
  if (input.pageId) {
    const prior = await getPage(input.tenantId, input.orgId, input.pageId);
    // ADR 0754 — idempotent-return is for seeds; a create-only caller asked for a
    // NEW page, and handing it a concurrent writer's page as its own is an overwrite
    // by another name.
    if (prior && input.createOnly) throw new OpenwopError('conflict', `A page with id \`${input.pageId}\` already exists.`, 409, { pageId: input.pageId });
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
  const tags = cleanPageTags(input.tags);
  const facets = cleanPostFacets(input);
  const page: Page = {
    pageId: input.pageId ?? `page:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title,
    slug,
    status: 'draft',
    sections: validateSections(input.sections, input.baseLocale ?? 'en', input.tenantId),
    ...(tags.length > 0 ? { tags } : {}),
    ...facets,
    ...(input.collection === 'docs' ? { collection: 'docs' as const } : {}),
    ...(input.collection === 'docs' && typeof input.docsNav === 'string' && input.docsNav ? { docsNav: cleanString(input.docsNav, MAX.slug, '') } : {}),
    version: 1,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  // ADR 0754 — the protocol lane creates, never overwrites: a row that appeared
  // under this id after the caller's checks is a 409 here, not a silent update.
  if (input.createOnly) await pages.create(page); else await pages.put(page);
  await syncPageUsage(page);
  return page;
}

export async function updatePage(
  tenantId: string,
  orgId: string,
  pageId: string,
  patch: { title?: string; slug?: string; sections?: unknown; tags?: unknown; baseLocale?: string; kind?: unknown; authorId?: unknown; category?: unknown; docsNav?: string },
  updatedBy: string,
  // ADR 0592 §1 (CMSL-1) — OPTIONAL optimistic-concurrency pin, enforced HERE
  // (the service read is the authoritative one, so every caller that sends the
  // pin is covered — route, submit auto-translate merge, workflow surface).
  // Optional on purpose: making it required would break clone/agent/API
  // callers in one move; the SPA editor always sends it. The house pattern is
  // the approval pin (contentApproval.ts) + the commerce order-row CAS.
  opts?: { expectedVersion?: number },
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (opts?.expectedVersion !== undefined && p.version !== opts.expectedVersion) {
    throw new OpenwopError(
      'conflict',
      `The page changed since it was loaded (version ${p.version}, expected ${opts.expectedVersion}) — reload and reapply your edits, or overwrite explicitly.`,
      409,
      { pageId, currentVersion: p.version, expectedVersion: opts.expectedVersion },
    );
  }
  const next: Page = { ...p, updatedBy, updatedAt: nowIso(), version: p.version + 1 };
  // ADR 0391 post facets — validated; explicit null clears (facet removal).
  const facets = cleanPostFacets(patch);
  if (facets.kind !== undefined) next.kind = facets.kind;
  if (patch.authorId === null) delete next.authorId;
  else if (facets.authorId !== undefined) next.authorId = facets.authorId;
  if (patch.category === null) delete next.category;
  else if (facets.category !== undefined) next.category = facets.category;
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
  if (patch.sections !== undefined) next.sections = validateSections(patch.sections, patch.baseLocale ?? 'en', tenantId);
  if (patch.tags !== undefined) {
    const tags = cleanPageTags(patch.tags);
    if (tags.length > 0) next.tags = tags;
    else delete next.tags;
  }
  // ADR 0392 — docs nav ordering (only meaningful on a docs-collection page).
  if (patch.docsNav !== undefined && p.collection === 'docs') {
    const nav = cleanString(patch.docsNav, MAX.slug, '');
    if (nav) next.docsNav = nav; else delete next.docsNav;
  }
  await pages.put(next);
  // ADR 0392 grade pass D2 — an in-place edit of a PUBLISHED page (an admin
  // capability; editors must unpublish first) changes live public content
  // without a transition, so it must re-fire the lifecycle or derived stores
  // (the docs KB) go stale until the next unpublish→republish cycle.
  if (next.status === 'published') {
    void fireCmsPageLifecycle({
      tenantId: next.tenantId, orgId: next.orgId, pageId: next.pageId, slug: next.slug,
      title: next.title, ...(next.collection ? { collection: next.collection } : {}), event: 'published',
    });
  }
  await syncPageUsage(next);
  return next;
}

// ── Protocol content façade (ADR 0748, RFC 0103 §D / RFC 0206) ────────────
// The protocol `/content/*` admin ops are a VIEW of these same kernel rows, not
// a second store. Two id spaces meet here, and each rule below exists because
// the CMS convention would otherwise silently change what the caller addressed.

/** A protocol `pageId` / `sectionId`: bounded, and safe as a storage key. */
export const PROTOCOL_CONTENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROTOCOL_SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** A protocol SECTION id: the content-id grammar, minus the CMS `sec:` prefix.
 *  `toCmsSectionId` is idempotent on that prefix, so `hero` and `sec:hero` would
 *  both address `sec:hero` — two protocol ids for one stored section, and a
 *  `sectionOrder` holding both passed the raw-id duplicate check and stored two
 *  sections under one id (ADR 0755, WIT-CNT-7). The projection never emits the
 *  prefix, so no id a client read back from this host is refused. */
export function isProtocolSectionId(id: string): boolean {
  return PROTOCOL_CONTENT_ID_RE.test(id) && !id.startsWith('sec:');
}

/** CMS section ids carry a `sec:` prefix (`validateSection` re-mints any other
 *  id), protocol ids do not: `hero` ↔ `sec:hero`, both directions. */
export function toCmsSectionId(id: string): string {
  return id.startsWith('sec:') ? id : `sec:${id}`;
}
export function toProtocolSectionId(id: string): string {
  return id.startsWith('sec:') ? id.slice(4) : id;
}

/**
 * `POST /content/pages`. Refuses where `createPage` would quietly adapt, because
 * on the protocol the caller chose both keys and the slug IS the delivery
 * address: an existing `pageId` is 409 (never the prior row returned as if
 * created), and a taken slug is 409 (never `slug-2`). `sectionOrder` becomes one
 * empty `fields` section per id, in order, so render order lives in the one CMS
 * order rather than a second field. Always created as a DRAFT; the caller
 * publishes through `transitionPage`, which owns the publish side-effects.
 */
export async function createProtocolPage(input: {
  tenantId: string; orgId: string; pageId: unknown; slug: unknown; name: unknown; sectionOrder: unknown;
  createdBy: string; baseLocale: string;
}): Promise<Page> {
  const pageId = typeof input.pageId === 'string' ? input.pageId : '';
  if (!PROTOCOL_CONTENT_ID_RE.test(pageId)) {
    throw new OpenwopError('validation_error', '`pageId` must be 1–128 characters of letters, digits and `._:-`.', 400, { field: 'pageId' });
  }
  const slug = typeof input.slug === 'string' ? input.slug : '';
  // `slugify` is the CMS normaliser; a slug it would rewrite is not one this host
  // can serve at the address the caller asked for.
  if (!PROTOCOL_SLUG_RE.test(slug) || slugify(slug) !== slug) {
    throw new OpenwopError('validation_error', `\`slug\` must match ^[a-z][a-z0-9-]*$ (at most ${MAX.slugChars} characters, no leading/trailing or doubled hyphen).`, 400, { field: 'slug' });
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new OpenwopError('validation_error', '`name` is required.', 400, { field: 'name' });
  }
  if (!Array.isArray(input.sectionOrder)) {
    throw new OpenwopError('validation_error', '`sectionOrder` must be an array of section ids.', 400, { field: 'sectionOrder' });
  }
  const order: string[] = [];
  for (const raw of input.sectionOrder as unknown[]) {
    if (typeof raw !== 'string' || !isProtocolSectionId(raw)) {
      throw new OpenwopError('validation_error', 'Each `sectionOrder` entry must be 1–128 characters of letters, digits and `._:-`, not starting with `sec:`.', 400, { field: 'sectionOrder' });
    }
    if (order.includes(raw)) throw new OpenwopError('validation_error', `Section \`${raw}\` appears twice in \`sectionOrder\`.`, 400, { field: 'sectionOrder' });
    order.push(raw);
  }
  if (order.length > MAX.sections) {
    throw new OpenwopError('validation_error', `A page holds at most ${MAX.sections} sections.`, 400, { max: MAX.sections });
  }
  // TENANT-wide, not org-scoped (ADR 0755, WIT-CNT-1). The kernel row key is
  // (tenant type, pageId) with no org in it, so `getPage`'s org filter read a
  // sibling org's page as absent and `createPage`'s `pages.put` then OVERWROTE it
  // — moved to this org, demoted to draft, sections emptied: a live page in
  // another org taken down by a caller with no authority there. Any row under
  // this id is a 409, whichever org holds it; the message names no org.
  if (await pages.get(input.tenantId, pageId)) {
    throw new OpenwopError('conflict', `A page with id \`${pageId}\` already exists.`, 409, { pageId });
  }
  if ((await slugSet(input.tenantId, input.orgId)).has(slug)) {
    throw new OpenwopError('conflict', `The slug \`${slug}\` is already in use.`, 409, { slug });
  }
  const page = await createPage({
    tenantId: input.tenantId,
    orgId: input.orgId,
    pageId,
    slug,
    title: input.name,
    sections: order.map((id) => ({ sectionId: toCmsSectionId(id), type: 'fields', data: {} })),
    createdBy: input.createdBy,
    baseLocale: input.baseLocale,
    createOnly: true,
  });
  // ADR 0754 — the slug check above is a read; two concurrent creates both pass
  // it. Post-write re-check: if the slug is not ours ALONE (another page holds it,
  // or `createPage` renamed ours because one landed in between), withdraw ours and
  // 409. Both racers may withdraw — a retry then succeeds — but never two pages on
  // one slug and never a silent rename, which is the "409, never renamed" promise.
  const holders = (await listPages(input.tenantId, input.orgId)).filter((p) => p.slug === slug && p.pageId !== page.pageId);
  if (page.slug !== slug || holders.length > 0) {
    await deletePage(input.tenantId, input.orgId, page.pageId);
    throw new OpenwopError('conflict', `The slug \`${slug}\` is already in use.`, 409, { slug });
  }
  return page;
}

/**
 * `PUT /content/pages/{pageId}/sections/{sectionId}` — `locale == baseLocale`
 * REPLACES the section's base `data`, any other locale replaces
 * `localizations[locale]` (PUT semantics). A section the page does not hold is
 * appended as a `fields` section. An existing typed section keeps its closed
 * schema: fields outside it are dropped, as in the editor, and the returned
 * record shows exactly what was kept.
 *
 * `authorize` runs against the FRESH page on every attempt, so the caller's
 * status-dependent authority (draft = editor, live = admin, gated = refused)
 * is decided on the row actually written, not on an earlier read. Version-pinned
 * through `updatePage` with ONE bounded retry — the `updateSectionDraft` shape.
 */
export async function upsertProtocolSection(input: {
  tenantId: string; orgId: string; pageId: string; sectionId: string; locale: string;
  data: Record<string, unknown>; baseLocale: string; actor: string;
  authorize: (page: Page) => Promise<void>;
}): Promise<{ page: Page; section: Section } | null> {
  if (!isProtocolSectionId(input.sectionId)) {
    throw new OpenwopError('validation_error', '`sectionId` must be 1–128 characters of letters, digits and `._:-`, not starting with `sec:`.', 400, { field: 'sectionId' });
  }
  const cmsId = toCmsSectionId(input.sectionId);
  const isBase = input.locale === input.baseLocale;
  for (let attempt = 0; ; attempt += 1) {
    const page = await getPage(input.tenantId, input.orgId, input.pageId);
    if (!page) return null;
    await input.authorize(page);
    const existing = page.sections.find((s) => s.sectionId === cmsId);
    // A shared-section reference carries no content of its own (ADR 0204 C4):
    // `validateSection` would keep the ref and DROP the write, answering 200 for
    // text that never landed. Detaching is an editor decision, not a side effect.
    if (existing?.ref) {
      throw new OpenwopError('conflict', 'This section inherits a shared section; detach it in the editor before writing its content.', 409, { sectionId: input.sectionId, sharedSectionId: existing.ref.sharedSectionId });
    }
    if (!existing && page.sections.length >= MAX.sections) {
      throw new OpenwopError('validation_error', `A page holds at most ${MAX.sections} sections.`, 400, { max: MAX.sections });
    }
    const base: Section = existing ?? { sectionId: cmsId, type: 'fields', data: {} };
    let next: Section;
    if (isBase) {
      next = { ...base, data: input.data };
    } else {
      // The stamp described the overlay being replaced; a stamp is kept only while
      // its overlay exists (ADR 0592 §3), and this write makes no provenance claim.
      const { [input.locale]: _replaced, ...restStamps } = base.aiDrafted ?? {};
      next = {
        ...base,
        localizations: { ...(base.localizations ?? {}), [input.locale]: input.data },
        ...(Object.keys(restStamps).length > 0 ? { aiDrafted: restStamps } : {}),
      };
      if (Object.keys(restStamps).length === 0) delete next.aiDrafted;
    }
    const sections = existing ? page.sections.map((s) => (s.sectionId === cmsId ? next : s)) : [...page.sections, next];
    try {
      const saved = await updatePage(input.tenantId, input.orgId, input.pageId, { sections, baseLocale: input.baseLocale }, input.actor, { expectedVersion: page.version });
      if (!saved) return null;
      const section = saved.sections.find((s) => s.sectionId === cmsId);
      if (!section) throw new OpenwopError('internal_error', 'The section was not stored.', 500, {});
      return { page: saved, section };
    } catch (err) {
      if (attempt === 0 && err instanceof OpenwopError && err.code === 'conflict') continue;
      throw err;
    }
  }
}

export async function deletePage(
  tenantId: string,
  orgId: string,
  pageId: string,
  // ADR 0748 correction (2026-09-27) — a status-dependent authority decision
  // (draft = editor, anything live = admin tier) must be taken on the row this
  // function is about to delete, not on a caller's earlier read. The kernel has
  // no conditional delete, so this is the narrowest window available: the
  // decision runs on THIS read, immediately before `pages.delete`. A throw aborts
  // the delete.
  opts?: { authorize?: (page: Page) => Promise<void> },
): Promise<boolean> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return false;
  if (opts?.authorize) await opts.authorize(p);
  await pages.delete(tenantId, pageId);
  // WF-SHARE-4 — cascade the public share links that referenced this page.
  // Dynamic import: sharing imports THIS module for its resolver, so a static
  // edge back would cycle (the crm/signService precedent). Best-effort — a
  // cascade failure must not fail the delete, and the link would 404 anyway;
  // what it must not do is leave a row that reports "in use externally".
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'cms_page', pageId);
  } catch { /* best-effort cascade — the link resolves 404 regardless */ }
  // CMNT-2 — cascade the page's comment threads. Comment `body` is declared PII
  // and `listThread` never re-derives visibility from the parent, so an orphaned
  // thread stays API-readable to anyone with `workspace:read` who knows the id,
  // for up to the retention window. `chat_message` / `canvas_document` /
  // `creative_brief` already cascade; `cms_page` did not.
  // Dynamic import for the same reason as the sharing cascade above: comments
  // imports THIS module for its resolver registry, so a static edge would cycle.
  // Best-effort (the delete already succeeded) but never SILENT — CMSGAP-2.
  try {
    const { pruneThreadsForResourceAndComposites } = await import('../comments/commentsService.js');
    await pruneThreadsForResourceAndComposites(tenantId, 'cms_page', pageId);
  } catch (err) {
    log.warn('comment_thread_cascade_failed', { resourceType: 'cms_page', pageId, error: err instanceof Error ? err.message : String(err) });
  }
  // ADR 0392 grade pass D1 — deleting a page must fire the lifecycle seam so
  // consumers (the docs→KB sync) drop their derived documents; without this a
  // deleted docs page stays citable by the chat forever (an orphan).
  void fireCmsPageLifecycle({
    tenantId: p.tenantId, orgId: p.orgId, pageId: p.pageId, slug: p.slug,
    title: p.title, ...(p.collection ? { collection: p.collection } : {}), event: 'deleted',
  });
  try {
    await clearUsageForRef(tenantId, orgId, 'cms-page', pageId);
  } catch (err) {
    // Best-effort — the delete already succeeded — but never silent (CMSGAP-2).
    log.warn('cms usage cleanup failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  // RI/content-scout — cascade the page's own CMS children (page FIRST so a mid-cascade
  // failure leaves inert orphans, never a live page with half its versions). Best-effort
  // + logged, like the usage clear above. All three live in the cms feature (intra-feature).
  try {
    for (const v of (await versions.list()).filter((v) => v.tenantId === tenantId && v.orgId === orgId && v.pageId === pageId)) {
      await versions.delete(v.versionId);
    }
    // Redirects are slug-keyed: a redirect FROM this page's slug is dead, and an inbound
    // redirect TO it now dead-ends — delete both (also prevents a stale redirect resurrecting
    // against a future page that reclaims the freed slug).
    for (const r of (await redirects.list()).filter((r) => r.tenantId === tenantId && r.orgId === orgId && (r.fromSlug === p.slug || r.toSlug === p.slug))) {
      await redirects.delete(r.redirectId);
    }
    for (const e of await listExperiments(tenantId, orgId, pageId)) {
      await deleteExperiment(tenantId, orgId, pageId, e.experimentId, 'system');
    }
  } catch (err) {
    log.warn('cms page child cascade failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  // ADR 0593 D2 (CMSA-2a / CMSAWF-1) — cascade the page's pending editorial
  // review. It was the one child store `deletePage` never touched, and the
  // consequence was worse than an orphan: the inbox card became UNCLEARABLE
  // (approve and reject both CAS-resolved, failed the transition, compensated
  // and threw, forever — polluting the governance chain on every attempt).
  // Best-effort like every cascade above, but never silent (CMSGAP-2); the
  // decide-arm backstop in `contentApproval.ts` covers a failure here.
  try {
    await rejectPendingApprovalForPage(tenantId, pageId, 'Closed automatically — the page was deleted.', true);
  } catch (err) {
    log.warn('cms pending approval cascade failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

// ── Media usage references (ADR 0206 / gap-analysis B4) ─────────────────────

/** Every media serve token a page's sections reference — base data AND per-locale
 *  overlays (locale image variants, ADR 0007). Tokens are opaque here; media
 *  resolves them. */
export function collectMediaTokens(sections: readonly Section[]): string[] {
  const tokens = new Set<string>();
  const grab = (d: Record<string, unknown>): void => {
    for (const key of ['imageToken', 'token'] as const) {
      const v = d[key];
      if (typeof v === 'string' && v.length > 0) tokens.add(v);
    }
  };
  for (const s of sections) {
    grab(s.data);
    for (const overlay of Object.values(s.localizations ?? {})) grab(overlay);
  }
  return [...tokens];
}

/** Reconcile the media "used by" graph for this page (best-effort — a save must
 *  never fail because usage bookkeeping did). Media owns the rows + the
 *  token→asset resolution (ADR 0007 boundary). */
async function syncPageUsage(page: Page): Promise<void> {
  try {
    await syncUsageRefs(
      page.tenantId,
      page.orgId,
      { kind: 'cms-page', id: page.pageId, label: page.title },
      collectMediaTokens(page.sections),
    );
  } catch (err) {
    // Best-effort — a save never fails on bookkeeping — but never silent (CMSGAP-2).
    log.warn('cms media-usage reconcile failed', { pageId: page.pageId, error: err instanceof Error ? err.message : String(err) });
  }
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
  /**
   * ADR 0593 §C3 (CMSA-11) — WHY this snapshot exists. `snapshotPage` fires on
   * SUBMIT as well as on publish (ADR 0206 B1), so "a version row exists" has
   * never meant "this content was ever approved": a submitted-and-then-REJECTED
   * version leaves a durable, addressable snapshot behind, and the page
   * experiment lane will bind it to live traffic.
   *
   * `'publish'` is MONOTONIC — a row captured at submit is PROMOTED in place
   * when that same `page.version` is published (`transitionPage` does not bump
   * `version`, so submit→approve lands on the very row submit captured, and a
   * capture-time-only stamp would mark every legitimately published snapshot
   * `'submit'` forever).
   *
   * OPTIONAL, and absence makes NO claim: rows written before this field
   * existed carry neither value. The experiment gate treats that as
   * unidentifiable and REFUSES rather than falling through (the CMSA-7 rule) —
   * see `pageExperimentsService.assertVariantSnapshotReviewed`.
   */
  origin?: 'publish' | 'submit';
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

/**
 * Capture a content snapshot. DISTINCT-CONTENT-ONLY (ADR 0206 / ADR 0009
 * correction): skip when the newest snapshot already captures this
 * `page.version` — so submit→publish of unchanged content, or a re-submit
 * without edits, never duplicates a capture. Snapshots are content captures
 * keyed by version, not status events; `publishedBy`/`publishedAt` read as
 * "capturedBy/capturedAt" (field names kept for stored-row + editor-API
 * compatibility).
 */
async function snapshotPage(page: Page, publishedBy: string, origin: 'publish' | 'submit'): Promise<void> {
  const newest = (await versions.list())
    .filter((x) => x.pageId === page.pageId)
    .sort(byNewest)[0];
  if (newest && newest.version === page.version) {
    // ADR 0593 §C3 (CMSA-11) — dedupe, but PROMOTE. `transitionPage` never
    // bumps `version`, so an approve lands on exactly the row submit captured
    // and this early return is the common publish path, not a corner. A
    // capture-time-only stamp would therefore mark the canonical published
    // snapshot `'submit'` on every gated org and the experiment gate would
    // refuse the ONE version it must allow — the prescribed cure, built
    // literally, is the gate-with-no-exit shape. Promotion is one-way.
    // NOTE (review F8): only `origin` is rewritten. `publishedBy`/`publishedAt`
    // keep naming the SUBMITTER and the submit instant, which is correct under
    // this row's own doc ("they read as capturedBy/capturedAt") — the capture
    // really did happen then, by them. Approver attribution lives on the
    // approval row, which is the record that answers "who let this out".
    if (origin === 'publish' && newest.origin !== 'publish') {
      await versions.put({ ...newest, origin: 'publish' });
    }
    return;
  }
  const v: PageVersion = {
    origin,
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

/** One version row, tenant+org+page IDOR-guarded (ADR 0236 D1 — the experiment
 *  seam reads a variant's snapshot exactly the way restoreVersion does). */
export async function getVersion(tenantId: string, orgId: string, pageId: string, versionId: string): Promise<PageVersion | null> {
  const v = await versions.get(versionId);
  return v && v.tenantId === tenantId && v.orgId === orgId && v.pageId === pageId ? v : null;
}

/** Restore a past version's content into the page's DRAFT (does not publish). */
export async function restoreVersion(
  tenantId: string,
  orgId: string,
  pageId: string,
  versionId: string,
  actor: string,
  // ADR 0593 CORRECTION (review F5) — WHY the pending review is being closed.
  // The experiment-promote lane calls this FIRST and unconditionally, so by the
  // time its own arm tried to close the row the CAS had already refused and the
  // recorded cause was the generic restore note. The caller that knows the real
  // reason has to supply it, or the governance record says the wrong thing.
  closeReviewNote = 'Closed automatically — a previous version was restored and the page returned to draft.',
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  const v = await versions.get(versionId);
  if (!v || v.pageId !== pageId || v.tenantId !== tenantId || v.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Version not found for this page.', 404, { versionId });
  }
  const next: Page = { ...p, title: v.snapshot.title, sections: v.snapshot.sections, status: 'draft', version: p.version + 1, updatedBy: actor, updatedAt: nowIso() };
  await pages.put(next);
  await syncPageUsage(next); // restored sections may reference different assets
  // ADR 0593 D2 (CMSA-2b) — a restore ALWAYS lands the page in `draft`, so a
  // pending review of the pre-restore content is about content that no longer
  // exists. Left open it wedged: approve 409'd stale (correct) but reject
  // 409'd-and-reopened forever, because `transitionPage('reject')` demands
  // `in_review`. Close it and say why; a resubmit mints a fresh, correctly
  // pinned row (that is what the gated experiment-promote lane now does).
  try {
    await rejectPendingApprovalForPage(tenantId, pageId, closeReviewNote, true);
  } catch (err) {
    log.warn('cms pending approval cascade failed', { pageId, error: err instanceof Error ? err.message : String(err) });
  }
  recordCmsAction('restore', next, actor, { restoredVersion: v.version }); // ADR 0204 C1/C5
  return next;
}

// ── Lifecycle events + audit (ADR 0204 C1/C5) ───────────────────────────────

/** Workflow action → the `host.cms.page.*` lifecycle event it emits (vendor
 *  pattern, `openwop-app.crm.contact-triaged` precedent — schema-legal, no RFC). */
const EVENT_FOR_ACTION: Record<string, string> = {
  submit: 'host.cms.page.submitted',
  approve: 'host.cms.page.published',
  publish: 'host.cms.page.published',
  reject: 'host.cms.page.rejected',
  archive: 'host.cms.page.archived',
  unpublish: 'host.cms.page.unpublished',
  restore: 'host.cms.page.restored',
};

/**
 * Record a CMS action: an audit row (C5 — `payload.tenantId` is REQUIRED, the
 * tenant-scoped governance read withholds rows without it, fail-closed) and,
 * when the action maps to a lifecycle event, a webhook fan-out through the
 * ONE delivery pipeline (C1). Both best-effort — bookkeeping never fails the
 * write it describes. No section content rides an event or audit row (titles
 * only).
 *
 * CORRECTED (ADR 0668 D2) — this used to read "and never a locale (RFC 0103 §F)".
 * §F's invariant (`spec/v1/localized-content.md:165`) is scoped to a **run event
 * log**; a `host.cms.page.*` host-extension webhook is not one. The claim was also
 * already inaccurate: `setLocalePublishState` passes `{ locale, state }` through
 * `extra`, so the AUDIT row has carried a locale since ADR 0205. A host-ext
 * lifecycle payload may carry the locale it describes; a run event log may not.
 */
function recordCmsAction(action: string, page: Page, actor: string, extra?: Record<string, unknown>): void {
  const at = nowIso();
  const base = { tenantId: page.tenantId, orgId: page.orgId, pageId: page.pageId, slug: page.slug, status: page.status, version: page.version, actor, at, ...extra };
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `cms.${action}`, resource: page.pageId, outcome: 'success', payload: base })
      .catch((err) => log.warn('cms audit append failed', { action, pageId: page.pageId, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  // ADR 0668 D2 (CMSLWF-15) — releasing a withheld locale is a PUBLISH for the readers
  // of that locale (ADR 0593's own gate comment says so: it "instantly serves overlays
  // that were being held back"), and it emitted on NO lane. It rides the EXISTING kinds
  // rather than minting one, because a new `host.cms.page.*` type is an operator-catalog
  // change under the ADR 0617 D4 parity gate; the `locale` in `extra` is the discriminator.
  const eventType = action === 'locale-publish-state'
    ? (extra?.state === 'published' ? 'host.cms.page.published' : 'host.cms.page.unpublished')
    : EVENT_FOR_ACTION[action];
  if (eventType) {
    void emitHostEvent({ type: eventType, tenantId: page.tenantId, payload: { ...base, title: page.title } });
  }
  // ADR 0392 — the in-process page-lifecycle seam (consumers filter on
  // `collection`; CMS stays ignorant of who cares). Fire only for the publish
  // STATE transitions that move a page in/out of the public surface.
  // ADR 0668 D2 — the lifecycle seam is DELIBERATELY not extended to a locale flip.
  // `CmsPageLifecycleChange` carries no locale (`host/cmsPageLifecycle.ts`), and the one
  // registered consumer DELETES the whole document on `unpublished`
  // (`features/docs/docsKnowledgeService.ts`) — so withholding a single `es` overlay of a
  // docs page would evict a still-published page, English body included, from the docs KB.
  // The KB also flattens BASE `data` only, so a locale flip changes nothing it stores:
  // firing this seam would be pure loss in one direction and a no-op in the other.
  const lifecycle = action === 'locale-publish-state' ? undefined : LIFECYCLE_FOR_ACTION[action];
  if (lifecycle) {
    void fireCmsPageLifecycle({
      tenantId: page.tenantId, orgId: page.orgId, pageId: page.pageId, slug: page.slug,
      title: page.title, ...(page.collection ? { collection: page.collection } : {}), event: lifecycle,
    });
  }
}

/** The lifecycle event a workflow action produces, when it changes public
 *  visibility (ADR 0392). `submit`/`reject`/`restore` don't move the page in/out
 *  of the public surface, so they don't fire. */
const LIFECYCLE_FOR_ACTION: Record<string, 'published' | 'unpublished' | 'archived'> = {
  approve: 'published',
  publish: 'published',
  unpublish: 'unpublished',
  archive: 'archived',
};

// ── Editorial workflow (Phase 2) ────────────────────────────────────────────

export type WorkflowAction = 'submit' | 'approve' | 'reject' | 'publish' | 'archive' | 'unpublish';

/** Legal `from → to` per action; the ROUTE enforces the SCOPE (submit =
 *  workspace:write; the rest = host:members:manage). `unpublish` (and the exit
 *  from `archived`) is how a published/archived page returns to draft to be
 *  edited through the gate again — there is no other path back to draft except
 *  restoreVersion (code-review #1/#5: closes the archived dead-end + gives a
 *  clean re-edit path so live content isn't patched in place). */
const TRANSITIONS: Record<WorkflowAction, { from: PageStatus[]; to: PageStatus }> = {
  // UX_UPGRADE-content R2 (CMS2-M1 fold-in) — `in_review` is a legal FROM state
  // because a resubmit is how an edited in-review page RE-PINS its approval.
  // The version pin refuses to publish content that changed after submit, which
  // is the point; but with submit draft-only there was no way to make the pin
  // catch up, so an admin editing an in-review page (which `routes.ts` allows,
  // deliberately, so a reviewer's requested change can be made) left the page
  // permanently unapprovable — the 409's own remedy, "submit it again", was
  // itself a 409. The only escape was `reject`, which fires a rejection event
  // and audit row against content the reviewer actually wanted.
  submit: { from: ['draft', 'in_review'], to: 'in_review' },
  approve: { from: ['in_review'], to: 'published' },
  reject: { from: ['in_review'], to: 'draft' },
  publish: { from: ['draft', 'in_review'], to: 'published' }, // admin direct-publish
  archive: { from: ['published'], to: 'archived' },
  unpublish: { from: ['published', 'archived'], to: 'draft' }, // back to draft to re-edit
};

export async function transitionPage(
  tenantId: string,
  orgId: string,
  pageId: string,
  action: WorkflowAction,
  actor: string,
  // ADR 0593 D3 (CMSA-3 / CMSAWF-3) — OPTIONAL optimistic-concurrency pin, the
  // same shape `updatePage` takes (ADR 0592 §1). The approval handler threads
  // `approval.pageVersion` on the APPROVE arm so the approve-what-you-saw pin is
  // a precondition on the write rather than a check-then-act read: an admin
  // PATCH landing in the window used to publish unseen content under the
  // reviewer's name. Optional on purpose — every other transition lane
  // (submit/reject/publish/unpublish/archive, the sweep, promote) is unchanged.
  opts?: { expectedVersion?: number },
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (opts?.expectedVersion !== undefined && p.version !== opts.expectedVersion) {
    throw new OpenwopError(
      'conflict',
      `This page changed after it was submitted for review (version ${p.version}, expected ${opts.expectedVersion}). Re-open it, read the current version, and submit it again.`,
      409,
      // `phase: 'transition'` distinguishes this from the handler's pre-CAS
      // staleness read. Same user-facing meaning and the same FE arm, but a
      // witness for the TOCTOU window CANNOT tell the two apart without it —
      // both produce a 409 and leave the row pending, so the test would pass
      // whether or not the precondition exists.
      { reason: 'stale_review', phase: 'transition', pageId, currentVersion: p.version, approvedVersion: opts.expectedVersion },
    );
  }
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(p.status)) {
    throw new OpenwopError('validation_error', `Cannot ${action} a page in status \`${p.status}\`.`, 409, { status: p.status, action });
  }
  const next: Page = { ...p, status: rule.to, updatedBy: actor, updatedAt: nowIso() };
  if (rule.to === 'published') {
    next.publishedVersion = next.version;
    next.publishedAt = next.updatedAt; // ADR 0391 (a) — the publish instant (blog order + RSS pubDate)
    delete next.scheduledPublishAt; // any publish consumes a pending schedule (ADR 0204 C2)
    // A pending scheduledUnpublishAt deliberately SURVIVES publish — it is the
    // embargo-end half of the pair (ADR 0204 C2b).
    await snapshotPage(next, actor, 'publish'); // capture the published snapshot (Phase 3)
  } else if (p.status === 'published' || p.status === 'archived') {
    // Leaving published/archived (manual unpublish, archive) makes a pending
    // unpublish schedule moot — consume the field; the marker self-heals at
    // the next sweep read (the same discipline as the publish lane).
    delete next.scheduledUnpublishAt;
  }
  if (action === 'submit') {
    // ADR 0206 (B1): capture at submit too, so review-time version compares
    // have the submitted content. snapshotPage dedupes by version, so
    // submit→publish of unchanged content still yields ONE capture (and the
    // publish arm PROMOTES that row's `origin` — ADR 0593 §C3).
    await snapshotPage(next, actor, 'submit');
  }
  await pages.put(next);
  recordCmsAction(action, next, actor); // ADR 0204 C1/C5 — event + audit, best-effort
  return next;
}

// ── Translator locale grants (ADR 0205 D1) ──────────────────────────────────
// A NARROWING filter over an editor's write authority (the ADR 0132
// conversation-scope precedent — narrowing filters live with the feature;
// authority itself stays accessControl's): a member with a grant may edit ONLY
// the granted locales' overlays on draft pages — never base content, page
// chrome (title/slug/tags), section structure, foreign locales, or workflow
// status. No grant ⇒ unchanged full-editor behavior.

export interface CmsLocaleGrant {
  grantId: string; // `${tenantId}:${orgId}:${subject}` — deterministic
  tenantId: string;
  orgId: string;
  /** The member's authenticated subject (User.userId). */
  subject: string;
  locales: string[];
  updatedBy: string;
  updatedAt: string;
}

const localeGrants = new DurableCollection<CmsLocaleGrant>('cms:localegrant', (g) => g.grantId);

export async function listLocaleGrants(tenantId: string, orgId: string): Promise<CmsLocaleGrant[]> {
  return (await localeGrants.list()).filter((g) => g.tenantId === tenantId && g.orgId === orgId);
}

export async function getLocaleGrant(tenantId: string, orgId: string, subject: string): Promise<CmsLocaleGrant | null> {
  const g = await localeGrants.get(`${tenantId}:${orgId}:${subject}`);
  return g && g.tenantId === tenantId && g.orgId === orgId ? g : null;
}

/** Set (or, with an empty locale list, remove) a member's translator grant.
 *  ADR 0592 §9 (CMSL-7) — grant locales are validated against the org's
 *  CONFIGURED `supportedLocales`: a grant for an unconfigured locale narrows
 *  a member to overlays no lane delivers (a de-facto lockout that looks like
 *  a working grant), so it 400s at write with the unsupported set named. */
export async function putLocaleGrant(tenantId: string, orgId: string, subject: string, locales: unknown, updatedBy: string): Promise<CmsLocaleGrant | null> {
  if (!Array.isArray(locales)) throw new OpenwopError('validation_error', '`locales` must be an array.', 400, {});
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of locales) {
    const l = String(raw);
    if (!LOCALE_RE.test(l)) throw new OpenwopError('validation_error', `Invalid locale \`${l}\` (expected BCP-47).`, 400, { locale: l });
    if (!seen.has(l)) { seen.add(l); cleaned.push(l); }
  }
  if (cleaned.length > 0) {
    const settings = await getContentLanguageSettings(tenantId, orgId);
    const unsupported = cleaned.filter((l) => !settings.supportedLocales.includes(l));
    if (unsupported.length > 0) {
      throw new OpenwopError(
        'validation_error',
        `These locales are not configured translation locales for this org: [${unsupported.join(', ')}] — add them in language settings first.`,
        400,
        { unsupported, supportedLocales: settings.supportedLocales },
      );
    }
  }
  const grantId = `${tenantId}:${orgId}:${subject}`;
  if (cleaned.length === 0) {
    await localeGrants.delete(grantId);
    return null;
  }
  const row: CmsLocaleGrant = { grantId, tenantId, orgId, subject, locales: cleaned, updatedBy, updatedAt: nowIso() };
  await localeGrants.put(row);
  return row;
}

const stable = (v: unknown): string => JSON.stringify(v ?? null);

/**
 * Enforce the translator narrowing on a page PATCH (ADR 0205 D1): the incoming
 * sections must be IDENTICAL to the stored page except for overlay changes on
 * granted locales. Structure (count/order/ids/types), base `data`, and shared
 * refs are immutable to a locale-scoped member. Throws `forbidden_scope` 403.
 */
export function assertLocaleScopedSectionsPatch(current: Page, incoming: Section[], grantedLocales: readonly string[]): void {
  const deny = (reason: string, details: Record<string, unknown> = {}): never => {
    throw new OpenwopError('forbidden_scope', `Your translator grant is limited to [${grantedLocales.join(', ')}] — ${reason}`, 403, { grantedLocales: [...grantedLocales], ...details });
  };
  if (incoming.length !== current.sections.length) deny('sections cannot be added or removed.');
  const granted = new Set(grantedLocales);
  current.sections.forEach((cur, i) => {
    const next = incoming[i]!;
    if (next.sectionId !== cur.sectionId || next.type !== cur.type) deny('sections cannot be reordered or retyped.', { sectionId: cur.sectionId });
    if (stable(next.ref) !== stable(cur.ref)) deny('shared-section references cannot change.', { sectionId: cur.sectionId });
    if (stable(next.data) !== stable(cur.data)) deny('base content cannot change.', { sectionId: cur.sectionId });
    const locales = new Set([...Object.keys(cur.localizations ?? {}), ...Object.keys(next.localizations ?? {})]);
    for (const locale of locales) {
      if (stable(next.localizations?.[locale]) !== stable(cur.localizations?.[locale]) && !granted.has(locale)) {
        deny(`the \`${locale}\` overlay is outside your grant.`, { sectionId: cur.sectionId, locale });
      }
    }
    // ADR 0592 §3 correction (review F4) — the AI-provenance stamps are part
    // of the per-locale surface this guard protects: without this, a
    // translator granted only `es` could STRIP (or forge) `fr`'s `aiDrafted`
    // stamp with a 200 — laundering the exact signal the human review gate
    // depends on, through the narrowed lane itself (the in-family instance).
    // Their OWN granted locales stay free: editing legitimately clears the
    // stamp there.
    const aiLocales = new Set([...Object.keys(cur.aiDrafted ?? {}), ...Object.keys(next.aiDrafted ?? {})]);
    for (const locale of aiLocales) {
      if (stable(next.aiDrafted?.[locale]) !== stable(cur.aiDrafted?.[locale]) && !granted.has(locale)) {
        deny(`the \`${locale}\` AI-provenance stamp is outside your grant.`, { sectionId: cur.sectionId, locale });
      }
    }
  });
}

// ── Shared sections (ADR 0204 C4, inherit-only v1) ──────────────────────────

/** A reusable section owned by the org — pages reference it (`Section.ref`)
 *  and inherit its content at delivery time. Content is validated/sanitized
 *  exactly like an inline section. */
export interface SharedSection {
  sharedSectionId: string;
  tenantId: string;
  orgId: string;
  name: string;
  type: SectionType;
  data: Record<string, unknown>;
  localizations?: Record<string, Record<string, unknown>>;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const sharedSections = new DurableCollection<SharedSection>('cms:sharedsection', (s) => s.sharedSectionId);
const MAX_SHARED_SECTIONS = 100;

export async function listSharedSections(tenantId: string, orgId: string): Promise<SharedSection[]> {
  return (await sharedSections.list()).filter((s) => s.tenantId === tenantId && s.orgId === orgId);
}

export async function getSharedSection(tenantId: string, orgId: string, sharedSectionId: string): Promise<SharedSection | null> {
  const s = await sharedSections.get(sharedSectionId);
  return s && s.tenantId === tenantId && s.orgId === orgId ? s : null;
}

export async function createSharedSection(
  tenantId: string,
  orgId: string,
  input: { name: string; type: unknown; data: unknown; localizations?: unknown },
  createdBy: string,
  baseLocale = 'en',
): Promise<SharedSection> {
  const existing = await listSharedSections(tenantId, orgId);
  if (existing.length >= MAX_SHARED_SECTIONS) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX_SHARED_SECTIONS} shared sections.`, 409, { max: MAX_SHARED_SECTIONS });
  }
  const type = input.type as SectionType;
  if (!SECTION_TYPES.includes(type)) {
    throw new OpenwopError('validation_error', `type must be one of: ${SECTION_TYPES.join(', ')}`, 400, { type: input.type });
  }
  const d = (typeof input.data === 'object' && input.data !== null ? input.data : {}) as Record<string, unknown>;
  // ADR 0668 D1 — this lane never called `validateSection`, so the ADR 0593 §C9 guard had
  // NEVER run on a shared section, on either axis. `resolveSharedRefs` copies `data` AND
  // `localizations` into every page that references this section, so one poisoned shared
  // section is served everywhere it is used — the same defect as the page lane, wider.
  assertSectionTenant(type, d, tenantId);
  const data = buildSectionData(type, d, false);
  const localizations = validateLocalizations(type, input.localizations, baseLocale, tenantId);
  const ts = nowIso();
  const row: SharedSection = {
    sharedSectionId: `shsec:${randomUUID()}`,
    tenantId,
    orgId,
    name: cleanString(input.name, MAX.title, 'Untitled shared section'),
    type,
    data,
    ...(localizations && Object.keys(localizations).length > 0 ? { localizations } : {}),
    version: 1,
    createdBy,
    updatedBy: createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await sharedSections.put(row);
  return row;
}

export async function updateSharedSection(
  tenantId: string,
  orgId: string,
  sharedSectionId: string,
  patch: { name?: string; data?: unknown; localizations?: unknown },
  updatedBy: string,
  baseLocale = 'en',
): Promise<SharedSection | null> {
  const cur = await getSharedSection(tenantId, orgId, sharedSectionId);
  if (!cur) return null;
  const next: SharedSection = { ...cur, updatedBy, updatedAt: nowIso(), version: cur.version + 1 };
  if (patch.name !== undefined) next.name = cleanString(patch.name, MAX.title, cur.name);
  if (patch.data !== undefined) {
    const d = (typeof patch.data === 'object' && patch.data !== null ? patch.data : {}) as Record<string, unknown>;
    assertSectionTenant(cur.type, d, tenantId); // ADR 0668 D1 — see createSharedSection
    next.data = buildSectionData(cur.type, d, false);
  }
  if (patch.localizations !== undefined) {
    const loc = validateLocalizations(cur.type, patch.localizations, baseLocale, tenantId);
    if (loc && Object.keys(loc).length > 0) next.localizations = loc;
    else delete next.localizations;
  }
  await sharedSections.put(next);
  return next;
}

/** Pages referencing a shared section — the "impacted pages" list an editor
 *  MUST see before changing shared content (the research-doc acceptance
 *  criterion). Bounded by the per-org page cap. */
/**
 * ADR 0593 §C9 (adversarial review of #3428, F1) — THE sections a reader can
 * actually be served for this page: its own, PLUS every section inside a
 * snapshot bound to a RUNNING experiment.
 *
 * This is the root cause under CMSA-1 and CMSA-10 alike. Every page-set scan in
 * this feature read `page.sections`, and delivery does not always serve
 * `page.sections`: `publicPageBySlug` (ADR 0236 D1) substitutes
 * `version.snapshot.sections` for a visitor on a non-holdout arm, and BOTH
 * `resolveSharedRefs` and `localizePage` then run over the SNAPSHOT. A section
 * dropped from the live page but surviving in a bound snapshot was therefore
 * invisible to `listPagesUsingSharedSection` and to the language-settings
 * scans — while still reaching the public. Proven twice, anonymously, with the
 * gate ON (`test/cms-bound-snapshot-delivery.test.ts`).
 *
 * RUNNING only, deliberately: a draft or stopped experiment serves nobody, and
 * including it would refuse edits that reach no reader — the over-refusal half
 * of the same mistake (§C9 F2). The cost of that choice is that STARTING an
 * experiment enlarges this set, so `startExperiment` re-checks the gate for the
 * same reason it re-checks the snapshot's review stamp.
 *
 * Bounded: ≤1 running experiment per page × `MAX.variants` snapshot reads.
 */
export async function deliverableSectionsForPage(page: Page): Promise<Section[]> {
  const out = [...page.sections];
  // Only a PUBLISHED page has an experiment delivery lane — `publicPageBySlug`
  // reaches the variant path through `getPublishedBySlug`, which is
  // published-only. An in_review page's snapshots serve nobody.
  if (page.status !== 'published') return out;
  const running = await findRunningExperiment(page.tenantId, page.orgId, page.pageId);
  if (!running) return out;
  for (const v of running.variants) {
    if (!v.versionId) continue; // the holdout serves the live page
    const version = await getVersion(page.tenantId, page.orgId, page.pageId, v.versionId);
    if (version) out.push(...version.snapshot.sections);
  }
  return out;
}

export async function listPagesUsingSharedSection(tenantId: string, orgId: string, sharedSectionId: string): Promise<Array<{ pageId: string; title: string; slug: string; status: PageStatus }>> {
  const all = await listPages(tenantId, orgId);
  const out: Array<{ pageId: string; title: string; slug: string; status: PageStatus }> = [];
  for (const p of all) {
    // §C9 F1 — the DELIVERABLE sections, not merely the live ones.
    const sections = await deliverableSectionsForPage(p);
    if (sections.some((s) => s.ref?.sharedSectionId === sharedSectionId)) {
      out.push({ pageId: p.pageId, title: p.title, slug: p.slug, status: p.status });
    }
  }
  return out;
}

/** Delete a shared section — 409 while any page still references it (the
 *  reference would dangle; delivery drops dangling refs but the editor must
 *  clean up deliberately). */
export async function deleteSharedSection(tenantId: string, orgId: string, sharedSectionId: string): Promise<boolean> {
  const cur = await getSharedSection(tenantId, orgId, sharedSectionId);
  if (!cur) return false;
  const used = await listPagesUsingSharedSection(tenantId, orgId, sharedSectionId);
  if (used.length > 0) {
    throw new OpenwopError('conflict', `Shared section is referenced by ${used.length} page(s) — detach or remove those sections first.`, 409, { pages: used.map((p) => p.pageId) });
  }
  await sharedSections.delete(sharedSectionId);
  return true;
}

/**
 * Resolve `Section.ref` references into concrete content for DELIVERY (the
 * editor keeps raw refs). A dangling ref (shared section deleted) is DROPPED
 * from delivery — never rendered empty. Type comes from the shared row (the
 * source of truth; the ref section's own `type` is a hint for the editor).
 */
export async function resolveSharedRefs(page: Page): Promise<Page> {
  if (!page.sections.some((s) => s.ref)) return page;
  const resolved: Section[] = [];
  for (const s of page.sections) {
    if (!s.ref) { resolved.push(s); continue; }
    const shared = await getSharedSection(page.tenantId, page.orgId, s.ref.sharedSectionId);
    if (!shared) continue; // dangling — drop from delivery
    resolved.push({
      sectionId: s.sectionId,
      type: shared.type,
      data: shared.data,
      ...(shared.localizations ? { localizations: shared.localizations } : {}),
    });
  }
  return { ...page, sections: resolved };
}

// ── Scheduled publishing (ADR 0204 C2) ──────────────────────────────────────

/** Set (or replace) a page's one-shot scheduled publish time. Caller (route)
 *  enforces admin scope + the approval-gate 409; here we validate the page is
 *  in a publishable status and the time parses to the future. */
export async function setScheduledPublish(tenantId: string, orgId: string, pageId: string, atIso: string, actor: string): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (p.status !== 'draft' && p.status !== 'in_review') {
    throw new OpenwopError('validation_error', `Cannot schedule a page in status \`${p.status}\` — only draft/in_review pages can be scheduled.`, 409, { status: p.status });
  }
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new OpenwopError('validation_error', 'Invalid `at` — expected an ISO-8601 timestamp.', 400, { at: atIso });
  if (at <= Date.now()) throw new OpenwopError('validation_error', '`at` must be in the future.', 400, { at: atIso });
  const next: Page = { ...p, scheduledPublishAt: new Date(at).toISOString(), updatedBy: actor, updatedAt: nowIso() };
  await pages.put(next);
  // ADR 0408 — the sweep reads MARKERS, never the page store (see the sweep).
  await scheduledMarkers.put({ pageId: next.pageId, tenantId, orgId, at: next.scheduledPublishAt ?? '' });
  recordCmsAction('schedule', next, actor, { scheduledPublishAt: next.scheduledPublishAt });
  return next;
}

/** Cancel a pending scheduled publish (or record a sweep skip — `reason`). */
export async function clearScheduledPublish(tenantId: string, orgId: string, pageId: string, actor: string, reason = 'cancelled'): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (!p.scheduledPublishAt) return p;
  const next: Page = { ...p, updatedBy: actor, updatedAt: nowIso() };
  delete next.scheduledPublishAt;
  await pages.put(next);
  await scheduledMarkers.delete(next.pageId);
  recordCmsAction('schedule-cleared', next, actor, { reason });
  return next;
}

/** Pages whose scheduled publish time has passed and are still publishable —
 *  the sweep's work list. ADR 0408: reads the tiny `cms:scheduled` MARKER set
 *  (never a page scan — cheaper than the pre-kernel cross-tenant scan);
 *  stale markers (page gone / schedule cleared out-of-band) self-heal here. */
export async function listScheduledDuePages(nowIso_: string): Promise<Page[]> {
  const due = (await scheduledMarkers.list()).filter((m) => m.at <= nowIso_);
  const out: Page[] = [];
  for (const m of due) {
    const p = await getPage(m.tenantId, m.orgId, m.pageId);
    if (p && p.scheduledPublishAt && p.scheduledPublishAt <= nowIso_ && (p.status === 'draft' || p.status === 'in_review')) {
      out.push(p);
    } else {
      await scheduledMarkers.delete(m.pageId); // self-heal
    }
  }
  return out;
}

// ── Scheduled unpublish (ADR 0204 C2b — embargo end) ────────────────────────

/** Set (or replace) a page's one-shot scheduled UNPUBLISH time. Legal while
 *  the page is `published`, or while a publish schedule is pending (the
 *  embargo pair, in which case the unpublish must be strictly later). The
 *  approval gate deliberately does NOT apply here: the gate protects the
 *  PUBLISH direction (content going public); unpublishing removes content —
 *  the fail-safe direction (Contentful/Sanity likewise leave it ungated). */
export async function setScheduledUnpublish(tenantId: string, orgId: string, pageId: string, atIso: string, actor: string): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  const pairedWithPendingPublish = (p.status === 'draft' || p.status === 'in_review') && Boolean(p.scheduledPublishAt);
  if (p.status !== 'published' && !pairedWithPendingPublish) {
    throw new OpenwopError('validation_error', `Cannot schedule an unpublish for a page in status \`${p.status}\` — the page must be published, or have a pending scheduled publish.`, 409, { status: p.status });
  }
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new OpenwopError('validation_error', 'Invalid `at` — expected an ISO-8601 timestamp.', 400, { at: atIso });
  if (at <= Date.now()) throw new OpenwopError('validation_error', '`at` must be in the future.', 400, { at: atIso });
  const iso = new Date(at).toISOString();
  if (pairedWithPendingPublish && p.scheduledPublishAt && iso <= p.scheduledPublishAt) {
    throw new OpenwopError('validation_error', 'The unpublish time must be after the scheduled publish time.', 400, { at: iso, scheduledPublishAt: p.scheduledPublishAt });
  }
  const next: Page = { ...p, scheduledUnpublishAt: iso, updatedBy: actor, updatedAt: nowIso() };
  await pages.put(next);
  await scheduledUnpublishMarkers.put({ pageId: next.pageId, tenantId, orgId, at: iso });
  recordCmsAction('schedule-unpublish', next, actor, { scheduledUnpublishAt: iso });
  return next;
}

/** Cancel a pending scheduled unpublish (or record a sweep skip — `reason`). */
export async function clearScheduledUnpublish(tenantId: string, orgId: string, pageId: string, actor: string, reason = 'cancelled'): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  if (!p.scheduledUnpublishAt) return p;
  const next: Page = { ...p, updatedBy: actor, updatedAt: nowIso() };
  delete next.scheduledUnpublishAt;
  await pages.put(next);
  await scheduledUnpublishMarkers.delete(next.pageId);
  recordCmsAction('schedule-unpublish-cleared', next, actor, { reason });
  return next;
}

/** Pages whose scheduled unpublish time has passed and are still PUBLISHED —
 *  the unpublish lane's work list. The fire guard is `published` ONLY: an
 *  archived page is legal for a MANUAL unpublish but a scheduled one firing
 *  there would yank it to draft as a surprise — such markers self-heal with
 *  the schedule cleared out-of-band (the sweep audits the skip). */
export async function listScheduledDueUnpublishPages(nowIso_: string): Promise<Page[]> {
  const due = (await scheduledUnpublishMarkers.list()).filter((m) => m.at <= nowIso_);
  const out: Page[] = [];
  for (const m of due) {
    const p = await getPage(m.tenantId, m.orgId, m.pageId);
    if (p && p.scheduledUnpublishAt && p.scheduledUnpublishAt <= nowIso_ && p.status === 'published') {
      out.push(p);
    } else if (p && p.scheduledUnpublishAt && p.scheduledUnpublishAt <= nowIso_) {
      // Due but NOT published (e.g. the pair's publish was cancelled and the
      // page never went live): clear BOTH field and marker with an audit —
      // deleting only the marker would strand a forever-"pending" schedule
      // the page still displays and no lane will ever fire.
      await clearScheduledUnpublish(m.tenantId, m.orgId, m.pageId, 'system:cms-scheduler', 'not-published');
    } else {
      await scheduledUnpublishMarkers.delete(m.pageId); // stale marker — self-heal
    }
  }
  return out;
}

/** Resolve a slug to a PUBLISHED page, following at most one redirect hop. Drafts
 *  / in-review / archived pages are invisible by slug. */
export async function getPublishedBySlug(tenantId: string, orgId: string, slug: string): Promise<{ page: Page; redirectedFrom?: string } | null> {
  const all = await listPages(tenantId, orgId);
  const direct = all.find((p) => p.slug === slug && p.status === 'published');
  // ADR 0204 C4 — the ONE delivery chokepoint resolves shared-section refs
  // (every published read routes through here: cms by-slug, publishing public
  // page, /v1/content, the workflow surface's getPage).
  if (direct) return { page: await resolveSharedRefs(direct) };
  const redirect = (await redirects.list()).find((r) => r.tenantId === tenantId && r.orgId === orgId && r.fromSlug === slug);
  if (redirect) {
    const target = all.find((p) => p.slug === redirect.toSlug && p.status === 'published');
    if (target) return { page: await resolveSharedRefs(target), redirectedFrom: slug };
  }
  return null;
}

// ── Content language settings + localized delivery (ADR 0064) ───────────────
//
// ADR 0406 Phase 1 (the ADR 0408 parity seam): the settings model + store
// moved to core `host/contentLocales.ts` so cms and entities consume ONE
// locale truth per org. The collection name (`cms:langsettings`) and every
// symbol are unchanged — this re-export keeps all consumers and the wire
// byte-identical; cms remains the management ROUTE surface.
import {
  getContentLanguageSettings,
  updateContentLanguageSettings,
  __resetContentLocales,
  type ContentLanguageSettings,
} from '../../host/contentLocales.js';
export { getContentLanguageSettings, updateContentLanguageSettings, type ContentLanguageSettings };

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
  // ADR 0205 D2 — a locale explicitly held in `'draft'` is withheld from
  // delivery: it is removed from the negotiable set AND its overlays are
  // stripped before resolution, so requests fall through the existing RFC 0103
  // chain (family → base). Absent state = published (backward compatible).
  const state = page.localePublishState ?? {};
  const deliverable = settings.supportedLocales.filter((l) => state[l] !== 'draft');
  const supported = [settings.baseLocale, ...deliverable];
  const locale = supported.length > 1
    ? negotiateLocale(acceptLanguage, supported, settings.baseLocale)
    : settings.baseLocale;
  const withheld = settings.supportedLocales.filter((l) => state[l] === 'draft');
  const sections: DeliverySection[] = page.sections.map((s) => {
    let source = s;
    if (withheld.length > 0 && s.localizations) {
      const loc = { ...s.localizations };
      for (const l of withheld) delete loc[l];
      source = { ...s, ...(Object.keys(loc).length > 0 ? { localizations: loc } : {}) };
      if (Object.keys(loc).length === 0) delete source.localizations;
    }
    return {
      sectionId: s.sectionId,
      type: s.type,
      data: resolveSection(source, locale, settings.baseLocale),
    };
  });
  return { page: { ...page, sections }, locale };
}

/** Flip one locale's publish state (ADR 0205 D2). Admin-tier at the route;
 *  only configured supported locales are addressable. */
export async function setLocalePublishState(
  tenantId: string,
  orgId: string,
  pageId: string,
  locale: string,
  state: 'draft' | 'published',
  actor: string,
): Promise<Page | null> {
  const p = await getPage(tenantId, orgId, pageId);
  if (!p) return null;
  const settings = await getContentLanguageSettings(tenantId, orgId);
  // ADR 0593 §C8 (adversarial review F3) — the "configured locale" precondition
  // applies to the RELEASE direction only. It used to apply to both, and that
  // made the §C2 widening refusal a gate with no PRACTICAL exit: the safe way
  // to add a locale is to withhold it per page FIRST and then release each page
  // through the already-gated publish route — but withholding an unconfigured
  // locale 400'd, and adding it was refused because it was not withheld. A
  // perfect circle, whose only remaining exit was unpublishing every live page
  // that held an overlay. Withholding removes content from delivery, so opening
  // it is the same fail-safe direction `unpublish` and the widening/narrowing
  // split already turn on.
  if (state === 'published' && !settings.supportedLocales.includes(locale)) {
    throw new OpenwopError('validation_error', `\`${locale}\` is not a configured translation locale for this org.`, 400, { locale });
  }
  if (!LOCALE_RE.test(locale) || locale === settings.baseLocale) {
    throw new OpenwopError('validation_error', `\`${locale}\` is not a valid non-base translation locale.`, 400, { locale });
  }
  // ADR 0593 (CMSA-8) — bump the version. This was the ONE page write outside
  // the version discipline, and therefore invisible to the approval pin: a
  // locale could be withheld or released while the page sat `in_review` and the
  // approve would never notice. Low-stakes (admin tier, delivery state rather
  // than content) but it is the same closed world the pin depends on, so it
  // joins it rather than being an exception a later reader has to rediscover.
  const next: Page = { ...p, updatedBy: actor, updatedAt: nowIso(), version: p.version + 1 };
  const map = { ...(p.localePublishState ?? {}) };
  if (state === 'published') delete map[locale]; // absent = published (compat)
  else map[locale] = 'draft';
  if (Object.keys(map).length > 0) next.localePublishState = map;
  else delete next.localePublishState;
  await pages.put(next);
  recordCmsAction('locale-publish-state', next, actor, { locale, state });
  return next;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetCms(): Promise<void> {
  await pages.__clear();
  await versions.__clear();
  await redirects.__clear();
  await __resetContentLocales();
  await sharedSections.__clear();
  await localeGrants.__clear();
}

/** R3 (UX_UPGRADE-content known-open) — subject erasure over the KERNEL-adapted
 *  page store (the legacy `cms:page` collection is read-dark; an eraser writing
 *  it would touch rows nothing reads — which is why this lives HERE, beside the
 *  adapter, not in a module with its own store handles). Anonymize-not-delete
 *  for org content; the subject's OWN locale grant is DELETED (an anonymized
 *  grant would still grant, to nobody auditable). */
export const ERASED_SUBJECT = 'erased:subject';

export async function eraseCmsSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!subjectKey) return { rowsTouched: 0 };
  // ADR 0592 §8 — match every subject-key FORM (raw `alice` + scoped
  // `user:alice`): the DSAR entry point accepts either, while cms rows store
  // the raw principal (the approvals eraser's subjectKeyForms discipline; a
  // scoped-vs-raw mismatch used to no-op silently).
  const { forms } = subjectKeyForms(subjectKey);
  const hit = (v: unknown): boolean => typeof v === 'string' && forms.has(v);
  let touched = 0;
  for (const p of await pages.listForTenant(tenantId)) {
    if (p.tenantId !== tenantId) continue;
    let next: Page | null = null;
    if (hit(p.authorId)) next = { ...(next ?? p), authorId: ERASED_SUBJECT };
    if (hit(p.createdBy)) next = { ...(next ?? p), createdBy: ERASED_SUBJECT };

    if (hit(p.updatedBy)) next = { ...(next ?? p), updatedBy: ERASED_SUBJECT };
    if (next) { await pages.put(next); touched += 1; }
  }
  for (const v of await versions.list()) {
    if (v.tenantId !== tenantId || !hit(v.publishedBy)) continue;
    await versions.put({ ...v, publishedBy: ERASED_SUBJECT });
    touched += 1;
  }
  for (const g of await localeGrants.list()) {
    if (g.tenantId !== tenantId) continue;
    if (hit(g.subject)) { await localeGrants.delete(g.grantId); touched += 1; continue; }

    if (hit(g.updatedBy)) { await localeGrants.put({ ...g, updatedBy: ERASED_SUBJECT }); touched += 1; }
  }
  // ADR 0592 §8 (CMSL-4) — the two stores the eraser NEVER enumerated:
  // shared-section attribution and the per-org language-settings operator
  // attribution (anonymize-not-delete, same as pages).
  for (const s of await sharedSections.list()) {
    if (s.tenantId !== tenantId) continue;
    let next: SharedSection | null = null;
    if (hit(s.createdBy)) next = { ...(next ?? s), createdBy: ERASED_SUBJECT };
    if (hit(s.updatedBy)) next = { ...(next ?? s), updatedBy: ERASED_SUBJECT };
    if (next) { await sharedSections.put(next); touched += 1; }
  }
  touched += await eraseContentLanguageSettingsSubject(tenantId, forms, ERASED_SUBJECT);
  // ADR 0592 §8 (CMSLWF-9) — page-experiment creator attribution (cms-owned
  // sibling store; call-time import keeps the module edge cycle-safe).
  touched += await erasePageExperimentSubject(tenantId, forms, ERASED_SUBJECT);
  log.info('cms_subject_erased', { tenantId, rows: touched });
  return { rowsTouched: touched };
}
