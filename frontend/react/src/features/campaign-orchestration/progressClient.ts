/**
 * ADR 1154 D1/D2 — the client for a campaign's place on the guided path. The
 * step is a server read (`GET …/campaigns/:id/progress`); this module only
 * fetches and types it. Nothing here derives or stores a step.
 *
 * @see docs/adr/1154-campaign-studio-guided-flow.md
 */
import { config, authedHeaders, fetchOpts } from '../../client/config.js';
import { FeatureDisabledError } from './campaignStudioClient.js';

export const CAMPAIGN_STEPS = ['brief', 'plan', 'create', 'review', 'launch', 'measure'] as const;
export type CampaignStep = (typeof CAMPAIGN_STEPS)[number];
export type StepState = 'not-started' | 'in-progress' | 'needs-you' | 'done' | 'unknown';
export type NextAction =
  | 'write-brief' | 'complete-brief' | 'approve-message' | 'confirm-brief'
  | 'set-goal' | 'make-plan' | 'draft-channels' | 'redo-rejected'
  | 'review-waiting' | 'launch' | 'resume' | 'view-results';

export interface StepProgress {
  step: CampaignStep;
  state: StepState;
  missing?: string[];
  channels?: Array<{ channel: string; state: string; runId?: string; at?: string }>;
  waiting?: number;
}

/** One detail section: read, unreadable, or its feature is off. */
export type Detail<T> = { status: 'ok'; value: T } | { status: 'unknown' } | { status: 'unavailable' };

export interface CampaignProgress {
  campaignId: string;
  status: string;
  steps: StepProgress[];
  current: CampaignStep;
  next: NextAction;
  detail: {
    preflight: Detail<{ campaignId: string; ready: boolean; items: Array<{ id: string; status: 'ok' | 'missing' | 'warn'; blocking: boolean; missing?: string[] }> }>;
    plans: Detail<{ count: number }>;
    reviewWindows: Detail<{ count: number }>;
    runs: Detail<{ count: number }>;
  };
}

const base = `${config.baseUrl}/host/openwop-app/campaign-orchestration`;

export const isCampaignStep = (v: string | undefined): v is CampaignStep => (CAMPAIGN_STEPS as readonly string[]).includes(v ?? '');

/** The workspace path of one step; with no step, the campaign's overview. */
export const campaignStepPath = (id: string, step?: CampaignStep): string =>
  `/campaign-studio/campaigns/${encodeURIComponent(id)}${step ? `/${step}` : ''}`;

export async function getCampaignProgress(campaignId: string): Promise<CampaignProgress> {
  const res = await fetch(`${base}/campaigns/${encodeURIComponent(campaignId)}/progress`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    if (res.status === 404 && /not enabled/i.test(detail)) throw new FeatureDisabledError(detail);
    throw new Error(detail || `getCampaignProgress returned ${res.status}`);
  }
  return ((await res.json()) as { progress: CampaignProgress }).progress;
}
