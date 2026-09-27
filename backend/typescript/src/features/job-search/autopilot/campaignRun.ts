/**
 * WF-JS-1 — the campaign PASS: the production dispatch lane for `runCampaign`.
 *
 * Until this module, `runCampaign`/`applyToListing` had ZERO production callers
 * (WORKFLOWS-ASSESSMENT § job-search): ADR 0545 P3/P4 were pinned by unit tests
 * only, and Tier-A autopilot could not be started by any user or agent. This is
 * the one caller, and it is reached ONLY through the ADR 0543 stack lane — a
 * kanban card naming the `career.campaign` chain, claimed by the heartbeat,
 * gated by agent policy + run budget + (at `autonomyLevel:'review'`) a human
 * approval. There is deliberately no direct "run it now" execution route: the
 * loop IS the executor, and every authority object stays in front of it.
 *
 * What a pass does, per ACTIVE grant (grants key on `(subjectId, campaignId)` —
 * a workspace can hold several members' grants, so "the" grant is wrong):
 *
 *   listings → digest → CampaignItem → runCampaign(items, submitLane, now)
 *
 * and `runCampaign`'s pipeline enforces, per item: eligibility → floor →
 * answers (park, spend nothing) → grant consult (replay/pace/ceiling refusals)
 * → claim CAS → deal-before-effect → submit → consume.
 *
 * Honesty properties this module adds on top:
 *
 *  - A listing whose board has NO submit lane is skipped BEFORE the pipeline
 *    (`board-no-submit-lane`) — entering the pipeline would claim the listing
 *    and mint a deal for a submission that cannot happen. The skip is a first-
 *    class digest row, so "we cannot actually submit to this board yet" is a
 *    number the user sees, never a silent nothing (the vacuous-lane trap).
 *  - `dailyCap` (steering, ADR 0545 D5) is enforced here across the whole pass
 *    via a CAS'd per-(subject, UTC-day) counter — the grant's `ratePerHour`
 *    bounds velocity, this bounds volume; both were previously stored promises
 *    nothing kept.
 *  - `isReplay` derives STRUCTURALLY from the ADR 0531 ambient effect context —
 *    a replayed/forked run reaches this code with `replaying: true` and every
 *    grant consult refuses before reading a store. Belt-and-braces: the node
 *    that calls this is also classified side-effecting (recorded-outcome fast
 *    path), so on replay it normally never executes at all.
 */
import { createLogger } from '../../../observability/logger.js';
import { currentEffectContext } from '../../../host/runEffectContext.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../../host/retentionPurger.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { appendAudit } from '../../../host/auditChainService.js';
import { applyGrants, type ApplyGrant } from '../../../host/applyGrant.js';
import { getSteering } from '../agent/steering.js';
import { listListings } from '../boards/listing.js';
import { getBoardAdapter } from '../boards/adapters.js';
import { listAnswers } from './answerBank.js';
import { runCampaign, type CampaignDigest, type CampaignItem } from './campaign.js';
import type { PreparedSubmission } from './pipeline.js';
import type { JobDigest } from '../domain/digest.js';
import type { FitProfile } from '../domain/fitScoring.js';
import type { ApplicantConstraints } from '../domain/eligibility.js';
import type { EntityRecord } from '../../entities/entitiesService.js';

const log = createLogger('jobSearch.campaignRun');

/** One grant's slice of a pass, plus the pass-level skips that never reached
 *  the pipeline (no submit lane / daily cap). */
export interface GrantPassResult {
  grantId: string;
  campaignId: string;
  subjectId: string;
  digest: CampaignDigest;
}

export interface CampaignPassReport {
  ranGrants: number;
  listings: number;
  /** Listings whose board ships no submit lane yet — visible, never silent. */
  skippedNoSubmitLane: number;
  /** Items not attempted because the subject's UTC-day cap was already spent. */
  skippedDailyCap: number;
  results: GrantPassResult[];
}

/* ------------------------------------------------------------------------- *
 * The per-(subject, UTC-day) applied counter — `dailyCap`'s teeth.
 * ------------------------------------------------------------------------- */

interface DayCount {
  key: string; // `${tenantId}:${subjectId}:${day}`
  tenantId: string;
  subjectId: string;
  day: string; // UTC YYYY-MM-DD, derived from the pass's `now` — replay-safe
  used: number;
}

export const campaignDayCounts = new DurableCollection<DayCount>(
  'job-search:campaign-day',
  (c) => c.key,
  undefined,
  (c) => c.tenantId,
);

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/**
 * DSAR (ADR 0464 class): day counts key on the SUBJECT — a per-person record of
 * application activity — so erasure must remove them. Counting rows are not
 * "content", but a key that names an erased person is still a link to them.
 */
export async function eraseSubjectCampaignDays(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await campaignDayCounts.listByPrefix(`${tenantId}:`)) {
    if (forms.has(row.subjectId)) await campaignDayCounts.delete(row.key);
  }
}

registerSubjectEraser(eraseSubjectCampaignDays);

// JS-DATA-6 — age-out: day counters accrete ~365/subject/year and are pure
// pacing state; a year-old counter guards nothing. The guard is DAY-granular:
// only rows whose `day` sorts strictly before the CUTOFF'S day are eligible.
// The seam's cutoff carries the sweep's wall-clock time-of-day, so comparing
// the row's midnight-mapped instant against it would still purge a counter ON
// its own cutoff day for any afternoon sweep — and today's counter is a LIVE
// SAFETY CONTROL (the daily cap on applications sent on someone's behalf): a
// 0-day window would otherwise hand a capped subject a fresh allowance every
// sweep tick (re-grade finding). The classification gate comes first (the
// seam passes (tenantId, CLASSIFICATION, cutoffIso) — the misbinding lesson).
registerRetentionPurger({
  feature: 'job-search:campaign-day',
  purge: async (tenantId, classification, cutoffIso) => {
    if (classification !== 'confidential-pii') return 0;
    const cutoffDay = cutoffIso.slice(0, 10); // UTC YYYY-MM-DD
    const aged = (await campaignDayCounts.listForTenantIndexed(tenantId)).filter((r) => r.day < cutoffDay);
    return purgeRowsByAge(
      'job-search:campaign-day',
      aged,
      tenantId,
      cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: `${r.day}T00:00:00.000Z`, id: r.key }),
      (id) => campaignDayCounts.delete(id),
    );
  },
});

async function dayUsed(tenantId: string, subjectId: string, now: number): Promise<number> {
  const row = await campaignDayCounts.get(`${tenantId}:${subjectId}:${utcDay(now)}`);
  return row?.used ?? 0;
}

/** CAS-increment, same discipline as the grant ceiling: two concurrent passes
 *  cannot both fit into the day's last slot. */
export async function consumeDaySlot(tenantId: string, subjectId: string, now: number, cap: number): Promise<boolean> {
  const key = `${tenantId}:${subjectId}:${utcDay(now)}`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await campaignDayCounts.get(key);
    if ((current?.used ?? 0) >= cap) return false;
    if (!current) {
      // `compareAndSwap(null, …)` = insert-if-absent: the loser of a racing
      // first-slot insert re-reads and CASes against the winner's row.
      const created = await campaignDayCounts.compareAndSwap(null, { key, tenantId, subjectId, day: utcDay(now), used: 1 });
      if (created) return true;
      continue;
    }
    if (await campaignDayCounts.compareAndSwap(current, { ...current, used: current.used + 1 })) return true;
  }
  return false; // six lost races = real contention; refusing is the safe direction
}

/* ------------------------------------------------------------------------- *
 * Listing → pipeline input assembly
 * ------------------------------------------------------------------------- */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Build a JobDigest from a stored listing row. Pure and deterministic — every
 * field comes from the ROW (capturedAt included: the row's own timestamps, not
 * the pass clock), so two passes over the same listing assemble byte-identical
 * inputs and the fit score cannot drift between heartbeats.
 */
export function digestFromListing(row: EntityRecord): JobDigest {
  const v = row.values ?? {};
  const ext = ((row as { ext?: Record<string, unknown> }).ext ?? {}) as Record<string, unknown>;
  return {
    dealId: '', // not a deal yet — the pipeline mints the deal on apply
    tenantId: row.tenantId,
    version: 1,
    title: str(v.title),
    companyName: str(v.company_name),
    location: typeof v.location === 'string' ? v.location : null,
    remote: typeof v.remote === 'boolean' ? v.remote : null,
    skills: strArr(ext.skills),
    requirements: strArr(ext.requirements),
    responsibilities: strArr(ext.responsibilities),
    descriptionExcerpt: str(ext.descriptionExcerpt),
    employmentType: 'unknown',
    sponsorship: ext.sponsorship === 'offered' || ext.sponsorship === 'not-offered' ? ext.sponsorship : 'silent',
    citizenshipRequirementQuote: typeof ext.citizenshipRequirementQuote === 'string' ? ext.citizenshipRequirementQuote : null,
    clearanceRequirementQuote: typeof ext.clearanceRequirementQuote === 'string' ? ext.clearanceRequirementQuote : null,
    sponsorshipQuote: typeof ext.sponsorshipQuote === 'string' ? ext.sponsorshipQuote : null,
    salaryMin: numOrNull(ext.salaryMin),
    salaryMax: numOrNull(ext.salaryMax),
    currency: typeof ext.currency === 'string' ? ext.currency : null,
    sourceUrl: str(v.source_url) || null,
    capturedAt: '', // unknown at listing time; the applications path stamps its own
  };
}

/**
 * ApplicantConstraints from the subject's ANSWER BANK — the only store that
 * holds facts the applicant affirmed. Absence is NEUTRAL (the fit-scoring
 * doctrine): `requiresSponsorship` is true only on an affirmative answer, and
 * the two "meets the stated bar" fields default to true — the eligibility rules
 * only disqualify when the POSTING states a bar AND the applicant states they
 * miss it. An unanswered bank never manufactures a disqualification.
 */
export function applicantFromBank(bank: ReadonlyArray<{ questionKey: string; value: string | number | boolean }>): ApplicantConstraints {
  const byKey = new Map(bank.map((a) => [a.questionKey, a.value]));
  const affirmative = (v: unknown): boolean => v === true || v === 'yes' || v === 'true';
  const negative = (v: unknown): boolean => v === false || v === 'no' || v === 'false';
  return {
    requiresSponsorship: affirmative(byKey.get('work-auth.requires-sponsorship')),
    meetsCitizenshipRequirement: !negative(byKey.get('work-auth.legally-authorised')),
    holdsRequiredClearance: true,
  };
}

/** FitProfile from steering — the ONE policy owner (ADR 0545 D5). Steering has
 *  no skills store (the vertical ships no durable profile yet), so `skills` is
 *  empty and skill-heavy postings score low — the digest then says WHY
 *  (`below-floor` with the score), which is the honest outcome until a profile
 *  exists. Title match (roles) and remote preference do the lifting. */
function profileFromPolicy(policy: { roles: string[]; remote: boolean | null }): FitProfile {
  return { skills: [], targetTitles: policy.roles, salaryFloor: null, wantsRemote: policy.remote };
}

const liveGrant = (g: ApplyGrant, now: number): boolean =>
  !g.revokedAt && Date.parse(g.expiresAt) > now && g.submitsUsed < g.maxSubmits;

/* ------------------------------------------------------------------------- *
 * The pass
 * ------------------------------------------------------------------------- */

export async function runTenantCampaignPass(tenantId: string, now: number): Promise<CampaignPassReport> {
  // Structural replay derivation (ADR 0531): inside a node execution this is the
  // run's own flag; outside a run (a test calling directly) it is absent ⇒ live.
  const isReplay = currentEffectContext()?.replaying === true;

  const steering = await getSteering(tenantId);
  const policy = steering.policy;

  const grants = (await applyGrants.listByPrefix(`${tenantId}:`)).filter((g) => liveGrant(g, now));
  const listingRows = await listListings(tenantId);

  const report: CampaignPassReport = {
    ranGrants: 0,
    listings: listingRows.length,
    skippedNoSubmitLane: 0,
    skippedDailyCap: 0,
    results: [],
  };

  for (const grant of grants) {
    // One bank read per grant subject; `prepareAnswers` inside the pipeline does
    // its own key-scoped reads for the form questions.
    const bank = await listAnswers(tenantId, grant.subjectId);
    const applicant = applicantFromBank(bank);
    const profile = profileFromPolicy(policy);

    const digest: CampaignDigest = { considered: 0, applied: [], alreadyApplied: 0, parked: [], skipped: [] };
    const items: CampaignItem[] = [];

    for (const row of listingRows) {
      const jobDigest = digestFromListing(row);
      const board = str(row.values?.source_board);
      const adapter = board ? getBoardAdapter(board) : undefined;
      const lane = adapter?.submitLane;
      if (!lane) {
        // Skipped BEFORE the pipeline: entering it would CLAIM the listing and
        // mint a deal for a submission that cannot happen. First-class outcome.
        digest.considered += 1;
        digest.skipped.push({ listingId: row.entityId, reason: 'board-no-submit-lane', detail: board || 'unknown-board' });
        report.skippedNoSubmitLane += 1;
        continue;
      }
      if ((await dayUsed(tenantId, grant.subjectId, now)) >= policy.dailyCap) {
        digest.considered += 1;
        digest.skipped.push({ listingId: row.entityId, reason: 'daily-cap', detail: String(policy.dailyCap) });
        report.skippedDailyCap += 1;
        continue;
      }
      items.push({
        listingId: row.entityId,
        input: {
          tenantId,
          orgId: grant.orgId,
          subjectId: grant.subjectId,
          digest: jobDigest,
          profile,
          applicant,
          questions: await lane.fetchQuestions(row),
          minMatchScore: policy.minMatchScore,
          campaignId: grant.campaignId,
          origin: adapter.origin,
          isReplay,
          now,
        },
      });
    }

    // The submit closure consumes a day slot ONLY at the moment of submission —
    // after eligibility/floor/park/grant, before the outside effect — so a pass
    // full of parked items never burns the day budget.
    const laneDigest = await runCampaign(
      items,
      async (prepared: PreparedSubmission) => {
        const row = listingRows.find((r) => r.entityId === prepared.listingId);
        const adapter = row ? getBoardAdapter(str(row.values?.source_board)) : undefined;
        if (!row || !adapter?.submitLane) return { ok: false };
        if (!(await consumeDaySlot(tenantId, grant.subjectId, now, policy.dailyCap))) return { ok: false };
        return adapter.submitLane.submit(prepared, row);
      },
      now,
    );

    // Merge the pre-pipeline skips with the pipeline's own digest.
    const merged: CampaignDigest = {
      considered: digest.considered + laneDigest.considered,
      applied: laneDigest.applied,
      alreadyApplied: laneDigest.alreadyApplied,
      parked: laneDigest.parked,
      skipped: [...digest.skipped, ...laneDigest.skipped],
    };

    report.ranGrants += 1;
    report.results.push({ grantId: grant.grantId, campaignId: grant.campaignId, subjectId: grant.subjectId, digest: merged });

    // D6 — the pass is reported, never silent. The audit row is what the
    // attestation's "N through this host in the window" claim reads.
    await appendAudit(tenantId, 'job-search.campaign.pass', {
      grantId: grant.grantId,
      campaignId: grant.campaignId,
      subjectId: grant.subjectId,
      considered: merged.considered,
      applied: merged.applied.length,
      alreadyApplied: merged.alreadyApplied,
      parked: merged.parked.length,
      skipped: merged.skipped.length,
      isReplay,
    });
  }

  log.info('campaign_pass', {
    tenantId,
    ranGrants: report.ranGrants,
    listings: report.listings,
    skippedNoSubmitLane: report.skippedNoSubmitLane,
    skippedDailyCap: report.skippedDailyCap,
  });
  return report;
}
