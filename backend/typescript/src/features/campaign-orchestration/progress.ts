/**
 * ADR 1154 D1/D2 — a campaign's place on the guided path, as a READ.
 *
 * Brief → Plan → Create → Review → Launch → Measure. Nothing here is stored and
 * nothing here moves a campaign: the step is folded from records the existing
 * chains, gates and people already write. There is no stage field, no
 * transition table and no driver. `CampaignStatus` stays the stored field; this
 * module never writes it.
 *
 * Two layers:
 *
 * - `foldProgress` is PURE. It takes the campaign row, its brief row and the
 *   number of reviews waiting, and returns the six steps and the current one.
 *   The home list uses exactly this (point reads on campaign and brief rows and
 *   one approvals query), so a campaign's step on the home and in its workspace
 *   can never disagree.
 * - `readCampaignProgress` adds DETAIL to the same fold for one campaign: the
 *   preflight, plan links, open review windows and the run count. Detail never
 *   changes a step's state or the current step.
 *
 * A section that could not be read is `unknown`; one whose feature is off is
 * `unavailable`. Neither is ever shown as not started or as done (the ADR 0570
 * D3 read-back rule, as `readCampaignLinks` applies it).
 *
 * @see docs/adr/1154-campaign-studio-guided-flow.md
 */

import { createLogger } from '../../observability/logger.js';
import { listOpenVetoes } from '../../host/autonomyPolicy/index.js';
import { validateBrief } from '../campaign-brief/briefService.js';
import type { CampaignBrief, CampaignChannel } from '../campaign-brief/types.js';
import { listPlansForCampaign } from '../campaign-studio/planLinks.js';
import { setupOf } from './agentTools.js';
import { listCampaignRuns } from './campaignRunTag.js';
import { runPreflight, type PreflightResult } from './preflight.js';
import type { ChannelOutcomeState, MarketingCampaign } from './types.js';

const log = createLogger('campaign-orchestration.progress');

export const CAMPAIGN_STEPS = ['brief', 'plan', 'create', 'review', 'launch', 'measure'] as const;
export type CampaignStep = (typeof CAMPAIGN_STEPS)[number];

/**
 * - `not-started`: nothing recorded for this step yet.
 * - `in-progress`: started, and the next move is the user's or a run's.
 * - `needs-you`: a person's decision is waiting.
 * - `done`: everything this step asks for is recorded.
 * - `unknown`: the records cannot say (a read failed, or the work predates the
 *   record). Never treated as done.
 */
export const STEP_STATES = ['not-started', 'in-progress', 'needs-you', 'done', 'unknown'] as const;
export type StepState = (typeof STEP_STATES)[number];

/** What the user should do next. Machine codes; the screen owns the words. */
export const NEXT_ACTIONS = [
  'write-brief', 'complete-brief', 'approve-message', 'confirm-brief',
  'set-goal', 'make-plan',
  'draft-channels', 'redo-rejected',
  'review-waiting',
  'launch', 'resume',
  'view-results',
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export type ChannelProgressState = ChannelOutcomeState | 'not-started';

export interface StepProgress {
  step: CampaignStep;
  state: StepState;
  /** Machine codes naming what the step still lacks (brief fields, setup slots, `goal`, `plan`). */
  missing?: string[];
  /** Create: one entry per enabled channel, in the campaign's order. */
  channels?: Array<{ channel: CampaignChannel; state: ChannelProgressState; runId?: string; at?: string }>;
  /** Review: how many decisions are waiting on a person (as far as this caller may see). */
  waiting?: number;
}

export interface CampaignProgress {
  campaignId: string;
  status: MarketingCampaign['status'];
  steps: StepProgress[];
  /** The first step that is not done. `measure` once everything before it is. */
  current: CampaignStep;
  next: NextAction;
}

/** Inputs of the pure fold. `brief` is `null` when the campaign has none (or it
 *  belongs to another client), and `'unknown'` when it could not be read.
 *  `waiting` is `'unknown'` when the approvals read failed. */
export interface ProgressInputs {
  campaign: MarketingCampaign;
  brief: CampaignBrief | null | 'unknown';
  waiting: number | 'unknown';
}

const LIVE: ReadonlySet<MarketingCampaign['status']> = new Set(['active', 'paused', 'completed']);

function briefStep(brief: ProgressInputs['brief']): { step: StepProgress; next: NextAction } {
  if (brief === 'unknown') return { step: { step: 'brief', state: 'unknown' }, next: 'complete-brief' };
  if (!brief) return { step: { step: 'brief', state: 'not-started' }, next: 'write-brief' };
  const validation = validateBrief(brief);
  const setup = setupOf(brief);
  const missing = [...validation.issues.map((i) => i.field), ...setup.missing.map((m) => m.slot)];
  // A generated message waiting for approval is the one decision on this step.
  if (brief.kernelReview) return { step: { step: 'brief', state: 'needs-you', ...(missing.length ? { missing } : {}) }, next: 'approve-message' };
  const hasMessage = Boolean(brief.kernel) && !brief.kernelStale;
  // Setup (brand, persona, knowledge) is advisory, as it is in the launch
  // checklist: it is listed as missing but does not hold the step open.
  if (!validation.valid || !hasMessage) {
    return { step: { step: 'brief', state: 'in-progress', missing: hasMessage ? missing : [...missing, 'message'] }, next: 'complete-brief' };
  }
  if (brief.status !== 'confirmed') return { step: { step: 'brief', state: 'in-progress' }, next: 'confirm-brief' };
  return { step: { step: 'brief', state: 'done' }, next: 'set-goal' };
}

function planStep(campaign: MarketingCampaign): { step: StepProgress; next: NextAction } {
  const missing: string[] = [];
  if (!campaign.goal) missing.push('goal');
  if (!campaign.productionPlanId) missing.push('plan');
  if (missing.length === 0) return { step: { step: 'plan', state: 'done' }, next: 'draft-channels' };
  return {
    step: { step: 'plan', state: missing.length === 2 ? 'not-started' : 'in-progress', missing },
    next: campaign.goal ? 'make-plan' : 'set-goal',
  };
}

function createStep(campaign: MarketingCampaign): { step: StepProgress; next: NextAction } {
  const channels = campaign.channels.map((channel) => {
    const o = campaign.channelState?.[channel];
    return o ? { channel, state: o.state as ChannelProgressState, runId: o.runId, at: o.at } : { channel, state: 'not-started' as const };
  });
  const states = channels.map((c) => c.state);
  const settled = (s: ChannelProgressState): boolean => s === 'approved' || s === 'published';
  let state: StepState;
  if (channels.length === 0) state = 'not-started';
  else if (states.every(settled)) state = 'done';
  else if (states.some((s) => s === 'awaiting-review')) state = 'needs-you';
  else if (states.every((s) => s === 'not-started')) {
    // A campaign finalized before channel outcomes were recorded (ADR 1154 D4)
    // has drafts this read cannot see. Say so; never call it not started.
    state = campaign.finalizedAt ? 'unknown' : 'not-started';
  } else state = 'in-progress';
  return { step: { step: 'create', state, channels }, next: states.some((s) => s === 'rejected') ? 'redo-rejected' : 'draft-channels' };
}

/**
 * The pure fold. Deterministic in its inputs: no clock, no I/O.
 */
export function foldProgress(inputs: ProgressInputs): CampaignProgress {
  const { campaign, waiting } = inputs;
  // A brief of another client is no brief for this campaign.
  const brief = inputs.brief && inputs.brief !== 'unknown' && inputs.brief.orgId !== campaign.orgId ? null : inputs.brief;
  const b = briefStep(brief);
  const p = planStep(campaign);
  const c = createStep(campaign);

  const live = LIVE.has(campaign.status);
  const review: StepProgress = waiting === 'unknown'
    ? { step: 'review', state: 'unknown' }
    : waiting > 0
      ? { step: 'review', state: 'needs-you', waiting }
      // Nothing waiting means the step is done only once there was something to review.
      : { step: 'review', state: c.step.state === 'done' || live ? 'done' : c.step.state === 'unknown' ? 'unknown' : 'not-started', waiting: 0 };
  const launch: StepProgress = { step: 'launch', state: live ? 'done' : 'not-started' };
  const measure: StepProgress = {
    step: 'measure',
    state: campaign.status === 'completed' ? 'done' : campaign.status === 'active' || campaign.status === 'paused' ? 'in-progress' : 'not-started',
  };

  const steps = [b.step, p.step, c.step, review, launch, measure];
  const current = steps.find((s) => s.state !== 'done')?.step ?? 'measure';
  // A waiting decision outranks the path: it is the one thing only a person can clear.
  let next: NextAction;
  if (review.state === 'needs-you' && current !== 'brief') next = 'review-waiting';
  else if (current === 'brief') next = b.next;
  else if (current === 'plan') next = p.next;
  else if (current === 'create') next = c.next;
  else if (current === 'review') next = 'review-waiting';
  else if (current === 'launch') next = 'launch';
  else next = campaign.status === 'paused' ? 'resume' : 'view-results';
  return { campaignId: campaign.id, status: campaign.status, steps, current, next };
}

/** One detail section: read, unreadable, or its feature is off. */
export type Detail<T> = { status: 'ok'; value: T } | { status: 'unknown' } | { status: 'unavailable' };

export interface CampaignProgressDetail {
  /** Launch: the checklist (ADR 0961 D7, owned here since ADR 1154 D6). */
  preflight: Detail<PreflightResult>;
  /** Plan: plan canvases linked to this campaign. `unavailable` when the canvas feature is off. */
  plans: Detail<{ count: number }>;
  /** Review: open review windows (a step that proceeds unless someone objects in time). */
  reviewWindows: Detail<{ count: number }>;
  /** Every tagged run of this campaign, counted from the run index. */
  runs: Detail<{ count: number }>;
}

async function detail<T>(name: string, campaignId: string, enabled: boolean, read: () => Promise<T>): Promise<Detail<T>> {
  if (!enabled) return { status: 'unavailable' };
  try {
    return { status: 'ok', value: await read() };
  } catch (err) {
    log.warn('campaign_progress_read_failed', { section: name, campaignId, error: err instanceof Error ? err.message : String(err) });
    return { status: 'unknown' };
  }
}

/**
 * The full read for one campaign. The caller has checked `workspace:read` on
 * the campaign's org and supplies the brief and the waiting count it read under
 * that same authority. Every owner read here is scoped to the campaign's tenant
 * and org.
 */
export async function readCampaignProgress(
  inputs: ProgressInputs,
  isEnabled: (featureId: string) => Promise<boolean>,
): Promise<CampaignProgress & { detail: CampaignProgressDetail }> {
  const { campaign } = inputs;
  const { tenantId, orgId, id } = campaign;
  const plansOn = await isEnabled('campaign-studio');
  const [preflight, plans, reviewWindows, runs] = await Promise.all([
    detail('preflight', id, true, () => runPreflight(tenantId, campaign)),
    detail('plans', id, plansOn, async () => ({ count: (await listPlansForCampaign(tenantId, id)).filter((l) => l.orgId === orgId).length })),
    detail('reviewWindows', id, true, async () => ({ count: (await listOpenVetoes(tenantId, id)).length })),
    detail('runs', id, true, async () => ({ count: (await listCampaignRuns(tenantId, id)).length })),
  ]);
  return { ...foldProgress(inputs), detail: { preflight, plans, reviewWindows, runs } };
}
