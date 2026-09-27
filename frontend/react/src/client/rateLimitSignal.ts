/**
 * ADR 0640 — one place that KNOWS the app is being rate-limited.
 *
 * The backend answers a burst with the canonical 429 envelope + `Retry-After`,
 * and every client module already classifies that per call (`classifyHttpError`
 * → "This page is busy"). What was missing is the aggregate: a page load fans
 * out 20+ reads, so a limit presents as a dozen UNRELATED features failing at
 * once, and nothing in the UI says "rate limited". MEASURED 2026-09-06 on a
 * white-label deploy: the operator concluded the features were broken and
 * found the 429s only by grouping Cloud Run logs by status.
 *
 * Thirty-seven client modules call `fetch` directly (no single wrapper), so the
 * observer sits at the one seam they all share: `window.fetch`. It NEVER alters
 * a request or a response — it reads the status and `Retry-After` off responses
 * to same-origin / API-base URLs and publishes the latest deadline. The shell
 * renders one banner off that signal (`RateLimitBanner`).
 */

export interface RateLimitState {
  /** Epoch ms after which the server said requests may resume. */
  untilMs: number;
  /** When the signal was raised (epoch ms). */
  atMs: number;
}

type Listener = (state: RateLimitState | null) => void;
const listeners = new Set<Listener>();
let current: RateLimitState | null = null;
let installed = false;

export function getRateLimitState(): RateLimitState | null {
  return current && current.untilMs > Date.now() ? current : null;
}

export function subscribeRateLimited(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Parse `Retry-After` (delta-seconds per RFC 9110; an HTTP-date is also legal). */
export function retryAfterMs(header: string | null, nowMs = Date.now()): number {
  if (!header) return 5_000;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(1_000, secs * 1_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(1_000, at - nowMs) : 5_000;
}

/** Record a 429 seen on `res`. Exported for the observer and for tests. */
export function noteRateLimited(res: Pick<Response, 'status' | 'headers'>, nowMs = Date.now()): void {
  if (res.status !== 429) return;
  const untilMs = nowMs + retryAfterMs(res.headers.get('retry-after'), nowMs);
  // Only ever extend the deadline: a burst yields many 429s with the same window.
  if (current && current.untilMs >= untilMs) return;
  current = { untilMs, atMs: nowMs };
  for (const fn of listeners) fn(current);
}

/** Test seam — drop the signal. */
export function _resetRateLimitSignal(): void {
  current = null;
  for (const fn of listeners) fn(null);
}

function isObservedUrl(input: RequestInfo | URL, win: Pick<Window, 'location'>): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw, win.location.href);
    return u.origin === win.location.origin || raw.startsWith('/');
  } catch {
    return false;
  }
}

/**
 * Wrap `win.fetch` once. Idempotent; a second call is a no-op. The wrapper
 * forwards arguments untouched and returns the SAME response object — it only
 * looks at `status` and one header, so streaming bodies are unaffected.
 */
export function installRateLimitObserver(win: Window = window): void {
  if (installed) return;
  installed = true;
  const original = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original(input, init);
    if (res.status === 429 && isObservedUrl(input, win)) noteRateLimited(res);
    return res;
  };
}

/** Test seam — allow a fresh install against a new window. */
export function _resetRateLimitObserver(): void {
  installed = false;
}
