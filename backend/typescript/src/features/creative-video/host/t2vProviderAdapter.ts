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
 * output URL). ADR 1051 D2: the base, version, models, ratios and durations come
 * from Runway's published spec (`runwayModels.ts`, pinned to a saved fixture);
 * the base and default model stay env-overridable. It is OFF by default (the `creative-video.t2v` sub-toggle) precisely
 * because provider availability + cost are the open question.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §P4
 */

import { brokeredPost, brokeredFetch, type BrokeredEgressDeps } from '../../../host/brokeredEgress.js';
import { connectionExists } from '../../connections/connectionsService.js';
import { createLogger } from '../../../observability/logger.js';
import { downloadGuardedResult, postBeforeDialSafe, type VideoAdapter, type VideoConnectionPin } from './videoProviderAdapter.js';
import { RUNWAY_API_BASE, RUNWAY_API_VERSION, DEFAULT_RUNWAY_MODEL, resolveRunwayRequest, runwayModel, type RunwayEndpoint } from './runwayModels.js';

const log = createLogger('creative-video.t2v');

/** The connections provider id backing t2v (governed spend). Env-tunable. */
export function t2vProvider(): string {
  return (process.env.OPENWOP_T2V_PROVIDER || 'runway').trim() || 'runway';
}
/** ADR 1051 D2 — the spec's server, unless an operator overrides it. */
export function t2vApiBase(): string {
  return (process.env.OPENWOP_T2V_API_BASE || RUNWAY_API_BASE).replace(/\/+$/, '');
}
function usingRunwayBase(): boolean {
  return t2vApiBase() === RUNWAY_API_BASE;
}
function t2vApiVersion(): string {
  return process.env.OPENWOP_T2V_API_VERSION || RUNWAY_API_VERSION;
}
const warnedDefaultModel = new Set<string>();
/** The operator's default model FOR THIS ENDPOINT, when the table lists it there;
 *  else the table's default, warned once per endpoint. A default that serves only
 *  one endpoint (`gen4_turbo` is image-to-video only) must not break the other
 *  (grade-code CV83CD-5). Replaced rather than refused: a refused default would
 *  fail every request that names no model. */
export function t2vDefaultModel(endpoint: RunwayEndpoint): string {
  const configured = (process.env.OPENWOP_T2V_DEFAULT_MODEL ?? '').trim();
  if (!configured) return DEFAULT_RUNWAY_MODEL;
  if (runwayModel(configured, endpoint)) return configured;
  if (!warnedDefaultModel.has(endpoint)) { warnedDefaultModel.add(endpoint); log.warn('t2v_default_model_not_for_endpoint', { configured, endpoint, using: DEFAULT_RUNWAY_MODEL }); }
  return DEFAULT_RUNWAY_MODEL;
}
/**
 * Result-URL host allowlist for the SSRF-guarded download (eTLD+1s). Runway
 * serves task outputs from CloudFront (`https://dnznrvs05pmza.cloudfront.net/…`,
 * per its outputs guide, read 2026-11-03), so `cloudfront.net` is allowed while
 * the base is Runway's own — an operator override for another vendor does not
 * inherit it. Why not the exact distribution: a CDN rotation would turn a PAID
 * job into a refused download. The URL comes only from Runway's authenticated
 * TLS task response, and the egress guard (https, no redirect, pinned
 * resolution, private ranges refused) and the size cap still apply. Residual: a
 * compromised provider could make us fetch any public CloudFront object, capped.
 */
function allowedT2VHosts(): string[] {
  const extra = (process.env.OPENWOP_T2V_RESULT_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  return ['runwayml.com', ...(usingRunwayBase() ? ['cloudfront.net'] : []), ...extra];
}

export function makeT2VAdapter(deps: BrokeredEgressDeps, pin?: VideoConnectionPin): VideoAdapter {
  const auth = { authScheme: 'bearer' as const };
  const versionHeader = { 'X-Runway-Version': t2vApiVersion() };
  const pollDeps: BrokeredEgressDeps = pin ? { ...deps, ...(pin.actingUserId ? { actingUserId: pin.actingUserId } : {}) } : deps;
  return {
    async hasConnection() {
      return connectionExists({ tenantId: deps.tenantId, provider: t2vProvider(), ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}), ...(deps.orgId ? { orgId: deps.orgId } : {}) });
    },

    async submitJob(input) {
      // ADR 1051 D2 — every request names a model, ratio and duration the spec
      // accepts (gen4.5 REQUIRES ratio and duration). The service resolves them
      // before any spend; this fills the defaults for a direct call and refuses,
      // pre-dial, anything the table does not know.
      const endpoint = input.promptImage ? 'i2v' : 't2v';
      const r = resolveRunwayRequest(endpoint, {
        ...(input.model ? { model: input.model } : {}), ...(input.ratio ? { ratio: input.ratio } : {}),
        ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}), defaultModel: t2vDefaultModel(endpoint),
      });
      if (!r.ok) return { ok: false, error: `t2v_invalid_${r.field}` };
      // ADR 0945 D7 — the same task API animates a still: `image_to_video` takes
      // the image as a data URI (`promptImage`) and the motion as `promptText`.
      const body = JSON.stringify({
        ...(input.promptImage ? { promptImage: input.promptImage } : {}),
        promptText: input.script.slice(0, 1000),
        model: r.value.model,
        ratio: r.value.ratio,
        duration: r.value.durationSec,
      });
      const path = input.promptImage ? '/v1/image_to_video' : '/v1/text_to_video';
      const out = await postBeforeDialSafe(() => brokeredPost(deps, { provider: t2vProvider(), url: `${t2vApiBase()}${path}`, body, extraHeaders: versionHeader, ...auth }));
      if (out.outcome !== 'sent') return { ok: false, error: out.outcome };
      let json: Record<string, unknown> = {};
      try { json = (await out.res.json()) as Record<string, unknown>; } catch { /* {} */ }
      if (out.res.status < 200 || out.res.status >= 300) return { ok: false, error: `t2v_${out.res.status}` };
      const providerJobId = typeof json.id === 'string' ? json.id : '';
      if (!providerJobId) return { ok: false, error: 't2v_no_job_id' };
      return { ok: true, value: { providerJobId, connectionId: out.provenance.connectionId } };
    },

    async pollJob(providerJobId) {
      const out = await brokeredFetch(pollDeps, { provider: t2vProvider(), url: `${t2vApiBase()}/v1/tasks/${encodeURIComponent(providerJobId)}`, method: 'GET', extraHeaders: versionHeader, ...auth, ...(pin ? { connectionId: pin.connectionId } : {}) });
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
