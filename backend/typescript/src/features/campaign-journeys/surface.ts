/**
 * Campaign-journeys workflow surface (ADR 0222 / ADR 0014) — the two verbs the
 * journey chains compose: the idempotent enrollment guard and the eligibility
 * composite. Read the module header in `journeyService.ts` for the doctrine.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { enroll, checkEligibility, checkJourneyChannelEligibility, listEnrollments, checkEngagement, checkFrequency, resolveSegment, resolveEnrollmentOrg, type EnrollOptions } from './journeyService.js';
import { bucketOf } from '../../host/variantAssignment.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { getExperimentRow } from '../../host/experiments/store.js';
import { assignAt, readExperimentsRunStamp } from '../../host/experiments/runFreeze.js';
import { OpenwopError } from '../../types.js';
import { JOURNEY_SPLIT_SURFACE } from './experimentSurface.js';
import { assertRunScopeOrg } from '../../host/accessControlService.js';
import { runStampOf } from '../campaign-ops/surface.js';
import { checkSendWindow, smsSendContext, smsTemplateBody } from './smsSend.js';
import { journeySendTime } from './sendTime.js';
import type { MarketingChannel } from '../consent/consentService.js';

/**
 * ADR 0955 D1 (J9) — bind a journey verb's `orgId` to the run that calls it.
 *
 * The run's client comes from the host-written stamps ONLY, never from a node input: ADR
 * 0921's `openwop-app.campaignOps` (read through its owner, `runStampOf`) and ADR 0941's run
 * tag `campaignOrchestration.orgId`. Either one naming another client, or the two naming
 * different clients, is `wrong_client`. A run carrying neither (an event-triggered journey)
 * takes the chain's `orgId` (ADR 0955 D1, "from the enrolling surface"), and when the run
 * has a person behind it that person must be able to read that client.
 *
 * > The run-tag read is by key because ADR 0941's `readCampaignRunTag` is not on main yet
 * > (#5050). Replace this one line with it when #5050 lands; do not add a third reader.
 */
async function bindJourneyOrg(scope: BundleScope, orgId: string): Promise<void> {
  if (scope.runId) {
    const run = await hostExtStorage().getRun(scope.runId);
    if (!run || run.tenantId !== scope.tenantId) {
      throw new OpenwopError('forbidden_scope', 'The run this journey step belongs to could not be read.', 403, { reason: 'run_unreadable' });
    }
    const opsOrg = (await runStampOf(scope))?.orgId;
    const tag = (run.metadata as Record<string, unknown> | undefined)?.campaignOrchestration;
    const tagOrg = tag && typeof tag === 'object' && typeof (tag as { orgId?: unknown }).orgId === 'string' ? (tag as { orgId: string }).orgId : undefined;
    for (const stamped of [opsOrg, tagOrg]) {
      if (stamped !== undefined && stamped !== orgId) {
        throw new OpenwopError('forbidden_scope', 'This run belongs to a different client.', 403, { reason: 'wrong_client' });
      }
    }
  }
  if (orgId) await assertRunScopeOrg(scope, orgId, 'workspace:read');
}

/**
 * ADR 0955 D1 — the journey's client from a verb's args. An ABSENT org is `''`, which is NOT a
 * tenant-wide read: every verb resolves it through `resolveEnrollmentOrg`, which refuses `''`
 * (`client_required`) once the workspace has a client, and in a workspace with none the
 * workspace IS the only scope. Witnessed per verb by `adr0955-p0-channel-eligibility.test.ts`
 * ("an absent org is refused by every verb once the workspace has a client").
 */
const journeyOrgOf = (orgId: unknown): string => (typeof orgId === 'string' ? orgId.trim() : '');

const channelArg = (v: string | undefined): 'email' | 'sms' => {
  if (v === undefined || v === 'email') return 'email';
  if (v === 'sms') return 'sms';
  throw new OpenwopError('validation_error', '`channel` must be "email" or "sms".', 400, { field: 'channel' });
};
const purposeArg = (v: string | undefined): 'marketing' | 'transactional' => {
  if (v === undefined || v === 'marketing') return 'marketing';
  if (v === 'transactional') return 'transactional';
  throw new OpenwopError('validation_error', '`purpose` must be "marketing" or "transactional".', 400, { field: 'purpose' });
};

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
  const orgId = journeyOrgOf(args.orgId);
  if (orgId) opts.orgId = orgId;
  return opts;
};

// ADR 0227: optional per-channel consent ask; anything unrecognized falls back
// to the email default (the only shipped journey send channel).
const channelOf = (v: string | undefined): MarketingChannel => (v === 'sms' || v === 'push' ? v : 'email');

export function buildCampaignJourneysSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  /** The engine arm: `assignAt(experiment, contact, run's frozen asOf)`. A run
   *  with no stamp (or an experiment not assigning at its instant) is not in the
   *  test: the contact takes the control path, `assigned: false`, and
   *  `journey.split`'s observe skips it the same way. The org is required and
   *  bound to the run like every other journey verb (`bindJourneyOrg`: a run
   *  stamped for another client is `wrong_client`, and the run's person must
   *  read the org), and the experiment must be a journey split. */
  const engineSplit = async (contactId: string, experimentId: string, orgId: string): Promise<Record<string, unknown>> => {
    if (!orgId) throw new OpenwopError('validation_error', 'An engine split names its orgId.', 400, { field: 'orgId', reason: 'org_required' });
    await bindJourneyOrg(scope, orgId);
    const exp = await getExperimentRow(tenantId, orgId, experimentId);
    if (!exp || exp.surface.kind !== JOURNEY_SPLIT_SURFACE) throw new OpenwopError('not_found', 'Journey split experiment not found.', 404, { reason: 'experiment_not_found' });
    const run = scope.runId ? await hostExtStorage().getRun(scope.runId) : null;
    const stamp = run && run.tenantId === tenantId ? readExperimentsRunStamp(run.metadata) : null;
    const a = stamp ? assignAt(exp, contactId, stamp.asOf) : null;
    const arm = a?.arm.key ?? exp.arms[0]!.key;
    const control = arm === exp.arms[0]!.key;
    return { arm, control, treatment: !control, experimentId, assigned: a !== null, ...(a ? { epoch: a.epoch } : {}) };
  };
  return {
    enroll: async (args) => {
      await bindJourneyOrg(scope, journeyOrgOf(args.orgId));
      return { ...(await enroll(tenantId, str(args.journeyId), str(args.contactId), optStr(args.runId), enrollOpts(args))) };
    },
    checkEligibility: async (args) => ({ ...(await checkEligibility(tenantId, str(args.contactId), channelOf(optStr(args.channel)))) }),
    // ADR 0955 D2 — the one per-channel check, bound to the run's client.
    checkChannelEligibility: async (args) => {
      const orgId = journeyOrgOf(args.orgId);
      await bindJourneyOrg(scope, orgId);
      const topicId = optStr(args.topicId);
      return { ...(await checkJourneyChannelEligibility(tenantId, orgId, str(args.contactId), channelArg(optStr(args.channel)), { purpose: purposeArg(optStr(args.purpose)), ...(topicId ? { topicId } : {}) })) };
    },
    // ADR 0955 D4 — is NOW inside the client's send window for this contact, and if not, when.
    checkSendWindow: async (args) => {
      const orgId = journeyOrgOf(args.orgId);
      await bindJourneyOrg(scope, orgId);
      return { ...(await checkSendWindow(tenantId, orgId, str(args.contactId), channelArg(optStr(args.channel)))) };
    },
    // ADR 0955 D2/D4 — everything a journey SMS needs before the egress, or a typed refusal.
    smsSendContext: async (args) => {
      const orgId = journeyOrgOf(args.orgId);
      await bindJourneyOrg(scope, orgId);
      const topicId = optStr(args.topicId);
      return { ...(await smsSendContext(tenantId, orgId, str(args.contactId), { purpose: purposeArg(optStr(args.purpose)), ...(topicId ? { topicId } : {}) })) };
    },
    // ADR 0955 D5 — when this contact is most likely to read, clamped into the window.
    sendTime: async (args) => {
      const orgId = journeyOrgOf(args.orgId);
      await bindJourneyOrg(scope, orgId);
      const defaultTime = optStr(args.defaultTime);
      return { ...(await journeySendTime(tenantId, orgId, str(args.contactId), channelArg(optStr(args.channel)), defaultTime ? { defaultTime } : {})) };
    },
    // ADR 0955 D8 — a pinned SMS template version's body (never the live template).
    smsTemplateBody: async (args) => {
      const orgId = journeyOrgOf(args.orgId);
      await bindJourneyOrg(scope, orgId);
      return { ...(await smsTemplateBody(tenantId, orgId, str(args.templateId), num(args.templateVersion, 0))) };
    },
    // ADR 0955 D1 — one client's rows. A workspace with no clients lists everything, as before.
    listEnrollments: async (args) => {
      const orgId = journeyOrgOf(args.orgId);
      await bindJourneyOrg(scope, orgId);
      const resolved = await resolveEnrollmentOrg(tenantId, orgId);
      return { enrollments: await listEnrollments(tenantId, optStr(args.journeyId), resolved || undefined) };
    },
    // ADR 0243 — journey-depth read verbs (tenant from the surface scope, never a node input).
    checkEngagement: async (args) => ({ ...(await checkEngagement(tenantId, str(args.contactId), optStr(args.campaignId))) }),
    checkFrequency: async (args) => ({ ...(await checkFrequency(tenantId, str(args.contactId), num(args.windowDays, 30), num(args.maxSends, 1))) }),
    resolveSegment: async (args) => ({ ...(await resolveSegment(tenantId, str(args.segmentId))) }),
    // ADR 0267 / CDP-E — journey experiment/holdout split (deterministic, replay-stable).
    // ADR 0949 P3b (D5) — an engine experiment (`exp:` id, `experiments` ON)
    // assigns through the engine at the run's frozen instant; any other id keeps
    // the string-salted holdout, byte-identical, so existing journeys route as before.
    bucketHoldout: async (args) => {
      const contactId = str(args.contactId);
      const experimentId = str(args.experimentId);
      if (experimentId.startsWith('exp:') && (await resolveOne('experiments', { tenantId }).catch(() => null))?.enabled) {
        return engineSplit(contactId, experimentId, journeyOrgOf(args.orgId));
      }
      const r = holdoutArm(contactId, experimentId, num(args.holdoutPct, 10));
      return { arm: r.arm, bucket: r.bucket, control: r.arm === 'control', treatment: r.arm === 'treatment' };
    },
  };
}
