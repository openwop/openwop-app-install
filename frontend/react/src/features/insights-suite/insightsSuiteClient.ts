/**
 * Insights & Drafting config client (ADR 1102 D10) — the one door,
 * `/v1/host/openwop-app/insights-suite/config`. The suite runs as whoever saves
 * it (D4), so no principal ever rides the request.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const URL_ = () => `${config.baseUrl}/host/openwop-app/insights-suite/config`;

export interface InsightsSuiteConfigView {
  principalUserId: string;
  businessUnit?: string;
  scheduleCron?: string;
  scheduleTimezone?: string;
  planSource?: { projectId?: string };
  anniversaryTriggerEnabled?: boolean;
  updatedAt: string;
}

export interface InsightsSuiteState {
  config: InsightsSuiteConfigView | null;
  /** `null` when nothing is saved yet. */
  runsAsYou: boolean | null;
  /** The saved schedule is actually armed (it can be paused in Schedules). */
  scheduleArmed: boolean;
  canWrite: boolean;
}

export interface InsightsSuiteSave {
  scheduleCron?: string;
  scheduleTimezone?: string;
  planSource?: { projectId?: string };
  businessUnit?: string;
  takeOver?: boolean;
}

/** A refusal the panel translates: `field` places it, `reason` words it. The
 *  server's `message` is developer-facing English and is kept only as a last resort. */
export class InsightsSuiteSaveError extends Error {
  constructor(message: string, readonly status: number, readonly field?: string, readonly reason?: string) {
    super(message);
    this.name = 'InsightsSuiteSaveError';
  }
}

/** A load that failed for a reason other than "not available to you". */
export class InsightsSuiteLoadError extends Error {
  constructor(readonly status: number) {
    super(`insights-suite config load failed (${status})`);
    this.name = 'InsightsSuiteLoadError';
  }
}

/** `null` = the suite is not available to this caller (toggle off or no access). */
export async function getInsightsSuite(): Promise<InsightsSuiteState | null> {
  const res = await fetch(URL_(), fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  if (!res.ok) throw new InsightsSuiteLoadError(res.status);
  return (await res.json()) as InsightsSuiteState;
}

export async function saveInsightsSuite(body: InsightsSuiteSave): Promise<InsightsSuiteConfigView> {
  const res = await fetch(URL_(), fetchOpts({
    method: 'PUT',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }));
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; details?: { field?: string; reason?: string } };
    throw new InsightsSuiteSaveError(err.message ?? '', res.status, err.details?.field, err.details?.reason);
  }
  return ((await res.json()) as { config: InsightsSuiteConfigView }).config;
}
