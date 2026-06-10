/**
 * In-process network recorder for the sample app.
 *
 * Wraps `window.fetch` once at app boot and captures every backend
 * call (REST + SSE) into a bounded in-memory ring buffer. The
 * NetworkPanel component subscribes to the recorder and renders a
 * Chrome-DevTools-style list scoped to OpenWOP traffic — give users
 * a way to see the wire-shape behind the AI chat / builder / keys
 * pages without opening DevTools.
 *
 * Scope notes:
 * - Only captures requests routed through `fetch`. In **bearer-mode**,
 *   `subscribeToRun` routes through the SDK's `streamEvents()` which is
 *   fetch + ReadableStream, so the initial subscribe is captured (the
 *   long-lived stream's individual events are not surfaced through the
 *   fetch hook — they're observable separately via a `subscribeToRun`
 *   callback if a downstream component wires that in). In **cookie-mode**,
 *   the same `subscribeToRun` falls back to native `EventSource` (since
 *   the SDK's `streamEvents` doesn't expose a fetch-credentials option to
 *   carry `openwop.session`), and EventSource subscribes are NOT captured
 *   by this recorder — they bypass fetch entirely.
 * - Request bodies are recorded only when JSON-ish (avoids logging
 *   binary uploads). Response bodies are truncated to 16KB to keep
 *   localStorage / memory bounded.
 * - The buffer survives reload: the last `PERSIST_MAX` entries are
 *   mirrored to `sessionStorage` (throttled, quota-safe, response bodies
 *   re-truncated to `PERSIST_RESPONSE_BYTES`) and rehydrated on boot, so a
 *   hot-reload or accidental refresh doesn't wipe the record. It stays
 *   tab-scoped (sessionStorage, not localStorage) so it doesn't outlive the
 *   session or leak across tabs.
 *
 * Diagnostic capture (body buffering + sessionStorage mirror) is default-on in
 * dev, default-OFF in production. Request bodies are credential-redacted (see
 * redactRequestBody) for defense in depth. In production the wrapper still
 * installs a liveness-only tap (recordLastSuccess for the cold-start card) —
 * no bodies, no buffer, no sessionStorage. Enable full capture in prod with
 * VITE_ENABLE_NETWORK_RECORDER=1; leave window.fetch fully unmodified with
 * VITE_DISABLE_NETWORK_RECORDER=1.
 */

import { recordLastSuccess } from './lastSuccess.js';
import { config as backendConfig } from '../client/config.js';

const MAX_ENTRIES = 200;
const MAX_RESPONSE_BYTES = 16 * 1024;
const STORAGE_KEY = 'openwop.networkRecorder.v1';
const PERSIST_MAX = 50;
const PERSIST_RESPONSE_BYTES = 4 * 1024;

export type NetworkEntryKind = 'rest' | 'sse';

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  /** Origin-relative path for tighter UI rendering. */
  path: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  status?: number;
  ok?: boolean;
  kind: NetworkEntryKind;
  requestBody?: string;
  responseBody?: string;
  responseTruncated?: boolean;
  error?: string;
  /** For SSE entries, captured event deltas appear here in order. */
  sseEvents?: Array<{ at: number; data: string }>;
}

type Listener = (entries: readonly NetworkEntry[]) => void;

const entries: NetworkEntry[] = [];
const listeners = new Set<Listener>();
let installed = false;

let persistScheduled = false;

function canPersist(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !!window.sessionStorage;
  } catch {
    return false; // access can throw under strict privacy settings
  }
}

/** Mirror the tail of the buffer to sessionStorage, coalescing the burst of
 *  push+update calls in one tick into a single write. Quota-safe: on failure
 *  it drops the persisted copy rather than throwing into the fetch hook. */
function schedulePersist(): void {
  if (persistScheduled || !canPersist()) return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    try {
      const trimmed = entries.slice(-PERSIST_MAX).map((e) =>
        e.responseBody && e.responseBody.length > PERSIST_RESPONSE_BYTES
          ? { ...e, responseBody: e.responseBody.slice(0, PERSIST_RESPONSE_BYTES), responseTruncated: true }
          : e,
      );
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // QuotaExceededError / serialization failure — discard the persisted
      // mirror; the in-memory buffer is the source of truth and is unaffected.
      try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  }, 0);
}

/** Rehydrate the buffer from sessionStorage on boot. No-op if the buffer
 *  already has entries (don't clobber a live session) or the persisted state
 *  is absent/corrupt. */
function hydrateFromStorage(): void {
  if (!canPersist() || entries.length > 0) return;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const e of parsed as NetworkEntry[]) {
      if (e && typeof e.id === 'string' && typeof e.url === 'string') entries.push(e);
    }
  } catch {
    /* corrupt persisted state — ignore and start fresh */
  }
}

function notify(): void {
  const snapshot = entries.slice();
  for (const l of listeners) {
    try { l(snapshot); } catch { /* ignore listener errors */ }
  }
  schedulePersist();
}

function push(entry: NetworkEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  notify();
}

function update(id: string, patch: Partial<NetworkEntry>): void {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return;
  entries[idx] = { ...entries[idx]!, ...patch };
  notify();
}

function relativePath(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + (u.search || '');
  } catch {
    return url;
  }
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body.slice(0, 8 * 1024);
  // FormData / Blob / URLSearchParams / ReadableStream: skip; the
  // recorder is intentionally JSON-leaning for the sample.
  return undefined;
}

/** Routes whose request body carries plaintext credential material and must
 *  NEVER enter the recorder buffer or its sessionStorage mirror
 *  (threat-model-secret-leakage). Matched against the origin-relative path;
 *  the optional `/api/` prefix covers the Firebase Hosting rewrite. */
const SECRET_REQUEST_PATHS: readonly RegExp[] = [
  /^\/(?:api\/)?v1\/host\/sample\/byok\/secrets(?:$|\/|\?)/,
];

/** Conservative field-name denylist applied to any *other* captured request
 *  body — defense in depth if a new secret-bearing route is added without
 *  updating SECRET_REQUEST_PATHS. Request bodies only; response bodies are
 *  BE-shaped and never echo submitted secrets. */
const SECRET_FIELD_KEYS = new Set([
  'value', 'apikey', 'api_key', 'secret', 'password', 'privatekey', 'private_key', 'credential', 'token',
]);

/** Strip plaintext credential material from a captured request body before it
 *  is buffered/persisted. Route-level redaction is exact; the field-level pass
 *  is best-effort JSON scrubbing. Returns the (possibly redacted) string. */
export function redactRequestBody(path: string, body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (SECRET_REQUEST_PATHS.some((re) => re.test(path))) {
    return '[redacted: credential request body]';
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      let touched = false;
      const scrub = (o: Record<string, unknown>): void => {
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (SECRET_FIELD_KEYS.has(k.toLowerCase()) && typeof v === 'string') {
            o[k] = '[redacted]';
            touched = true;
          } else if (v && typeof v === 'object') {
            scrub(v as Record<string, unknown>);
          }
        }
      };
      scrub(parsed as Record<string, unknown>);
      return touched ? JSON.stringify(parsed) : body;
    }
  } catch {
    /* not JSON — already length-capped in bodyToString(); leave as-is */
  }
  return body;
}

export type RecorderMode = 'off' | 'liveness' | 'full';

/** Resolve the recorder mode from the Vite env (pure, testable).
 *  - 'off'      → window.fetch left unmodified (legacy hard opt-out).
 *  - 'liveness' → wrap fetch but only recordLastSuccess (prod default).
 *  - 'full'     → buffer + body capture + sessionStorage mirror. */
export function recorderMode(env: Record<string, string | boolean | undefined>): RecorderMode {
  if (env.VITE_DISABLE_NETWORK_RECORDER === '1') return 'off';
  const isProd = env.PROD === true || env.PROD === 'true';
  if (isProd && env.VITE_ENABLE_NETWORK_RECORDER !== '1') return 'liveness';
  return 'full';
}

export function installNetworkRecorder(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  // Diagnostic capture is DEV-default-on, PROD-default-OFF. The recorder
  // captures request/response bodies (now credential-redacted, see
  // redactRequestBody), but a debug tool that mirrors traffic to
  // sessionStorage has no business being on by default in a shipped build.
  // - dev: on unless VITE_DISABLE_NETWORK_RECORDER=1 (legacy opt-out).
  // - prod: off unless VITE_ENABLE_NETWORK_RECORDER=1 (explicit opt-in).
  const env = (typeof import.meta !== 'undefined'
    ? (import.meta as { env?: Record<string, string | boolean> }).env
    : undefined) ?? {};
  // Diagnostic CAPTURE (body buffering + sessionStorage mirror) is
  // dev-default-on / prod-default-off. But the fetch wrapper ALSO marks the
  // backend alive for the cold-start warm-window card (recordLastSuccess) —
  // a production feature. So in prod we still install a liveness-only tap
  // (no bodies, no buffer, no sessionStorage); full capture stays opt-in.
  const mode = recorderMode(env);
  if (mode === 'off') return; // legacy hard opt-out: unmodified fetch
  const captureEnabled = mode === 'full';
  installed = true;
  if (captureEnabled) {
    // Restore the prior session's tail so a reload/hot-reload keeps the record.
    hydrateFromStorage();
    if (entries.length > 0) notify();
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    // Only record traffic to OUR backend. The path filter alone
    // wasn't enough — third-party APIs (Firebase Auth's
    // identitytoolkit.googleapis.com/v1/accounts:lookup, etc.) share
    // the `/v1/` prefix and were being captured. Constrain by ORIGIN
    // first: same-origin OR the configured backend baseUrl.
    const path = relativePath(url);
    const isOpenwopOrigin = (() => {
      try {
        const u = new URL(url, window.location.origin);
        if (u.origin === window.location.origin) return true;
        if (backendConfig.baseUrl) {
          try {
            const b = new URL(backendConfig.baseUrl);
            if (u.origin === b.origin) return true;
          } catch { /* malformed baseUrl */ }
        }
        return false;
      } catch {
        return false;
      }
    })();
    const isApiPath = path.startsWith('/v1/') || path.startsWith('/.well-known/openwop') || path.startsWith('/api/');
    if (!isOpenwopOrigin || !isApiPath) {
      return nativeFetch(input, init);
    }

    // Liveness-only tap (prod default): record that the backend answered so the
    // cold-start card can predict warm/cold, WITHOUT buffering bodies or
    // persisting anything. 401/403 still count as "container alive".
    if (!captureEnabled) {
      const res = await nativeFetch(input, init);
      if (res.status > 0 && res.status < 500) recordLastSuccess(Date.now());
      return res;
    }

    const method = (init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const requestBody = redactRequestBody(path, bodyToString(init?.body));
    const isSse = (init?.headers && new Headers(init.headers).get('accept')?.includes('text/event-stream')) === true
      || path.includes('/events') || path.includes(':stream');

    const entry: NetworkEntry = {
      id,
      method,
      url,
      path,
      startedAt,
      kind: isSse ? 'sse' : 'rest',
      ...(requestBody !== undefined ? { requestBody } : {}),
    };
    push(entry);

    try {
      const res = await nativeFetch(input, init);
      const finishedAt = Date.now();
      // Clone the response to read the body without consuming it for
      // the caller. SSE responses are streams — don't clone-read those
      // (it'd block until the stream ends).
      let responseBody: string | undefined;
      let responseTruncated = false;
      if (!isSse) {
        try {
          const clone = res.clone();
          const text = await clone.text();
          responseTruncated = text.length > MAX_RESPONSE_BYTES;
          responseBody = responseTruncated ? text.slice(0, MAX_RESPONSE_BYTES) : text;
        } catch {
          /* ignore read errors — the original response is unaffected */
        }
      }
      update(id, {
        finishedAt,
        durationMs: finishedAt - startedAt,
        status: res.status,
        ok: res.ok,
        ...(responseBody !== undefined ? { responseBody } : {}),
        ...(responseTruncated ? { responseTruncated } : {}),
      });
      // Mark the BE as alive for the cold-start-card warm-window
      // prediction. A 2xx anywhere on the OpenWOP API surface is
      // sufficient evidence the container is up. 401/403 still count
      // as "container alive" (auth refused, but server responded).
      if (res.status > 0 && res.status < 500) {
        recordLastSuccess(finishedAt);
      }
      return res;
    } catch (err) {
      const finishedAt = Date.now();
      update(id, {
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

export function listNetworkEntries(): readonly NetworkEntry[] {
  return entries;
}

export function clearNetworkEntries(): void {
  entries.length = 0;
  notify();
}

export function subscribeNetworkEntries(listener: Listener): () => void {
  listeners.add(listener);
  // Immediate snapshot so the consumer renders without waiting for
  // the next event.
  listener(entries.slice());
  return () => { listeners.delete(listener); };
}

/** Append an SSE event onto an in-flight entry. Used by the streams
 *  client wrapper so the network panel can show the event timeline
 *  inside the SSE row's detail view. */
export function appendSseEvent(requestUrl: string, data: string): void {
  // Find the most-recently-started SSE entry whose URL matches.
  // (We don't have a direct id link from the streams client; the
  // url-match heuristic is fine for the bounded buffer.)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== 'sse' || e.url !== requestUrl) continue;
    if (e.finishedAt !== undefined) break; // closed; stop scanning
    const events = e.sseEvents ? [...e.sseEvents] : [];
    events.push({ at: Date.now(), data });
    entries[i] = { ...e, sseEvents: events };
    notify();
    break;
  }
}
