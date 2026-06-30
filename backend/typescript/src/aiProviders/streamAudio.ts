/**
 * Live-stream audio resolver seam (ADR 0138 P1, RFC 0106 §B.1).
 *
 * `callTranscriber({ audio: { streamRef } })` needs to read the bytes a live
 * mic transport has buffered for a `streamRef`. Transport is **host-internal**
 * (RFC 0106 §E) and lives in the `voice` feature-package — but the transcription
 * itself is a CORE `aiProviders` concern (ADR 0138 architect finding #1: the
 * `StreamingTranscriber` path lives in core, never in the feature, so core's
 * `callTranscriber` never depends on the feature being loaded).
 *
 * This is the dependency INVERSION that keeps that boundary clean: core owns the
 * resolver *interface* + registry; the feature's transport REGISTERS a resolver
 * at boot (the `setSubjectOrgResolver` / `registerToolResultTransform` precedent).
 * When no resolver is registered, the live `streamRef` path stays an honest
 * `transcription_unsupported` (the advertisement is DERIVED — finding #3).
 *
 * The resolver returns the buffered utterance bytes + the owning tenant; core
 * re-checks `tenantId` against the call scope (§F `voice-streamref-tenant-bound`).
 */

/** Buffered live-audio for one `streamRef`, resolved by the registered transport. */
export interface ResolvedStreamAudio {
  /** The accumulated utterance bytes, base64. */
  contentBase64: string;
  /** The audio MIME type the transport captured (e.g. `audio/webm`). */
  contentType: string;
  /** The tenant the `streamRef` is bound to — core re-checks this against the call scope. */
  tenantId: string;
}

/** Resolve a `streamRef` to its buffered audio, or `null` if unknown/empty. */
export type StreamAudioResolver = (streamRef: string) => Promise<ResolvedStreamAudio | null>;

let resolver: StreamAudioResolver | null = null;

/** Register the host-internal live-audio transport (called once, at feature boot). */
export function registerStreamAudioResolver(fn: StreamAudioResolver): void {
  resolver = fn;
}

/** The registered resolver, or `null` when no live transport is wired. */
export function getStreamAudioResolver(): StreamAudioResolver | null {
  return resolver;
}

/** Whether a live streaming-transcription path is wired (drives honest advertisement). */
export function liveTranscriptionWired(): boolean {
  return resolver !== null;
}
