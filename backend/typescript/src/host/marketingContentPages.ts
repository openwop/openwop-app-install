/**
 * Real, PUBLISHED marketing pages (ADR 0027 / ADR 0486 follow-up) — the small set
 * of host-global marketing pages that ship with genuine copy (not the operator
 * placeholders in {@link marketingLegalPages}). About, Roadmap, Changelog, and
 * Support give the public navigation useful destinations beyond Features +
 * Compare.
 *
 * These own the `page:host-site-{about,roadmap,changelog,support,claude-code,white-label}` ids (the same id space the
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
import { demoMode } from './demoMode.js';

const log = createLogger('host.marketingContentPages');

const SYSTEM_ACTOR = 'system';
/** Bump to refresh the built-in copy on a redeploy (only while never human-edited). */
const SEED_VERSION = 6;
/** Same id space as the placeholder seeder — this module owns these public slugs. */
const pageIdFor = (slug: string): string => `page:host-site-${slug}`;

export interface PageSpec { slug: string; title: string; sections: Section[] }

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
      'OpenWOP is the open-source protocol for multi-agent workflow orchestration — and this is the reference app that shows what it can do.'),
    rich('mc-what', 'What this is', 'An open protocol, a working showcase',
      'OpenWOP (Workflow Orchestration Protocol) is the open-source protocol for multi-agent workflow orchestration: how a run of AI agents, tools and people starts, streams its events, stops for a person’s approval, resumes and replays. This application is its reference implementation: a working showcase you can use, rebrand, or self-host.\n\nDesign an agent or a workflow on a visual canvas — drag, connect, done — or start from a ready-made template and make it your own. Give your agents names, schedules, and their own to-do boards, so *Sally in Sales* or *Marcus in Support* becomes a coworker that does real work.'),
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

// ADR 0785 — the Claude Code feature page. Claims stay inside what ships: the
// companion connects out, the credential stays local, and it is opt-in + at the
// user's own risk (ADR 0785 D2). Setup lives in the tutorial + docs/CLAUDE-CODE-SETUP.md.
const CLAUDE_CODE: PageSpec = {
  slug: 'claude-code',
  title: 'Claude Code',
  sections: [
    { sectionId: 'mc-hero', type: 'hero', data: {
      eyebrow: 'Claude Code',
      heading: 'Your own Claude Code, one tab away from your work',
      subheading: 'Pair the Claude Code on your machine with your workspace. Use it from a chat tab, let it work with your to-dos, and answer its permission prompts from your phone.',
      ctaLabel: 'Follow the setup tutorial', ctaUrl: '/tutorials/set-up-claude-code',
      // NOT the GitHub setup guide: that repo is private, so the link 404'd for every visitor (2026-10-05).
      ctaLabel2: 'Get the companion app', ctaUrl2: 'https://www.npmjs.com/package/@openwop/agent-host',
    } },
    rich('mc-what', 'How it works', 'It runs on your machine. Your workspace just connects to it.',
      'A small companion app, `@openwop/agent-host`, pairs your machine with your workspace using a one-time code you type yourself. It connects **out** to the workspace and never opens a port on your machine.\n\nClaude Code keeps running where your code lives, in the folder you choose, signed in the way you already sign it in. Your Claude credential never leaves your machine, and this app never sees it.'),
    // Four again (2026-10-05): the 'Tasks from workflows' card was pulled while the
    // `claude-code.task` step had no builder form and no per-device opt-in. Both ship
    // now (ADR 0785 D7): the palette's "Ask Claude Code" step and a gallery template.
    cards('mc-can', 'What you can do', 'Four ways to work with it', 'Start with the terminal tab; the rest is there when you need it.', [
      { title: 'A terminal tab in the chat', text: 'Open Claude Code next to your conversations. Leave the chat and come back, or lose your connection, and it keeps running on your machine; the tab catches up.', icon: 'terminal' },
      { title: 'Your to-dos, in reach', text: 'Sessions started from the app can list your to-dos and add new ones, over a connection scoped to your workspace.', icon: 'board' },
      { title: 'Approve from anywhere', text: 'Permission prompts can also appear as Allow or Deny cards in your inbox. Only you can answer them; a device can never approve itself.', icon: 'lock' },
      { title: 'Tasks from workflows', text: 'Add an "Ask Claude Code" step to a workflow to hand it a coding task. Only devices you have allowed to take workflow tasks ever receive one, and a task cut off mid-way stops for your decision instead of retrying.', icon: 'workflow' },
    ]),
    cards('mc-setup', 'Set up', 'Three steps', 'About ten minutes with Node.js 22 and Claude Code already installed.', [
      { title: '1. Pair', text: 'Copy the pairing command from the Claude Code page, run it on your machine, then type the code it prints and approve the device.' },
      { title: '2. Run', text: 'Start the companion in the folder you want Claude Code to work in, and keep it running.' },
      { title: '3. Open', text: 'In the chat, choose New tab, then Claude Code, and start a session.' },
    ]),
    rich('mc-trust', 'Before you turn it on', 'Opt-in, and on your own credential',
      'Claude Code is off until your workspace admin enables it. Signing Claude Code in with an Anthropic API key, Amazon Bedrock or Google Vertex is the supported path; using a personal Claude login is at your own risk, and the approval page shows the relevant terms before you pair.\n\nYou can revoke a device at any time from the Claude Code page, and it stops working on its next request.'),
    { sectionId: 'mc-cta', type: 'cta', data: {
      eyebrow: 'Get started', heading: 'Bring your Claude Code into your workspace',
      subheading: 'The tutorial walks you through pairing, the chat tab and inbox approvals.',
      label: 'Start the tutorial', url: '/tutorials/set-up-claude-code',
    } },
  ],
};

// ADR 0843 — the white-label page: what running the reference app under your
// own name involves, told by two narrated films (the `video` section type).
// The films are openwop.dev-hosted showcase media, so the page is DEMO-GATED
// (ADR 0196 Gate A, the hero film's rule): a white-label install never seeds a
// page that loads media from openwop.dev or advertises re-skinning OpenWOP.
// Claims stay inside the evidence (ADR 0824 § Copy rules, as corrected by
// ADR 0843): none of the gated assurance claims, and the operator's side of
// the bargain (operations, upgrades, model costs) is stated plainly.
const FILM_BASE = 'https://openwop.dev/assets/video';
const WHITE_LABEL: PageSpec = {
  slug: 'white-label',
  title: 'White label',
  sections: [
    { sectionId: 'mc-hero', type: 'hero', data: {
      eyebrow: 'White label',
      heading: 'Your brand on an app *that already works.*',
      subheading: 'Run the OpenWOP reference app under your own name and on infrastructure you choose, without forking its core. The app is open source (Apache 2.0), and it is the same app that runs here.',
      ctaLabel: 'Install your branded copy', ctaUrl: 'https://openwop.dev/install/',
      ctaLabel2: 'Try it first', ctaUrl2: '/chat',
      // No hero artwork: the default workflow vignette is captioned "Open
      // standard", a claim this page must not make (and the films are the art).
      visual: 'none',
    } },
    { sectionId: 'mc-wl-film-companies', type: 'video', data: {
      heading: 'Why companies run it *as their own*',
      title: 'OpenWOP for Companies: Run AI Agents on Your Terms',
      length: '1:57',
      uploadDate: '2026-10-06',
      src: `${FILM_BASE}/openwop-companies.mp4?v=2026-10-06.3`,
      poster: `${FILM_BASE}/openwop-companies-poster.jpg?v=2026-10-06.3`,
      captions: `${FILM_BASE}/openwop-companies.en.vtt?v=2026-10-06.3`,
      youtubeUrl: 'https://www.youtube.com/watch?v=ABqfybP2w4k',
      description: 'A 117-second narrated film, with English captions. A company wants AI agents doing real work and has to decide where that work should live. Buying a platform puts the workflows inside someone else\'s product; building your own takes months. The film shows a third way: the OpenWOP reference app, open source, started with one command and rebranded as the placeholder company Example Co, then real screens of a workflow, an approval waiting for finance, the recorded event stream and ten example agents. It ends plainly: you run it, so keeping it running is yours too.',
    } },
    cards('mc-wl-yours', '', 'What you can make *yours*', '', [
      { title: 'Your name and logo', text: 'Set the `VITE_BRAND_*` settings at build time.', icon: 'pencil' },
      { title: 'Your colours', text: 'Override the tokens in `src/brand/brand.css`.', icon: 'sparkles' },
      { title: 'Your starting team', text: 'Rename the ten example agents, or turn demo seeding off for a clean tenant.', icon: 'roster' },
      { title: 'Your cloud', text: 'Docker Compose with no cloud account, Fly.io, Render, Railway, AWS, Azure or Google Cloud.', icon: 'globe' },
    ]),
    { sectionId: 'mc-wl-film-install', type: 'video', data: {
      heading: 'How to re-skin it *without forking it*',
      title: 'OpenWOP Install: Re-skin It, Don\'t Fork It',
      length: '1:15',
      uploadDate: '2026-10-02',
      src: `${FILM_BASE}/openwop-install.mp4?v=2026-10-02.2`,
      poster: `${FILM_BASE}/openwop-install-poster.jpg?v=2026-10-02.2`,
      captions: `${FILM_BASE}/openwop-install.en.vtt?v=2026-10-02.2`,
      youtubeUrl: 'https://www.youtube.com/watch?v=0aZtImUivlA',
      description: 'A 75-second narrated film, with English captions. You want to offer agents to your own customers under your own name. Rather than build an app from scratch, or copy one and maintain the copy forever, you take the ready-made OpenWOP app and change only how it looks: download one file and check it, start it with one command, and set your product name and colours.',
    } },
    cards('mc-wl-take-on', '', 'What you *take on*', '', [
      { title: 'You operate it', text: 'There is no service contract or SLA behind the app, and no paid managed offering from the OpenWOP project.', icon: 'settings' },
      { title: 'Upgrades are yours to schedule', text: 'You choose when to move to a new release.', icon: 'clock' },
      { title: 'Model costs are yours', text: 'Your provider keys pay for model calls. The mock-AI demo workflows cost nothing.', icon: 'key' },
      { title: 'The evidence is self-reported today', text: 'Published conformance results come from the project\'s steward or an affiliated organization.', icon: 'scale' },
    ]),
    { sectionId: 'mc-cta', type: 'cta', data: {
      eyebrow: 'Get started', heading: 'Start from an app *you own.*',
      subheading: 'Download the bundle, check it, and put your name on it.',
      label: 'Install your branded copy', url: 'https://openwop.dev/install/',
    } },
  ],
};

/** The seeded pages for this install. The white-label page is demo-only (above). */
function pages(): PageSpec[] {
  return demoMode() ? [ABOUT, ROADMAP, CHANGELOG, SUPPORT, CLAUDE_CODE, WHITE_LABEL] : [ABOUT, ROADMAP, CHANGELOG, SUPPORT, CLAUDE_CODE];
}

/** Test seam: the built-in page specs (all of them, demo-gated or not). */
export const MARKETING_CONTENT_PAGE_SPECS: readonly PageSpec[] = [ABOUT, ROADMAP, CHANGELOG, SUPPORT, CLAUDE_CODE, WHITE_LABEL];

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
  for (const spec of pages()) {
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
    pages().map((spec) => getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, pageIdFor(spec.slug))),
  );
  return present.filter(Boolean).length;
}

