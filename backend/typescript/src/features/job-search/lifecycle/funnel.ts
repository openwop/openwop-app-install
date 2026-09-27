/**
 * ADR 0546 D4/P1 — the only honest scoreboard.
 *
 * "Applications sent" is a vanity number this product explicitly does not sell
 * (ADR 0539). So the report answers the questions a job-seeker actually has:
 * is anyone reading these, where does the funnel break, and — the dominant
 * variable by an order of magnitude — does a warm path change the answer.
 *
 * ## Zero is reported as zero
 *
 * P1's verification names this: "a variant with zero responses is reported as
 * zero, not hidden." It is the whole integrity of the surface. A dashboard that
 * silently drops empty rows tells the user their approach is working, because
 * the failures are the rows that vanished. Every cell here is either a number
 * with its denominator or an explicit `null` meaning "not enough data to say" —
 * and `null` is NEVER rendered as 0%, which would be a claim rather than an
 * absence.
 *
 * ## Everything derives from stage history, nothing is stored
 *
 * The numbers are projections over CRM's own stage-history rows. Nothing here
 * keeps a counter, because a counter is a second source of truth that drifts
 * from the thing it counts and cannot be recomputed after a correction. The
 * cost is a scan per report; the benefit is that the report cannot lie about
 * data that is right there.
 */
import { listDeals, listStageHistoryForPipeline } from '../../crm/crmEntitiesService.js';
import type { Deal } from '../../crm/entities/deals.js';
import { resolveApplicationPipeline } from '../domain/applications.js';

/** Ordered funnel steps. `applied` is the denominator for everything. */
export const FUNNEL_STAGES = ['applied', 'screening', 'interviewing', 'offer'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/**
 * A rate with the numbers it came from.
 *
 * `rate` is `null` when the denominator is 0. That is deliberately not `0`:
 * "nobody replied to your 40 applications" and "you have not applied yet" are
 * different facts, and a UI given `0` for both would report the second as the
 * first.
 */
export interface Rate {
  numerator: number;
  denominator: number;
  /** numerator ÷ denominator, or null when there is nothing to divide. */
  rate: number | null;
}

const rateOf = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
});

export interface FunnelReport {
  /** Applications, by the furthest stage each one reached. */
  reachedStage: Record<FunnelStage, number>;
  /** Replies ÷ applications. The headline. */
  responseRate: Rate;
  /** Stage→stage conversion, each with its own denominator. */
  conversions: Array<{ from: FunnelStage; to: FunnelStage; rate: Rate }>;
  /**
   * The dominant variable (2–3% cold vs 40–65% referred), reported FIRST.
   * Both arms are always present, including when one has no applications —
   * an absent arm is how "we have no warm data" becomes "warm does not help".
   */
  warmVsCold: { warm: Rate; cold: Rate };
  /** Median hours from applied to the first employer action. Null when none. */
  medianHoursToFirstResponse: number | null;
  /** Response rate per source board. Every board with applications appears. */
  bySource: Array<{ source: string; rate: Rate }>;
  /** Applications with no employer action at all. Counted, never hidden. */
  silent: number;
  /**
   * Whether the "Job search" pipeline exists at all (grade-trio finding 9).
   * FALSE must render as "pipeline not found" — a missing pipeline used to
   * produce a report byte-identical to a brand-new user's empty funnel,
   * collapsing "we lost your pipeline" into "you have not applied yet", the
   * exact distinction this module's zero-is-zero contract forbids collapsing.
   */
  pipelineFound: boolean;
}

/**
 * JS-LIFE-2 — funnel semantics ride stage POSITION, not stage NAME.
 *
 * The old shape lowercased the stage's display name and compared it to the
 * funnel vocabulary, so renaming "Screening" → "Phone screen" in CRM silently
 * counted every deal there as `silent` — the report under-reported with no
 * error. History rows carry the STABLE `toStageId`, and the pipeline's
 * `stages` array IS its order (updatePipeline preserves it and stage ids
 * survive renames), so the position is the honest signal: positions 0..3 map
 * onto applied/screening/interviewing/offer; positions BEYOND the vocabulary
 * (an appended custom stage) count as a response but never a funnel
 * advancement; a stageId no longer in the pipeline (deleted stage)
 * contributes nothing.
 *
 * RESIDUALS (recorded in the assessment, not fixed here):
 *  - the pipeline is resolved by the ID BINDING now (renames are harmless);
 *    `pipelineFound: false` remains for the genuinely-deleted case, rendered
 *    as "pipeline not found", never as an empty funnel;
 *  - history rows now carry `toStagePosition` (a WRITE-TIME snapshot), so
 *    later stage reorders/insertions no longer re-score those moves. Rows
 *    written before the field existed still fall back to the current index
 *    — the residual persists for PRE-EXISTING history only and ages out as
 *    new moves append (write-forward closure; history is append-only, so a
 *    backfill would be fabrication).
 */
function stageOf(position: number | undefined): FunnelStage | null {
  if (position === undefined) return null;
  // Positions BEYOND the funnel vocabulary contribute nothing (grade-trio
  // finding 4: the earlier cap-at-offer scored an appended "Rejected" stage
  // as an OFFER and rolled both conversions to 100% — on the module whose
  // docblock says "the only honest scoreboard"). A custom terminal stage is
  // an employer RESPONSE (isResponse keeps position >= 1) but never a funnel
  // advancement.
  return FUNNEL_STAGES[position] ?? null;
}

/** Did this row's stage count as an employer RESPONSE? Position ≥ 1. */
function isResponse(position: number | undefined): boolean {
  return position !== undefined && position >= 1;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
};

/**
 * Build the report.
 *
 * `isWarm` is supplied by the caller rather than read here: warm-path
 * attribution is ADR 0546 D0/D5's concern, and having the scoreboard decide it
 * would put two definitions of "warm" in the product.
 */
export async function buildFunnelReport(
  tenantId: string,
  orgId: string,
  isWarm: (deal: Deal) => boolean = () => false,
): Promise<FunnelReport> {
  // Resolved by the ID BINDING (name fallback self-heals legacy tenants).
  const pipeline = (await resolveApplicationPipeline(tenantId, orgId)) ?? undefined;
  // Stage ORDER by stable id — renames cannot move a stage's position.
  const stagePosition = new Map((pipeline?.stages ?? []).map((s, i) => [s.stageId, i]));
  const deals = pipeline ? await listDeals(tenantId, orgId, { pipelineId: pipeline.pipelineId }) : [];

  const reachedStage: Record<FunnelStage, number> = { applied: 0, screening: 0, interviewing: 0, offer: 0 };
  const hoursToFirst: number[] = [];
  const bySourceCounts = new Map<string, { applications: number; responses: number }>();
  let warmApps = 0;
  let warmResponses = 0;
  let coldApps = 0;
  let coldResponses = 0;
  let responded = 0;

  // ONE read of the pipeline's stage history, grouped in memory.
  //
  // The first version called `getStageHistory` per deal, and that is worse than
  // an N+1: `getStageHistory` scans the tenant's ENTIRE history and filters, so
  // a user with 200 applications and 600 history rows cost 120,000 row visits
  // per page load — on a report a user refreshes. `listStageHistoryForPipeline`
  // already existed for exactly this, and its own docstring calls itself "the
  // report's raw input". Found by the grading pass, in my own code.
  const allHistory = pipeline ? await listStageHistoryForPipeline(tenantId, orgId, pipeline.pipelineId) : [];
  const historyByDeal = new Map<string, typeof allHistory>();
  for (const row of allHistory) {
    const list = historyByDeal.get(row.dealId);
    if (list) list.push(row);
    else historyByDeal.set(row.dealId, [row]);
  }

  for (const deal of deals) {
    const chronological = [...(historyByDeal.get(deal.dealId) ?? [])]
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const rows = chronological.map((h) => ({
      // The write-time SNAPSHOT wins (reproducible across later stage
      // reorders/insertions — the recorded residual, now closed for every
      // row written since the field landed); legacy rows fall back to the
      // CURRENT index, exactly the old behavior.
      position: h.toStagePosition ?? stagePosition.get(h.toStageId),
      at: h.at,
    }));
    let reached: FunnelStage = 'applied';
    for (const r of rows) {
      const stg = stageOf(r.position);
      if (stg && FUNNEL_STAGES.indexOf(stg) > FUNNEL_STAGES.indexOf(reached)) reached = stg;
    }
    reachedStage[reached] += 1;

    const didRespond = rows.some((r) => isResponse(r.position));
    if (didRespond) responded += 1;

    // Time to the FIRST employer action, measured from the deal's creation
    // rather than from a stage row — the `applied` row may not exist when the
    // deal was created directly at that stage.
    if (didRespond) {
      const first = rows.find((r) => isResponse(r.position));
      if (first) {
        const started = Date.parse(deal.createdAt);
        const at = Date.parse(first.at);
        if (Number.isFinite(started) && Number.isFinite(at) && at >= started) {
          hoursToFirst.push((at - started) / 3_600_000);
        }
      }
    }

    if (isWarm(deal)) {
      warmApps += 1;
      if (didRespond) warmResponses += 1;
    } else {
      coldApps += 1;
      if (didRespond) coldResponses += 1;
    }

    const source = String((deal.customFields as Record<string, unknown> | undefined)?.board ?? 'unknown');
    const row = bySourceCounts.get(source) ?? { applications: 0, responses: 0 };
    row.applications += 1;
    if (didRespond) row.responses += 1;
    bySourceCounts.set(source, row);
  }

  const total = deals.length;

  // Conversions are computed from "reached AT LEAST this stage", so each step's
  // denominator is the population that could have converted — not the number
  // sitting in the previous stage today, which would count a fast mover as a
  // loss from the stage they already left.
  const atLeast = (s: FunnelStage): number =>
    FUNNEL_STAGES.slice(FUNNEL_STAGES.indexOf(s)).reduce((n, k) => n + reachedStage[k], 0);

  const conversions = FUNNEL_STAGES.slice(0, -1).map((from, i) => {
    const to = FUNNEL_STAGES[i + 1]!;
    return { from, to, rate: rateOf(atLeast(to), atLeast(from)) };
  });

  return {
    reachedStage,
    responseRate: rateOf(responded, total),
    conversions,
    warmVsCold: { warm: rateOf(warmResponses, warmApps), cold: rateOf(coldResponses, coldApps) },
    medianHoursToFirstResponse: median(hoursToFirst),
    // EVERY source with applications appears, including the ones with zero
    // responses — those are the most useful rows on the page.
    bySource: [...bySourceCounts.entries()]
      .map(([source, c]) => ({ source, rate: rateOf(c.responses, c.applications) }))
      .sort((a, b) => (a.source < b.source ? -1 : 1)),
    silent: total - responded,
    pipelineFound: pipeline !== undefined,
  };
}
