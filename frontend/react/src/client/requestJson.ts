/**
 * requestJson — the one typed REST helper for the app's raw-fetch clients.
 *
 * Before this, each client repeated the same dance (build URL, merge
 * authedHeaders, set credentials via fetchOpts, check res.ok, parse JSON) and
 * signalled failure by throwing `new Error("… failed: 429")` — forcing
 * classifyHttpError to regex the status back out of the message. This helper
 * centralizes that and throws a structured ApiError carrying a numeric
 * `.status`, so downstream code (and classifyHttpError) reads the status
 * directly. It also exposes a telemetry seam (see setRequestTelemetry) wired
 * to the observability reporter.
 */

import { config, authedHeaders, fetchOpts } from './config.js';

/** Structured REST failure. `status` is the HTTP status (0 for network
 *  errors). `body` is the parsed JSON error payload when the server sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly body: unknown;
  constructor(args: { status: number; statusText: string; url: string; body?: unknown; message?: string }) {
    super(args.message ?? `${args.url} → ${args.status} ${args.statusText}`);
    this.name = 'ApiError';
    this.status = args.status;
    this.statusText = args.statusText;
    this.url = args.url;
    this.body = args.body;
  }
}

export interface RequestTelemetry {
  /** Called for every completed request (success or failure). */
  onRequest(ev: { method: string; path: string; status: number; durationMs: number; ok: boolean }): void;
}

let telemetry: RequestTelemetry | null = null;
/** Install a telemetry sink (observability layer). Pass null to detach. */
export function setRequestTelemetry(sink: RequestTelemetry | null): void {
  telemetry = sink;
}

export interface RequestOptions<T> extends Omit<RequestInit, 'body'> {
  /** JSON request body — serialized + content-type set automatically. */
  json?: unknown;
  /** Raw body (passed through; you set content-type yourself via headers). */
  body?: BodyInit | null;
  /** Optional runtime validator for the parsed response. Throws ApiError(0,…)
   *  if it returns false, so a malformed 200 fails like any other error. */
  guard?: (v: unknown) => v is T;
  /** Treat these non-2xx statuses as success (e.g. [404] for idempotent
   *  delete). The parsed body (or undefined) is returned. */
  okStatuses?: readonly number[];
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Perform an authenticated JSON request against the backend and return the
 * parsed (optionally guarded) body. Throws ApiError on failure.
 *
 * `path` may be absolute (http…) or backend-relative (`/v1/…`); relative
 * paths are resolved against config.baseUrl.
 */
export async function requestJson<T = unknown>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const { json, body, guard, okStatuses, headers, ...rest } = opts;
  const url = /^https?:\/\//.test(path) ? path : `${config.baseUrl}${path}`;
  const method = (rest.method ?? (json !== undefined || body !== undefined ? 'POST' : 'GET')).toUpperCase();

  const mergedHeaders = authedHeaders({
    ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(headers as Record<string, string> | undefined),
  });

  const init = fetchOpts({
    ...rest,
    method,
    headers: mergedHeaders,
    ...(json !== undefined ? { body: JSON.stringify(json) } : body !== undefined ? { body } : {}),
  });

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Network-level failure (offline/DNS/CORS). Surface as ApiError(0,…) so
    // callers have one error type; classifyHttpError maps status 0 → offline.
    const durationMs = Date.now() - started;
    telemetry?.onRequest({ method, path, status: 0, durationMs, ok: false });
    throw new ApiError({ status: 0, statusText: 'network', url, message: err instanceof Error ? err.message : 'Failed to fetch' });
  }
  const durationMs = Date.now() - started;
  const accepted = res.ok || (okStatuses?.includes(res.status) ?? false);
  telemetry?.onRequest({ method, path, status: res.status, durationMs, ok: accepted });

  if (!accepted) {
    const body2 = await parseBody(res);
    const detail = body2 && typeof body2 === 'object'
      ? (body2 as { message?: string; error?: string }).message ?? (body2 as { error?: string }).error
      : undefined;
    throw new ApiError({
      status: res.status,
      statusText: res.statusText,
      url,
      body: body2,
      message: detail ? `${method} ${path} → ${res.status}: ${detail}` : `${method} ${path} → ${res.status} ${res.statusText}`,
    });
  }

  const parsed = await parseBody(res);
  if (guard && !guard(parsed)) {
    // Carry the real (2xx) status, not 0 — a malformed-but-delivered response
    // is an "unknown" error, not a network/offline failure (classifyHttpError
    // maps status 0 → offline).
    throw new ApiError({ status: res.status, statusText: 'invalid-response', url, message: `${method} ${path} → response failed shape validation` });
  }
  return parsed as T;
}
