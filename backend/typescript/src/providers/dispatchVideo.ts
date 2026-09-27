/**
 * Native video-generation provider dispatch (ADR 0411) — the `dispatchImages`
 * sibling for generative VIDEO. v1 provider: Replicate, which hosts Veo 3 AND
 * Kling / Luma Ray / Wan / minimax behind a single BYOK token, so one dispatcher
 * yields many models. Reuses the ADR 0401 Replicate primitives (create → poll to
 * terminal → SSRF-pinned output fetch) — video just polls longer and the output
 * cap is larger.
 *
 * Dependency-free global `fetch`; plain-Error throws (status + snippet, NEVER the
 * key) that the adapter maps onto the video error taxonomy; an AbortSignal from
 * the host timeout wrapper; a fixed `api.replicate.com` host (no SSRF surface on
 * the credentialed calls) + the allowlist-pinned, UNCREDENTIALED output fetch.
 */

import {
  REPLICATE_DEFAULT_BASE_URL, REPLICATE_TERMINAL, snippetOf,
  assertAllowedReplicateOutputUrl, type ReplicatePrediction,
} from './dispatchImages.js';

/** Curated default video model (ADR 0411) — Veo 3 (fast tier) per the provider
 *  steer. ROTATION SURFACE: an external id that can be sunset upstream; this is
 *  the ONE place to bump, pinned by test. BYOK operators override via `model`. */
export const DEFAULT_REPLICATE_VIDEO_MODEL = 'google/veo-3-fast';

/** ~200 MiB output cap — a short reel at 720/1080p. Operator-tunable via
 *  `OPENWOP_VIDEO_MAX_BYTES` (a smaller cap trims per-job peak RSS on a small
 *  instance); read at call time so it is testable. */
const REPLICATE_VIDEO_MAX_BYTES_DEFAULT = 200 * 1024 * 1024;
function videoMaxBytes(): number {
  const v = Number(process.env.OPENWOP_VIDEO_MAX_BYTES ?? '');
  return Number.isFinite(v) && v > 0 ? v : REPLICATE_VIDEO_MAX_BYTES_DEFAULT;
}

/** Read a response body to a Buffer while enforcing `maxBytes` DURING the stream:
 *  a declared oversized `content-length` rejects up front, and the running total
 *  aborts the read the instant it crosses the cap — so an oversized/hostile CDN
 *  response can never balloon RSS past the cap before rejection (grade-code VID-2). */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('replicate_output_too_large: video exceeds the configured cap');
  if (!res.body) { // no readable stream — fall back to buffering, still cap-checked
    const b = Buffer.from(await res.arrayBuffer());
    if (b.byteLength > maxBytes) throw new Error('replicate_output_too_large: video exceeds the configured cap');
    return b;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error('replicate_output_too_large: video exceeds the configured cap'); }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks);
}

/** ADR 0411 P2 — which video models accept the `generate_audio` input. Replicate
 *  REJECTS unknown inputs with 422, and BYOK operators can point `model` at
 *  Kling/Luma/Wan/minimax (no audio input), so `generate_audio` is forwarded
 *  ONLY for the audio-capable family. ROTATION SURFACE: the audio-capable set —
 *  the ONE place to widen when another hosted model gains a `generate_audio`
 *  input (pinned by test). The Veo family (veo-3, veo-3-fast, veo-3.1…) native-
 *  generates synced audio via `generate_audio` (default true). */
export function isAudioCapableVideoModel(model: string): boolean {
  return /^google\/veo-3/.test(model);
}

export interface DispatchVideoArgs {
  apiKey: string;
  prompt: string;
  model?: string | undefined;
  negativePrompt?: string | undefined;
  durationSeconds?: number | undefined;
  /** e.g. '16:9' | '9:16' | '1:1' — forwarded when the model accepts it. */
  aspectRatio?: string | undefined;
  seed?: number | undefined;
  /** ADR 0411 P2 — Veo `generate_audio` (default true upstream). Forwarded ONLY
   *  for `isAudioCapableVideoModel` models (else omitted → no 422). The load-
   *  bearing case is `false` (suppress Veo's default audio). */
  generateAudio?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface DispatchedVideo {
  base64: string;
  mimeType: string;
  sizeBytes: number;
}

/** Replicate video model dispatch: create a prediction, poll to terminal under
 *  the caller's AbortSignal (host max-wait), then fetch the single output mp4
 *  URL (allowlist-pinned, uncredentialed, size-capped) to base64. */
export async function dispatchVideoReplicate(args: DispatchVideoArgs): Promise<DispatchedVideo> {
  const baseUrl = (process.env.REPLICATE_BASE_URL ?? REPLICATE_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = args.model ?? DEFAULT_REPLICATE_VIDEO_MODEL;
  if (!/^[\w.-]+\/[\w.-]+$/.test(model)) {
    throw new Error(`replicate_bad_model: model must be "owner/name" (got "${model.slice(0, 80)}")`);
  }
  const input: Record<string, unknown> = {
    prompt: args.prompt,
    ...(args.negativePrompt ? { negative_prompt: args.negativePrompt } : {}),
    ...(args.durationSeconds ? { duration: args.durationSeconds } : {}),
    ...(args.aspectRatio ? { aspect_ratio: args.aspectRatio } : {}),
    ...(args.seed != null ? { seed: args.seed } : {}),
    // Audio: forward ONLY for the audio-capable family (else Replicate 422s on
    // the unknown input). Absent ⇒ Veo's upstream default (audio on) applies.
    ...(args.generateAudio != null && isAudioCapableVideoModel(model) ? { generate_audio: args.generateAudio } : {}),
  };
  const created = await fetch(`${baseUrl}/models/${model}/predictions`, {
    method: 'POST',
    // A short wait; video is slow, so we expect to poll. `Prefer: wait` caps at 60s.
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}`, prefer: 'wait=60' },
    body: JSON.stringify({ input }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!created.ok) {
    if (created.status === 404 || created.status === 422) {
      throw new Error(`replicate_model_unavailable_${created.status}: video model "${model}" is unavailable (deprecated or wrong id) — set an explicit \`model\` (owner/name) to override the default`);
    }
    throw new Error(`replicate_predictions_${created.status}: ${await snippetOf(created)}`);
  }
  let prediction = (await created.json().catch(() => ({}))) as ReplicatePrediction;
  while (!REPLICATE_TERMINAL.has(prediction.status ?? '')) {
    if (args.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const pollUrl = prediction.urls?.get;
    if (!pollUrl) throw new Error('replicate_no_poll_url: non-terminal prediction carried no urls.get');
    const parsed = assertAllowedReplicateOutputUrl(pollUrl);
    if (parsed.hostname !== 'api.replicate.com') throw new Error('replicate_poll_host_denied: poll URL must be api.replicate.com');
    await new Promise((r) => setTimeout(r, 2_000)); // video is slow — poll every 2s
    const res = await fetch(pollUrl, { headers: { authorization: `Bearer ${args.apiKey}` }, ...(args.signal ? { signal: args.signal } : {}) });
    if (!res.ok) throw new Error(`replicate_poll_${res.status}: ${await snippetOf(res)}`);
    prediction = (await res.json().catch(() => ({}))) as ReplicatePrediction;
  }
  if (prediction.status !== 'succeeded') {
    const reason = typeof prediction.error === 'string' ? prediction.error.slice(0, 300) : prediction.status;
    throw new Error(`replicate_${prediction.status}: ${reason}`);
  }
  // Video models return a single output URL (string), or an array — take the first.
  const out = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (typeof out !== 'string' || out.length === 0) throw new Error('replicate_no_output: succeeded prediction carried no video URL');
  assertAllowedReplicateOutputUrl(out);
  const res = await fetch(out, { ...(args.signal ? { signal: args.signal } : {}) });
  if (!res.ok) throw new Error(`replicate_output_${res.status}: ${await snippetOf(res)}`);
  const buf = await readBodyCapped(res, videoMaxBytes());
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4';
  return { base64: buf.toString('base64'), mimeType, sizeBytes: buf.byteLength };
}
