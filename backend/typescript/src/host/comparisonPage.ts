/**
 * Comparison page (ADR 0485) — a public, HOST-GLOBAL CMS page presenting a
 * capability comparison matrix across the competitive workflow-orchestration
 * landscape, authored in the same typed-section model as the Features page and
 * published at `/p/compare`.
 *
 * It lives in the SAME reserved system-site org as the home + features pages
 * ({@link SYSTEM_SITE_ORG} in a `host:`-prefixed tenant no real principal can
 * hold), so it is host-global (shared across the deployment, not per-tenant) and
 * editable only by the super-admin. This is NOT a parallel page system: it is a
 * real `cmsService` page, created + published through the normal workflow,
 * exactly like {@link ensureFeaturesPage}.
 *
 * The matrix rides a first-class `comparison` section type (ADR 0485) — cells are
 * short authored status tokens the renderer treats as text (no HTML, no live
 * references). Content lives in `seed-data/comparisonPage.json` (brand-authorable).
 * Bump {@link SEED_VERSION} after editing that file so a redeploy refreshes the
 * live page — but only while it has never been hand-edited in the CMS (a human
 * edit sets `updatedBy` off `system` and freezes the page).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import {
  createPage, getPage, listPages, transitionPage, updatePage,
  type Page, type Section,
} from '../features/cms/cmsService.js';
import { ensureSystemSite, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from './systemSite.js';
import comparisonPage from './seed-data/comparisonPage.json';

const log = createLogger('host.comparisonPage');

/** Deterministic page id ⇒ idempotent seed even across a concurrent multi-instance
 *  first boot (no `compare` + `compare-2` duplicate). */
const COMPARISON_PAGE_ID = 'page:host-site-comparison';
const COMPARISON_SLUG = 'compare';
const SYSTEM_ACTOR = 'system';
/** Bump when comparisonPage.json changes — a redeploy then refreshes the live
 *  page IF it has never been human-edited (see `doEnsure`). */
const SEED_VERSION = 1;

// ── Content model (the brand-authorable JSON shape) ─────────────────────────

interface HeroData { eyebrow?: string; heading: string; subheading?: string; ctaLabel?: string; ctaUrl?: string; ctaLabel2?: string; ctaUrl2?: string }
interface RichData { eyebrow?: string; heading?: string; body: string }
interface MatrixRow { label: string; cells: string[] }
interface MatrixData {
  eyebrow?: string; heading?: string; lede?: string; legend?: string; note?: string;
  columns: string[]; rows: MatrixRow[]; highlightColumn?: number;
}
interface CtaData { eyebrow?: string; heading?: string; subheading?: string; label: string; url: string }
interface ComparisonPageContent {
  title: string; slug: string; hero: HeroData; intro?: RichData;
  matrix: MatrixData; outro?: RichData; cta: CtaData;
}

const content = comparisonPage as unknown as ComparisonPageContent;

/** Build the typed sections (ADR 0485): hero → intro (richText) → the capability
 *  matrix (comparison) → a closing through-line (richText) → CTA. Known-valid
 *  (static, in-repo); the `comparison` cells are authored short status tokens. */
function buildSections(): Section[] {
  const sections: Section[] = [
    { sectionId: 'c-hero', type: 'hero', data: { ...content.hero } },
  ];
  if (content.intro) {
    sections.push({
      sectionId: 'c-intro',
      type: 'richText',
      data: { eyebrow: content.intro.eyebrow, heading: content.intro.heading, text: content.intro.body },
    });
  }
  sections.push({
    sectionId: 'c-matrix',
    type: 'comparison',
    data: {
      ...(content.matrix.eyebrow ? { eyebrow: content.matrix.eyebrow } : {}),
      ...(content.matrix.heading ? { heading: content.matrix.heading } : {}),
      ...(content.matrix.lede ? { lede: content.matrix.lede } : {}),
      ...(content.matrix.legend ? { legend: content.matrix.legend } : {}),
      ...(content.matrix.note ? { note: content.matrix.note } : {}),
      columns: content.matrix.columns,
      rows: content.matrix.rows,
      ...(content.matrix.highlightColumn !== undefined ? { highlightColumn: content.matrix.highlightColumn } : {}),
    },
  });
  if (content.outro) {
    sections.push({
      sectionId: 'c-outro',
      type: 'richText',
      data: { eyebrow: content.outro.eyebrow, heading: content.outro.heading, text: content.outro.body },
    });
  }
  sections.push({ sectionId: 'c-cta', type: 'cta', data: { ...content.cta } });
  return sections;
}

const COMPARISON_SECTIONS: Section[] = buildSections();

const seedMarker = new DurableCollection<{ id: 'seed'; version: number }>('comparison-page-seed', (m) => m.id);

let ensuring: Promise<Page> | null = null;

async function findComparisonPage(): Promise<Page | null> {
  const pages = await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
  return pages.find((p) => p.slug === COMPARISON_SLUG) ?? null;
}

/** Apply the latest sections to the live page + republish (system authority),
 *  keeping `updatedBy = system` so the page stays "unedited". Mirrors
 *  featuresPage.applyDefault: self-heals on a mid-sequence storage error (left
 *  draft → next ensure re-publishes). */
async function applyDefault(): Promise<void> {
  const p = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, COMPARISON_PAGE_ID);
  if (!p) return;
  if (p.status === 'published' || p.status === 'archived') {
    await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, COMPARISON_PAGE_ID, 'unpublish', SYSTEM_ACTOR);
  }
  await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, COMPARISON_PAGE_ID, { title: content.title, sections: COMPARISON_SECTIONS }, SYSTEM_ACTOR);
  await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, COMPARISON_PAGE_ID, 'publish', SYSTEM_ACTOR);
}

async function doEnsure(): Promise<Page> {
  // The reserved system-site org must exist first (idempotent; shared with the home + features pages).
  await ensureSystemSite();

  let page = await findComparisonPage();
  if (!page) {
    page = await createPage({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: COMPARISON_PAGE_ID,
      title: content.title, slug: COMPARISON_SLUG, sections: COMPARISON_SECTIONS, createdBy: SYSTEM_ACTOR,
    });
    const published = await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, page.pageId, 'publish', SYSTEM_ACTOR);
    page = published ?? page;
    await seedMarker.put({ id: 'seed', version: SEED_VERSION });
    log.info('comparison_page_seeded', { pageId: page.pageId, seedVersion: SEED_VERSION });
  } else if (page.updatedBy === SYSTEM_ACTOR) {
    // Refresh the built-in content on a redeploy with a newer SEED_VERSION — but
    // only while a human has never edited it (a real edit freezes the page).
    const marker = await seedMarker.get('seed');
    if (marker?.version !== SEED_VERSION) {
      await applyDefault();
      await seedMarker.put({ id: 'seed', version: SEED_VERSION });
      log.info('comparison_page_refreshed', { from: marker?.version ?? null, to: SEED_VERSION });
    }
  }
  return page;
}

/** Ensure the host-global published Comparison page exists (idempotent). */
export function ensureComparisonPage(): Promise<Page> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** The current Comparison page, or null when absent (drives the dashboard count). */
export async function getComparisonPage(): Promise<Page | null> {
  return findComparisonPage();
}
