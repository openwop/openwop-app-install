/**
 * ADR 0824 D2 — real `<title>` / meta description for the seeded system-site
 * pages (home + the published marketing pages), written as ordinary
 * `PageSeo` records through `putSeo` — the same record an operator edits in the
 * CMS SEO panel, so the crawler prerender, the SPA's `applySeo`, the sitemap
 * and the RSS feed all read it from the one existing SSoT.
 *
 * Before this, no seed wrote a `PageSeo`, so every head fell back to the page
 * title ("Home") and the first hero subheading.
 *
 * Never-clobber, the seed-refresh rule every system-site seeder uses: a record
 * whose `updatedBy` is not the system actor was written by a person and is
 * left alone forever. A system-authored record is refreshed when this table
 * changes, keeping any other field it carries.
 *
 * Copy rules (ADR 0824 § Copy): the PROTOCOL is open source, this app is not —
 * never call the app open source; none of the gated assurance claims.
 */
import { createLogger } from '../observability/logger.js';
import { getPage } from '../features/cms/cmsService.js';
import { getSeo, putSeo } from '../features/publishing/publishingService.js';
import { ensureSystemSite, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from './systemSite.js';
import { ensureFeaturesPage } from './featuresPage.js';
import { ensureComparisonPage } from './comparisonPage.js';
import { ensureMarketingContentPages } from './marketingContentPages.js';

const log = createLogger('host.systemSiteSeo');
const SYSTEM_ACTOR = 'system';

export interface SystemPageSeo { metaTitle: string; metaDescription: string }

/** pageId → head copy. Titles ≤ 60 chars, descriptions ≈ 130–165 (test-pinned). */
export const SYSTEM_SITE_PAGE_SEO: Readonly<Record<string, SystemPageSeo>> = {
  'page:host-site-home': {
    metaTitle: 'OpenWOP — the reference app for multi-agent workflows',
    metaDescription: 'The reference app for OpenWOP, the open-source protocol for multi-agent workflow orchestration. Watch a workflow run, pause it for approval, rewind it. No sign-up.',
  },
  'page:host-site-about': {
    metaTitle: 'About the OpenWOP reference app',
    metaDescription: 'What the OpenWOP reference app is for: AI coworkers you own, workflows that replay step by step, and people approving what agents propose.',
  },
  'page:host-site-roadmap': {
    metaTitle: 'OpenWOP app roadmap: what ships next',
    metaDescription: 'What is coming next in the OpenWOP reference app, with evidence for what has shipped: faster starts, clearer handoffs to people, more connections.',
  },
  'page:host-site-changelog': {
    metaTitle: 'OpenWOP app changelog and release notes',
    metaDescription: 'Release notes for the OpenWOP reference app: the milestones actually deployed, newest first, not a feed of work still in progress.',
  },
  'page:host-site-support': {
    metaTitle: 'OpenWOP app support and help',
    metaDescription: 'Get help with the OpenWOP reference app: the quickstart, connecting provider keys safely, tracing a run, and where to ask about the OpenWOP protocol.',
  },
  'page:host-site-claude-code': {
    metaTitle: 'Use Claude Code from your OpenWOP workspace',
    metaDescription: 'Pair the Claude Code on your machine with your OpenWOP workspace. Use it from a chat tab, let it work with your to-dos, and answer its prompts from your phone.',
  },
  // ADR 0843 — seeded on the demo deployment only (marketingContentPages), so
  // the ensure below skips it wherever the page does not exist.
  'page:host-site-white-label': {
    metaTitle: 'Run the OpenWOP app under your own brand',
    metaDescription: 'Put your name, logo and colours on the OpenWOP reference app and run it on the cloud you choose, without forking it. Two films show how, and what you take on.',
  },
  'page:host-site-comparison': {
    metaTitle: 'How OpenWOP compares on workflow orchestration',
    metaDescription: 'A capability matrix comparing OpenWOP with prosumer automation, durable execution, data pipelines, AI-agent builders and enterprise BPM tools.',
  },
  'page:host-site-features': {
    metaTitle: 'OpenWOP app features: agents, workflows, approvals',
    metaDescription: 'Every feature in the OpenWOP reference app: AI coworkers and repeatable workflows in one reviewable workspace, with approvals, replay and add-ons.',
  },
};

async function doEnsure(): Promise<void> {
  // The pages must exist before their SEO can (putSeo 404s an absent page).
  // Each ensure is idempotent + concurrency-collapsed, so racing the boot
  // seeders that also call them is free.
  await Promise.allSettled([ensureSystemSite(), ensureFeaturesPage(), ensureComparisonPage(), ensureMarketingContentPages()]);
  for (const [pageId, want] of Object.entries(SYSTEM_SITE_PAGE_SEO)) {
    try {
      if (!(await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId))) continue;
      const have = await getSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId);
      if (have && have.updatedBy !== SYSTEM_ACTOR) continue; // a person wrote it — frozen
      if (have && have.metaTitle === want.metaTitle && have.metaDescription === want.metaDescription) continue;
      // putSeo REPLACES the record, so carry every other field a system record holds.
      const keep = have
        ? { ogTitle: have.ogTitle, ogDescription: have.ogDescription, ogImageToken: have.ogImageToken, canonicalUrl: have.canonicalUrl, noindex: have.noindex }
        : {};
      await putSeo(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, SYSTEM_ACTOR, { ...keep, ...want });
      log.info('system_site_seo_written', { pageId });
    } catch (err) {
      log.warn('system_site_seo_failed', { pageId, error: String(err) });
    }
  }
}

let ensuring: Promise<void> | null = null;

/** Idempotent, concurrency-collapsed boot ensure (the ensureSystemSite shape). */
export function ensureSystemSiteSeo(): Promise<void> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** Test-only: forget the collapsed promise so a fresh store re-runs the ensure. */
export function __resetSystemSiteSeoForTests(): void {
  ensuring = null;
}
