/**
 * ADR 0115 Phase 3 — external image-provider adapter (the real text-to-image
 * dispatch). Present ONLY when the operator opts in (`imageGenerationAdvertised()`
 * — `OPENWOP_IMAGE_PROVIDER_ENABLED`) AND an endpoint is configured; otherwise
 * `imageProviderConfigured()` is false and `callImageGenerator` stays honest-off.
 *
 * Mirrors the ADR 0114 sandbox adapter: SSRF-guarded (deny private/loopback unless
 * allow-private, https-pinned), wall-clock timeout, and §D endpoint non-disclosure
 * (errors are generic — never echo the operator's private endpoint). The returned
 * base64 image is stored host-side as a Media asset by the caller (never raw on the
 * result boundary).
 */
import { fetch as undiciFetch } from 'undici';
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** ADR 0115 Phase 6 — per-PROVIDER endpoint resolution. A provider-specific
 *  `OPENWOP_IMAGE_PROVIDER_ENDPOINT_<PROVIDER>` (e.g. `_OPENAI`, `_GOOGLE` for Imagen)
 *  wins; absent ⇒ the generic `OPENWOP_IMAGE_PROVIDER_ENDPOINT` (back-compat: a single
 *  generic endpoint still serves every provider). So an operator runs a SECOND provider
 *  by configuring its own endpoint — no code change, inert until configured. The provider
 *  values themselves (`openai` / `google` / …) are the host's existing `IMAGE_PROVIDERS`. */
export function imageEndpoint(provider?: string): string | undefined {
  const perProvider = provider ? process.env[`OPENWOP_IMAGE_PROVIDER_ENDPOINT_${provider.toUpperCase()}`]?.trim() : undefined;
  return perProvider || process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT?.trim() || undefined;
}

/** The provider's API key — `OPENWOP_IMAGE_PROVIDER_KEY_<PROVIDER>` wins, else the generic
 *  `OPENWOP_IMAGE_PROVIDER_KEY` (so each provider may carry its own credential). */
function imageApiKey(provider?: string): string | undefined {
  const perProvider = provider ? process.env[`OPENWOP_IMAGE_PROVIDER_KEY_${provider.toUpperCase()}`]?.trim() : undefined;
  return perProvider || process.env.OPENWOP_IMAGE_PROVIDER_KEY?.trim() || undefined;
}

/** True only when the operator advertised the capability (`OPENWOP_IMAGE_PROVIDER_ENABLED`,
 *  the same flag `imageGenerationAdvertised()` reads — inlined to avoid an
 *  aiProvidersHost↔adapter import cycle) AND wired an endpoint for the given provider
 *  (per-provider or the generic fallback). */
export function imageProviderConfigured(provider?: string): boolean {
  return process.env.OPENWOP_IMAGE_PROVIDER_ENABLED === 'true' && imageEndpoint(provider) !== undefined;
}

export interface RawImage { base64: string; mimeType: string }

export async function dispatchImageGeneration(req: { prompt: string; model?: string; size?: string; n: number; provider?: string }): Promise<RawImage[]> {
  const endpoint = imageEndpoint(req.provider);
  if (!endpoint) throw new Error('image_provider_not_configured');
  const apiKey = imageApiKey(req.provider);
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('image_provider_misconfigured'); }
  // SSRF guard (the ADR 0108 compat pattern) — never echo the endpoint (§D).
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) throw new Error('image_provider_blocked');
  if (url.protocol !== 'https:' && !webhookPrivateEgressAllowed()) throw new Error('image_provider_insecure');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ prompt: req.prompt, model: req.model, size: req.size, n: req.n }),
      // MKP-2: the endpoint is operator-configured (untrusted); pin egress through the
      // connect-time-validating dispatcher to close the DNS-rebind TOCTOU the string
      // host-check can't. Unconditional — guardedLookup permits private ranges under
      // webhookPrivateEgressAllowed(); redirect:'error' refuses a redirect bypass.
      redirect: 'error',
      dispatcher: webhookEgressDispatcher(),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error((e as { name?: string }).name === 'AbortError' ? 'image_provider_timeout' : 'image_provider_transport_error'); // §D — no endpoint
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('image_provider_error'); // §D — no status/endpoint echo
  const body = (await res.json()) as { images?: Array<{ base64?: unknown; b64_json?: unknown; mimeType?: unknown }> };
  const out: RawImage[] = [];
  for (const img of body.images ?? []) {
    const base64 = typeof img.base64 === 'string' ? img.base64 : typeof img.b64_json === 'string' ? img.b64_json : undefined;
    if (!base64) continue;
    out.push({ base64, mimeType: typeof img.mimeType === 'string' ? img.mimeType : 'image/png' });
  }
  if (out.length === 0) throw new Error('image_provider_empty');
  return out;
}
