/**
 * Campaign-journeys workflow surface (ADR 0222 / ADR 0014) — the two verbs the
 * journey chains compose: the idempotent enrollment guard and the eligibility
 * composite. Read the module header in `journeyService.ts` for the doctrine.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { enroll, checkEligibility, listEnrollments, checkEngagement, checkFrequency, resolveSegment, type EnrollOptions } from './journeyService.js';
import { bucketOf } from '../../host/variantAssignment.js';
import type { MarketingChannel } from '../consent/consentService.js';

/** ADR 0267 / CDP-E — deterministic per-contact holdout/experiment split. Reuses
 *  the ONE shared bucketing primitive (`variantAssignment.bucketOf`), keyed on the
 *  contact (ruling #7). Pure + replay-stable: the same (contactId, experimentId)
 *  always yields the same arm, so a forked/replayed journey routes identically.
 *  `arm='control'` when the contact falls in the first `holdoutPct`% of buckets. */
export function holdoutArm(contactId: string, experimentId: string, holdoutPct: number): { arm: 'control' | 'treatment'; bucket: number } {
  const pct = Math.max(0, Math.min(100, holdoutPct));
  const bucket = bucketOf(contactId, experimentId || 'default', 'journey-holdout'); // 0..9999
  return { arm: bucket < pct * 100 ? 'control' : 'treatment', bucket };
}

const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

// ADR 0299: pull the arbitration inputs off the node args, building the options
// object with only the DEFINED keys (exactOptionalPropertyTypes-safe). An absent
// exclusivityGroup ⇒ enroll takes the unchanged ADR 0222 path.
const enrollOpts = (args: Record<string, unknown>): EnrollOptions => {
  const opts: EnrollOptions = {};
  if (typeof args.priority === 'number' && Number.isFinite(args.priority)) opts.priority = Math.trunc(args.priority);
  const group = optStr(args.exclusivityGroup);
  if (group) opts.exclusivityGroup = group;
  return opts;
};

// ADR 0227: optional per-channel consent ask; anything unrecognized falls back
// to the email default (the only shipped journey send channel).
const channelOf = (v: string | undefined): MarketingChannel => (v === 'sms' || v === 'push' ? v : 'email');

export function buildCampaignJourneysSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    enroll: async (args) => ({ ...(await enroll(tenantId, str(args.journeyId), str(args.contactId), optStr(args.runId), enrollOpts(args))) }),
    checkEligibility: async (args) => ({ ...(await checkEligibility(tenantId, str(args.contactId), channelOf(optStr(args.channel)))) }),
    listEnrollments: async (args) => ({ enrollments: await listEnrollments(tenantId, optStr(args.journeyId)) }),
    // ADR 0243 — journey-depth read verbs (tenant from the surface scope, never a node input).
    checkEngagement: async (args) => ({ ...(await checkEngagement(tenantId, str(args.contactId), optStr(args.campaignId))) }),
    checkFrequency: async (args) => ({ ...(await checkFrequency(tenantId, str(args.contactId), num(args.windowDays, 30), num(args.maxSends, 1))) }),
    resolveSegment: async (args) => ({ ...(await resolveSegment(tenantId, str(args.segmentId))) }),
    // ADR 0267 / CDP-E — journey experiment/holdout split (deterministic, replay-stable).
    bucketHoldout: async (args) => {
      const r = holdoutArm(str(args.contactId), str(args.experimentId), num(args.holdoutPct, 10));
      return { arm: r.arm, bucket: r.bucket, control: r.arm === 'control', treatment: r.arm === 'treatment' };
    },
  };
}
