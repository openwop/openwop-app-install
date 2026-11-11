/**
 * AI-video API client (ADR 0404 §b) — the creative affordance over
 * /host/openwop-app/creative-video/orgs/:orgId/*. Connecting the provider (the
 * API key) is the Connections surface's job.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { readErrorCode, readErrorMessage } from '../../client/errorEnvelope.js';

export type VideoJobStatus = 'submitting' | 'processing' | 'downloading' | 'completed' | 'failed';
export interface VideoJob {
  jobId: string;
  kind?: 'avatar' | 't2v' | 'i2v';
  status: VideoJobStatus;
  provider: string;
  model?: string;
  /** ADR 1051 D4 — what was asked of the model (a request, not a measurement). */
  requested?: { model: string; ratio: string; durationSec: number };
  assetId?: string;
  error?: string;
  createdAt: string;
}

/** ADR 1051 D2 — the host's model table (`GET …/video-models`). */
export interface VideoModel {
  id: string;
  label: string;
  endpoints: ('t2v' | 'i2v')[];
  ratios: Partial<Record<'t2v' | 'i2v', string[]>>;
  duration: { min: number; max: number } | { oneOf: number[] };
  defaultDurationSec: number;
}
/** The host's video options: its model table, and the VERSION of the consent
 *  sentence it expects back (ADR 1051 D5). The sentence itself is this page's
 *  translated `consentLabel`; a server-side bump of the version without a new
 *  label is CV83UX-5 (filed). */
export interface VideoModels { defaultModel: string; models: VideoModel[]; likenessConsentTextVersion: string }

/** A refusal that carries the server's typed code (a 4xx envelope). */
export class VideoApiError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly status: number) { super(message); }
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
    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    throw new VideoApiError(readErrorMessage(body) || `${ctx} returned ${res.status}`, readErrorCode(body), res.status);
  }
  return (await res.json()) as T;
}

/** A generation POST carries a GenerateResult JSON body even on a failed outcome
 *  (429 over-budget, 403 paid video off, 409 no-connection, 502 provider-failed or
 *  unconfirmed) — parse it rather than throw, so the UI can show the specific
 *  reason. Anything else (a 422 refusal, auth, toggle-off 404) throws a
 *  `VideoApiError` carrying the server's code. */
async function asGenerateResult(res: Response, ctx: string): Promise<GenerateResult> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  const j = body as (GenerateResult & { status?: unknown }) | null;
  if (j && typeof j === 'object' && (j.status === 'completed' || j.status === 'pending' || j.status === 'failed') && typeof j.jobId === 'string') return j;
  throw new VideoApiError(readErrorMessage(body) || `${ctx} returned ${res.status}`, readErrorCode(body), res.status);
}

export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}

export async function listVideoJobs(orgId: string): Promise<VideoJob[]> {
  const res = await fetch(`${orgBase(orgId)}/jobs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ jobs: VideoJob[] }>(res, 'listVideoJobs')).jobs;
}

/** Avatar video. `consent` is the person's tick on the consent sentence of
 *  version `textVersion` (ADR 1051 D5); the server records it against them for
 *  this avatar and voice, and refuses any other version. */
export async function generateVideo(orgId: string, input: { script: string; avatarId: string; voiceId?: string; consent: { attested: boolean; textVersion: string } }): Promise<GenerateResult> {
  const { consent, ...rest } = input;
  const body = { ...rest, likenessConsent: consent };
  const res = await fetch(`${orgBase(orgId)}/generate`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) }));
  return asGenerateResult(res, 'generateVideo');
}

export async function listVideoModels(orgId: string): Promise<VideoModels> {
  const res = await fetch(`${orgBase(orgId)}/video-models`, fetchOpts({ headers: authedHeaders() }));
  return asJson<VideoModels>(res, 'listVideoModels');
}

/** Frontier text-to-video (ADR 0404 §P4) — gated by the creative-video.t2v sub-toggle
 *  server-side (a 404 here means the sub-capability is off for the tenant). */
export async function textToVideo(orgId: string, input: { prompt: string; model?: string; ratio?: string; durationSec?: number }): Promise<GenerateResult> {
  const res = await fetch(`${orgBase(orgId)}/text-to-video`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asGenerateResult(res, 'textToVideo');
}

export async function getVideoJob(orgId: string, jobId: string): Promise<VideoJob> {
  const res = await fetch(`${orgBase(orgId)}/jobs/${encodeURIComponent(jobId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<VideoJob>(res, 'getVideoJob');
}
