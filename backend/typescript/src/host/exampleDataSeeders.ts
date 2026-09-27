/**
 * Demo-seeder registry — the extensible backbone of the `/demo-data` dashboard.
 *
 * Each seedable kind of demo data is ONE {@link ExampleDataSeeder} entry: an id, a
 * label/description, a live `count` (so the dashboard shows "N present"), a
 * `seed`, and a `clear`. Adding a future demo data type (prompts, memory, …) is
 * a single entry here — no dashboard or endpoint edits. The dashboard, the
 * status endpoint, and the seed/clear endpoints all derive from this array, so
 * they can never drift (modelled on myndhyve's seed-step registry, adapted to
 * openwop's single-tenant host-extension runtime).
 *
 * Everything stays IDEMPOTENT + non-destructive to user-authored data: seeders
 * create only what's missing; clearers remove only the canonical demo entities.
 */

import type { Storage } from '../storage/storage.js';
import { clearExampleAgents, countExampleAgents, seedExampleAgents, exampleDataSeedEnabled } from './exampleDataSeed.js';
import { countDemoPeople, seedDemoPeople, clearDemoPeople } from './demoPeopleSeed.js';
import { countDemoMedia, seedDemoMedia, clearDemoMedia } from './demoMediaSeed.js';
import { countDemoCrm, seedDemoCrm, clearDemoCrm } from './demoCrmSeed.js';
import { countDemoJobSearch, seedDemoJobSearch, clearDemoJobSearch } from './demoJobSearchSeed.js';
import { countDemoCommerceDepth, seedDemoCommerceDepth, clearDemoCommerceDepth } from './demoCommerceDepthSeed.js';
import { countDemoMerchandising, seedDemoMerchandising, clearDemoMerchandising } from './demoMerchandisingSeed.js';
import { countDemoTerritories, seedDemoTerritories, clearDemoTerritories } from './demoTerritoriesSeed.js';
import { countDemoCdp, seedDemoCdp, clearDemoCdp } from './demoCdpSeed.js';
import { countDemoContentMarketing, seedDemoContentMarketing, clearDemoContentMarketing } from './demoContentMarketingSeed.js';
import { countDemoEntities, seedDemoEntities, clearDemoEntities } from './demoEntitiesSeed.js';
import { countDemoAppBuilder, seedDemoAppBuilder, clearDemoAppBuilder } from './demoAppBuilderSeed.js';
import { countDemoKicktodo, seedDemoKicktodo, clearDemoKicktodo } from './demoKicktodoSeed.js';
import { countDemoWalkthroughs, seedDemoWalkthroughs, clearDemoWalkthroughs } from './demoWalkthroughsSeed.js';
import { clearTutorialRows, countTutorialRows, seedTutorials } from '../features/tutorials/tutorialsService.js';
import { countDemoOpsPlanning, seedDemoOpsPlanning, clearDemoOpsPlanning } from './demoOpsPlanningSeed.js';
import { countDemoDealers, seedDemoDealers, clearDemoDealers } from './demoDealersSeed.js';
import { countDemoCommissions, seedDemoCommissions, clearDemoCommissions } from './demoSalesCommissionsSeed.js';
import { countDemoSalesMaps, seedDemoSalesMaps, clearDemoSalesMaps } from './demoSalesMapsSeed.js';
import { countDemoProduction, seedDemoProduction, clearDemoProduction } from './demoProductionSeed.js';
import { seedAdvisoryBoards, countAdvisors, clearAdvisoryBoards } from './advisoryBoardSeed.js';
import { ensureSystemSite, getSystemHomePage } from './systemSite.js';
import { ensureFeaturesPage, getFeaturesPage } from './featuresPage.js';
import { ensureComparisonPage, getComparisonPage } from './comparisonPage.js';
import { ensureMarketingContentPages, countMarketingContentPages } from './marketingContentPages.js';
import { ensureMarketingLegalPages, countMarketingLegalPages } from './marketingLegalPages.js';
import {
  clearWorkforceHistory,
  countWorkforceRuns,
  seedWorkforceEntities,
  seedWorkforceHistory,
} from './workforceService.js';
import {
  countWorkflowAuthorShowcase,
  seedWorkflowAuthorShowcase,
  clearWorkflowAuthorShowcase,
} from './workflowAuthorSeed.js';
import {
  countStrategyShowcase,
  seedStrategyShowcase,
  clearStrategyShowcase,
} from './strategyShowcaseSeed.js';
import {
  countCampaignShowcase,
  seedCampaignShowcase,
  clearCampaignShowcase,
} from './campaignShowcaseSeed.js';
import {
  countCommerceShowcase,
  seedCommerceShowcase,
  clearCommerceShowcase,
} from './commerceShowcaseSeed.js';
import {
  countUcpReferenceMerchant,
  seedUcpReferenceMerchant,
  clearUcpReferenceMerchant,
} from './ucpReferenceMerchantSeed.js';

export type SeedAction = 'created' | 'skipped' | 'error' | 'cleared';

/** One step's outcome — mirrors the dashboard's per-row result. */
export interface StepResult {
  step: string;
  label: string;
  action: SeedAction;
  message: string;
  details?: Record<string, unknown>;
  /** Set when this step wasn't in the caller's selection but was pulled in as a
   *  transitive `dependsOn` ancestor (seed runs only — clear never expands). */
  autoIncluded?: true;
}

export interface RunSummary {
  created: number;
  skipped: number;
  cleared: number;
  errors: number;
  total: number;
}

export interface RunResult {
  success: boolean;
  dryRun: boolean;
  results: StepResult[];
  summary: RunSummary;
}

/** A seedable kind of demo data. */
export interface ExampleDataSeeder {
  id: string;
  label: string;
  description: string;
  /** Steps that should seed before this one (the registry order already
   *  satisfies these; declared for documentation + future reordering). */
  dependsOn?: string[];
  /** Live count of this kind present for the tenant (drives "N present"). */
  count(tenantId: string, storage: Storage): Promise<number>;
  /** Create what's missing. Returns how many net-new items were created. */
  seed(tenantId: string, storage: Storage): Promise<{ created: number; details?: Record<string, unknown> }>;
  /** Remove the canonical demo entities (never user-authored data). */
  clear(tenantId: string, storage: Storage): Promise<{ cleared: number; details?: Record<string, unknown> }>;
}

const demoPeopleSeeder: ExampleDataSeeder = {
  id: 'demo-people',
  label: 'People & org (Solstice Roasters)',
  description: 'The 12 Solstice Roasters coworkers — CEO, VP Sales, four account executives, marketing, merchandising, customer success, ops, finance, and IT — as users + profiles, plus the org and its sales / marketing / customer-success teams. The substrate every later demo phase resolves owners, assignees, and members against.',
  dependsOn: [],
  async count(tenantId) {
    return countDemoPeople(tenantId);
  },
  async seed(tenantId) {
    return seedDemoPeople(tenantId);
  },
  async clear(tenantId, storage) {
    return clearDemoPeople(tenantId, storage);
  },
};

const demoJobSearchSeeder: ExampleDataSeeder = {
  id: 'demo-job-search',
  label: 'Job search — applications pipeline (ADR 0539/0540)',
  description:
    'The job-search vertical showcase: a NON-REVENUE pipeline (ADR 0540 D3) whose Reports tab shows counts with no currency rollup, four applications as real CRM deals across Applied→Offer, each carrying a structured job digest. Applications are created through crmEntitiesService so CRM authz + stage history apply. Requires the job-search toggle; skips honestly when off.',
  dependsOn: ['demo-crm'],
  async count(tenantId) {
    return countDemoJobSearch(tenantId);
  },
  async seed(tenantId) {
    return seedDemoJobSearch(tenantId);
  },
  async clear(tenantId) {
    return clearDemoJobSearch(tenantId);
  },
};

const demoEntitiesSeeder: ExampleDataSeeder = {
  id: 'demo-entities',
  label: 'Entities — team roster (Solstice Roasters)',
  description: 'A team-member content type (published + public read) with a departments taxonomy and a six-person roster (one deliberate draft) — the ADR 0407 delivery-bridge proving consumer: the About page’s entityList section and the anonymous public-entities read resolve these rows. Requires the entities toggle; skips honestly when off.',
  async count(tenantId) {
    return countDemoEntities(tenantId);
  },
  async seed(tenantId) {
    return seedDemoEntities(tenantId);
  },
  async clear(tenantId) {
    return clearDemoEntities(tenantId);
  },
};

const demoMediaSeeder: ExampleDataSeeder = {
  id: 'demo-media',
  label: 'Media library (Solstice Roasters)',
  description: 'A brand-consistent media library — 34 self-authored PNG assets across Product Photos, Brand, and Blog collections. Commerce product images and CMS pages reference these, so it precedes both. No external images.',
  dependsOn: ['demo-people'],
  async count(tenantId) {
    return countDemoMedia(tenantId);
  },
  async seed(tenantId) {
    return seedDemoMedia(tenantId);
  },
  async clear(tenantId) {
    return clearDemoMedia(tenantId);
  },
};

const agentsSeeder: ExampleDataSeeder = {
  id: 'agents',
  label: 'Agents',
  description: 'Named demo coworkers — each with a task board, sample cards, schedules, and an org-chart seat.',
  async count(tenantId) {
    return countExampleAgents(tenantId);
  },
  async seed(tenantId, storage) {
    // skipWorkforces: the `workforces` step owns workforce seeding, so loading
    // the agents step never silently seeds workforces too.
    const r = await seedExampleAgents(tenantId, storage, { heal: true, skipWorkforces: true });
    const restored =
      (r.healed?.boards ?? 0) + (r.healed?.schedules ?? 0) + (r.healed?.profiles ?? 0) +
      (r.healed?.prunedLegacy ?? 0) + (r.healed?.orgChart ? 1 : 0);
    return {
      created: r.seeded ? r.agents : restored,
      details: { agents: r.agents, ...(r.healed ?? {}) },
    };
  },
  async clear(tenantId, storage) {
    return clearExampleAgents(tenantId, storage);
  },
};

const advisorsSeeder: ExampleDataSeeder = {
  id: 'advisors',
  label: 'Advisory boards',
  description: 'Simulated-persona advisors (e.g. Elon Trask, Ben Franklan) grouped into boards you can convene together via @@ — each with its own instructions and preseeded memory. Requires the Board of Advisors feature to be enabled.',
  async count(tenantId) {
    return countAdvisors(tenantId);
  },
  async seed(tenantId, storage) {
    const r = await seedAdvisoryBoards(tenantId, storage, { heal: true });
    return {
      created: r.advisorsCreated + r.boardsCreated,
      details: r.skippedToggleOff
        ? { skipped: 'advisory-board feature is off' }
        : { advisors: r.advisorsCreated, boards: r.boardsCreated },
    };
  },
  async clear(tenantId, storage) {
    const { advisorsCleared, boardsCleared } = await clearAdvisoryBoards(tenantId, storage);
    return { cleared: advisorsCleared + boardsCleared, details: { advisors: advisorsCleared, boards: boardsCleared } };
  },
};

const cmsHomepageSeeder: ExampleDataSeeder = {
  id: 'cms-homepage',
  label: 'CMS homepage',
  description: 'The public, CMS-driven front page shown to anonymous visitors at the site root (ADR 0027). Host-global content — shared across the deployment, not per-tenant — so it is shown for visibility but not cleared from here.',
  async count() {
    // Host-global: the reserved system-site home page. 1 when present, else 0.
    try {
      await getSystemHomePage();
      return 1;
    } catch {
      return 0;
    }
  },
  async seed() {
    // Idempotent ensure of the reserved system site + published home page.
    const before = await getSystemHomePage().then(() => 1).catch(() => 0);
    await ensureSystemSite();
    return { created: before === 0 ? 1 : 0, details: { hostGlobal: true } };
  },
  async clear() {
    // Host-global content: never cleared per-tenant (it would remove the public
    // front page for the whole deployment). Shown for visibility only.
    return { cleared: 0, details: { hostGlobal: true, note: 'host-global; not cleared per-tenant' } };
  },
};

const workforcesSeeder: ExampleDataSeeder = {
  id: 'workforces',
  label: 'Workforces',
  description: 'Governed agent clusters plus weeks of synthetic run history for the instrumented ones (telemetry, governance, graduation).',
  dependsOn: ['agents'],
  async count(_tenantId, storage) {
    return (await countWorkforceRuns(storage, _tenantId)).workforces;
  },
  async seed(tenantId, storage) {
    const entities = await seedWorkforceEntities();
    const hist = await seedWorkforceHistory(storage, tenantId, { nowMs: Date.now() });
    return { created: hist.runs, details: { workforceEntities: entities, runs: hist.runs } };
  },
  async clear(tenantId, storage) {
    const { runs } = await clearWorkforceHistory(storage, tenantId);
    return { cleared: runs, details: { runs } };
  },
};

const demoCrmSeeder: ExampleDataSeeder = {
  id: 'demo-crm',
  label: 'CRM — the B2B anchor (Solstice Roasters)',
  description: '15 wholesale accounts (cafés, hotels, grocers), 75+ contacts with CDP identifiers and one reversible near-duplicate merge, 4 probability-weighted pipelines, 30 deals, ~60 activities, 25 tasks, 6 overlapping segments, 4 custom fields, and 13 weeks of backdated pipeline snapshots. The anchor CRM reports, quota attainment, CDP, and strategy KRs read from. Requires the CRM feature.',
  dependsOn: ['demo-people'],
  async count(tenantId) {
    return countDemoCrm(tenantId);
  },
  async seed(tenantId) {
    return seedDemoCrm(tenantId);
  },
  async clear(tenantId) {
    return clearDemoCrm(tenantId);
  },
};

const featurePagesSeeder: ExampleDataSeeder = {
  id: 'features-page',
  label: 'Features page',
  description: 'The public, CMS-driven "Features" page documenting every feature the app offers (ADR 0027), published at /p/features. Host-global content — shared across the deployment, not per-tenant — so it is shown for visibility but not cleared from here.',
  async count() {
    // Host-global: the reserved system-site features page. 1 when present, else 0.
    return (await getFeaturesPage()) ? 1 : 0;
  },
  async seed() {
    // Idempotent ensure of the published, host-global features page.
    const before = (await getFeaturesPage()) ? 1 : 0;
    await ensureFeaturesPage();
    return { created: before === 0 ? 1 : 0, details: { hostGlobal: true } };
  },
  async clear() {
    // Host-global content: never cleared per-tenant (it would remove the public
    // features page for the whole deployment). Shown for visibility only.
    return { cleared: 0, details: { hostGlobal: true, note: 'host-global; not cleared per-tenant' } };
  },
};

const comparisonPageSeeder: ExampleDataSeeder = {
  id: 'comparison-page',
  label: 'Comparison page',
  description: 'The public, CMS-driven "Comparison" page presenting a capability matrix across the competitive workflow-orchestration landscape (ADR 0485), published at /p/compare. Host-global content — shared across the deployment, not per-tenant — so it is shown for visibility but not cleared from here.',
  async count() {
    // Host-global: the reserved system-site comparison page. 1 when present, else 0.
    return (await getComparisonPage()) ? 1 : 0;
  },
  async seed() {
    // Idempotent ensure of the published, host-global comparison page.
    const before = (await getComparisonPage()) ? 1 : 0;
    await ensureComparisonPage();
    return { created: before === 0 ? 1 : 0, details: { hostGlobal: true } };
  },
  async clear() {
    // Host-global content: never cleared per-tenant (it would remove the public
    // comparison page for the whole deployment). Shown for visibility only.
    return { cleared: 0, details: { hostGlobal: true, note: 'host-global; not cleared per-tenant' } };
  },
};

const marketingContentPagesSeeder: ExampleDataSeeder = {
  id: 'marketing-content-pages',
  label: 'Marketing content pages',
  description: 'The public, CMS-driven marketing pages that ship with real, PUBLISHED copy (ADR 0486 follow-up) — About (/p/about) + Roadmap (/p/roadmap) — so the public nav has genuine destinations beyond Features + Compare. Host-global content — shown for visibility but not cleared per-tenant.',
  async count() {
    return countMarketingContentPages();
  },
  async seed() {
    const before = await countMarketingContentPages();
    await ensureMarketingContentPages();
    return { created: Math.max(0, (await countMarketingContentPages()) - before), details: { hostGlobal: true } };
  },
  async clear() {
    // Host-global content: never cleared per-tenant (it would remove the public
    // About/Roadmap pages for the whole deployment). Shown for visibility only.
    return { cleared: 0, details: { hostGlobal: true, note: 'host-global; not cleared per-tenant' } };
  },
};

const marketingLegalPagesSeeder: ExampleDataSeeder = {
  id: 'marketing-legal-pages',
  label: 'Marketing & legal pages',
  description: 'The standard public-site set (ADR 0391) as host-global DRAFT system-site pages: 8 marketing pages (about, careers, press, contact, community, support, changelog, roadmap) with honest starter copy, plus a 16-page legal suite (privacy, terms, DPA, AUP, cookies, AI addendum, API terms, marketplace terms, DMCA, subprocessors, security, SLA, vulnerability disclosure, accessibility, support terms, access-control policy) whose bodies are counsel-review PLACEHOLDERS — never real legal text. Seeded as draft so an operator reviews and publishes each through the editorial gate. Host-global content — shown for visibility but not cleared per-tenant.',
  async count() {
    return countMarketingLegalPages();
  },
  async seed() {
    const { created } = await ensureMarketingLegalPages();
    return { created, details: { hostGlobal: true } };
  },
  async clear() {
    // Host-global draft content: never cleared per-tenant (it would remove the
    // deployment's marketing/legal pages for everyone). Shown for visibility only.
    return { cleared: 0, details: { hostGlobal: true, note: 'host-global; not cleared per-tenant' } };
  },
};

const workflowAuthorSeeder: ExampleDataSeeder = {
  id: 'workflow-author-examples',
  label: 'AI-authored workflows',
  description: 'Showcase workflows that look like AI Workflow Author output (ADR 0072) — runnable graphs built from deterministic demo nodes, badged illustrative — so a visitor sees what "Create with AI" produces. Seeded as TENANT-OWNED workflows (WFAWF-6 / ADR 0596 R2), so they list in your builder gallery, open in the builder, and delete like any workflow you author yourself.',
  async count(tenantId) {
    return countWorkflowAuthorShowcase(tenantId);
  },
  async seed(tenantId) {
    return seedWorkflowAuthorShowcase(tenantId);
  },
  async clear(tenantId) {
    return clearWorkflowAuthorShowcase(tenantId);
  },
};

const demoWalkthroughsSeeder: ExampleDataSeeder = {
  id: 'demo-walkthroughs',
  label: 'Guided walkthroughs',
  description: 'The two sample guided walkthroughs — Campaign Studio "your first brief" and Chat "send your first message" — seeded as TENANT-OWNED walkthroughs (ADR 0435), so they list under "Your walkthroughs", open in the builder, and delete like any walkthrough you record yourself. They also back the connect-your-ai / campaign-studio tutorials and manual test CHAT-01. Requires the Guided walkthroughs toggle to be visible in the app.',
  async count(tenantId) {
    return countDemoWalkthroughs(tenantId);
  },
  async seed(tenantId) {
    return seedDemoWalkthroughs(tenantId);
  },
  async clear(tenantId) {
    return clearDemoWalkthroughs(tenantId);
  },
};

/**
 * ADR 0488 D1/D3 — makes the shipped tutorials EDITABLE in this workspace.
 *
 * Deliberately NOT framed as demo content: unlike every other seeder here, the
 * artifact already exists and is already readable. `/tutorials` serves the
 * shipped library from the in-repo seed floor whether or not this ever runs.
 * What seeding adds is OWNERSHIP — kernel rows the workspace can edit and
 * localize (ADR 0406 overlays), which the Tutor agent then reads back.
 *
 * Which is why "clear" here means REVERT TO SHIPPED, not "remove the tutorials".
 * The description says so in as many words: a clear discards this workspace's
 * edits, and the tutorials keep working. Nobody should be able to lose authored
 * content by tidying up example data.
 *
 * Idempotent and non-destructive on re-seed: a row the workspace has customised
 * is never overwritten by a redeploy (`ext.customizedAt` guards it), and a row
 * already at the current `seedVersion` is skipped.
 */
const tutorialsSeeder: ExampleDataSeeder = {
  id: 'tutorials',
  label: 'Editable tutorials',
  // §Correction (grade-code `TUT-13` / grade-data `LOC-1`): this description
  // used to promise the workspace could "rewrite them for your team and
  // translate them into your locales". Neither is possible yet — tutorials ship
  // no tenant write path (generic entity writes are refused on system types),
  // and no locale is read back on this surface. The copy now states what
  // seeding ACTUALLY does today; the editing/translation lane is ADR 0488 P6
  // work and the promise returns with it.
  description: 'Copies the shipped product tutorials into this workspace as your own content rows (ADR 0488), so the AI Tutor answers from your workspace\'s copy rather than the shipped library. Editing and per-locale translation of these rows are not available yet. The tutorials at /tutorials work with or without this; seeding only gives you ownership of them. Clearing reverts to the shipped text — it does not remove the tutorials.',
  async count(tenantId) {
    return countTutorialRows(tenantId);
  },
  async seed(tenantId) {
    // A throw here would be recorded as `action:'error'` and would flip the
    // WHOLE example-data run to success:false, so one optional seeder would make
    // seeding a workspace look broken. It is downgraded to a skip — but the
    // REASON is no longer asserted.
    //
    // §Correction (grade-data `TUT-2`): this catch used to report every failure
    // as "the Entities feature is not enabled". That diagnosis was a guess, and
    // it was wrong: `entitiesService` gates at the ROUTE layer, not the service,
    // so an off toggle does NOT make this throw. What actually threw was a
    // schema defect in the tutorial type — and because the operator was told a
    // confident, plausible, wrong cause on every run, the dead kernel lane
    // stayed invisible for the program's whole lifetime. A blanket catch may
    // decide the SEVERITY of a failure; it must never invent its CAUSE.
    try {
      const r = await seedTutorials(tenantId);
      return { created: r.created, details: { updated: r.updated, skipped: r.skipped } };
    } catch (err) {
      return {
        created: 0,
        details: {
          skipped: 'tutorials could not be copied into this workspace — /tutorials still serves the shipped library',
          error: String(err),
        },
      };
    }
  },
  async clear(tenantId) {
    const r = await clearTutorialRows(tenantId);
    return { cleared: r.cleared, details: { note: 'reverted to the shipped tutorial text' } };
  },
};

const strategyShowcaseSeeder: ExampleDataSeeder = {
  id: 'strategy-showcase',
  label: 'Strategy showcase',
  description: 'A coherent fictional company ("Northwind AI") across Strategy + Priority Matrix + Board of Advisors: scored priority lists, strategies linked to those priorities, and a Board of Directors that carries the org strategies as context — so the board (or the Strategy Analyst) can access and analyze the whole plan. Requires the Strategy, Priority Matrix, and Board of Advisors features to be enabled.',
  dependsOn: ['advisors'],
  async count(tenantId) {
    return countStrategyShowcase(tenantId);
  },
  async seed(tenantId, storage) {
    const r = await seedStrategyShowcase(tenantId, storage);
    return {
      created: r.created,
      details: r.skipped ? { skipped: r.skipped } : r.details,
    };
  },
  async clear(tenantId, storage) {
    const r = await clearStrategyShowcase(tenantId, storage);
    return { cleared: r.cleared, details: r.details };
  },
};

const campaignShowcaseSeeder: ExampleDataSeeder = {
  id: 'campaign-showcase',
  label: 'Campaign Studio showcase',
  description: 'A coherent fictional DTC brand ("Solstice Roasters") across the Campaign Studio cluster: a Brand with a real voice profile + guardrails, two personas, a confirmed campaign brief carrying its messaging kernel, the finalized marketing campaign, a two-platform 14-day ad-performance series feeding the KPI and intelligence surfaces, and (when the Creative Briefs feature is enabled) one visual creative brief tied to the campaign. Requires the Campaign Brief, Campaign Orchestration, and Campaign Connectors features to be enabled (enabling them stays an explicit admin action — this seeder never flips toggles).',
  async count(tenantId) {
    return countCampaignShowcase(tenantId);
  },
  async seed(tenantId, storage) {
    const r = await seedCampaignShowcase(tenantId, storage);
    return {
      created: r.created,
      details: r.skipped ? { skipped: r.skipped } : r.details,
    };
  },
  async clear(tenantId, storage) {
    const r = await clearCampaignShowcase(tenantId, storage);
    return { cleared: r.cleared, details: r.details };
  },
};

const commerceShowcaseSeeder: ExampleDataSeeder = {
  id: 'commerce-showcase',
  label: 'Commerce showcase',
  description: 'The "Solstice Roasters" storefront (same fictional brand as the campaign showcase): four products spanning all three types — physical with variants + inventory, one deliberately low-stock so the alert surface lights up, a digital download, a service — plus a coupon and three orders exercising the lifecycle (pending / paid / delivered→fulfilled). Requires the E-Commerce feature to be enabled (enabling it stays an explicit admin action — this seeder never flips toggles).',
  async count(tenantId) {
    return countCommerceShowcase(tenantId);
  },
  async seed(tenantId) {
    return seedCommerceShowcase(tenantId);
  },
  async clear(tenantId) {
    return clearCommerceShowcase(tenantId);
  },
};

const demoCommerceDepthSeeder: ExampleDataSeeder = {
  id: 'demo-commerce-depth',
  label: 'Commerce depth (Solstice Roasters)',
  description: '24 products across 6 categories with images, variants, typed facet fields, and low-stock cases; 2 bundles; 3 subscribe-and-save products + 5 subscriptions; 3 per-company wholesale price lists; 4 coupons; 2 affiliates; 45 orders over 60 days with deliberate co-purchase patterns; and 8 quotes. Adds depth under distinct ids alongside the commerce-showcase. Requires the E-Commerce feature.',
  dependsOn: ['demo-media', 'demo-crm', 'commerce-showcase'],
  async count(tenantId) {
    return countDemoCommerceDepth(tenantId);
  },
  async seed(tenantId) {
    return seedDemoCommerceDepth(tenantId);
  },
  async clear(tenantId) {
    return clearDemoCommerceDepth(tenantId);
  },
};

const demoTerritoriesSeeder: ExampleDataSeeder = {
  id: 'demo-territories',
  label: 'Sales territories (Solstice Roasters)',
  description: '3 territory types, 1 active + 1 planning model (the one-active-pointer CAS), 8 territories in a 2-level West/East → metro hierarchy managed by the seeded reps, 6 first-match-wins assignment rules over company region/industry (then a reassignment), and 4 quarters of quotas per leaf with rep splits so attainment shows real numbers against the CRM deals. Requires the Sales Territories feature.',
  dependsOn: ['demo-people', 'demo-crm'],
  async count(tenantId) {
    return countDemoTerritories(tenantId);
  },
  async seed(tenantId) {
    return seedDemoTerritories(tenantId);
  },
  async clear(tenantId) {
    return clearDemoTerritories(tenantId);
  },
};

const demoOpsPlanningSeeder: ExampleDataSeeder = {
  id: 'demo-ops-planning',
  label: 'Ops & planning (Solstice Roasters)',
  description: '2 strategies whose KRs bind to LIVE seeded metrics (commerce revenue, deal total, conversions) + check-ins, 5 projects with kanban boards, 2 priority-matrix lists with 12 scored ideas + a planning session, 10 CSM accounts linked to CRM companies, the Iris assistant graph (stakeholders / commitments / decisions / meetings / 3 pending actions), and a Go-to-Market advisory board carrying a strategy as context. Strategy / priority-matrix / advisory-board / CSM require their toggles; projects + assistant are always-on.',
  dependsOn: ['demo-crm', 'demo-commerce-depth', 'demo-people'],
  async count(tenantId) {
    return countDemoOpsPlanning(tenantId);
  },
  async seed(tenantId) {
    return seedDemoOpsPlanning(tenantId);
  },
  async clear(tenantId, storage) {
    return clearDemoOpsPlanning(tenantId, storage);
  },
};

const demoContentMarketingSeeder: ExampleDataSeeder = {
  id: 'demo-content-marketing',
  label: 'Content & marketing (Solstice Roasters)',
  description: 'A Solstice brand kit, a 6-page CMS site (with a publish transition + an A/B experiment), 4 forms with UTM-tagged submissions, an email program (8 templates + 6 campaigns + engagement), the campaign brief→campaign cluster (one confirmed brief with a filled messaging kernel + 4 personas), and a 12-document library. Brand + CMS are always-on core; forms / email / campaign-brief / campaign-orchestration / documents each require their toggle and skip honestly.',
  dependsOn: ['demo-crm', 'demo-media', 'demo-commerce-depth'],
  async count(tenantId) {
    return countDemoContentMarketing(tenantId);
  },
  async seed(tenantId) {
    return seedDemoContentMarketing(tenantId);
  },
  async clear(tenantId) {
    return clearDemoContentMarketing(tenantId);
  },
};

const demoAppBuilderSeeder: ExampleDataSeeder = {
  id: 'demo-app-builder',
  label: 'App builder — a 5-screen mobile app (Aurora)',
  description: 'A populated `canvas.app-builder` app — Welcome → Login → Home → Profile → Settings, real components from the closed catalog, connectors with triggers/labels, and spread-out x/y — so the graph-first screen-flow board opens framed with a legible flow instead of a blank frame. Requires the `app-builder` toggle; skips honestly when off.',
  async count(tenantId) { return countDemoAppBuilder(tenantId); },
  async seed(tenantId) { return seedDemoAppBuilder(tenantId); },
  async clear(tenantId) { return clearDemoAppBuilder(tenantId); },
};

const demoCdpSeeder: ExampleDataSeeder = {
  id: 'demo-cdp',
  label: 'CDP — events, identity, consent, syncs, journey (Solstice Roasters)',
  description: 'Event schemas (one versioned), ~400 collected + ~1800 analytics events over 45 days with 40 identity links (so GoldenRecord / segment estimates / traits / attribution are non-empty), a consent policy + 40 records (some opted-out), CDC + event destination syncs with a purpose-label dry-run, a segment-enrolled journey with a 20% holdout, and scoped developer keys (only hashes persist). Each sub-step requires its feature toggle (cdp / consent / destination-sync / campaign-journeys / developer-keys) and skips honestly when off.',
  dependsOn: ['demo-crm', 'demo-commerce-depth'],
  async count(tenantId) {
    return countDemoCdp(tenantId);
  },
  async seed(tenantId) {
    return seedDemoCdp(tenantId);
  },
  async clear(tenantId) {
    return clearDemoCdp(tenantId);
  },
};

const demoMerchandisingSeeder: ExampleDataSeeder = {
  id: 'demo-merchandising',
  label: 'Merchandising — promotions, discovery, recos (Solstice Roasters)',
  description: 'Promotions (every type incl. a budget-capped loss leader and a scheduled sale), discovery collections + a one-level taxonomy + pin/boost/bury/hide merch rules (then an embeddings rebuild), and recommendation placements (then an affinity rebuild over the seeded orders). Each sub-step requires its feature toggle (promotions / discovery / recommendations) and skips honestly when off.',
  dependsOn: ['demo-commerce-depth'],
  async count(tenantId) {
    return countDemoMerchandising(tenantId);
  },
  async seed(tenantId) {
    return seedDemoMerchandising(tenantId);
  },
  async clear(tenantId) {
    return clearDemoMerchandising(tenantId);
  },
};

const demoDealersSeeder: ExampleDataSeeder = {
  id: 'demo-dealers',
  label: 'Dealer network (Solstice Roasters)',
  description: '8 reseller dealers over the CRM companies (channel tiers + one suspended partner), 1–3 retail outlets each with real lat/lng (which also drive the Sales Map pins), a partner-portal token per dealer, and deal registrations in mixed states (pending / approved / rejected). Requires the Dealers feature.',
  dependsOn: ['demo-crm'],
  async count(tenantId) {
    return countDemoDealers(tenantId);
  },
  async seed(tenantId) {
    return seedDemoDealers(tenantId);
  },
  async clear(tenantId) {
    return clearDemoDealers(tenantId);
  },
};

const demoSalesCommissionsSeeder: ExampleDataSeeder = {
  id: 'demo-sales-commissions',
  label: 'Sales commissions (Solstice Roasters)',
  description: 'An AE commission plan (6% of won-deal value, a 9% accelerator past quota, a per-period cap) plus a computed statement per rep for the quarter(s) they actually closed deals — real numbers, with one statement walked through draft → approved → paid. Requires the Sales Commissions feature.',
  dependsOn: ['demo-people', 'demo-crm', 'demo-territories'],
  async count(tenantId) {
    return countDemoCommissions(tenantId);
  },
  async seed(tenantId) {
    return seedDemoCommissions(tenantId);
  },
  async clear(tenantId) {
    return clearDemoCommissions(tenantId);
  },
};

const demoSalesMapsSeeder: ExampleDataSeeder = {
  id: 'demo-sales-maps',
  label: 'Sales map (Solstice Roasters)',
  description: 'Warms the sales-map geocode cache with manual points for the demo metros. The visible map pins come from the dealer outlets (seeded by demo-dealers) and the choropleth from territory attainment (demo-territories) — no external geocoder is ever called. Requires the Sales Maps feature.',
  dependsOn: ['demo-dealers', 'demo-territories'],
  async count(tenantId) {
    return countDemoSalesMaps(tenantId);
  },
  async seed(tenantId) {
    return seedDemoSalesMaps(tenantId);
  },
  async clear(tenantId) {
    return clearDemoSalesMaps(tenantId);
  },
};

const demoProductionSeeder: ExampleDataSeeder = {
  id: 'demo-production',
  label: 'Production intelligence (Solstice Roasters)',
  description: '5 external creative vendors (video / photography / branding / copy / audio contractors + agencies with capabilities, price ranges and quality ratings) plus 2 asset-production plans — an approved Spring-launch plan and a draft holiday plan routing each asset internal / contractor / agency / hybrid. Requires the Production Intelligence feature.',
  dependsOn: ['demo-people', 'demo-crm'],
  async count(tenantId) {
    return countDemoProduction(tenantId);
  },
  async seed(tenantId) {
    return seedDemoProduction(tenantId);
  },
  async clear(tenantId) {
    return clearDemoProduction(tenantId);
  },
};

const ucpReferenceMerchantSeeder: ExampleDataSeeder = {
  id: 'ucp-reference-merchant',
  label: 'UCP reference merchant',
  description: 'A demo reach:\'mcp\' merchant (ADR 0260) — a real, conformant UCP-over-MCP merchant projecting commerce, plus a workspace Connection so the UCP buyer can be pointed at it to VALIDATE the ucp.<op> convention (ADR 0258) end-to-end. The merchant only serves when its dev route is enabled (OPENWOP_UCP_REF_MERCHANT_ENABLED); it moves NO money (checkout creates a PENDING, unpaid order).',
  dependsOn: ['commerce-showcase'],
  async count(tenantId) {
    return countUcpReferenceMerchant(tenantId);
  },
  async seed(tenantId) {
    return seedUcpReferenceMerchant(tenantId);
  },
  async clear(tenantId) {
    return clearUcpReferenceMerchant(tenantId);
  },
};

/** The registry. Order = seed order (dependencies first). */
const demoKicktodoSeeder: ExampleDataSeeder = {
  id: 'demo-kicktodo',
  label: 'KickTodo challenges',
  description:
    'Three published challenges (Sleep Reset, Deep Work, Morning Movement) plus one enrollment, so Discover, Today, Plan, Progress and Journal all render real content. Skipped when the kicktodo-core toggle is off.',
  count: (tenantId) => countDemoKicktodo(tenantId),
  seed: (tenantId) => seedDemoKicktodo(tenantId),
  clear: (tenantId) => clearDemoKicktodo(tenantId),
};

export const EXAMPLE_DATA_SEEDERS: readonly ExampleDataSeeder[] = [demoPeopleSeeder, demoMediaSeeder, agentsSeeder, advisorsSeeder, workforcesSeeder, demoCrmSeeder, demoTerritoriesSeeder, demoDealersSeeder, demoSalesCommissionsSeeder, demoSalesMapsSeeder, demoProductionSeeder, cmsHomepageSeeder, featurePagesSeeder, comparisonPageSeeder, marketingContentPagesSeeder, marketingLegalPagesSeeder, workflowAuthorSeeder, demoWalkthroughsSeeder, tutorialsSeeder, strategyShowcaseSeeder, campaignShowcaseSeeder, commerceShowcaseSeeder, demoCommerceDepthSeeder, demoMerchandisingSeeder, demoCdpSeeder, demoEntitiesSeeder, demoContentMarketingSeeder, demoOpsPlanningSeeder, demoAppBuilderSeeder, ucpReferenceMerchantSeeder, demoJobSearchSeeder, demoKicktodoSeeder];

export interface ExampleDataStepStatus {
  id: string;
  label: string;
  description: string;
  count: number;
}

/** Per-step live counts for the dashboard. */
export async function exampleDataStatus(tenantId: string, storage: Storage): Promise<ExampleDataStepStatus[]> {
  return Promise.all(
    EXAMPLE_DATA_SEEDERS.map(async (s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      count: await s.count(tenantId, storage).catch(() => 0),
    })),
  );
}

/** Resolve a requested step-id list to seeders, preserving registry order.
 *  Unknown ids are ignored; an empty/absent list means ALL steps. */
function selected(steps?: readonly string[]): ExampleDataSeeder[] {
  if (!steps || steps.length === 0) return [...EXAMPLE_DATA_SEEDERS];
  const want = new Set(steps);
  return EXAMPLE_DATA_SEEDERS.filter((s) => want.has(s.id));
}

/**
 * Resolve the selection for SEEDING: the named steps PLUS their transitive
 * `dependsOn` ancestors, in registry order (grade-data, the #1348/#1356 review
 * finding): `dependsOn` was documentation only, so seeding a step without its
 * substrate (demo-media without demo-people's org) stranded rows under fallback
 * scopes. Ancestors are safe to auto-run — every seeder is idempotent, so an
 * already-seeded ancestor just reports `skipped`. Unknown ids are ignored
 * (existing behavior); the visited-set makes a dependency cycle harmless.
 * CLEARING deliberately does NOT expand (`selected` above): a destructive
 * operation never grows beyond the explicit selection (architect ruling).
 */
function selectedForSeed(steps?: readonly string[]): { steps: ExampleDataSeeder[]; autoIncluded: ReadonlySet<string> } {
  if (!steps || steps.length === 0) return { steps: [...EXAMPLE_DATA_SEEDERS], autoIncluded: new Set() };
  const byId = new Map(EXAMPLE_DATA_SEEDERS.map((s) => [s.id, s]));
  const want = new Set<string>();
  const visit = (id: string): void => {
    if (want.has(id)) return;
    const s = byId.get(id);
    if (!s) return;
    want.add(id);
    for (const dep of s.dependsOn ?? []) visit(dep);
  };
  for (const id of steps) visit(id);
  const named = new Set(steps);
  const autoIncluded = new Set([...want].filter((id) => !named.has(id)));
  return { steps: EXAMPLE_DATA_SEEDERS.filter((s) => want.has(s.id)), autoIncluded };
}

function emptySummary(): RunSummary {
  return { created: 0, skipped: 0, cleared: 0, errors: 0, total: 0 };
}

/** Seed the selected steps (all when none given). `dryRun` writes nothing and
 *  reports the action each step WOULD take from its current count.
 *
 *  `onStep` is invoked with each `StepResult` the moment its seeder finishes —
 *  this is what lets the route STREAM per-step progress (ADR 0292). The full
 *  reseed makes hundreds of real service calls and runs well past the 30s
 *  request-timeout; a streaming caller flushes headers first (so the timeout
 *  becomes a no-op) and forwards each `onStep` event, dodging both the 30s
 *  middleware and the ~60s `/api` proxy budget. Non-streaming callers just omit
 *  `onStep` and read the aggregate `RunResult` — same values, one JSON body. */
export async function runExampleDataSeed(
  tenantId: string,
  storage: Storage,
  opts: {
    steps?: readonly string[];
    dryRun?: boolean;
    onStep?: (result: StepResult) => void | Promise<void>;
  } = {},
): Promise<RunResult> {
  const dryRun = opts.dryRun === true;
  const results: StepResult[] = [];
  const summary = emptySummary();

  // LEAK-7: honor the documented `OPENWOP_DEMO_SEED_ENABLED=false` kill-switch
  // for EVERY seeder, not just the agents seeder. SEEDING.md / WHITE-LABEL.md
  // promise this flag removes seeding entirely; a hardened deploy must not be
  // able to `POST /example-data/run` synthetic workforce/workflow-author data.
  if (!exampleDataSeedEnabled()) {
    return { success: true, dryRun, results: [], summary };
  }

  // Record a completed step: push it to the aggregate AND emit it live. Emitter
  // errors (e.g. a client that hung up mid-stream) must never abort seeding —
  // the seed is idempotent and finishing it leaves the tenant consistent.
  const record = async (result: StepResult): Promise<void> => {
    results.push(result);
    if (opts.onStep) {
      try {
        await opts.onStep(result);
      } catch {
        /* client disconnected / write failed — keep seeding to completion */
      }
    }
  };

  const { steps, autoIncluded } = selectedForSeed(opts.steps);
  for (const s of steps) {
    summary.total += 1;
    const auto = autoIncluded.has(s.id) ? ({ autoIncluded: true } as const) : {};
    try {
      if (dryRun) {
        const have = await s.count(tenantId, storage);
        const action: SeedAction = have > 0 ? 'skipped' : 'created';
        if (action === 'created') summary.created += 1; else summary.skipped += 1;
        await record({
          step: s.id, label: s.label, action, ...auto,
          message: have > 0 ? `${have} already present — would skip` : 'would create',
          details: { present: have },
        });
        continue;
      }
      const { created, details } = await s.seed(tenantId, storage);
      const action: SeedAction = created > 0 ? 'created' : 'skipped';
      if (created > 0) summary.created += 1; else summary.skipped += 1;
      await record({
        step: s.id, label: s.label, action, ...auto,
        message: created > 0 ? `${created} created` : 'already present — skipped',
        ...(details ? { details } : {}),
      });
    } catch (err) {
      summary.errors += 1;
      await record({
        step: s.id, label: s.label, action: 'error', ...auto,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { success: summary.errors === 0, dryRun, results, summary };
}

/** Clear the selected steps (all when none given). Never dry-run (destructive
 *  actions are confirmed in the UI instead). */
export async function runDemoClear(
  tenantId: string,
  storage: Storage,
  opts: { steps?: readonly string[]; onStep?: (result: StepResult) => void | Promise<void> } = {},
): Promise<RunResult> {
  const results: StepResult[] = [];
  const summary = emptySummary();
  // Record a completed step + emit it live (streaming). An emitter error (client
  // hung up) must never abort the clear — each seeder's clear is idempotent, so
  // finishing leaves the tenant consistent.
  const record = async (result: StepResult): Promise<void> => {
    results.push(result);
    if (opts.onStep) {
      try { await opts.onStep(result); } catch { /* client gone — keep clearing */ }
    }
  };
  // Clear in reverse registry order so dependents go before their dependencies.
  for (const s of selected(opts.steps).reverse()) {
    summary.total += 1;
    try {
      const { cleared, details } = await s.clear(tenantId, storage);
      summary.cleared += cleared > 0 ? 1 : 0;
      if (cleared === 0) summary.skipped += 1;
      await record({
        step: s.id, label: s.label,
        action: cleared > 0 ? 'cleared' : 'skipped',
        message: cleared > 0 ? `${cleared} cleared` : 'nothing to clear',
        ...(details ? { details } : {}),
      });
    } catch (err) {
      summary.errors += 1;
      await record({
        step: s.id, label: s.label, action: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { success: summary.errors === 0, dryRun: false, results, summary };
}
