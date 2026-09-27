/**
 * classifyHttpError — generic transport-error → friendly copy for the
 * non-chat surfaces (Runs, Orgs, Kanban, Capabilities). The chat feed has its
 * own provider-error table (`chat/lib/errorClassify.ts`, keyed on serialized
 * provider error CODES); this is the complementary HTTP/network-status mapping
 * the fan-out list pages were missing — they rendered raw `listX failed: 429`
 * strings (GAP-ANALYSIS E5). Pair with the `<Notice>` component.
 *
 * The per-IP read budget (~60/min) means 429 is a *normal*, recoverable state
 * for a single real user on a busy page, not an error to apologize for — the
 * copy says "busy, retry shortly", not "something broke".
 */
import { readErrorCode } from './errorEnvelope.js';
import { sessionRefusalOf } from './sessionRefusal.js';

export interface ClassifiedError {
  kind:
    | 'rate-limited' | 'budget-exhausted' | 'offline' | 'auth' | 'forbidden' | 'not-found' | 'server' | 'unknown'
    // ADR 0621 D5 — a 401 that REFUSED a live session (keyed on `body.error`,
    // never the status alone). Each is its own kind so `loadErrorMessage` can
    // localize the reason (`common:error_<kind>`) when the hard-sign-out choke
    // could not open the sign-in modal.
    | 'account-disabled' | 'account-erased' | 'session-revoked';
  title: string;
  detail: string;
  /** True when a plain retry is the right next action. */
  retryable: boolean;
}

/**
 * The machine-readable error CODE off a thrown transport error, wherever the
 * parsed envelope landed — the same carrier walk as `errorReasonOf`, reading the
 * envelope's `error` through the ONE shared reader (H27 / S22), so a caller
 * keying on `not_found` / `forbidden_scope` / `runner_unavailable` does not
 * re-derive flat-vs-nested tolerance for the third time in this codebase.
 */
export function errorCodeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const anyErr = err as { body?: unknown; envelope?: unknown };
  for (const carrier of [anyErr.body, anyErr.envelope, err]) {
    const code = readErrorCode(carrier);
    if (code !== undefined) return code;
  }
  return null;
}

/**
 * Pull the machine-readable `details.reason` off a structured error, wherever
 * the transport put the parsed envelope: `ApiError.body` (requestJson),
 * `WopError.envelope` (the SDK), or the error object itself (a server-side
 * `OpenwopError` shape). Exported so feature code (e.g. the chat workflow
 * dispatch wrapper) can key on the same reason without re-parsing.
 */
export function errorReasonOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const anyErr = err as { body?: unknown; envelope?: unknown };
  for (const carrier of [anyErr.body, anyErr.envelope, err]) {
    if (!carrier || typeof carrier !== 'object') continue;
    const details = (carrier as { details?: unknown }).details;
    if (!details || typeof details !== 'object') continue;
    const reason = (details as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return null;
}

/** Pull an HTTP status out of an Error — both `status`/`statusCode` properties
 *  (SDK `WopError`) and the `... failed: 429 ...` message convention used by
 *  the raw-fetch clients. */
function statusOf(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const anyErr = err as { status?: unknown; statusCode?: unknown };
    if (typeof anyErr.status === 'number') return anyErr.status;
    if (typeof anyErr.statusCode === 'number') return anyErr.statusCode;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = /\b(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** A failed `fetch()` rejects with a TypeError ("Failed to fetch") — i.e. the
 *  request never reached the server (offline, DNS, CORS, CDN fault). The
 *  shared requestJson helper normalizes that to an ApiError with `status: 0`. */
function isNetworkError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { status?: unknown }).status === 0) return true;
  return err instanceof TypeError || (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message));
}

/** The parsed envelope wherever the transport parked it — the same carrier walk
 *  as `errorCodeOf`, returned as a body for `sessionRefusalOf`. */
function refusalCarrierOf(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  const anyErr = err as { body?: unknown; envelope?: unknown };
  for (const carrier of [anyErr.body, anyErr.envelope, err]) {
    if (readErrorCode(carrier) !== undefined) return carrier;
  }
  return undefined;
}

export function classifyHttpError(err: unknown): ClassifiedError {
  if (isNetworkError(err)) {
    return {
      kind: 'offline',
      title: "Can't reach the server",
      detail: 'Check your connection — this view will recover once you are back online.',
      retryable: true,
    };
  }
  const status = statusOf(err);
  // ADR 0482 (ux-1): a budget-exhausted 429 is a DELIBERATE owner-set pause,
  // not transient pressure — keyed on the machine-readable envelope reason,
  // never the message text. Plain "wait and retry" copy stays reserved for
  // reasonless 429s (the per-IP read budget).
  if (status === 429 && errorReasonOf(err) === 'workflow_budget_exhausted') {
    return {
      kind: 'budget-exhausted',
      title: 'Daily budget reached',
      detail: "This workflow's runs are paused until tomorrow (UTC). Raise or remove the budget in the builder to continue.",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      kind: 'rate-limited',
      title: 'Too many requests',
      detail: 'This page is busy. Wait a few seconds and retry.',
      retryable: true,
    };
  }
  // ADR 0621 D5 / USERS-UX-13 — the three session-refusal codes are NOT
  // "your session may have expired": a disabled or erased account cannot sign
  // back in, and a revoked session was ended on purpose. Say which.
  const refusal = status === null ? null : sessionRefusalOf(status, refusalCarrierOf(err));
  if (refusal === 'account_disabled') {
    return {
      kind: 'account-disabled',
      title: 'Account disabled',
      detail: 'This account has been disabled by an administrator. Contact your workspace admin.',
      retryable: false,
    };
  }
  if (refusal === 'account_erased') {
    return {
      kind: 'account-erased',
      title: 'Account removed',
      detail: 'This account no longer exists.',
      retryable: false,
    };
  }
  if (refusal === 'session_revoked') {
    return {
      kind: 'session-revoked',
      title: 'Signed out',
      detail: 'Your session was signed out on every device. Sign in again to continue.',
      retryable: false,
    };
  }
  if (status === 401) {
    return {
      kind: 'auth',
      title: 'Not authorized',
      detail: 'Your session may have expired. Sign in again to continue.',
      retryable: false,
    };
  }
  // UX_UPGRADE-projects R2 — 403 USED to fold into `auth`, so every "you don't
  // have permission here" was reported as "your session may have expired, sign
  // in again". That is a false instruction as well as a false diagnosis: the
  // user signs out, signs back in, and gets the identical message. The two
  // statuses mean opposite things — 401 is "we don't know who you are", 403 is
  // "we know exactly who you are, and no". A multi-org member picking a
  // workspace where they hold read-only hits this on their first click.
  if (status === 403) {
    return {
      kind: 'forbidden',
      title: 'Not allowed',
      detail: "You don't have permission to do that here. Ask an admin of this workspace for access.",
      retryable: false,
    };
  }
  if (status === 404) {
    return { kind: 'not-found', title: 'Not found', detail: 'This resource no longer exists.', retryable: false };
  }
  if (status !== null && status >= 500) {
    return {
      kind: 'server',
      title: 'Server error',
      detail: 'Something went wrong on the server. This is usually transient — retry shortly.',
      retryable: true,
    };
  }
  return {
    kind: 'unknown',
    title: 'Something went wrong',
    detail: err instanceof Error ? err.message : String(err ?? 'Unknown error'),
    retryable: true,
  };
}
