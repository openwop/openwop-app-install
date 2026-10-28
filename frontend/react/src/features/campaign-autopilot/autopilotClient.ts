/**
 * ADR 0961 — client for /host/openwop-app/campaign-autopilot/*. Reuses the shared
 * client config; owns only the autopilot's two calls.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type PreflightItemId = 'brief' | 'brief-complete' | 'brief-setup' | 'ad-account' | 'goal';
export interface PreflightItem { id: PreflightItemId; status: 'ok' | 'missing' | 'warn'; blocking: boolean; missing?: string[] }
export interface Preflight { campaignId: string; ready: boolean; items: PreflightItem[] }
export interface LaunchResult { runId: string; campaignId: string; reused: boolean }

/** A failed call, carrying the HTTP status so the UI can say why. */
export class AutopilotError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const base = `${config.baseUrl}/host/openwop-app/campaign-autopilot/campaigns`;

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new AutopilotError(res.status, detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The checklist, plus whether the caller may launch (advisory; launch re-checks). */
export async function getPreflight(campaignId: string): Promise<{ preflight: Preflight; canLaunch: boolean }> {
  const out = await asJson<{ preflight: Preflight; canLaunch?: boolean }>(await fetch(`${base}/${encodeURIComponent(campaignId)}/preflight`, fetchOpts({ headers: authedHeaders() })), 'preflight');
  return { preflight: out.preflight, canLaunch: out.canLaunch === true };
}

export async function launchAutopilot(campaignId: string): Promise<LaunchResult> {
  return asJson<LaunchResult>(await fetch(`${base}/${encodeURIComponent(campaignId)}/launch`, fetchOpts({ method: 'POST', headers: authedHeaders() })), 'launch');
}
