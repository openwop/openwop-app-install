/**
 * The ONE reader for an OpenWOP HTTP error body (H27 / S22 /
 * `spec/v1/rest-endpoints.md` §"Error response shape").
 *
 * The canonical envelope is FLAT — `{ error: "<code>", message, details? }`,
 * `additionalProperties: false`, so `retriable` / `retryAfter` / `field` live
 * under `details`, never at a new top level and never inside `error`.
 *
 * Between 2026-06 and 2026-08 a NESTED `{ error: { code, message, retriable } }`
 * form drifted into this host's seams (and into a few entries of the spec's own
 * code list, which is where it came from). S22 settled it in favour of the
 * schema. Backend emission converged in H27; this reader tolerates the nested
 * shape through the deprecation window that ends with the first conformance
 * minor after 2026-11-10, because a peer host — or a browser tab left open
 * across a deploy — can still hand us one.
 *
 * Why a shared module rather than a read at each call site: every client that
 * hand-rolled this got it wrong in a different direction, and each failure was
 * SILENT. `voiceClient` read `body.error.code` off a string and threw away every
 * backend code, so `useVoiceMode`'s `transcription_unsupported` branch could
 * never match and "STT is not configured" degraded to a bare status. `biClient`
 * read `body.error.message` off a string, so every typed 422 from the metric
 * validator reached the user as "createBiMetric returned 422". Neither showed up
 * as an error anywhere — `undefined ?? fallback` is not a failure.
 *
 * These functions never throw: a malformed body (null, an array, a string, an
 * `error` that is a number) yields `undefined`, so a caller's fallback runs.
 */

import { noteSessionRefusal } from './sessionRefusal.js';
import { normalizeErrorCode } from './v2Wire.js';

/** The canonical flat envelope. */
export interface ErrorEnvelopeBody {
  readonly error: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The machine-readable error code. Flat `error` wins; a legacy nested
 *  `error.code` is tolerated for the deprecation window. */
export function readErrorCode(body: unknown): string | undefined {
  const b = asRecord(body);
  if (!b) return undefined;
  // ADR 0647 — on the major-2 wire a code this host does not register travels
  // as `openwop-app.<code>`. Every branch in the app matches the bare spelling,
  // and this is the ONE place codes are read, so the prefix comes off here.
  if (typeof b.error === 'string' && b.error.length > 0) return normalizeErrorCode(b.error);
  const nested = asRecord(b.error);
  const code = nested?.code;
  return typeof code === 'string' && code.length > 0 ? normalizeErrorCode(code) : undefined;
}

/** The human-readable message. Top-level `message` wins; a legacy nested
 *  `error.message` is tolerated for the deprecation window. */
export function readErrorMessage(body: unknown): string | undefined {
  const b = asRecord(body);
  if (!b) return undefined;
  if (typeof b.message === 'string' && b.message.length > 0) return b.message;
  const nested = asRecord(b.error);
  const message = nested?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/** `details.retriable` — the ONLY place the retry hint lives on the canonical
 *  envelope. A legacy nested `error.retriable` is tolerated for the window.
 *  Absent means "do not infer retriability from the HTTP status". */
export function readRetriable(body: unknown): boolean | undefined {
  const b = asRecord(body);
  if (!b) return undefined;
  const details = asRecord(b.details);
  if (typeof details?.retriable === 'boolean') return details.retriable;
  const nested = asRecord(b.error);
  return typeof nested?.retriable === 'boolean' ? nested.retriable : undefined;
}

/** One `details` field, read safely off either shape. */
export function readErrorDetail(body: unknown, key: string): unknown {
  const b = asRecord(body);
  if (!b) return undefined;
  const details = asRecord(b.details) ?? asRecord(asRecord(b.error)?.details);
  return details?.[key];
}

/** True iff the body is the canonical flat envelope — `error` + `message`
 *  non-empty strings and no top-level key outside the closed set. Reporting
 *  only; readers above deliberately accept more than this. */
export function isCanonicalErrorEnvelope(body: unknown): body is ErrorEnvelopeBody {
  const b = asRecord(body);
  if (!b) return false;
  if (typeof b.error !== 'string' || b.error.length === 0) return false;
  if (typeof b.message !== 'string' || b.message.length === 0) return false;
  for (const k of Object.keys(b)) if (k !== 'error' && k !== 'message' && k !== 'details') return false;
  return b.details === undefined || asRecord(b.details) !== undefined;
}

/** True iff the body is the LEGACY nested shape. For telemetry and tests —
 *  never for asserting a pass. */
export function isLegacyNestedEnvelope(body: unknown): boolean {
  const nested = asRecord(asRecord(body)?.error);
  return typeof nested?.code === 'string';
}

/**
 * TWIN-UX-6 — an Error carrying the backend's OWN prose as a typed field.
 *
 * The twin / profile-memory / memory-extraction clients all threw
 * `` `${ctx} failed (${res.status})` ``, and every consumer prefers `e.message`
 * (`e instanceof Error` is true for all of them), so SEVEN translated keys x FOUR
 * locales — 28 strings — were unreachable by construction. None of them read the
 * response BODY either, so the backend's genuinely actionable prose ("This memory
 * already holds the maximum 200 curated notes. Remove some before adding more.")
 * was replaced by `addMemory failed (400)`.
 *
 * `serverMessage` is TYPED rather than sniffed out of the message string, so a
 * consumer that wants to present it differently (a Notice vs a field error) can.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The backend's own `message`, when it sent one — already human prose. */
  readonly serverMessage?: string;
  constructor(message: string, status: number, serverMessage?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (serverMessage !== undefined) this.serverMessage = serverMessage;
  }
}

/**
 * Build an `ApiError` from a non-ok Response: the backend's message when it sent
 * one, else the caller's LOCALIZED fallback. Localize at the THROW SITE — the
 * pattern `memory/lib/memoryClient.ts:32` already used and the rest of this
 * surface did not.
 */
export async function apiErrorFrom(res: Response, localizedFallback: string): Promise<ApiError> {
  const body = await res.clone().json().catch(() => undefined);
  // ADR 0621 D5 — session-refusal 401s run the hard sign-out choke.
  noteSessionRefusal(res.status, body);
  const server = readErrorMessage(body);
  return new ApiError(server ?? localizedFallback, res.status, server);
}
