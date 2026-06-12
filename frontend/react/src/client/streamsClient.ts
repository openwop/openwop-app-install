/**
 * SSE stream client.
 *
 * Dual-path subscription:
 *
 *   - **Bearer-mode** (`config.authMode === 'bearer'`) → routes through the
 *     published SDK's `streamEvents()` (fetch + ReadableStream — `sse.ts`).
 *     The SDK sets `Authorization: Bearer ${apiKey}` as a real header, which
 *     kills the prior `?apiKey=<key>` URL query-param security smell
 *     (URL-borne credentials leak to browser history, server logs, and
 *     shared screenshots). Reconnect-with-Last-Event-ID is implemented in
 *     this wrapper since the SDK's generator is single-shot.
 *
 *   - **Cookie-mode** (`config.authMode === 'cookie'`) → stays on native
 *     `EventSource` with `withCredentials: true`. The SDK's `streamEvents()`
 *     uses raw `fetch()` without exposing a `credentials: 'include'` option,
 *     so it can't carry the `openwop.session` cookie cross-origin. A future
 *     SDK enhancement that adds either a fetch-credentials option or a
 *     custom-fetch hook to `streamEvents()` would let this path migrate
 *     too; tracked in the comments below.
 *
 * Both paths preserve the same public API (`subscribeToRun`, `Subscription`,
 * dual idle/absolute timeouts) so the 5 consumer surfaces don't need to know
 * which transport they got.
 */

import { streamEvents, type RunEventDoc, type StreamMode } from '@openwop/openwop';
import { config } from './config.js';
import { readSseFrames } from './sseFrames.js';

export interface SubscribeOptions {
  modes?: readonly StreamMode[];
  onEvent: (event: RunEventDoc) => void;
  onError?: (err: Event) => void;
  onClose?: () => void;
  /** Dual-layer timeouts. Idle resets on each event arrival; absolute
   *  is a hard deadline that never resets. Either firing closes the
   *  subscription and invokes onTimeout. */
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  onTimeout?: (kind: 'idle' | 'absolute') => void;
}

export interface Subscription {
  close(): void;
}

/** Maximum reconnect attempts the bearer-mode path makes before giving up.
 *  Each attempt re-sends `Last-Event-ID` so the server can resume from where
 *  the prior connection dropped (per the SSE spec). EventSource's native
 *  reconnect (used by cookie-mode) is unbounded; bounding bearer-mode keeps
 *  failed-network scenarios from looping forever. */
const MAX_RECONNECTS = 5;

export function subscribeToRun(runId: string, opts: SubscribeOptions): Subscription {
  // Dual-layer timeouts shared by both transports.
  const idleMs = opts.idleTimeoutMs ?? 30_000;
  const absoluteMs = opts.absoluteTimeoutMs ?? 120_000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let manuallyClosed = false;

  function clearTimers(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (absoluteTimer) { clearTimeout(absoluteTimer); absoluteTimer = null; }
  }

  function fireTimeout(kind: 'idle' | 'absolute', onAbort: () => void): void {
    if (timedOut) return;
    timedOut = true;
    clearTimers();
    onAbort();
    opts.onTimeout?.(kind);
  }

  function resetIdle(onAbort: () => void): void {
    if (timedOut) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fireTimeout('idle', onAbort), idleMs);
  }

  const hooks: TimerHooks = {
    onTimedOut: () => timedOut,
    onManuallyClosed: () => manuallyClosed,
    setManuallyClosed: (v) => { manuallyClosed = v; },
    clearTimers,
    resetIdle,
    armAbsolute: (onAbort) => {
      absoluteTimer = setTimeout(() => fireTimeout('absolute', onAbort), absoluteMs);
    },
  };

  // Single mode arg normalization shared by both transports.
  const modeOpt: StreamMode | readonly StreamMode[] | undefined =
    opts.modes && opts.modes.length > 0
      ? (opts.modes.length === 1 ? opts.modes[0]! : opts.modes)
      : undefined;

  // Both transports are now fetch + ReadableStream generators that yield
  // EVERY event the backend emits — no hard-coded event-type allowlist, so
  // additively-introduced event types (per `version-negotiation.md`) flow
  // through on an SDK bump, not a hand-edit (GAP-ANALYSIS A-1). Bearer mode
  // uses the published SDK's `streamEvents`; cookie mode uses a local twin
  // that swaps the `Authorization` header for `credentials: 'include'`
  // (the SDK's fetch can't carry the `openwop.session` cookie — see header).
  const makeGenerator = config.authMode === 'bearer'
    ? (lastEventId: string | undefined, signal: AbortSignal) =>
        streamEvents(
          { baseUrl: config.sseBaseUrl, apiKey: config.apiKey },
          runId,
          {
            ...(modeOpt !== undefined ? { streamMode: modeOpt } : {}),
            ...(lastEventId !== undefined ? { lastEventId } : {}),
            signal,
          },
        )
    : (lastEventId: string | undefined, signal: AbortSignal) =>
        streamEventsCredentialed(config.sseBaseUrl, runId, {
          ...(modeOpt !== undefined ? { streamMode: modeOpt } : {}),
          ...(lastEventId !== undefined ? { lastEventId } : {}),
          signal,
        });

  return subscribeViaGenerator(makeGenerator, opts, hooks);
}

/** Shared timer wiring passed from `subscribeToRun` to the transport-specific
 *  subscribe implementations. Keeps both paths honest about idle/absolute
 *  behavior without duplicating the timer state. */
interface TimerHooks {
  onTimedOut: () => boolean;
  onManuallyClosed: () => boolean;
  setManuallyClosed: (v: boolean) => void;
  clearTimers: () => void;
  resetIdle: (onAbort: () => void) => void;
  armAbsolute: (onAbort: () => void) => void;
}

/** Shared subscribe loop for both transports. `makeGenerator` builds a fresh
 *  RunEventDoc async-generator (re-entered each reconnect with the recorded
 *  Last-Event-ID). Reconnects on transient errors up to MAX_RECONNECTS, then
 *  surfaces a fatal error via `opts.onError`. Every yielded event is shape-
 *  validated before dispatch (GAP-ANALYSIS A-2): a value without a string
 *  `type` is logged and skipped, never silently forwarded as a RunEventDoc. */
function subscribeViaGenerator(
  makeGenerator: (
    lastEventId: string | undefined,
    signal: AbortSignal,
  ) => AsyncGenerator<RunEventDoc, void, void>,
  opts: SubscribeOptions,
  hooks: Pick<TimerHooks, 'onTimedOut' | 'onManuallyClosed' | 'setManuallyClosed' | 'clearTimers' | 'resetIdle' | 'armAbsolute'>,
): Subscription {
  const abort = new AbortController();
  let lastEventId: string | undefined;
  let attempt = 0;

  const onAbort = (): void => abort.abort();
  hooks.armAbsolute(onAbort);
  hooks.resetIdle(onAbort);

  void (async () => {
    while (!hooks.onTimedOut() && !hooks.onManuallyClosed() && attempt <= MAX_RECONNECTS) {
      try {
        const generator = makeGenerator(lastEventId, abort.signal);
        for await (const ev of generator) {
          if (hooks.onTimedOut() || hooks.onManuallyClosed()) return;
          hooks.resetIdle(onAbort);
          // SDK doesn't surface the raw `id:` field on each yield, so fall
          // back to the event's `sequence` — every RunEventDoc carries it and
          // the BE accepts it as a Last-Event-ID equivalent for resume.
          if (typeof ev.sequence === 'number') {
            lastEventId = String(ev.sequence);
          }
          // A-2: validate before dispatch. `RunEventDoc.type` is the
          // forward-compat discriminator (string-typed in the SDK); a parsed
          // JSON value lacking it isn't a run event we can route.
          if (!ev || typeof ev.type !== 'string') {
            console.warn('[streamsClient] dropping malformed run event (missing string `type`):', ev);
            continue;
          }
          opts.onEvent(ev);
        }
        // Generator exhausted cleanly (server FIN after terminal event).
        hooks.clearTimers();
        if (!hooks.onManuallyClosed()) opts.onClose?.();
        return;
      } catch (err) {
        if (hooks.onManuallyClosed() || hooks.onTimedOut()) {
          hooks.clearTimers();
          return;
        }
        attempt += 1;
        if (attempt > MAX_RECONNECTS) {
          hooks.clearTimers();
          if (opts.onError) opts.onError(new Event('error'));
          return;
        }
        // Linear backoff: 500ms × attempt. Tight reconnect without hammering
        // the server during sustained outages. Re-subscribe with Last-Event-ID.
        await new Promise((r) => setTimeout(r, 500 * attempt));
        void err;
      }
    }
  })();

  return {
    close() {
      hooks.setManuallyClosed(true);
      hooks.clearTimers();
      abort.abort();
      opts.onClose?.();
    },
  };
}

/** Cookie-mode SSE generator — a credentialed twin of the SDK's `streamEvents`
 *  (`sse.ts`). Mirrors its RFC 8895 `event:`/`data:`/`id:` parser verbatim,
 *  including the `event: batch` array envelope (S3) and keep-alive skipping,
 *  but swaps the `Authorization` header for `credentials: 'include'` so the
 *  `openwop.session` cookie rides along. Replaces the prior native EventSource
 *  + hard-coded event-type allowlist (GAP-ANALYSIS A-1): this yields every
 *  event the backend emits, so new event types need no client edit. */
async function* streamEventsCredentialed(
  baseUrl: string,
  runId: string,
  opts: { streamMode?: StreamMode | readonly StreamMode[]; lastEventId?: string; signal?: AbortSignal },
): AsyncGenerator<RunEventDoc, void, void> {
  const params = new URLSearchParams();
  if (opts.streamMode) {
    params.set('streamMode', typeof opts.streamMode === 'string' ? opts.streamMode : opts.streamMode.join(','));
  }
  const qs = params.toString();
  const url = `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events${qs ? `?${qs}` : ''}`;
  const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
  if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;

  const internalAbort = new AbortController();
  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) internalAbort.abort();
    else externalSignal.addEventListener('abort', () => internalAbort.abort(), { once: true });
  }

  const res = await fetch(url, { method: 'GET', headers, credentials: 'include', signal: internalAbort.signal });
  if (!res.ok || res.body === null) {
    throw new Error(`SSE subscribe failed: HTTP ${res.status}`);
  }

  try {
    // Shared SSE line parser (`sseFrames.ts`) handles CRLF, cross-chunk
    // buffering, and `: heartbeat` comments. This consumer keeps the
    // RunEventDoc-specific concerns: the `event: batch` array envelope (S3)
    // and skipping non-JSON keep-alive/vendor lines.
    for await (const frame of readSseFrames(res.body, internalAbort.signal)) {
      let parsed: RunEventDoc | RunEventDoc[];
      try {
        parsed = JSON.parse(frame.data) as RunEventDoc | RunEventDoc[];
      } catch {
        continue; // keep-alive / non-JSON vendor lines
      }
      if (frame.event === 'batch' && Array.isArray(parsed)) yield* parsed;
      else yield parsed as RunEventDoc;
    }
  } finally {
    internalAbort.abort();
  }
}
