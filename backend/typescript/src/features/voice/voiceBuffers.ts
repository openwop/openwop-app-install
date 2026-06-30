/**
 * Host-internal live-audio buffers (ADR 0138 P1, RFC 0106 §B.1 / §E).
 *
 * The `voice` feature owns the live-mic TRANSPORT — host-internal per RFC 0106 §E.
 * P1 transport floor: the client appends utterance chunks over HTTP
 * (`POST …/voice/session/:id/audio`); the host accumulates them per `streamRef`
 * in memory, and on the endpoint signal (`…/commit`) the CORE
 * `callTranscriber({audio:{streamRef}})` reads the accumulated utterance through
 * the `StreamAudioResolver` seam and transcribes it. A lower-latency WebSocket /
 * WebRTC transport (the deferred open question) plugs in behind this same buffer
 * + `streamRef` model — `callTranscriber` and the resolver seam do not change.
 *
 * §F invariants enforced here:
 *  - `voice-streamref-tenant-bound`: a `streamRef` is bound to one tenant+session;
 *    every append re-checks the tenant, and the resolver returns the bound tenant
 *    so CORE re-checks it against the call scope (no cross-handle bleed).
 *  - a **max-uncommitted-audio budget** per utterance (TDoS guard): appends past
 *    the cap fail closed.
 *
 * Buffers are EPHEMERAL (process memory) — they hold no durable conversation
 * content (the committed `voice.*` turn is the durable record), so they are GC-able
 * and exempt from replay (ADR 0138 finding #7).
 *
 * MULTI-INSTANCE: because the buffer is process-memory, the HTTP-chunked transport
 * (P1) requires append + commit to reach the SAME instance — i.e. single-instance or
 * sticky-session affinity (the `channelPresence` precedent: opt in only on a topology
 * that can honor it). The `voice` toggle is OFF by default; the lower-latency WS/WebRTC
 * transport will likewise need session affinity. The `VoiceSession` record itself is
 * durable (cross-instance), so a mis-routed commit fails closed with a clean 404, never
 * a wrong-tenant read.
 */
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { registerStreamAudioResolver, type ResolvedStreamAudio } from '../../aiProviders/streamAudio.js';

/** Max accumulated audio per uncommitted utterance — fail-closed past this (§F TDoS). */
const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024; // 8 MiB
/** Backstop on concurrent open utterance buffers process-wide. */
const MAX_OPEN_BUFFERS = 2000;
/** Idle TTL — an abandoned (never committed/ended) utterance is reaped (§F max-duration). */
const BUFFER_IDLE_MS = 5 * 60 * 1000; // 5 min

interface StreamBuffer {
  streamRef: string;
  tenantId: string;
  sessionId: string;
  mimeType: string;
  parts: Buffer[];
  bytes: number;
  touchedMs: number;
}

const buffers = new Map<string, StreamBuffer>();

/** Reap utterance buffers idle past the TTL (§F max-duration). Lazy — runs on open. */
function reapIdle(nowMs: number): void {
  for (const [ref, b] of buffers) if (nowMs - b.touchedMs > BUFFER_IDLE_MS) buffers.delete(ref);
}

/** Only accept audio MIME types (defends the managed transcription path). */
function cleanAudioMime(v: unknown): string {
  return typeof v === 'string' && /^audio\/[a-z0-9.+-]+$/i.test(v) ? v.toLowerCase() : 'audio/webm';
}

/** Mint a `streamRef` and open an empty utterance buffer bound to one tenant+session. */
export function openStreamBuffer(tenantId: string, sessionId: string, mimeType: unknown): string {
  const now = Date.now();
  reapIdle(now); // lazy GC of abandoned utterances (§F max-duration)
  if (buffers.size >= MAX_OPEN_BUFFERS) {
    throw new OpenwopError('rate_limited', 'Too many open voice streams; try again shortly.', 429, {});
  }
  const streamRef = `vstream_${randomUUID()}`;
  buffers.set(streamRef, { streamRef, tenantId, sessionId, mimeType: cleanAudioMime(mimeType), parts: [], bytes: 0, touchedMs: now });
  return streamRef;
}

/** Append a base64 audio chunk to a streamRef's buffer; returns the new total byte count.
 *  Tenant-bound (§F) + budgeted (fail-closed). */
export function appendStreamChunk(streamRef: string, tenantId: string, base64: unknown): number {
  const buf = buffers.get(streamRef);
  // Collapse unknown + cross-tenant into one 404 (no existence oracle, §F).
  if (!buf || buf.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Voice stream not found.', 404, {});
  }
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new OpenwopError('validation_error', '`audioChunk` (base64 string) is required.', 400, { field: 'audioChunk' });
  }
  let chunk: Buffer;
  try {
    chunk = Buffer.from(base64, 'base64');
  } catch {
    throw new OpenwopError('validation_error', '`audioChunk` must be valid base64.', 400, { field: 'audioChunk' });
  }
  if (buf.bytes + chunk.length > MAX_UTTERANCE_BYTES) {
    // Fail closed past the per-utterance budget (§F TDoS guard).
    throw new OpenwopError('rate_limited', 'Voice utterance exceeds the per-turn audio budget.', 413, { capability: 'aiProviders.realtimeVoice' });
  }
  buf.parts.push(chunk);
  buf.bytes += chunk.length;
  buf.touchedMs = Date.now();
  return buf.bytes;
}

/** Discard a streamRef's buffer (after a turn commits, or on session end). GC. */
export function closeStreamBuffer(streamRef: string): void {
  buffers.delete(streamRef);
}

/** Discard every buffer for a session (session end / cleanup). */
export function closeSessionBuffers(sessionId: string): void {
  for (const [ref, b] of buffers) if (b.sessionId === sessionId) buffers.delete(ref);
}

/** The `StreamAudioResolver` (ADR 0138 finding #1) — CORE `callTranscriber` reads the
 *  accumulated utterance through this; the bound tenant is returned so core re-checks it. */
async function resolveStreamAudio(streamRef: string): Promise<ResolvedStreamAudio | null> {
  const buf = buffers.get(streamRef);
  if (!buf || buf.bytes === 0) return null;
  return { contentBase64: Buffer.concat(buf.parts).toString('base64'), contentType: buf.mimeType, tenantId: buf.tenantId };
}

/** Wire the live-audio transport into core (called once at feature boot). Idempotent. */
export function wireStreamAudioResolver(): void {
  registerStreamAudioResolver(resolveStreamAudio);
}

/** Test-only: reset buffers between cases. */
export function __resetVoiceBuffers(): void {
  buffers.clear();
}
