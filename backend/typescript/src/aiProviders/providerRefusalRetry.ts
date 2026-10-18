/**
 * ADR 0911 (Book AI P19) — how the structured-output retry loop treats a
 * provider that refused the call before the model answered.
 *
 * Before this, `dispatchStructured` recorded every `dispatchPlain` exception
 * as `parse-error`, retried at once, and on exhaustion threw
 * `envelope_invalid` ("did not emit valid JSON"). A 429 or a 5xx therefore
 * read as a model that wrote bad JSON, three attempts landed inside a second,
 * and a 401/403/404 that cannot succeed was retried anyway.
 *
 * Now a refusal is classified here:
 *   - `fatal`: rethrown at once. A rejected credential, model or request
 *     cannot succeed on retry. A rate limit is fatal HERE because
 *     `providers/dispatch.ts` `fetchWith429Retry` has already retried it
 *     (3 attempts, honouring `Retry-After`) for every chat provider; a second
 *     retry layer on top would make nine calls to a provider that said stop.
 *   - `transient` (5xx, timeout): retried after a backoff, recorded with the
 *     host-extension reason below, and if the loop ends on one, that error is
 *     thrown itself.
 * Anything else (not an `AiProviderError`, or another code) keeps the old
 * `parse-error` treatment.
 */

/** RFC 0032 §B.1 allows `x-host-<host>-<key>` reasons beside the closed enum,
 *  so this needs no wire change. */
export const PROVIDER_ERROR_RETRY_REASON = 'x-host-openwop-app-provider-error';

const FATAL_CODES = new Set(['byok_required_but_unresolved', 'model_not_supported', 'invalid_request', 'provider_rate_limited']);
const TRANSIENT_CODES = new Set(['provider_unavailable', 'provider_timed_out']);

export type ProviderRefusalKind = 'fatal' | 'transient';

interface CodedError { code?: unknown; details?: unknown; message?: unknown }

export function classifyProviderRefusal(err: unknown): ProviderRefusalKind | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as CodedError).code;
  if (typeof code !== 'string') return null;
  if (FATAL_CODES.has(code)) return 'fatal';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  return null;
}

/** Longest vendor text kept on a retry event. `providers/dispatch.ts` already
 *  cuts the body to 300 and `toAiProviderError` to 200; this is the event cap. */
export const UPSTREAM_EXCERPT_MAX = 160;

/** The retry-event text for a refusal: the host's code and message, plus a
 *  short excerpt of the vendor's own reason. Credential shapes are scrubbed by
 *  the caller's sanitizer before this reaches the event log. */
export function describeProviderRefusal(err: unknown, sanitize: (s: string) => string): string {
  const e = (err ?? {}) as CodedError;
  const code = typeof e.code === 'string' ? e.code : 'provider_error';
  const message = typeof e.message === 'string' ? e.message : '';
  const details = (e.details && typeof e.details === 'object') ? e.details as Record<string, unknown> : {};
  const status = typeof details.status === 'number' ? ` (HTTP ${details.status})` : '';
  const upstream = typeof details.upstreamMessage === 'string' ? details.upstreamMessage : '';
  const excerpt = upstream ? `: ${scrubVendorKeys(sanitize(upstream)).replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_EXCERPT_MAX)}` : '';
  return `${code}${status} ${message}${excerpt}`.trim();
}

/** Shapes the host-wide scrubbers do not cover but a vendor error body can
 *  echo: a Google API key, and a `key=` query parameter. */
function scrubVendorKeys(s: string): string {
  return s
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
    .replace(/([?&]key=)[^&\s"']+/gi, '$1***');
}

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Wait before retry `retryNumber` (1 = the first retry) after a transient
 *  refusal: `base × 2^(n-1)`, capped. `OPENWOP_PROVIDER_RETRY_BACKOFF_MS`
 *  (default 1000, 0 disables) sets the base. */
export function providerRetryBackoffMs(retryNumber: number): number {
  const base = envInt('OPENWOP_PROVIDER_RETRY_BACKOFF_MS', 1000, 0, 30_000);
  if (base === 0) return 0;
  return Math.min(base * 2 ** Math.max(0, retryNumber - 1), 8_000);
}

export function sleepMs(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
