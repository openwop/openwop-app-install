/**
 * `demo-job-search` seeder (ADR 0539 / ADR 0540).
 *
 * The job-search vertical showcase: a NON-REVENUE pipeline (ADR 0540 D3) with
 * applications as real CRM deals across the funnel, each carrying a job digest
 * (ADR 0540 D2).
 *
 * Honesty notes:
 * - Applications are created through `crmEntitiesService`, never a direct
 *   collection write, so CRM's own authz, validation and stage-history apply
 *   (the Forms→`crmService` precedent). What the demo shows is what the product
 *   does.
 * - The pipeline is created `non-revenue`, which is the whole point: the Reports
 *   tab over it must show counts and no currency rollup. A `revenue` demo
 *   pipeline would showcase the exact dishonesty ADR 0540 D3 exists to remove.
 * - Salaries ARE seeded on the deals. D3 suppresses the ROLLUP, not the record,
 *   and a demo with no salaries would fail to demonstrate that distinction.
 * - Toggle-gated: skips honestly when `job-search` is off, and never flips it.
 */
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { createPipeline, listPipelines, createDeal, listDeals, deleteDeal } from '../features/crm/crmEntitiesService.js';
import { jobDigests, type JobDigest } from '../features/job-search/domain/digest.js';
import { JOB_SEARCH_TOGGLE } from '../features/job-search/service.js';

const log = createLogger('seed.demoJobSearch');

const PIPELINE_NAME = 'Job search';
const DEMO_PREFIX = 'deal:demo-jobsearch-';

const STAGES = [
  { name: 'Applied', probability: 10 },
  { name: 'Screening', probability: 30 },
  { name: 'Interviewing', probability: 60 },
  { name: 'Offer', probability: 90 },
];

/** Deterministic ids (ADR 0162) — re-running the seeder must not mint a second
 *  copy of the same application. */
const APPLICATIONS = [
  {
    slug: 'staff-backend',
    title: 'Staff Backend Engineer',
    company: 'Northwind Systems',
    stageIdx: 2,
    amount: 195_000,
    digest: {
      skills: ['typescript', 'postgres', 'kubernetes'],
      requirements: ['8+ years backend', 'distributed systems'],
      responsibilities: ['own the ingestion pipeline', 'mentor engineers'],
      remote: true,
      location: 'Remote (US)',
      sponsorship: 'silent' as const,
    },
  },
  {
    slug: 'platform-lead',
    title: 'Platform Engineering Lead',
    company: 'Harbor Analytics',
    stageIdx: 1,
    amount: 210_000,
    digest: {
      skills: ['go', 'terraform', 'aws'],
      requirements: ['team leadership', 'IaC at scale'],
      responsibilities: ['lead a platform team of six'],
      remote: false,
      location: 'Austin, TX',
      sponsorship: 'offered' as const,
    },
  },
  {
    slug: 'senior-fullstack',
    title: 'Senior Full-Stack Engineer',
    company: 'Cobalt Health',
    stageIdx: 0,
    amount: 175_000,
    digest: {
      skills: ['typescript', 'react', 'postgres'],
      requirements: ['product sense', 'HIPAA-adjacent experience'],
      responsibilities: ['ship patient-facing features'],
      remote: true,
      location: 'Remote (US)',
      sponsorship: 'silent' as const,
    },
  },
  {
    slug: 'principal-eng',
    title: 'Principal Engineer, Infrastructure',
    company: 'Meridian Freight',
    stageIdx: 3,
    amount: 240_000,
    digest: {
      skills: ['rust', 'observability', 'postgres'],
      requirements: ['principal-level scope'],
      responsibilities: ['set infrastructure direction'],
      remote: false,
      location: 'Chicago, IL',
      sponsorship: 'not-offered' as const,
    },
  },
];

async function enabled(tenantId: string): Promise<boolean> {
  // `bucketUnit: 'tenant'` ⇒ the tenantId is a complete subject; there is no
  // principal in a seeding pass and none is needed.
  const assignment = await resolveOne(JOB_SEARCH_TOGGLE, { tenantId });
  return assignment?.enabled === true;
}

async function firstOrgId(tenantId: string): Promise<string | null> {
  const orgs = await listOrgs(tenantId);
  return orgs[0]?.orgId ?? null;
}

export async function countDemoJobSearch(tenantId: string): Promise<number> {
  const orgId = await firstOrgId(tenantId);
  if (!orgId) return 0;
  const deals = await listDeals(tenantId, orgId, {});
  return deals.filter((d) => d.dealId.startsWith(DEMO_PREFIX)).length;
}

export async function seedDemoJobSearch(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await enabled(tenantId))) {
    log.info('job_search_seed_skipped_toggle_off', { tenantId });
    return { created: 0, details: { skipped: 'toggle-off' } };
  }
  const orgId = await firstOrgId(tenantId);
  if (!orgId) return { created: 0, details: { skipped: 'no-org' } };

  const existing = await listPipelines(tenantId, orgId);
  const pipeline =
    existing.find((p) => p.name === PIPELINE_NAME) ??
    // The load-bearing argument: `non-revenue` (ADR 0540 D3).
    (await createPipeline(tenantId, orgId, PIPELINE_NAME, STAGES, 'non-revenue', { actor: 'demo:job-search', silent: true })); // ADR 0627 D2 — seeds are silent

  const deals = await listDeals(tenantId, orgId, {});
  const have = new Set(deals.map((d) => d.dealId));
  let created = 0;

  for (const app of APPLICATIONS) {
    const dealId = `${DEMO_PREFIX}${app.slug}`;
    if (have.has(dealId)) continue;
    const stage = pipeline.stages[app.stageIdx] ?? pipeline.stages[0];
    if (!stage) continue;

    await createDeal({
      tenantId,
      orgId,
      dealId,
      title: `${app.title} — ${app.company}`,
      pipelineId: pipeline.pipelineId,
      stageId: stage.stageId,
      amount: app.amount,
      currency: 'USD',
      createdBy: 'demo:job-search',
      validateCompany: async () => true,
      validateContact: async () => true,
      silent: true, // ADR 0627 D2 — a seed is a bulk lane
    });

    const digest: JobDigest = {
      dealId,
      tenantId,
      version: 1,
      title: app.title,
      companyName: app.company,
      location: app.digest.location,
      remote: app.digest.remote,
      skills: app.digest.skills,
      requirements: app.digest.requirements,
      responsibilities: app.digest.responsibilities,
      descriptionExcerpt: `${app.title} at ${app.company}.`,
      employmentType: 'w2',
      sponsorship: app.digest.sponsorship,
      citizenshipRequirementQuote: null,
      clearanceRequirementQuote: null,
      sponsorshipQuote:
        app.digest.sponsorship === 'not-offered'
          ? 'We are unable to sponsor or take over sponsorship of an employment visa at this time.'
          : null,
      salaryMin: app.amount - 20_000,
      salaryMax: app.amount + 20_000,
      currency: 'USD',
      sourceUrl: null,
      capturedAt: new Date(0).toISOString(),
    };
    await jobDigests.put(digest);
    created += 1;
  }

  return { created, details: { pipelineId: pipeline.pipelineId, kind: 'non-revenue' } };
}

export async function clearDemoJobSearch(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await firstOrgId(tenantId);
  if (!orgId) return { cleared: 0 };
  const deals = await listDeals(tenantId, orgId, {});
  let cleared = 0;
  for (const d of deals) {
    // Only the canonical demo rows — never user-authored applications.
    if (!d.dealId.startsWith(DEMO_PREFIX)) continue;
    // Delete the digest FIRST: it is keyed by the deal, so removing the deal
    // first would strand it as an orphan with no owner to find it by.
    await jobDigests.delete(`${tenantId}:${d.dealId}:1`);
    await deleteDeal(tenantId, orgId, d.dealId);
    cleared += 1;
  }
  return { cleared };
}
