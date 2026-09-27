/**
 * SSE stream client — ONE transport, major 2 (ADR 0647).
 *
 * `@openwop/openwop@2`'s `streamEvents()` opens `GET /runs/{runId}/events` with
 * `OpenWOP-Version: 2.0`, `Accept: text/event-stream` and `Last-Event-ID`, and
 * parses single and `event: batch` frames. It is driven here through a fetch
 * that carries THIS app's auth (`credentialedFetch`): the SDK's placeholder
 * bearer is stripped, `authedHeaders()` applied, the session cookie sent, and —
 * when there is no bearer at all (a cookie-mode owner on the cross-origin SSE
 * base, where the cookie cannot follow) — a run-scoped `streamToken` minted
 * same-origin from `/host/openwop-app/runs/{id}/events/token` rides the URL. Every event's
 * run id is unbound (`v2Wire.ts`) before it reaches a consumer.
 *
 * HISTORY. This used to be two transports: bearer mode through the 1.x SDK and
 * cookie mode through a hand-rolled fetch+ReadableStream generator, because the
 * 1.x `streamEvents()` had no way to carry credentials. 2.0's
 * `EventsStreamContext.fetch` is exactly the hook that comment asked for, so
 * the second transport is gone. Reconnect-with-Last-Event-ID stays in this
 * wrapper (`subscribeViaGenerator`): the SDK's generator is single-shot.
 *
 * The public API (`subscribeToRun`, `Subscription`, dual idle/absolute
 * timeouts) is unchanged, so the consumer surfaces do not know which major
 * fetched their events — that is the point.
 */
import { streamEvents, type RunEventDoc, type StreamMode } from '@openwop/openwop';
import { authedHeaders, config } from './config.js';
import { telemetry } from '../platform/telemetry.js';
import { toClientEvent } from './eventVocabulary.js';
import { VENDOR_BASE, unbindRunIds } from './v2Wire.js';
import { bound } from './runsClient.js';

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
  // ADR 0647 — ONE transport for both auth modes: the SDK's `streamEvents()`
  // (major 2: `/runs/{id}/events`, `OpenWOP-Version: 2.0`, batch frames,
  // Last-Event-ID) driven through a fetch that carries this app's auth. The
  // hand-rolled credentialed generator this replaces existed only because the
  // 1.x SDK had no fetch hook; 2.0's `EventsStreamContext.fetch` is that hook.
  const makeGenerator = (lastEventId: string | undefined, signal: AbortSignal) =>
    unbindEvents(
      boundStream(runId, (wireRunId) => streamEvents(
        { baseUrl: config.sseBaseUrl, apiKey: config.apiKey, protocolVersion: V2_PROTOCOL_VERSION, fetch: credentialedFetch(runId, signal) },
        wireRunId,
        {
          ...(modeOpt !== undefined ? { streamMode: modeOpt } : {}),
          ...(lastEventId !== undefined ? { lastEventId } : {}),
          signal,
        },
      )),
    );
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
          // CHAT-6: a stream that dies after exhausting reconnects is otherwise
          // invisible to ops (the caller gets an opaque Event). Report it so the
          // "bubble spins forever" class of bug is diagnosable in production.
          telemetry.reportError(err instanceof Error ? err : new Error('sse_stream_reconnect_exhausted'), {
            region: 'sse-stream',
            attempts: attempt,
          });
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
/** Mint a run-scoped stream capability SAME-ORIGIN (config.baseUrl → /api on
 *  prod), where an anon BYOK session's cookie DOES authenticate. The token then
 *  authorizes the cross-origin SSE for a caller who has no bearer token and
 *  whose cookie can't follow to *.run.app. Returns null on any failure (the
 *  caller opens the stream anyway and degrades to the prior 404). */
async function fetchRunStreamToken(runId: string, signal?: AbortSignal): Promise<string | null> {
  // SEC-5 — distinguish a TRANSIENT mint failure (5xx / network) from an AUTHZ one
  // (4xx). A 4xx is terminal (the caller isn't allowed to mint) → give up
  // immediately. A 5xx or a network error is worth ONE quick retry before falling
  // back to the no-token stream (which then 404s). One retry only — the mint is
  // stateless + cheap, and we must not block the live feed for long.
  const url = `${config.baseUrl}${VENDOR_BASE}/runs/${encodeURIComponent(runId)}/events/token`;
  const init = { method: 'GET', headers: authedHeaders(), credentials: 'include' as const, ...(signal ? { signal } : {}) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.ok) {
        const body = (await res.json()) as { streamToken?: unknown };
        return typeof body.streamToken === 'string' ? body.streamToken : null;
      }
      if (res.status < 500) return null; // 4xx — terminal authz failure, don't retry
      // 5xx — transient; fall through to one retry.
    } catch {
      if (signal?.aborted) return null; // caller cancelled — don't retry
      // network error — transient; fall through to one retry.
    }
  }
  return null;
}

/** `OpenWOP-Version` the stream is requested under — pinned, not derived from
 *  the discovery document, because this client is the thing that selects it. */
const V2_PROTOCOL_VERSION = '2.0';

/**
 * The SDK builds the URL and the SSE headers; this wraps the fetch it calls so
 * the request carries THIS app's auth: the SDK's placeholder bearer is stripped,
 * `authedHeaders()` applied, the session cookie sent, and — when there is no
 * bearer at all (cookie-mode owner on the cross-origin SSE base, where the
 * cookie cannot follow) — a run-scoped `streamToken` minted same-origin is
 * appended, exactly as the credentialed path did before.
 */
function credentialedFetch(runId: string, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.delete('Authorization');
    for (const [k, v] of Object.entries(authedHeaders())) headers.set(k, v);
    let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!headers.has('authorization')) {
      const streamToken = await fetchRunStreamToken(runId, signal);
      if (streamToken) {
        const u = new URL(url);
        u.searchParams.set('streamToken', streamToken);
        url = u.toString();
      }
    }
    return fetch(url, { ...init, headers, credentials: 'include' });
  };
}

/** The `{runId}` the SDK puts in the path MUST be tenant-bound (identity.md
 *  §5); the streamToken is still minted for the BARE id on the v1 token route. */
async function* boundStream(runId: string, open: (wireRunId: string) => AsyncGenerator<RunEventDoc, void, void>): AsyncGenerator<RunEventDoc, void, void> {
  yield* open(await bound(runId));
}

/**
 * Every run id on the major-2 wire is tenant-bound and 36 event types carry
 * their v2 spelling; the app keeps bare ids and its v1 dialect. Both
 * translations happen here, once per event (`eventVocabulary.ts`).
 */
async function* unbindEvents(gen: AsyncGenerator<RunEventDoc, void, void>): AsyncGenerator<RunEventDoc, void, void> {
  for await (const ev of gen) yield toClientEvent(unbindRunIds(ev));
}

