/**
 * Native image-generation provider dispatch (ADR 0115 § Correction 2026-07-17).
 *
 * The Phase-6 ruling ("per-vendor request/response shaping is an operator-side
 * gateway concern") was deliberately overturned (user decision): a plain BYOK
 * OpenAI/Google key must generate images out-of-box, exactly as the SIBLING
 * speech path does (`dispatchSpeech.ts` calls api.openai.com natively) — an
 * operator-run `{prompt}→{base64}` translation gateway is a real adoption cliff.
 * The operator-gateway adapter (`host/imageProviderAdapter.ts`) remains and
 * takes precedence when configured (back-compat; also the escape hatch for
 * providers that need bespoke shaping).
 *
 * Mirrors `dispatchSpeech.ts`: dependency-free global `fetch`, per-vendor
 * functions, plain-`Error` throws (status + body snippet, NEVER the key) that
 * the adapter maps onto the AiProviderError taxonomy, an `AbortSignal` from the
 * host timeout wrapper, and `<VENDOR>_BASE_URL` env overrides.
 *
 * Vendor endpoints (validated against the provider discovery docs, not SDKs —
 * the provider-wire-verify lesson):
 *  - OpenAI Images: POST {base}/images/generations — `gpt-image-1` returns
 *    base64 by default (and REJECTS `response_format`); `dall-e-*` models need
 *    `response_format: 'b64_json'`.
 *  - Google Imagen (Gemini API): POST {base}/models/{model}:predict with the
 *    `x-goog-api-key` header — `instances[{prompt}]` + `parameters.sampleCount`,
 *    replies `predictions[{bytesBase64Encoded, mimeType?}]`.
 */

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const GOOGLE_GENAI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';
const DEFAULT_GOOGLE_IMAGE_MODEL = 'imagen-3.0-generate-002';

/** Providers this module can dispatch natively with a plain vendor API key. */
export const NATIVE_IMAGE_PROVIDERS = ['openai', 'google', 'replicate'] as const; // ADR 0401 P2 adds replicate
export type NativeImageProvider = (typeof NATIVE_IMAGE_PROVIDERS)[number];

export function isNativeImageProvider(p: string): p is NativeImageProvider {
  return (NATIVE_IMAGE_PROVIDERS as readonly string[]).includes(p);
}

export interface DispatchImagesArgs {
  apiKey: string;
  prompt: string;
  n: number;
  model?: string | undefined;
  /** OpenAI only — e.g. '1024x1024'. Imagen sizes via model choice, not a param. */
  size?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface DispatchedImage {
  base64: string;
  mimeType: string;
}

export const snippetOf = async (res: { text(): Promise<string> }): Promise<string> =>
  (await res.text().catch(() => '')).slice(0, 300);

interface OpenAiImagesResponse {
  data?: Array<{ b64_json?: string }>;
}

/** OpenAI Images API. Throws plain Error (status + snippet, never the key). */
export async function dispatchImagesOpenAI(args: DispatchImagesArgs): Promise<DispatchedImage[]> {
  const baseUrl = (process.env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? DEFAULT_OPENAI_IMAGE_MODEL;
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      model,
      prompt: args.prompt,
      n: args.n,
      ...(args.size ? { size: args.size } : {}),
      // gpt-image-1 returns b64 by default and REJECTS response_format; the
      // dall-e models default to `url` and need the explicit b64 ask.
      ...(model.startsWith('dall-e') ? { response_format: 'b64_json' } : {}),
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!res.ok) throw new Error(`openai_images_${res.status}: ${await snippetOf(res)}`);
  const body = (await res.json().catch(() => ({}))) as OpenAiImagesResponse;
  const images = (body.data ?? [])
    .filter((d): d is { b64_json: string } => typeof d.b64_json === 'string' && d.b64_json.length > 0)
    .map((d) => ({ base64: d.b64_json, mimeType: 'image/png' }));
  if (images.length === 0) throw new Error('openai_images_no_data: response carried no b64 images');
  return images;
}

interface GoogleImagenResponse {
  predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
}

/** Google Imagen via the Gemini API `:predict` verb. Throws plain Error. */
export async function dispatchImagesGoogle(args: DispatchImagesArgs): Promise<DispatchedImage[]> {
  const baseUrl = (process.env.GOOGLE_BASE_URL ?? GOOGLE_GENAI_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? DEFAULT_GOOGLE_IMAGE_MODEL;
  const res = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': args.apiKey },
    body: JSON.stringify({ instances: [{ prompt: args.prompt }], parameters: { sampleCount: args.n } }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!res.ok) throw new Error(`google_imagen_${res.status}: ${await snippetOf(res)}`);
  const body = (await res.json().catch(() => ({}))) as GoogleImagenResponse;
  const images = (body.predictions ?? [])
    .filter((p): p is { bytesBase64Encoded: string; mimeType?: string } => typeof p.bytesBase64Encoded === 'string' && p.bytesBase64Encoded.length > 0)
    .map((p) => ({ base64: p.bytesBase64Encoded, mimeType: p.mimeType ?? 'image/png' }));
  if (images.length === 0) throw new Error('google_imagen_no_data: response carried no base64 predictions');
  return images;
}

/** Route to the native vendor dispatcher. */
export async function dispatchImagesNative(provider: NativeImageProvider, args: DispatchImagesArgs): Promise<DispatchedImage[]> {
  return provider === 'openai' ? dispatchImagesOpenAI(args) : provider === 'google' ? dispatchImagesGoogle(args) : dispatchImagesReplicate(args);
}

// ── ADR 0401 P2 — Replicate (SDXL / FLUX family) ─────────────────────────────

export const REPLICATE_DEFAULT_BASE_URL = 'https://api.replicate.com/v1';
const DEFAULT_REPLICATE_IMAGE_MODEL = 'black-forest-labs/flux-schnell';
/** Output bytes cap per image (Replicate delivers URLs, we fetch the bytes). */
const REPLICATE_MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

/**
 * The ONE image path that touches a non-fixed host: Replicate returns output
 * URLs (normally on `replicate.delivery`). The fetch is UNCREDENTIALED and the
 * host is allowlist-pinned — the same SSRF posture as the fixed vendor hosts.
 * (ADR 0401 correction: the connection-pack `brokeredFetch` is Connection
 * machinery; a fixed allowlist gives the identical guarantee here without
 * threading broker deps into this dependency-free module.)
 */
export function assertAllowedReplicateOutputUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`replicate_output_bad_url: unparseable output URL`); }
  const host = url.hostname.toLowerCase();
  const ok = url.protocol === 'https:'
    && (host === 'replicate.delivery' || host.endsWith('.replicate.delivery') || host === 'api.replicate.com');
  if (!ok) throw new Error(`replicate_output_host_denied: ${host} is not an allowed Replicate output host`);
  return url;
}

export interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

export const REPLICATE_TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const TERMINAL = REPLICATE_TERMINAL;

/**
 * Replicate image dispatch: create a prediction on the models endpoint with
 * `Prefer: wait` (sync up to 60s), then poll `urls.get` (api.replicate.com —
 * host-enforced) until terminal under the caller's AbortSignal; finally fetch
 * each output URL (allowlist-pinned, uncredentialed, size-capped) to base64.
 * Plain-Error throws (status + snippet, NEVER the key) like its siblings.
 */
export async function dispatchImagesReplicate(args: DispatchImagesArgs): Promise<DispatchedImage[]> {
  const model = args.model ?? DEFAULT_REPLICATE_IMAGE_MODEL;
  const images = await dispatchReplicateTask({
    apiKey: args.apiKey,
    model,
    input: { prompt: args.prompt, num_outputs: args.n },
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return images.slice(0, args.n);
}

// ── ADR 0401 P3 — edit / inpaint / background-remove / upscale dispatch ──────

export type ImageEditOp = 'edit' | 'inpaint' | 'background-remove';

/** The honest provider capability matrix (ADR 0401 §b). The adapter turns an
 *  unsupported (provider, op) into a typed `host_capability_missing` — never a
 *  silent fallback to another provider. */
export const IMAGE_OP_SUPPORT: Record<string, ReadonlySet<string>> = {
  openai: new Set(['generate', 'edit', 'inpaint']),
  google: new Set(['generate']),
  replicate: new Set(['generate', 'edit', 'inpaint', 'background-remove', 'upscale']),
};

/** Curated per-op Replicate default models (ADR 0401 OQ-3) — a known-good task
 *  set so the op menu is populated out-of-box; BYOK operators may override
 *  with any `owner/name`.
 *
 *  ROTATION SURFACE (R0401-2): these are EXTERNAL model ids and can be sunset
 *  upstream. This map (plus `DEFAULT_REPLICATE_IMAGE_MODEL`) is the ONE place to
 *  bump when that happens — pinned by `dispatch-images-replicate.test.ts` so a
 *  change is deliberate/reviewed (the providers.json discipline). A live 404/422
 *  surfaces as `replicate_model_unavailable_*` naming the model + the override. */
export const REPLICATE_OP_DEFAULT_MODELS: Record<string, string> = {
  edit: 'black-forest-labs/flux-dev',
  inpaint: 'stability-ai/stable-diffusion-inpainting',
  'background-remove': 'lucataco/remove-bg',
  upscale: 'nightmareai/real-esrgan',
};

export interface DispatchImageEditArgs {
  apiKey: string;
  imageBase64: string;
  mimeType: string;
  op: ImageEditOp;
  prompt?: string | undefined;
  maskBase64?: string | undefined;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** OpenAI `/images/edits` — multipart (image + optional mask + prompt).
 *  gpt-image-1 returns b64 by default. Throws plain Error, never the key. */
export async function dispatchImageEditOpenAI(args: DispatchImageEditArgs): Promise<DispatchedImage[]> {
  const baseUrl = (process.env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? DEFAULT_OPENAI_IMAGE_MODEL;
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', args.prompt ?? '');
  form.append('image', new Blob([Buffer.from(args.imageBase64, 'base64')], { type: args.mimeType }), 'image.png');
  if (args.maskBase64) {
    form.append('mask', new Blob([Buffer.from(args.maskBase64, 'base64')], { type: 'image/png' }), 'mask.png');
  }
  const res = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: { authorization: `Bearer ${args.apiKey}` },
    body: form,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!res.ok) throw new Error(`openai_images_edit_${res.status}: ${await snippetOf(res)}`);
  const body = (await res.json().catch(() => ({}))) as OpenAiImagesResponse;
  const images = (body.data ?? [])
    .filter((d): d is { b64_json: string } => typeof d.b64_json === 'string' && d.b64_json.length > 0)
    .map((d) => ({ base64: d.b64_json, mimeType: 'image/png' }));
  if (images.length === 0) throw new Error('openai_images_edit_no_data: response carried no b64 images');
  return images;
}

/** Run a Replicate task model over an input image (edit/inpaint/bg-remove/
 *  upscale). Inputs ride data URIs; outputs come back via the same pinned
 *  prediction flow as generation. */
async function dispatchReplicateTask(args: { apiKey: string; model: string; input: Record<string, unknown>; signal?: AbortSignal | undefined }): Promise<DispatchedImage[]> {
  const baseUrl = (process.env.REPLICATE_BASE_URL ?? REPLICATE_DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.model)) {
    throw new Error(`replicate_bad_model: model must be "owner/name" (got "${args.model.slice(0, 80)}")`);
  }
  const created = await fetch(`${baseUrl}/models/${args.model}/predictions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}`, prefer: 'wait=60' },
    body: JSON.stringify({ input: args.input }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!created.ok) {
    // R0401-2 — the curated default models (REPLICATE_OP_DEFAULT_MODELS) are
    // EXTERNAL names that can be sunset upstream. A 404/422 on the model
    // endpoint is exactly that rotation failure — name the model + the override
    // so an operator can react without reading the raw snippet.
    if (created.status === 404 || created.status === 422) {
      throw new Error(`replicate_model_unavailable_${created.status}: model "${args.model}" is unavailable (deprecated or wrong id) — set an explicit \`model\` (owner/name) to override the default`);
    }
    throw new Error(`replicate_predictions_${created.status}: ${await snippetOf(created)}`);
  }
  let prediction = (await created.json().catch(() => ({}))) as ReplicatePrediction;
  while (!TERMINAL.has(prediction.status ?? '')) {
    if (args.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const pollUrl = prediction.urls?.get;
    if (!pollUrl) throw new Error('replicate_no_poll_url: non-terminal prediction carried no urls.get');
    const parsed = assertAllowedReplicateOutputUrl(pollUrl);
    if (parsed.hostname !== 'api.replicate.com') throw new Error('replicate_poll_host_denied: poll URL must be api.replicate.com');
    await new Promise((r) => setTimeout(r, 1_000));
    const res = await fetch(pollUrl, { headers: { authorization: `Bearer ${args.apiKey}` }, ...(args.signal ? { signal: args.signal } : {}) });
    if (!res.ok) throw new Error(`replicate_poll_${res.status}: ${await snippetOf(res)}`);
    prediction = (await res.json().catch(() => ({}))) as ReplicatePrediction;
  }
  if (prediction.status !== 'succeeded') {
    const reason = typeof prediction.error === 'string' ? prediction.error.slice(0, 300) : prediction.status;
    throw new Error(`replicate_${prediction.status}: ${reason}`);
  }
  const outputs = (Array.isArray(prediction.output) ? prediction.output : [prediction.output])
    .filter((o): o is string => typeof o === 'string' && o.length > 0);
  if (outputs.length === 0) throw new Error('replicate_no_output: succeeded prediction carried no output URLs');
  const images: DispatchedImage[] = [];
  for (const raw of outputs) {
    assertAllowedReplicateOutputUrl(raw);
    const res = await fetch(raw, { ...(args.signal ? { signal: args.signal } : {}) });
    if (!res.ok) throw new Error(`replicate_output_${res.status}: ${await snippetOf(res)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > REPLICATE_MAX_OUTPUT_BYTES) throw new Error('replicate_output_too_large: output exceeds the 25 MiB cap');
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
    images.push({ base64: buf.toString('base64'), mimeType });
  }
  return images;
}

/** Replicate edit ops — the input shape per curated task model family. */
export async function dispatchImageEditReplicate(args: DispatchImageEditArgs): Promise<DispatchedImage[]> {
  const model = args.model ?? REPLICATE_OP_DEFAULT_MODELS[args.op] ?? REPLICATE_OP_DEFAULT_MODELS.edit!;
  const imageUri = `data:${args.mimeType};base64,${args.imageBase64}`;
  const input: Record<string, unknown> =
    args.op === 'background-remove' ? { image: imageUri }
      : args.op === 'inpaint' ? { image: imageUri, mask: `data:image/png;base64,${args.maskBase64 ?? ''}`, prompt: args.prompt ?? '' }
        : { image: imageUri, prompt: args.prompt ?? '' };
  return dispatchReplicateTask({ apiKey: args.apiKey, model, input, ...(args.signal ? { signal: args.signal } : {}) });
}

export interface DispatchImageUpscaleArgs {
  apiKey: string;
  imageBase64: string;
  mimeType: string;
  scale: 2 | 4;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Replicate upscale (Real-ESRGAN-class). */
export async function dispatchImageUpscaleReplicate(args: DispatchImageUpscaleArgs): Promise<DispatchedImage[]> {
  const model = args.model ?? REPLICATE_OP_DEFAULT_MODELS.upscale!;
  return dispatchReplicateTask({
    apiKey: args.apiKey,
    model,
    input: { image: `data:${args.mimeType};base64,${args.imageBase64}`, scale: args.scale },
    ...(args.signal ? { signal: args.signal } : {}),
  });
}
