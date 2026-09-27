/**
 * Frontier text-to-video adapter (ADR 0404 §P4). Like the avatar adapter, T2V is a
 * VENDOR adapter (governed spend), NOT a BYOK LLM dispatch: every call rides the
 * connections broker with the `adapterOnly` t2v provider (default `runway`), so a
 * job submission — which SPENDS money on an expensive frontier model — can never
 * bypass the ADR 0106 `video` meter via the generic `ctx.http.fetch`.
 *
 * ADR CORRECTION (see the ADR §P4 note): the original Phase-4 sketch proposed a
 * `providers/dispatchVideo.ts` BYOK model-provider dispatch mirroring
 * `dispatchImages.ts`. That template is SYNCHRONOUS (prompt→bytes inline); video is
 * inherently the async job shape (submit→CAS→poll→download→asset) P3 already built.
 * P4 therefore REUSES the P3 broker-adapter pipeline with a second provider — one
 * `videoService`, one job store, one `video` MediaKind, one SSRF download guard —
 * rather than standing up a parallel path. The operator's own Runway/Veo/Sora key
 * rides the same `kind:'api_key'` connection.
 *
 * The request/response mapping targets Runway's async task API (submit → poll task →
 * output URL); the API base + version are env-tunable for an alternate frontier
 * vendor. It is OFF by default (the `creative-video.t2v` sub-toggle) precisely
 * because provider availability + cost are the open question.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §P4
 */

import { brokeredPost, brokeredFetch, type BrokeredEgressDeps } from '../../../host/brokeredEgress.js';
import { downloadGuardedResult, type VideoAdapter } from './videoProviderAdapter.js';

/** The connections provider id backing t2v (governed spend). Env-tunable. */
export function t2vProvider(): string {
  return (process.env.OPENWOP_T2V_PROVIDER || 'runway').trim() || 'runway';
}
function t2vApiBase(): string {
  return (process.env.OPENWOP_T2V_API_BASE || 'https://api.runwayml.com').replace(/\/+$/, '');
}
function t2vApiVersion(): string {
  return process.env.OPENWOP_T2V_API_VERSION || '2024-11-06';
}
function defaultModel(): string {
  return process.env.OPENWOP_T2V_DEFAULT_MODEL || 'gen3a_turbo';
}
/** Result-URL host allowlist for the SSRF-guarded download (eTLD+1s). */
function allowedT2VHosts(): string[] {
  const extra = (process.env.OPENWOP_T2V_RESULT_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  return ['runwayml.com', ...extra];
}

export function makeT2VAdapter(deps: BrokeredEgressDeps): VideoAdapter {
  const auth = { authScheme: 'bearer' as const };
  const versionHeader = { 'X-Runway-Version': t2vApiVersion() };
  return {
    async submitJob(input) {
      const body = JSON.stringify({
        promptText: input.script.slice(0, 1000),
        model: input.model || defaultModel(),
        ...(input.durationSec ? { duration: input.durationSec } : {}),
        ratio: input.width && input.height ? `${input.width}:${input.height}` : '1280:768',
      });
      const out = await brokeredPost(deps, { provider: t2vProvider(), url: `${t2vApiBase()}/v1/text_to_video`, body, extraHeaders: versionHeader, ...auth });
      if (out.outcome !== 'sent') return { ok: false, error: out.outcome };
      let json: Record<string, unknown> = {};
      try { json = (await out.res.json()) as Record<string, unknown>; } catch { /* {} */ }
      if (out.res.status < 200 || out.res.status >= 300) return { ok: false, error: `t2v_${out.res.status}` };
      const providerJobId = typeof json.id === 'string' ? json.id : '';
      if (!providerJobId) return { ok: false, error: 't2v_no_job_id' };
      return { ok: true, value: { providerJobId } };
    },

    async pollJob(providerJobId) {
      const out = await brokeredFetch(deps, { provider: t2vProvider(), url: `${t2vApiBase()}/v1/tasks/${encodeURIComponent(providerJobId)}`, method: 'GET', extraHeaders: versionHeader, ...auth });
      if (out.outcome !== 'sent') return { ok: false, error: out.outcome };
      let json: Record<string, unknown> = {};
      try { json = (await out.res.json()) as Record<string, unknown>; } catch { /* {} */ }
      if (out.res.status < 200 || out.res.status >= 300) return { ok: false, error: `t2v_${out.res.status}` };
      const raw = typeof json.status === 'string' ? json.status.toUpperCase() : 'RUNNING';
      const status = raw === 'SUCCEEDED' ? 'completed' as const : (raw === 'FAILED' || raw === 'CANCELLED') ? 'failed' as const : 'processing' as const;
      const output = Array.isArray(json.output) ? json.output : [];
      const resultUrl = typeof output[0] === 'string' ? (output[0] as string) : undefined;
      return { ok: true, value: { status, ...(resultUrl ? { resultUrl } : {}) } };
    },

    async downloadResult(resultUrl) {
      return downloadGuardedResult(resultUrl, allowedT2VHosts());
    },
  };
}
