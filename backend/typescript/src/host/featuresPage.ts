/**
 * Features page (ADR 0027) — a public, HOST-GLOBAL CMS page documenting every
 * feature the app offers, authored in the same typed-section model as the system
 * home page and published at `/p/features`.
 *
 * It lives in the SAME reserved system-site org as the home page
 * ({@link SYSTEM_SITE_ORG} in a `host:`-prefixed tenant no real principal can
 * hold), so it is host-global (shared across the deployment, not per-tenant) and
 * editable only by the super-admin — never by org-scoped RBAC. This is NOT a
 * parallel page system: it is a real `cmsService` page, created + published
 * through the normal workflow, exactly like {@link ensureSystemSite}'s home page.
 *
 * Content lives in `seed-data/featurePages.json` (brand-authorable). Bump
 * {@link SEED_VERSION} after editing that file so a redeploy refreshes the live
 * page — but only while it has never been hand-edited in the CMS (a human edit
 * sets `updatedBy` off `system` and freezes the page).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import {
  createPage, getPage, listPages, transitionPage, updatePage,
  type Page, type Section,
} from '../features/cms/cmsService.js';
import { ensureSystemSite, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from './systemSite.js';
import featurePages from './seed-data/featurePages.json';

const log = createLogger('host.featuresPage');

/** Deterministic page id ⇒ idempotent seed even across a concurrent multi-instance
 *  first boot (no `features` + `features-2` duplicate). */
const FEATURES_PAGE_ID = 'page:host-site-features';
const FEATURES_SLUG = 'features';
const SYSTEM_ACTOR = 'system';
/** Bump when featurePages.json changes — a redeploy then refreshes the live page
 *  IF it has never been human-edited (see `doEnsure`). */
const SEED_VERSION = 4;

// ── Content model (the brand-authorable JSON shape) ─────────────────────────

interface FeatureEntry { name: string; tagline: string; appPath: string; icon?: string; optional?: boolean }
interface FeatureGroup { eyebrow: string; heading: string; lede?: string; features: FeatureEntry[] }
interface HeroData { eyebrow: string; heading: string; subheading: string; ctaLabel: string; ctaUrl: string; ctaLabel2?: string; ctaUrl2?: string }
interface AboutData { eyebrow: string; heading: string; body: string }
interface StepEntry { title: string; text: string }
interface HowItWorksData { eyebrow: string; heading: string; steps: StepEntry[] }
interface StatEntry { value: string; label: string }
interface CtaData { eyebrow: string; heading: string; subheading?: string; label: string; url: string }
interface FeaturePagesContent {
  title: string; slug: string; hero: HeroData; about?: AboutData;
  howItWorks?: HowItWorksData; groups: FeatureGroup[]; stats?: StatEntry[]; cta: CtaData;
}

const content = featurePages as unknown as FeaturePagesContent;

/** One feature → one `columns` card. The whole card is a link (`href` =
 *  appPath); the renderer wraps it in a single <Link>. `optional` renders as a
 *  badge; `icon` is a slug the renderer maps to a per-feature glyph (ADR 0027,
 *  ICON_BY_SLUG) and falls back to the node motif when absent/unknown. The card
 *  text is the plain tagline — NO inline link (avoids a nested <a> in the card). */
function cardOf(f: FeatureEntry): { title: string; text: string; href: string; icon?: string; optional?: boolean } {
  return {
    title: f.name, text: f.tagline, href: f.appPath,
    ...(f.icon ? { icon: f.icon } : {}),
    ...(f.optional ? { optional: true } : {}),
  };
}

/** Build the typed sections that orient a first-time visitor before the full
 *  catalog (ADR 0027): hero → "what is it" (richText) → "how it works" (numbered
 *  steps) → one cards section per group (each with a one-line `lede`) → a stats
 *  reassurance band → closing CTA. All section types are already styled (`.fp-*`,
 *  shared with the home page). Known-valid (static, in-repo). */
function buildSections(): Section[] {
  const sections: Section[] = [
    { sectionId: 'f-hero', type: 'hero', data: { ...content.hero } },
  ];
  if (content.about) {
    sections.push({
      sectionId: 'f-about',
      type: 'richText',
      data: { eyebrow: content.about.eyebrow, heading: content.about.heading, text: content.about.body },
    });
  }
  if (content.howItWorks) {
    sections.push({
      sectionId: 'f-how',
      type: 'columns',
      data: {
        eyebrow: content.howItWorks.eyebrow,
        heading: content.howItWorks.heading,
        layout: 'steps',
        columns: content.howItWorks.steps.map((s) => ({ title: s.title, text: s.text })),
      },
    });
  }
  content.groups.forEach((g, i) => {
    sections.push({
      sectionId: `f-grp-${i}`,
      type: 'columns',
      data: {
        eyebrow: g.eyebrow,
        heading: g.heading,
        ...(g.lede ? { lede: g.lede } : {}),
        layout: 'cards',
        columns: g.features.map(cardOf),
      },
    });
  });
  if (content.stats && content.stats.length > 0) {
    sections.push({
      sectionId: 'f-stats',
      type: 'columns',
      data: { layout: 'stats', columns: content.stats.map((s) => ({ title: s.value, text: s.label })) },
    });
  }
  sections.push({ sectionId: 'f-cta', type: 'cta', data: { ...content.cta } });
  return sections;
}

const FEATURE_SECTIONS: Section[] = buildSections();

const seedMarker = new DurableCollection<{ id: 'seed'; version: number }>('features-page-seed', (m) => m.id);

let ensuring: Promise<Page> | null = null;

async function findFeaturesPage(): Promise<Page | null> {
  const pages = await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
  return pages.find((p) => p.slug === FEATURES_SLUG) ?? null;
}

/** Apply the latest sections to the live page + republish (system authority),
 *  keeping `updatedBy = system` so the page stays "unedited". Mirrors
 *  systemSite.applyDefault: self-heals on a mid-sequence storage error (left
 *  draft → next ensure re-publishes). */
async function applyDefault(): Promise<void> {
  const p = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, FEATURES_PAGE_ID);
  if (!p) return;
  if (p.status === 'published' || p.status === 'archived') {
    await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, FEATURES_PAGE_ID, 'unpublish', SYSTEM_ACTOR);
  }
  await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, FEATURES_PAGE_ID, { title: content.title, sections: FEATURE_SECTIONS }, SYSTEM_ACTOR);
  await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, FEATURES_PAGE_ID, 'publish', SYSTEM_ACTOR);
}

async function doEnsure(): Promise<Page> {
  // The reserved system-site org must exist first (idempotent; shared with the home page).
  await ensureSystemSite();

  let page = await findFeaturesPage();
  if (!page) {
    page = await createPage({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: FEATURES_PAGE_ID,
      title: content.title, slug: FEATURES_SLUG, sections: FEATURE_SECTIONS, createdBy: SYSTEM_ACTOR,
    });
    const published = await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, page.pageId, 'publish', SYSTEM_ACTOR);
    page = published ?? page;
    await seedMarker.put({ id: 'seed', version: SEED_VERSION });
    log.info('features_page_seeded', { pageId: page.pageId, seedVersion: SEED_VERSION });
  } else if (page.updatedBy === SYSTEM_ACTOR) {
    // Refresh the built-in content on a redeploy with a newer SEED_VERSION — but
    // only while a human has never edited it (a real edit freezes the page).
    const marker = await seedMarker.get('seed');
    if (marker?.version !== SEED_VERSION) {
      await applyDefault();
      await seedMarker.put({ id: 'seed', version: SEED_VERSION });
      log.info('features_page_refreshed', { from: marker?.version ?? null, to: SEED_VERSION });
    }
  }
  return page;
}

/** Ensure the host-global published Features page exists (idempotent). */
export function ensureFeaturesPage(): Promise<Page> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** The current Features page, or null when absent (drives the dashboard count). */
export async function getFeaturesPage(): Promise<Page | null> {
  return findFeaturesPage();
}
