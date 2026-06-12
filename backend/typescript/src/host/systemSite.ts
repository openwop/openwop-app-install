/**
 * System site (ADR 0027) — the host-level homepage, modeled the MyndHyve way: a
 * GLOBAL page edited by the host-level role (super admin), NOT by tenant
 * membership. MyndHyve keeps the homepage in a global `cms_pages/home` (no
 * `ownerId`) gated by `isSuperAdmin()`; openwop-app's CMS is org-scoped, so the
 * equivalent is a RESERVED org in a reserved tenant that no real principal can
 * ever hold (`host:`-prefixed), holding a normal CMS page.
 *
 * This is NOT a parallel page system: the page is a real `cmsService` page in a
 * real `accessControl` org — both primitives are instantiated, not shadowed. The
 * only new thing is the AUTHORITY: super-admin (host-level) instead of org-scoped
 * RBAC (`requireOrgScope`), which stays untouched for every real tenant. The
 * reserved tenant is unreachable by auth, so the page is invisible to and
 * uneditable by normal callers — only the super-admin `/site-page` route reaches
 * it.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { getOrg, createOrg } from './accessControlService.js';
import {
  createPage, getPage, listPages, transitionPage, updatePage, validateSections,
  type Page, type Section,
} from '../features/cms/cmsService.js';

const log = createLogger('host.systemSite');

/** Reserved ids. `host:` is a tenant prefix no auth path mints (users get
 *  `user:` / `anon:` / `ws:`), so this org is invisible to every real caller. */
export const SYSTEM_SITE_TENANT = 'host:site';
export const SYSTEM_SITE_ORG = 'host-site';
export const SYSTEM_SITE_SLUG = 'home';
/** Deterministic page id ⇒ the seed is idempotent even across a concurrent
 *  multi-instance first boot (no `home` + `home-2` duplicate). */
const SYSTEM_SITE_PAGE_ID = 'page:host-site-home';
const SYSTEM_ACTOR = 'system';
/** Bump when DEFAULT_SECTIONS changes — a redeploy then refreshes the live page
 *  IF it has never been human-edited (see `doEnsure`). */
const SEED_VERSION = 4;

/**
 * The built-in default home page (ADR 0027) — a real, brand-aware marketing page
 * authored in the typed-section model, showcasing the app's capabilities. A super
 * admin edits it at Admin → Content → "Front page"; once edited, it is frozen
 * (this default never clobbers a human's edits).
 */
const DEFAULT_SECTIONS: Section[] = [
  { sectionId: 'd-hero', type: 'hero', data: {
    eyebrow: 'An open standard for AI agents & workflows',
    heading: 'AI coworkers that do real work — and stay yours.',
    subheading: 'OpenWOP is a live app *and* an open standard. Build AI agents and automated workflows that handle real tasks, then run them anywhere — because what you build is portable, not locked to one vendor.',
    ctaLabel: 'Try the live demo', ctaUrl: '/chat',
    ctaLabel2: 'See the open standard', ctaUrl2: 'https://openwop.dev',
  } },
  { sectionId: 'd-life', type: 'columns', data: {
    eyebrow: 'How it works', heading: 'Build it. Run it. Stay in control.', layout: 'steps',
    columns: [
      { title: 'Build', text: 'Design an agent or a workflow on a visual canvas — drag, connect, done. Or start from a ready-made template and make it your own.' },
      { title: 'Run', text: 'Watch it work in real time. Every run is repeatable and reviewable, so you can always see exactly what happened — and run it again if you need to.' },
      { title: 'Stay in control', text: 'You decide what agents do on their own and what needs your sign-off. Approvals, a full activity trail, and your own keys for connected apps are all built in.' },
    ],
  } },
  { sectionId: 'd-platform', type: 'columns', data: {
    eyebrow: 'What’s inside', heading: 'A real product, ready to use.', layout: 'cards',
    columns: [
      { title: 'AI Agents', text: 'Named AI coworkers — like Sally in Sales or Marcus in Support — each with its own tasks, schedule, and to-do board.' },
      { title: 'Workflow Builder', text: 'A visual, drag-and-drop canvas for multi-step automations: branch, route, and run steps side by side.' },
      { title: 'Knowledge Base', text: 'Give your agents a memory. Upload documents and they answer with cited sources you can check.' },
      { title: 'Executive Assistant', text: 'A chief-of-staff agent that tracks your commitments and drafts emails and tasks for your approval.' },
      { title: 'CRM & Forms', text: 'Track contacts, companies, and deals — with public forms that drop new leads straight into your pipeline.' },
      { title: 'Pages & Publishing', text: 'A page builder and public website with search-engine basics handled for you. (This very page was made with it.)' },
      { title: 'Connections', text: 'Securely link Google, Slack, Zoom and more. Your credentials stay encrypted and under your control.' },
      { title: 'Analytics & Email', text: 'See how your pages perform and run email campaigns — with privacy consent handled automatically.' },
    ],
  } },
  { sectionId: 'd-protocol', type: 'richText', data: {
    eyebrow: 'The open standard', heading: 'Build it once. Run it anywhere.',
    text: 'Most AI tools lock your work inside one platform. OpenWOP takes the opposite approach: it’s an **open standard** — like email or the web — that any provider can support.\n\nSo the agents and workflows you create aren’t trapped here. They run the same way on any compatible service, your data and credentials stay yours, and you’re free to move or self-host without starting over. This app is the open, working reference that proves it. Read the full standard at [openwop.dev](https://openwop.dev).',
  } },
  { sectionId: 'd-stats', type: 'columns', data: {
    layout: 'stats',
    columns: [
      { title: 'Open', text: 'standard — no lock-in' },
      { title: '30+', text: 'features, built in' },
      { title: 'Yours', text: 'data, agents & keys' },
      { title: 'Live', text: 'try the real app now' },
    ],
  } },
  { sectionId: 'd-trust', type: 'columns', data: {
    eyebrow: 'Ready for teams', heading: 'Built for real organizations.', layout: 'cards',
    columns: [
      { title: 'Sign-in your way', text: 'Email and two-factor, plus single sign-on with Okta or Microsoft — your team signs in the way it already does.' },
      { title: 'Roles & workspaces', text: 'Invite teammates with the right level of access — owner, admin, editor, or viewer — across shared workspaces.' },
      { title: 'Privacy built in', text: 'Consent handled by region, and full data deletion on request — privacy is part of the design, not an add-on.' },
      { title: 'Your keys, your control', text: 'Credentials for connected apps are encrypted and never leave the host — never logged, never shared.' },
    ],
  } },
  { sectionId: 'd-cta', type: 'cta', data: {
    eyebrow: 'Get started',
    heading: 'See it for yourself.',
    subheading: 'Explore the live app — no setup required — or read the open standard behind it.',
    label: 'Open the live demo →', url: '/chat',
  } },
];

export interface SystemSite { tenantId: string; orgId: string; pageId: string; slug: string }

const seedMarker = new DurableCollection<{ id: 'seed'; version: number }>('system-site-seed', (m) => m.id);

/** Run-once-per-process: dedupes concurrent callers within an instance (the
 *  common race). A cross-instance first-boot race is benign — the fixed org id
 *  upserts, and a duplicate draft page would never be the published one. */
let ensuring: Promise<SystemSite> | null = null;

async function findHomePage(): Promise<Page | null> {
  const pages = await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
  return pages.find((p) => p.slug === SYSTEM_SITE_SLUG) ?? null;
}

/** Apply DEFAULT_SECTIONS to the live page + republish (system authority). Keeps
 *  `updatedBy = system` so the page stays "unedited". Unlike `editSystemHomePage`,
 *  this skips a validate-before-unpublish step because DEFAULT_SECTIONS is static,
 *  in-repo, and known-valid — it cannot fail `validateSections`. The only failure
 *  mode is a storage error mid-sequence, which self-heals: the page is left
 *  `draft` and the next `doEnsure` (same SEED_VERSION mismatch) re-publishes it. */
async function applyDefault(): Promise<void> {
  const p = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID);
  if (!p) return;
  if (p.status === 'published' || p.status === 'archived') {
    await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID, 'unpublish', SYSTEM_ACTOR);
  }
  await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID, { title: 'Home', sections: DEFAULT_SECTIONS }, SYSTEM_ACTOR);
  await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID, 'publish', SYSTEM_ACTOR);
}

async function doEnsure(): Promise<SystemSite> {
  // 1. The reserved org (fixed id ⇒ idempotent upsert; no owner member — host-level).
  if (!(await getOrg(SYSTEM_SITE_ORG))) {
    await createOrg({ tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, createdBy: SYSTEM_ACTOR, name: 'OpenWOP Site' });
    log.info('system_site_org_created', { orgId: SYSTEM_SITE_ORG });
  }
  // 2. The home page (seeded + published) if absent.
  let page = await findHomePage();
  if (!page) {
    page = await createPage({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: SYSTEM_SITE_PAGE_ID,
      title: 'Home', slug: SYSTEM_SITE_SLUG, sections: DEFAULT_SECTIONS, createdBy: SYSTEM_ACTOR,
    });
    const published = await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, page.pageId, 'publish', SYSTEM_ACTOR);
    page = published ?? page;
    await seedMarker.put({ id: 'seed', version: SEED_VERSION });
    log.info('system_site_home_seeded', { pageId: page.pageId, seedVersion: SEED_VERSION });
  } else if (page.updatedBy === SYSTEM_ACTOR) {
    // 3. Refresh the built-in default on a redeploy with newer seed content —
    //    BUT only while the page has never been human-edited (a real edit sets
    //    updatedBy to the super-admin principal and freezes the page forever).
    const marker = await seedMarker.get('seed');
    if (marker?.version !== SEED_VERSION) {
      await applyDefault();
      await seedMarker.put({ id: 'seed', version: SEED_VERSION });
      log.info('system_site_default_refreshed', { from: marker?.version ?? null, to: SEED_VERSION });
    }
  }
  return { tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: SYSTEM_SITE_PAGE_ID, slug: SYSTEM_SITE_SLUG };
}

/** Ensure the reserved system site org + a published home page exist (idempotent). */
export function ensureSystemSite(): Promise<SystemSite> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** The current system home page (draft working copy — what the editor shows). */
export async function getSystemHomePage(): Promise<Page> {
  const site = await ensureSystemSite();
  const page = await getPage(site.tenantId, site.orgId, site.pageId);
  if (!page) throw new Error('system home page missing after ensure');
  return page;
}

/**
 * Host-level edit of the system home page (super-admin authority; callers gate).
 * Edits the LIVE page and re-publishes so changes go public immediately:
 * unpublish (→draft) → update → publish (→published snapshot). The brief draft
 * window is sub-request and only affects this one host page.
 */
export async function editSystemHomePage(patch: { title?: string; sections?: unknown }, actor: string): Promise<Page> {
  const site = await ensureSystemSite();
  const current = await getPage(site.tenantId, site.orgId, site.pageId);
  if (!current) throw new Error('system home page missing');
  // Validate the NEW content BEFORE touching the live page — a malformed PUT must
  // 400 without first unpublishing (which would 404 the homepage until re-fixed).
  if (patch.sections !== undefined) validateSections(patch.sections);
  if (current.status === 'published' || current.status === 'archived') {
    await transitionPage(site.tenantId, site.orgId, site.pageId, 'unpublish', actor); // → draft
  }
  await updatePage(site.tenantId, site.orgId, site.pageId, patch, actor);
  const published = await transitionPage(site.tenantId, site.orgId, site.pageId, 'publish', actor); // → published snapshot
  if (!published) throw new Error('system home page publish failed');
  return published;
}
