/**
 * Real, PUBLISHED marketing pages (ADR 0027 / ADR 0486 follow-up) — the small set
 * of host-global marketing pages that ship with genuine copy (not the operator
 * placeholders in {@link marketingLegalPages}). About, Roadmap, Changelog, and
 * Support give the public navigation useful destinations beyond Features +
 * Compare.
 *
 * These own the `page:host-site-{about,roadmap,changelog,support}` ids (the same id space the
 * placeholder seeder used), so on an existing deployment they ADOPT the unedited
 * draft placeholder and replace it with real, published content. A human edit in
 * the CMS (updatedBy off `system`) freezes the page — the operator's copy always
 * wins. Bump {@link SEED_VERSION} to refresh the built-in copy on redeploy.
 *
 * Content is honest and grounded (the same voice as the system home page): no
 * fabricated dates or forward commitments — the Roadmap describes themes + how to
 * follow along, per the placeholder's own "honest about planned vs shipped" note.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import {
  createPage, getPage, transitionPage, updatePage, type Section,
} from '../features/cms/cmsService.js';
import { ensureSystemSite, SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from './systemSite.js';

const log = createLogger('host.marketingContentPages');

const SYSTEM_ACTOR = 'system';
/** Bump to refresh the built-in copy on a redeploy (only while never human-edited). */
const SEED_VERSION = 2;
/** Same id space as the placeholder seeder — this module owns these public slugs. */
const pageIdFor = (slug: string): string => `page:host-site-${slug}`;

interface PageSpec { slug: string; title: string; sections: Section[] }

// ── section builders (the typed-section shapes cmsService validates) ────────
const hero = (eyebrow: string, heading: string, subheading: string): Section =>
  ({ sectionId: 'mc-hero', type: 'hero', data: { eyebrow, heading, subheading, ctaLabel: 'Open the workspace', ctaUrl: '/chat', ctaLabel2: 'Compare', ctaUrl2: '/p/compare' } });
const rich = (id: string, eyebrow: string, heading: string, text: string): Section =>
  ({ sectionId: id, type: 'richText', data: { eyebrow, heading, text } });
interface Card { title: string; text: string; href?: string; icon?: string }
const cards = (id: string, eyebrow: string, heading: string, lede: string, items: Card[], layout: 'cards' | 'showcase' = 'cards'): Section =>
  ({ sectionId: id, type: 'columns', data: { eyebrow, heading, lede, layout, columns: items } });
const cta = (eyebrow: string, heading: string, subheading: string): Section =>
  ({ sectionId: 'mc-cta', type: 'cta', data: { eyebrow, heading, subheading, label: 'Open the workspace', url: '/chat' } });

const ABOUT: PageSpec = {
  slug: 'about',
  title: 'About',
  sections: [
    hero('About', 'AI coworkers you actually own',
      'OpenWOP is an open standard for AI agents and workflows — and this is the reference app that shows what it can do.'),
    rich('mc-what', 'What this is', 'An open protocol, a working showcase',
      'OpenWOP — Open Workflow Orchestration Protocol — is an open standard for building, running, and governing AI agents and workflows. This application is its reference implementation: a working showcase you can use, fork, or self-host.\n\nDesign an agent or a workflow on a visual canvas — drag, connect, done — or start from a ready-made template and make it your own. Give your agents names, schedules, and their own to-do boards, so *Sally in Sales* or *Marcus in Support* becomes a coworker that does real work.'),
    cards('mc-principles', 'What we believe', 'Principles', 'The ideas the whole thing is built on.', [
      { title: 'Yours to keep', text: 'Bring your own model keys, export your estate, and self-host. Your data and your agents stay yours — never locked in.' },
      { title: 'Open by design', text: 'An open protocol evolved in the open through RFCs, so any conformant host can run the same workflows.' },
      { title: 'Built to run', text: 'Every workflow pins its version, replays deterministically, and forks from any step — so a run is always debuggable.' },
      { title: 'Humans in the loop', text: 'Agents propose; people decide. Approvals, review, and trust rails are first-class, not bolted on.' },
    ]),
    cta('Try it', 'See what your coworkers can do', 'Start a chat, build a workflow, and watch it run.'),
  ],
};

const ROADMAP: PageSpec = {
  slug: 'roadmap',
  title: 'Roadmap',
  sections: [
    hero('Roadmap', 'A roadmap with evidence, not promises.',
      'OpenWOP is built in the open. This page separates what you can use today from the areas we are exploring — without inventing delivery dates.'),
    rich('mc-open', 'How to read this', 'Direction is not a deadline',
      'The reference app evolves alongside open RFCs. A deployment can turn capabilities on when it is ready, so availability always depends on the host you are using. This page describes the direction of travel; the [features catalog](/p/features) and [changelog](/p/changelog) are the sources for what is publicly available.'),
    cards('mc-now', 'Use it now', 'Start with a reviewable loop', 'Three dependable ways to experience the platform before you explore the full catalog.', [
      { title: 'Ask, then act', text: 'Use one AI chat surface to turn a plain-language request into useful work.', href: '/chat', icon: 'chat' },
      { title: 'Design the path', text: 'Compose repeatable, multi-step work on the visual workflow canvas.', href: '/builder', icon: 'workflow' },
      { title: 'Inspect the record', text: 'Follow a run, review its steps, and replay or fork from what actually happened.', href: '/runs', icon: 'play' },
    ], 'showcase'),
    cards('mc-exploring', 'Exploring', 'Make the core loop stronger', 'The questions guiding the next rounds of work — not date-based commitments.', [
      { title: 'A faster way to begin', text: 'More useful starting points for turning a real job into a governed workflow.' },
      { title: 'A clearer handoff to people', text: 'Human controls that make reviews, approvals, and accountability easier to follow.' },
      { title: 'A more connected workspace', text: 'Broader ways to bring the systems and context your work already depends on into the loop.' },
    ]),
    rich('mc-follow', 'Follow the evidence', 'See what is real, then shape what is next',
      'Browse [what this deployment supports](/capabilities), compare the platform’s approach, or read the [open source project](https://github.com/openwop/openwop-app). The most useful roadmap feedback starts with a real task: try it, identify the point of friction, and tell us what would make the outcome more trustworthy.'),
    cta('Start with the present', 'Put one real task through the loop', 'The clearest way to evaluate the roadmap is to use what is ready today.'),
  ],
};

const CHANGELOG: PageSpec = {
  slug: 'changelog',
  title: 'Changelog',
  sections: [
    hero('Changelog', 'Public release notes', 'A record of deployed milestones, newest first — not a feed of work still in progress.'),
    rich('mc-cl-reading', 'How to read this', 'Published releases only',
      'Entries on this page are added when a public milestone is released. For work in progress, follow the [open source project](https://github.com/openwop/openwop-app); for the capabilities available to use, see the [features catalog](/p/features).'),
    rich('mc-cl-1', 'July 25, 2026', '',
      '**Public site refresh.** The home page is now always the public site for visitors, with a new menu that reaches every published page; the workspace moved to its own `/dashboard` URL.\n\n**About & Roadmap.** New pages explaining what OpenWOP is and where it’s headed — plus this changelog.\n\n**Steadier public pages.** Every public page is hardened against unexpected data, and pricing reads more clearly — plan features in plain language, and “everything included” for unlimited plans.\n\n**CAD editor.** The 3D orbit view is now reachable directly in the editor.'),
    rich('mc-cl-2', 'July 24, 2026', '',
      '**Compare the field.** A new public comparison page shows how OpenWOP stacks up across the workflow-orchestration landscape.\n\n**Deeper orchestration.** Per-node cost and budgets, smoother performance on large canvases, more ready-made templates, real-time builder collaboration, and online evaluations.'),
    rich('mc-cl-3', 'July 23, 2026', '',
      '**Orchestration foundations.** Run version pinning, debugging on production data, fleet insights, evaluations, and stronger human-in-the-loop controls.\n\n**Reviewable AI authoring.** Workflows an agent composes now go through a propose → review → approve flow before they run.'),
    cta('Keep going', 'See it in action', 'The best release notes are the app itself.'),
  ],
};

const SUPPORT: PageSpec = {
  slug: 'support',
  title: 'Support',
  sections: [
    hero('Support', 'Find the right next step.', 'Whether you are trying the reference app, setting up a workspace, or tracing a run, start with the path that matches the work.'),
    cards('mc-sup-paths', 'Choose a path', 'Get unstuck without guessing', 'Practical starting points for the questions people hit first.', [
      { title: 'Learn the foundations', text: 'Follow the quickstart from sign-in to a first result, with the core concepts in the right order.', href: '/docs/quickstart', icon: 'book' },
      { title: 'Try a real task', text: 'Ask the AI chat about your work, or use it to start a workflow from one conversation.', href: '/chat', icon: 'chat' },
      { title: 'Connect safely', text: 'Understand provider keys, integrations, and the guardrails around credentials.', href: '/docs/connections-and-keys', icon: 'key' },
      { title: 'Report a reproducible issue', text: 'Share what you expected, what happened, and the smallest set of steps that reproduces it.', href: 'https://github.com/openwop/openwop-app/issues/new/choose', icon: 'lifebuoy' },
    ], 'showcase'),
    rich('mc-sup-runs', 'When a run needs attention', 'Start from the record, not a guess',
      'Open the [run history](/runs) to inspect the recorded steps and outputs. If work is waiting on a person, check the [inbox](/inbox) for its approval or blocker. Those records make it much easier to explain what happened and decide the next safe action.'),
    rich('mc-sup-explore', 'For product questions', 'Use the source that fits the question',
      'The [features catalog](/p/features) explains each surface, the [comparison](/p/compare) explains the platform’s approach, and the [roadmap](/p/roadmap) distinguishes current capabilities from direction. For installation and usage guidance, browse the [documentation](/docs/welcome).'),
    cta('Ready to begin?', 'Open the workspace and follow the work', 'A real request is the fastest way to learn how the pieces fit together.'),
  ],
};

const PAGES: PageSpec[] = [ABOUT, ROADMAP, CHANGELOG, SUPPORT];

const seedMarker = new DurableCollection<{ id: string; version: number }>('marketing-content-pages-seed', (m) => m.id);

let ensuring: Promise<void> | null = null;

/** Replace a page's sections with the built-in copy + republish (system
 *  authority), keeping `updatedBy = system` so the page stays "unedited".
 *  Self-heals a mid-sequence storage error (left draft → next ensure republishes). */
async function applyDefault(spec: PageSpec): Promise<void> {
  const pageId = pageIdFor(spec.slug);
  const p = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId);
  if (!p) return;
  if (p.status === 'published' || p.status === 'archived') {
    await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, 'unpublish', SYSTEM_ACTOR);
  }
  await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, { title: spec.title, sections: spec.sections }, SYSTEM_ACTOR);
  await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, 'publish', SYSTEM_ACTOR);
}

async function doEnsure(): Promise<void> {
  await ensureSystemSite();
  for (const spec of PAGES) {
    const pageId = pageIdFor(spec.slug);
    const existing = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId);
    if (!existing) {
      await createPage({
        tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId,
        title: spec.title, slug: spec.slug, sections: spec.sections, createdBy: SYSTEM_ACTOR,
      });
      await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageId, 'publish', SYSTEM_ACTOR);
      await seedMarker.put({ id: spec.slug, version: SEED_VERSION });
      log.info('marketing_content_page_seeded', { slug: spec.slug, seedVersion: SEED_VERSION });
    } else if (existing.updatedBy === SYSTEM_ACTOR) {
      // Adopt the unedited placeholder draft (or refresh on a SEED_VERSION bump) —
      // a human edit freezes it (updatedBy off `system`), so the operator's copy wins.
      const marker = await seedMarker.get(spec.slug);
      if (marker?.version !== SEED_VERSION) {
        await applyDefault(spec);
        await seedMarker.put({ id: spec.slug, version: SEED_VERSION });
        log.info('marketing_content_page_refreshed', { slug: spec.slug, to: SEED_VERSION });
      }
    }
  }
}

/** Ensure the host-global, published marketing pages exist (idempotent). */
export function ensureMarketingContentPages(): Promise<void> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/** How many of these pages are present (drives the demo-data dashboard count). */
export async function countMarketingContentPages(): Promise<number> {
  const present = await Promise.all(
    PAGES.map((spec) => getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageIdFor(spec.slug))),
  );
  return present.filter(Boolean).length;
}

