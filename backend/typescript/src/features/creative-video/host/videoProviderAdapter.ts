/**
 * AI-video provider adapter (ADR 0404 §b) — HeyGen-class avatar (script→MP4).
 * A VENDOR adapter (governed spend), not an LLM provider: every call rides the
 * connections broker with the `adapterOnly` `heygen` provider, so a job submission
 * (which SPENDS money) can never bypass the ADR 0106 cost meter via the generic
 * `ctx.http.fetch`. Host base is a hardcoded constant.
 *
 * The completion RESULT URL is an UNTRUSTED provider URL — the download is
 * host-allowlisted (SSRF) + size-capped, mirroring dispatchImages' Replicate guard.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §b
 */

import { brokeredPost, brokeredFetch, type BrokeredEgressDeps } from '../../../host/brokeredEgress.js';
import { guardedEgressFetch } from '../../../host/webhookEgressGuard.js';

const HEYGEN_PROVIDER = 'heygen';
/** ~200 MiB cap on a downloaded video (video is large; still bounded). */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** Hard ceiling on the result download so a slow/hung provider URL can't pin a worker. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

function heygenApiBase(): string {
  return (process.env.OPENWOP_HEYGEN_API_BASE || 'https://api.heygen.com').replace(/\/+$/, '');
}

/** Allowed hosts for a downloaded result URL (SSRF guard). Default = HeyGen + its
 *  resource CDN eTLD+1s ONLY (`heygen.ai` covers `resource2.heygen.ai` etc.). We do
 *  NOT default-allow `amazonaws.com` — that would open every S3 bucket; an operator
 *  whose provider serves results from a specific bucket adds it via the env below. */
function allowedVideoHosts(): string[] {
  const extra = (process.env.OPENWOP_VIDEO_RESULT_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  return ['heygen.com', 'heygen.ai', ...extra];
}

/** Assert the result URL is https + on an allowed eTLD+1 (exact or subdomain).
 *  Throws on any private/unlisted host — an untrusted provider URL is never
 *  fetched blindly (SSRF). */
export function assertAllowedResultUrl(raw: string, allowedHosts: string[]): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('video_result_url_invalid'); }
  if (u.protocol !== 'https:') throw new Error('video_result_url_insecure');
  const host = u.hostname.toLowerCase();
  const ok = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) throw new Error(`video_result_url_host_denied:${host}`);
  return u;
}
export function assertAllowedVideoUrl(raw: string): URL {
  return assertAllowedResultUrl(raw, allowedVideoHosts());
}

/**
 * Download an UNTRUSTED provider result URL safely: positive host-allowlist on top
 * of the shared egress guard (`redirect:'error'` blocks redirect-to-internal; the
 * pinned-resolution dispatcher blocks DNS-rebind; https-only), a hard timeout, a
 * declared-length precheck, AND a streaming byte cap so a chunked/unknown-length
 * body can't OOM the worker. Shared by every video adapter (avatar + t2v).
 */
export async function downloadGuardedResult(resultUrl: string, allowedHosts: string[]): Promise<AdapterResult<{ base64: string; bytes: number; contentType: string }>> {
  try { assertAllowedResultUrl(resultUrl, allowedHosts); } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'download_denied' }; }
  let res: Awaited<ReturnType<typeof guardedEgressFetch>>;
  try { res = await guardedEgressFetch(resultUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }); }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'download_failed' }; }
  if (!res.ok) return { ok: false, error: `download_${res.status}` };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) return { ok: false, error: 'video_too_large' };
  const contentType = res.headers.get('content-type') || 'video/mp4';
  const body = res.body;
  if (!body) return { ok: false, error: 'download_empty' };
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_VIDEO_BYTES) { await reader.cancel().catch(() => {}); return { ok: false, error: 'video_too_large' }; }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, value: { base64: Buffer.concat(chunks, total).toString('base64'), bytes: total, contentType } };
}

export type JobStatus = 'processing' | 'completed' | 'failed';

export interface SubmitJobInput {
  /** The text driving the render — avatar script OR t2v prompt. */
  script: string;
  /** Avatar id (avatar mode); '' for t2v. */
  avatarId: string;
  voiceId?: string;
  /** Selectable model (t2v). */
  model?: string;
  /** Requested clip length in seconds (t2v). */
  durationSec?: number;
  width?: number;
  height?: number;
}
export type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface VideoAdapter {
  submitJob(input: SubmitJobInput): Promise<AdapterResult<{ providerJobId: string }>>;
  pollJob(providerJobId: string): Promise<AdapterResult<{ status: JobStatus; resultUrl?: string; durationSec?: number }>>;
  downloadResult(resultUrl: string): Promise<AdapterResult<{ base64: string; bytes: number; contentType: string }>>;
}

export function makeVideoAdapter(deps: BrokeredEgressDeps): VideoAdapter {
  const apiKeyHeader = { authScheme: 'raw' as const, authHeaderName: 'x-api-key' };
  return {
    async submitJob(input) {
      const body = JSON.stringify({
        video_inputs: [{
          character: { type: 'avatar', avatar_id: input.avatarId },
          voice: { type: 'text', input_text: input.script, ...(input.voiceId ? { voice_id: input.voiceId } : {}) },
        }],
        dimension: { width: input.width ?? 1280, height: input.height ?? 720 },
      });
      const out = await brokeredPost(deps, { provider: HEYGEN_PROVIDER, url: `${heygenApiBase()}/v2/video/generate`, body, ...apiKeyHeader });
      if (out.outcome !== 'sent') return { ok: false, error: out.outcome };
      let json: Record<string, unknown> = {};
      try { json = (await out.res.json()) as Record<string, unknown>; } catch { /* {} */ }
      if (out.res.status < 200 || out.res.status >= 300) return { ok: false, error: `heygen_${out.res.status}` };
      const data = (json.data ?? {}) as Record<string, unknown>;
      const providerJobId = typeof data.video_id === 'string' ? data.video_id : '';
      if (!providerJobId) return { ok: false, error: 'heygen_no_job_id' };
      return { ok: true, value: { providerJobId } };
    },

    async pollJob(providerJobId) {
      const out = await brokeredFetch(deps, { provider: HEYGEN_PROVIDER, url: `${heygenApiBase()}/v1/video_status.get?video_id=${encodeURIComponent(providerJobId)}`, method: 'GET', ...apiKeyHeader });
      if (out.outcome !== 'sent') return { ok: false, error: out.outcome };
      let json: Record<string, unknown> = {};
      try { json = (await out.res.json()) as Record<string, unknown>; } catch { /* {} */ }
      if (out.res.status < 200 || out.res.status >= 300) return { ok: false, error: `heygen_${out.res.status}` };
      const data = (json.data ?? {}) as Record<string, unknown>;
      const raw = typeof data.status === 'string' ? data.status : 'processing';
      const status: JobStatus = raw === 'completed' ? 'completed' : raw === 'failed' ? 'failed' : 'processing';
      return { ok: true, value: { status, ...(typeof data.video_url === 'string' ? { resultUrl: data.video_url } : {}), ...(typeof data.duration === 'number' ? { durationSec: data.duration } : {}) } };
    },

    async downloadResult(resultUrl) {
      // Uncredentialed, SSRF-guarded, size-capped download (heygen host allowlist).
      return downloadGuardedResult(resultUrl, allowedVideoHosts());
    },
  };
}
