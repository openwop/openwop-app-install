/**
 * ADR 0961 — client for /host/openwop-app/campaign-autopilot/*. Reuses the shared
 * client config; owns only the autopilot's two calls.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type PreflightItemId = 'brief' | 'brief-complete' | 'brief-setup' | 'ad-account' | 'goal';
export interface PreflightItem { id: PreflightItemId; status: 'ok' | 'missing' | 'warn'; blocking: boolean; missing?: string[] }
export interface Preflight { campaignId: string; ready: boolean; items: PreflightItem[] }
export interface LaunchAiInput { credentialRef: string; provider?: string; model?: string }
export interface LaunchResult { runId: string; campaignId: string; reused: boolean }

/** A failed call, carrying the HTTP status so the UI can say why. */
export class AutopilotError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) { super(message); }
}

const base = `${config.baseUrl}/host/openwop-app/campaign-autopilot/campaigns`;

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    let reason: string | undefined;
    try {
      const body = await res.json() as { message?: string; details?: { reason?: string }; error?: { message?: string; details?: { reason?: string } } | string };
      const nested = body.error && typeof body.error === 'object' ? body.error : undefined;
      detail = body.message ?? nested?.message ?? '';
      reason = body.details?.reason ?? nested?.details?.reason;
    } catch { /* non-JSON */ }
    throw new AutopilotError(res.status, detail || `${ctx} returned ${res.status}`, reason);
  }
  return (await res.json()) as T;
}

/** The checklist, plus whether the caller may launch (advisory; launch re-checks). */
export async function getPreflight(campaignId: string): Promise<{ preflight: Preflight; canLaunch: boolean }> {
  const out = await asJson<{ preflight: Preflight; canLaunch?: boolean }>(await fetch(`${base}/${encodeURIComponent(campaignId)}/preflight`, fetchOpts({ headers: authedHeaders() })), 'preflight');
  return { preflight: out.preflight, canLaunch: out.canLaunch === true };
}

export async function launchAutopilot(campaignId: string, ai?: LaunchAiInput): Promise<LaunchResult> {
  return asJson<LaunchResult>(await fetch(`${base}/${encodeURIComponent(campaignId)}/launch`, fetchOpts({ method: 'POST', headers: authedHeaders(ai ? { 'content-type': 'application/json' } : undefined), ...(ai ? { body: JSON.stringify({ ai }) } : {}) })), 'launch');
}
