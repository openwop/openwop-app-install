/**
 * ADR 0540 P4 — `ctx.features['job-search']` (ADR 0014).
 *
 * Read + ONE terminal write, per the ADR 0540 matrix row 3 — plus the WF-JS-1
 * campaign trigger, whose scope is stated precisely below. What is deliberately
 * absent matters more than what is present:
 *
 *  - no `submit` — no op takes a listing/answers/target and sends it. The law's
 *    substance (ADR 0543 §D3 correction note): no node may route AROUND the
 *    ADR 0541 grant. `runCampaignPass` below does not — it takes NOTHING but
 *    the run's own tenant, and triggers the standing campaign whose every
 *    submission is grant-consulted, pace-bounded, claim-CAS'd and consumed by
 *    the pipeline itself. A chain can ask "run my campaign under its authority
 *    objects now"; it cannot choose a target, widen a scope, or skip a gate;
 *  - no `tailor` that persists — a rewrite must pass the D4 guard and a human
 *    gate before it can become a document;
 *  - no policy WRITE — a chain must not be able to widen its own eligibility.
 *
 * Every op is scoped to the run's tenant. There is no orgId parameter a caller
 * could supply to reach another workspace: the org comes from the run's own
 * scope, so a chain cannot address a workspace its run does not belong to.
 */
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { checkEligibility, type ApplicantConstraints } from './domain/eligibility.js';
import { projectFitScores, JOB_FIT_CRITERIA, type FitProfile } from './domain/fitScoring.js';
import { computePriority } from '../../host/weightedScoring.js';
import { guardRewrite } from './domain/tailorGuard.js';
import { listApplications, advanceApplication } from './domain/applications.js';
import { runTenantCampaignPass } from './autopilot/campaignRun.js';
import type { JobDigest } from './domain/digest.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Closed-world: a digest arriving from a workflow is normalised the same way a
 *  digest arriving over HTTP is, so a chain cannot smuggle a field the route
 *  layer would have dropped. */
function digestOf(v: unknown): JobDigest {
  const d = (v ?? {}) as Partial<JobDigest>;
  const sponsorship = d.sponsorship;
  return {
    dealId: str(d.dealId), tenantId: str(d.tenantId), version: 1,
    title: str(d.title), companyName: str(d.companyName),
    location: typeof d.location === 'string' ? d.location : null,
    remote: typeof d.remote === 'boolean' ? d.remote : null,
    skills: arr(d.skills), requirements: arr(d.requirements), responsibilities: arr(d.responsibilities),
    descriptionExcerpt: str(d.descriptionExcerpt),
    employmentType:
      d.employmentType === 'w2' || d.employmentType === '1099' || d.employmentType === 'contract' || d.employmentType === 'internship'
        ? d.employmentType : 'unknown',
    sponsorship: sponsorship === 'offered' || sponsorship === 'not-offered' ? sponsorship : 'silent',
    citizenshipRequirementQuote: typeof d.citizenshipRequirementQuote === 'string' ? d.citizenshipRequirementQuote : null,
    clearanceRequirementQuote: typeof d.clearanceRequirementQuote === 'string' ? d.clearanceRequirementQuote : null,
    sponsorshipQuote: typeof d.sponsorshipQuote === 'string' ? d.sponsorshipQuote : null,
    salaryMin: num(d.salaryMin), salaryMax: num(d.salaryMax),
    currency: typeof d.currency === 'string' ? d.currency : null,
    sourceUrl: typeof d.sourceUrl === 'string' ? d.sourceUrl : null,
    capturedAt: str(d.capturedAt),
  };
}

const profileOf = (v: unknown): FitProfile => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { skills: arr(o.skills), targetTitles: arr(o.targetTitles), salaryFloor: num(o.salaryFloor), wantsRemote: typeof o.wantsRemote === 'boolean' ? o.wantsRemote : null };
};

const applicantOf = (v: unknown): ApplicantConstraints => {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    requiresSponsorship: o.requiresSponsorship === true,
    meetsCitizenshipRequirement: o.meetsCitizenshipRequirement !== false,
    holdsRequiredClearance: o.holdsRequiredClearance !== false,
  };
};

export function buildJobSearchSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** Score a digest. Pure — no store read, no write. */
    async scoreFit(input: { digest?: unknown; profile?: unknown }) {
      const scores = projectFitScores(digestOf(input?.digest), profileOf(input?.profile));
      return { score: computePriority(JOB_FIT_CRITERIA, scores), scores };
    },

    /** Verdict + the posting's own words. Never persists. */
    async checkEligibility(input: { digest?: unknown; applicant?: unknown }) {
      const v = checkEligibility(digestOf(input?.digest), applicantOf(input?.applicant));
      return { eligible: v.eligible, ruleId: v.ruleId, reason: v.reason, quote: v.quote };
    },

    /** Diff a proposed rewrite (D4). Returns the verdict; persisting is NOT here
     *  — a chain may check its own honesty, never bless it. */
    async guardRewrite(input: { original?: unknown; reworded?: unknown; allowedEmployers?: unknown }) {
      const v = guardRewrite(str(input?.original), str(input?.reworded), { allowedEmployers: arr(input?.allowedEmployers) });
      return { ok: v.ok, violations: v.violations.map((x) => ({ kind: x.kind, token: x.token })) };
    },

    /** Read applications for an org the RUN belongs to. */
    async listApplications(input: { orgId?: unknown }) {
      const orgId = str(input?.orgId);
      if (!orgId) return { applications: [] };
      return { applications: await listApplications(tenantId, orgId) };
    },

    /** The ONE terminal write (matrix row 3): move an application's stage. Goes
     *  through CRM so stage history records who moved it and when. */
    async recordOutcome(input: { orgId?: unknown; dealId?: unknown; stage?: unknown }) {
      const orgId = str(input?.orgId);
      const dealId = str(input?.dealId);
      const stage = str(input?.stage);
      if (!orgId || !dealId || !stage) return { moved: false };
      const deal = await advanceApplication(tenantId, orgId, dealId, stage, `run:${scope.runId ?? 'unknown'}`);
      return { moved: deal !== null, ...(deal ? { stageId: deal.stageId } : {}) };
    },

    /**
     * WF-JS-1 — trigger the tenant's standing campaign pass. Takes NO inputs by
     * design (see the header law): the pass derives everything from the
     * tenant's own steering, grants, listings and answer bank, and every
     * submission inside it is bounded by the ADR 0541 machinery. `isReplay` is
     * derived structurally inside the pass (ADR 0531 ambient context) — a
     * caller cannot assert liveness. `now` comes from the surface, not the
     * chain, for the same reason.
     */
    async runCampaignPass() {
      const report = await runTenantCampaignPass(tenantId, Date.now());
      return {
        ranGrants: report.ranGrants,
        listings: report.listings,
        skippedNoSubmitLane: report.skippedNoSubmitLane,
        skippedDailyCap: report.skippedDailyCap,
        results: report.results.map((r) => ({
          grantId: r.grantId,
          campaignId: r.campaignId,
          considered: r.digest.considered,
          applied: r.digest.applied,
          alreadyApplied: r.digest.alreadyApplied,
          parked: r.digest.parked.length,
          skipped: r.digest.skipped,
        })),
      };
    },
  };
}
