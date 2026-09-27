/**
 * AI-video API client (ADR 0404 §b) — the creative affordance over
 * /host/openwop-app/creative-video/orgs/:orgId/*. Connecting the provider (the
 * API key) is the Connections surface's job.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type VideoJobStatus = 'submitting' | 'processing' | 'downloading' | 'completed' | 'failed';
export interface VideoJob {
  jobId: string;
  status: VideoJobStatus;
  provider: string;
  assetId?: string;
  error?: string;
  createdAt: string;
}
export interface GenerateResult {
  status: 'completed' | 'pending' | 'failed';
  jobId: string;
  assetId?: string;
  error?: string;
}
export interface OrgRef { orgId: string; name: string }

const root = `${config.baseUrl}/host/openwop-app`;
const orgBase = (orgId: string): string => `${root}/creative-video/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** A generation POST carries a GenerateResult JSON body even on a failed outcome
 *  (429 over-budget, 409 no-connection, 502 provider-failed) — parse it rather than
 *  throw, so the UI can show the specific reason. A 4xx/5xx WITHOUT that shape
 *  (auth, toggle-off 404, rate-limit) still throws. */
async function asGenerateResult(res: Response, ctx: string): Promise<GenerateResult> {
  if (res.ok || res.status === 429 || res.status === 409 || res.status === 502) {
    try {
      const j = (await res.json()) as GenerateResult & { status?: string };
      if (j && typeof j.status === 'string') return j;
    } catch { /* fall through to throw */ }
  }
  throw new Error(`${ctx} returned ${res.status}`);
}

export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}

export async function listVideoJobs(orgId: string): Promise<VideoJob[]> {
  const res = await fetch(`${orgBase(orgId)}/jobs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ jobs: VideoJob[] }>(res, 'listVideoJobs')).jobs;
}

export async function generateVideo(orgId: string, input: { script: string; avatarId: string; voiceId?: string }): Promise<GenerateResult> {
  const res = await fetch(`${orgBase(orgId)}/generate`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asGenerateResult(res, 'generateVideo');
}

/** Frontier text-to-video (ADR 0404 §P4) — gated by the creative-video.t2v sub-toggle
 *  server-side (a 404 here means the sub-capability is off for the tenant). */
export async function textToVideo(orgId: string, input: { prompt: string; model?: string; durationSec?: number }): Promise<GenerateResult> {
  const res = await fetch(`${orgBase(orgId)}/text-to-video`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asGenerateResult(res, 'textToVideo');
}

export async function getVideoJob(orgId: string, jobId: string): Promise<VideoJob> {
  const res = await fetch(`${orgBase(orgId)}/jobs/${encodeURIComponent(jobId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<VideoJob>(res, 'getVideoJob');
}
