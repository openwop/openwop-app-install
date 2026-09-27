/**
 * `demo-production` seeder (ADR 0172 — Production Intelligence).
 *
 * NOT manufacturing/roasting: "Production" here is the Studio feature that plans
 * how Solstice Roasters produces its MARKETING assets — a directory of external
 * creative vendors (video/photography/branding/copy/audio contractors + agencies
 * with capabilities, price ranges and quality ratings) plus AI production PLANS
 * that route each asset internal/contractor/agency/hybrid. Seeds 5 vendors + 2
 * plans (an approved Spring-launch plan and a draft holiday plan).
 * `dependsOn: ['demo-people','demo-crm']` (team profiles for internal-match
 * context; CRM only as an optional vendor company link — left unset here).
 *
 * Toggle-gated on `production`; skips honestly (never flips). Vendors carry
 * `createdBy` → anchored on the demo actor. Plans have no `createdBy` and are
 * keyed by a GLOBAL `planId`, so demo plan ids fold a tenant hash (cross-tenant
 * collision guard) and count/clear select the `pln:demo-production-<tid>-` set.
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import {
  createVendor, listVendors, deleteVendor,
  savePlan, listPlans, transitionPlan,
} from '../features/production/productionService.js';
import { demoCrmTid } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoProduction');

export const DEMO_PRODUCTION_ACTOR = 'demo:production';
// `:`-separated (NOT all-hyphen) so the id is never a 40+char `[A-Za-z0-9_-]` run:
// savePlan runs planId through the secret-shape scrubber, which would redact a
// long hyphen-only id and fall back to a random uuid (losing the demo prefix).
const planIdPrefix = (tenantId: string): string => `pln:demo-production:${demoCrmTid(tenantId)}:`;
const demoPlanId = (tenantId: string, slug: string): string => `${planIdPrefix(tenantId)}${slug}`;

/** Demo plans for a tenant — the feature's own `listPlans` filtered by the demo
 *  id prefix (which folds the tenant hash). `seed()` warms the plan index once
 *  before writing (as `listVendors` does for vendors), so this read is stable. */
async function demoPlans(tenantId: string, orgId: string): Promise<{ planId: string; status: string }[]> {
  return (await listPlans(tenantId, orgId)).filter((p) => p.planId.startsWith(planIdPrefix(tenantId)));
}

const VENDORS = [
  {
    name: 'Roast & Reel Studio', type: 'contractor', region: 'West', contractStatus: 'preferred',
    capabilities: [{ name: 'Product & brand video', category: 'video', qualityRating: 5 }, { name: 'Motion graphics', category: 'video', qualityRating: 4 }],
    priceRanges: [{ capability: 'Product & brand video', min: 4000, max: 12000, unit: 'per-project' }],
    pastProjects: [{ projectId: 'p1', name: 'Spring cold-brew launch reel' }],
  },
  {
    name: 'Amber Light Photography', type: 'contractor', region: 'West', contractStatus: 'preferred',
    capabilities: [{ name: 'Packaging & product photography', category: 'photography', qualityRating: 5 }],
    priceRanges: [{ capability: 'Packaging & product photography', min: 1800, max: 6000, unit: 'per-project' }],
    pastProjects: [{ projectId: 'p1', name: 'Single-origin packaging shoot' }],
  },
  {
    name: 'Northbrew Creative', type: 'agency', region: 'East', contractStatus: 'active',
    capabilities: [{ name: 'Brand strategy', category: 'strategy', qualityRating: 4 }, { name: 'Campaign design', category: 'design', qualityRating: 4 }, { name: 'Social content', category: 'social-media', qualityRating: 4 }],
    priceRanges: [{ capability: 'Brand strategy', min: 6000, max: 20000, unit: 'per-month' }],
    pastProjects: [{ projectId: 'p1', name: 'Wholesale rebrand sprint' }],
  },
  {
    name: 'Copper Kettle Copy', type: 'contractor', region: 'West', contractStatus: 'active',
    capabilities: [{ name: 'Blog & email copywriting', category: 'writing', qualityRating: 4 }],
    priceRanges: [{ capability: 'Blog & email copywriting', min: 0.6, max: 1.2, unit: 'per-word' }],
    pastProjects: [{ projectId: 'p1', name: 'Origin-story blog series' }],
  },
  {
    name: 'Meridian Sound', type: 'contractor', region: 'East', contractStatus: 'inactive',
    capabilities: [{ name: 'Podcast & audio production', category: 'audio', qualityRating: 3 }],
    priceRanges: [{ capability: 'Podcast & audio production', min: 800, max: 3000, unit: 'per-project' }],
    pastProjects: [],
  },
] as const;

interface DemoPlan {
  slug: string;
  strategySummary: string;
  status: 'draft' | 'approved';
  recommendations: { assetType: string; assetDescription: string; executionRoute: string; rationale: string; budget: { min: number; max: number; currency: string }; timelineEstimate: string }[];
  totalBudget: { min: number; max: number; currency: string };
  timeline: string;
  capabilityAssessment: { strengths: string[]; gaps: string[]; overallRecommendation: string; confidence: number };
}

const PLANS: readonly DemoPlan[] = [
  {
    slug: 'spring-launch', status: 'approved',
    strategySummary: 'Spring cold-brew launch — produce the hero video, packaging photography, and a two-week social burst; keep copy and email in-house.',
    recommendations: [
      { assetType: 'Hero launch video', assetDescription: '30s brand film + 3 social cutdowns', executionRoute: 'contractor', rationale: 'No in-house video capability; Roast & Reel is a preferred 5★ partner.', budget: { min: 6000, max: 10000, currency: 'USD' }, timelineEstimate: '3 weeks' },
      { assetType: 'Packaging photography', assetDescription: 'Cold-brew bottle + lifestyle set', executionRoute: 'contractor', rationale: 'Specialist product photographer beats internal for pack shots.', budget: { min: 2000, max: 4000, currency: 'USD' }, timelineEstimate: '1 week' },
      { assetType: 'Social campaign', assetDescription: '2-week paid + organic burst', executionRoute: 'hybrid', rationale: 'Agency concepts + in-house community management.', budget: { min: 3000, max: 6000, currency: 'USD' }, timelineEstimate: '2 weeks' },
      { assetType: 'Email + landing copy', assetDescription: '4-email launch flow + landing page', executionRoute: 'internal', rationale: 'In-house copy owns the brand voice.', budget: { min: 0, max: 0, currency: 'USD' }, timelineEstimate: '1 week' },
    ],
    totalBudget: { min: 11000, max: 20000, currency: 'USD' },
    timeline: '6 weeks',
    capabilityAssessment: { strengths: ['Strong in-house brand voice + copy', 'Established social channels'], gaps: ['Video production', 'Motion design'], overallRecommendation: 'Route video + photography to specialist contractors; keep copy and social ops in-house.', confidence: 0.8 },
  },
  {
    slug: 'holiday-gift', status: 'draft',
    strategySummary: 'Holiday gift-set campaign — plan the asset mix for the gift bundle push (draft; awaiting budget sign-off).',
    recommendations: [
      { assetType: 'Gift-guide photography', assetDescription: 'Bundle + gifting lifestyle set', executionRoute: 'contractor', rationale: 'Reuse the preferred product photographer.', budget: { min: 2500, max: 4500, currency: 'USD' }, timelineEstimate: '1 week' },
      { assetType: 'Email + landing copy', assetDescription: '4-email holiday flow + landing page', executionRoute: 'internal', rationale: 'In-house copy owns the brand voice.', budget: { min: 0, max: 0, currency: 'USD' }, timelineEstimate: '1 week' },
    ],
    totalBudget: { min: 2500, max: 4500, currency: 'USD' },
    timeline: '4 weeks',
    capabilityAssessment: { strengths: ['In-house copy', 'Existing photography partner'], gaps: ['Gift-guide art direction'], overallRecommendation: 'Mostly internal; contract photography only.', confidence: 0.7 },
  },
];

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

export async function countDemoProduction(tenantId: string): Promise<number> {
  const orgId = await orgIdFor(tenantId);
  const vendors = (await listVendors(tenantId, orgId)).filter((v) => v.createdBy === DEMO_PRODUCTION_ACTOR).length;
  const plans = (await demoPlans(tenantId, orgId)).length;
  return vendors + plans;
}

export async function seedDemoProduction(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await resolveOne('production', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'production feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  let vendors = 0;
  let plans = 0;

  const existingVendorNames = new Set((await listVendors(tenantId, orgId)).filter((v) => v.createdBy === DEMO_PRODUCTION_ACTOR).map((v) => v.name));
  for (const v of VENDORS) {
    if (existingVendorNames.has(v.name)) continue;
    await createVendor({ tenantId, orgId, createdBy: DEMO_PRODUCTION_ACTOR, type: v.type, name: v.name, region: v.region, contractStatus: v.contractStatus, capabilities: v.capabilities, priceRanges: v.priceRanges, pastProjects: v.pastProjects });
    vendors += 1;
  }

  // Reading existing plans first both (a) makes the loop idempotent — savePlan is
  // an upsert, so without this a re-seed would re-count every plan — and (b) warms
  // the plan tenant-index before writing (as `listVendors` warms the vendor one),
  // so each savePlan maintains the index incrementally instead of a post-burst
  // backfill dropping rows.
  const existingPlanIds = new Set((await listPlans(tenantId, orgId)).map((p) => p.planId));
  for (const p of PLANS) {
    const planId = demoPlanId(tenantId, p.slug);
    if (existingPlanIds.has(planId)) continue;
    await savePlan({ tenantId, orgId, planId, strategySummary: p.strategySummary, recommendations: p.recommendations, totalBudget: p.totalBudget, timeline: p.timeline, capabilityAssessment: p.capabilityAssessment });
    // savePlan always creates as 'draft'; nudge the approved demo plan forward.
    if (p.status === 'approved') await transitionPlan(tenantId, orgId, planId, 'approved', DEMO_PRODUCTION_ACTOR).catch(() => undefined);
    plans += 1;
  }

  const details = { vendors, plans };
  log.info('demo_production_seeded', { tenantId, created: vendors + plans, ...details });
  return { created: vendors + plans, details };
}

export async function clearDemoProduction(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  let cleared = 0;
  for (const v of (await listVendors(tenantId, orgId)).filter((x) => x.createdBy === DEMO_PRODUCTION_ACTOR)) {
    if (await deleteVendor(tenantId, orgId, v.vendorId)) cleared += 1;
  }
  // Plans have no delete API — a local direct store handle, scoped by the demo id
  // prefix. Constructed here (not module scope) so the seeder never stands up a
  // second long-lived instance of the feature's own collection.
  const planStore = new DurableCollection<{ planId: string; tenantId: string }>('production:plan', (p) => p.planId, undefined, (p) => p.tenantId);
  for (const p of await demoPlans(tenantId, orgId)) {
    await planStore.delete(p.planId); cleared += 1;
  }
  log.info('demo_production_cleared', { tenantId, cleared });
  return { cleared };
}
