/**
 * Frontend config. Reads VITE_OPENWOP_BASE_URL + VITE_OPENWOP_API_KEY +
 * VITE_OPENWOP_AUTH_MODE at build time (Vite inlines into the bundle).
 * A `.env.local` at the react project root overrides defaults.
 *
 * Auth modes:
 *   'bearer' (default) — send Authorization: Bearer <apiKey>. Used by
 *       local dev + the conformance harness. apiKey defaults to
 *       'dev-token' which matches the backend's OPENWOP_API_KEYS
 *       fallback.
 *   'cookie' — send `credentials: 'include'` on every request; rely on
 *       the openwop.session cookie minted by the backend's auth
 *       middleware (P0.2). The Authorization header is dropped entirely.
 *       Used by the public deploy at app.openwop.dev.
 *
 * `authedHeaders()` + `fetchOpts()` are the single-source helpers — all
 * client modules go through them so flipping `VITE_OPENWOP_AUTH_MODE`
 * at build time switches every fetch site at once.
 */

import { BRAND_DEFAULTS } from '../brand/defaults.js';
import { DEV_FALLBACK_BASE_URL } from './baseUrlDefault';
import { getRequestLocale } from '../i18n/requestLocale.js';
import { noteSessionRefusal } from './sessionRefusal.js';

export type AuthMode = 'bearer' | 'cookie';

export const config = {
  baseUrl: (import.meta.env.VITE_OPENWOP_BASE_URL as string | undefined) ?? DEV_FALLBACK_BASE_URL,
  /** Base URL for SSE subscriptions ONLY. Defaults to `baseUrl` for
   *  dev, but on production app.openwop.dev the Firebase Hosting proxy
   *  (`/api/**` → Cloud Run) silently buffers SSE responses, breaking
   *  long-lived event streams. Workflow runs that suspend on a HITL
   *  approval would never deliver events to the FE because the proxy
   *  doesn't flush. Bypassing the proxy and hitting Cloud Run directly
   *  is the only path that delivers events live.
   *
   *  Cloud Run's CORS already permits `app.openwop.dev` so cross-origin
   *  EventSource works without further config. */
  sseBaseUrl: (import.meta.env.VITE_OPENWOP_SSE_BASE_URL as string | undefined)
    ?? (import.meta.env.VITE_OPENWOP_BASE_URL as string | undefined)
    ?? DEV_FALLBACK_BASE_URL,
  apiKey: (import.meta.env.VITE_OPENWOP_API_KEY as string | undefined) ?? 'dev-token',
  authMode: ((import.meta.env.VITE_OPENWOP_AUTH_MODE as string | undefined) ?? 'bearer') as AuthMode,
  /** Live pack registry root (RFC 0003 / 0013 / 0043). The pack browser
   *  fetches `${registryBaseUrl}/v1/index.json` + per-pack manifests,
   *  signatures and SBOMs directly. Defaults to the public registry;
   *  override with VITE_OPENWOP_REGISTRY_URL to point at a mirror. */
  registryBaseUrl:
    (import.meta.env.VITE_OPENWOP_REGISTRY_URL as string | undefined) ?? 'https://packs.openwop.dev',
  /** Public-site origin — hosts the conformance leaderboard
   *  (`${siteBaseUrl}/conformance/`) and the per-reference-host badge SVGs
   *  (`${siteBaseUrl}/badge/<host>.svg`). Defaults to the canonical
   *  `openwop.dev` deploy; override with VITE_OPENWOP_SITE_URL for an
   *  air-gapped / fork deployment that serves its own copies. The badge
   *  SVGs are also committed to this repo at `public/badge/` so a
   *  same-origin fork can point at e.g. `https://app.example.com`. */
  siteBaseUrl:
    (import.meta.env.VITE_OPENWOP_SITE_URL as string | undefined) ?? BRAND_DEFAULTS.homeUrl,
  /** The org whose PUBLISHED CMS posts back the public `/blog/*` archive
   *  (ADR 0391). Defaults to the reserved host-global system-site org
   *  (`host-site`, ADR 0027) so the deployment's own posts serve out of the box;
   *  override with VITE_PUBLIC_SITE_ORG_ID to point the public blog at a specific
   *  tenant's site. Any org's published posts remain servable at
   *  `/public/:orgId/blog`; this only picks the org the SPA's `/blog` routes use. */
  siteOrgId:
    (import.meta.env.VITE_PUBLIC_SITE_ORG_ID as string | undefined) ?? 'host-site',
};

/**
 * Cached Firebase ID token. Populated by `setCurrentIdToken()` which
 * the auth bootstrap calls from its `onIdTokenChanged` subscriber.
 * Reading the token is synchronous so `authedHeaders()` stays sync —
 * all the existing fetch call sites don't need to become async.
 *
 * Lifecycle: starts null. On first `onIdTokenChanged` fire (immediately
 * after page-load auth restore), gets set to either a string or null
 * (depending on whether a Firebase session exists). On sign-out,
 * cleared to null. On token rotation (~hourly), replaced.
 *
 * Worst case: a fetch fires between page-load and the first
 * `onIdTokenChanged` callback — token is null, request falls back
 * to cookie/bearer mode. Acceptable because the session cookie still
 * works for the anon path AND the next fetch (post-rotation) is
 * authed correctly.
 */
let cachedIdToken: string | null = null;

/**
 * `exp` of `cachedIdToken` in ms, parsed once on set (null when unparseable).
 *
 * The cache above is read SYNCHRONOUSLY by `authedHeaders()` on every request and
 * was refilled only by the SDK's proactive-refresh timer. `setTimeout` is throttled
 * in background tabs, so a backgrounded session parks an EXPIRED JWT here and then
 * attaches it to every subsequent request. The host rejects each one
 * (`OIDC verify failed … code:"expired"`) and falls through to the cookie path —
 * the tenant survives, but `oidcAuthTime` does not, so reveal-gated surfaces
 * silently fail for a signed-in user. Observed in prod as a continuous ~25s
 * cadence of `expired` warnings. Tracking `exp` lets the sync path detect the
 * staleness it cannot await on.
 */
let cachedIdTokenExp: number | null = null;

/** Treat a token as spent this many ms BEFORE its `exp` — a token that dies
 *  in-flight is as useless as one already dead. */
const ID_TOKEN_STALE_MS = 30_000;
/** Floor between forced-refresh attempts, so a persistently failing refresh
 *  (offline, revoked session) costs one call per window, not one per request. */
const ID_TOKEN_REFRESH_COOLDOWN_MS = 15_000;

let idTokenRefresher: (() => void) | null = null;
let lastRefreshAt = 0;

/**
 * Register the "force a fresh ID token" action. Cycle-free by the same rule as
 * `onAuthChange`: the auth bootstrap registers its own refresher rather than this
 * module importing the Firebase layer. The callback is fire-and-forget — it must
 * land its result via `setCurrentIdToken`.
 */
export function registerIdTokenRefresher(fn: (() => void) | null): void {
  idTokenRefresher = fn;
}

/** Decode a JWT `exp` (ms). Null on anything unparseable — callers then treat the
 *  token as usable, which is exactly the pre-existing behavior (never fail closed
 *  on a token we merely failed to READ). */
function parseJwtExpMs(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True when the cached token is past (or within `ID_TOKEN_STALE_MS` of) `exp`. */
function idTokenIsStale(): boolean {
  return cachedIdTokenExp !== null && Date.now() >= cachedIdTokenExp - ID_TOKEN_STALE_MS;
}

/** Ask the auth layer for a fresh token, at most once per cooldown window. */
function requestIdTokenRefresh(): void {
  const now = Date.now();
  if (!idTokenRefresher || now - lastRefreshAt < ID_TOKEN_REFRESH_COOLDOWN_MS) return;
  lastRefreshAt = now;
  idTokenRefresher();
}

/** Listeners fired whenever the auth identity changes (sign-in / sign-out /
 *  token rotation to a *different* token). Caches keyed on the tenant — chiefly
 *  the capabilities cache (GAP-ANALYSIS A-3) — register here so a tenant change
 *  re-negotiates instead of serving a prior tenant's view. Cycle-free: callers
 *  register their own clearers rather than config importing them. */
type AuthChangeListener = () => void;
const authChangeListeners = new Set<AuthChangeListener>();
export function onAuthChange(fn: AuthChangeListener): () => void {
  authChangeListeners.add(fn);
  return () => authChangeListeners.delete(fn);
}

/** Fire the auth/tenant-change listeners WITHOUT a token change (Deferred
 *  Phase D / SHELL-8): a workspace SWITCH rebinds the session tenant server-
 *  side while the Firebase token stays the same, so `setCurrentIdToken` never
 *  notifies — this is the explicit broadcast for that case. Every tenant-keyed
 *  cache already registered here (capabilities, effective access, feature
 *  assignments, nav config) resets for free. */
export function fireAuthChanged(): void {
  for (const fn of authChangeListeners) fn();
}

export function setCurrentIdToken(token: string | null): void {
  const changed = token !== cachedIdToken;
  cachedIdToken = token;
  cachedIdTokenExp = token ? parseJwtExpMs(token) : null;
  // A landed token means the refresher works — reopen the cooldown immediately so
  // the next expiry is chased without waiting out a window.
  if (token) lastRefreshAt = 0;
  // Token rotation to the same value (rare) is a no-op; identity changes
  // notify subscribers so tenant-scoped caches drop.
  if (changed) {
    for (const fn of authChangeListeners) fn();
  }
}

/** Headers carrying auth.
 *   - Signed-in (cached ID token present): Authorization: Bearer <id-token>
 *   - cookie mode: empty (cookie travels via credentials: 'include')
 *   - bearer mode: Authorization: Bearer <apiKey>
 *
 * Token takes precedence over cookie when both are available, so a
 * user who just signed in starts hitting the OIDC backend path without
 * the cookie path competing.
 */
export function authedHeaders(extra?: Record<string, string>): Record<string, string> {
  const base = extra ? { ...extra } : {};
  // i18n (spec/v1/i18n.md §"Accept-Language"): advertise the user's locale so
  // a host MAY return localized interrupt / error copy. Every REST call routes
  // through this helper (raw fetches + the SDK fetch wrapper), so one line
  // covers the app. Harmless when the host doesn't localize.
  // The user's CONTENT-language preference (explicit UI choice, else raw
  // navigator.language) — NOT collapsed to a supported UI locale, so content
  // negotiation (ADR 0064) is unchanged for non-en browsers. Byte-identical
  // to the prior navigator.language send until a user picks a UI locale.
  const requestLocale = getRequestLocale();
  if (requestLocale) {
    base['accept-language'] = requestLocale;
  }
  if (cachedIdToken && idTokenIsStale()) {
    // Deliberately attach NOTHING and let the request ride the session cookie:
    // an expired bearer is strictly worse than no bearer, because the host tries
    // it first, logs a rejection, and only then falls through to the same cookie —
    // and arrives without `oidcAuthTime`. Kick the refresh so the NEXT request is
    // properly authed. `cachedIdToken` stays set on purpose: `fetchOpts()` keys
    // `credentials: 'include'` off it, and the cookie is what we're falling back to.
    requestIdTokenRefresh();
  } else if (cachedIdToken) {
    base['authorization'] = `Bearer ${cachedIdToken}`;
  } else if (config.authMode === 'bearer') {
    base['authorization'] = `Bearer ${config.apiKey}`;
  }
  return base;
}

/**
 * A write the SERVER refused (401/403/409/429/5xx) — as opposed to a network
 * failure. The distinction is the whole point: an offline write is safely held
 * in the local cache and syncs later, but a REFUSED write is silent data loss
 * if the caller treats it like offline. Several call sites did exactly that —
 * `catch {}` around a `fetch` whose `res.ok` was never read — so a rate-limited
 * or session-expired save looked identical to success and the row lived only in
 * that one browser. Callers MUST surface this; they may keep the local copy.
 */
export class SyncFailureError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, reason?: string) {
    super(reason ? `sync_failed_${status}: ${reason}` : `sync_failed_${status}`);
    this.name = 'SyncFailureError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * True ONLY for a genuine transport failure — the one case where falling back
 * to device-local state is honest.
 *
 * Deliberately an allow-list, not `!(err instanceof SyncFailureError)`. A
 * catch-all would relabel every programming error (a `TypeError` from bad
 * serialization, a thrown assertion) as "offline" and swallow it — recreating,
 * one layer up, exactly the silent-failure bug this module exists to kill.
 * `fetch()` rejects with `TypeError` for network/DNS/CORS failures and with an
 * `AbortError` when cancelled; nothing else counts.
 */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof SyncFailureError) return false;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  // `instanceof TypeError` ALONE — deliberately no message sniffing. Browsers
  // word this differently ("Failed to fetch" / "NetworkError when attempting to
  // fetch resource" / "Load failed") and may localize it, so a message regex
  // would misclassify network failures for non-English users of an app that
  // ships four locales. The domain errors this must NOT swallow — `SerializeError`,
  // `CanonicalParseError` — extend `Error`, not `TypeError`, so the type check
  // is sufficient on its own.
  return err instanceof TypeError;
}

/**
 * Throw `SyncFailureError` unless the response succeeded. `allowStatuses` lets
 * a caller treat specific codes as success (e.g. 404 on DELETE = already gone).
 * Reads `details.reason` from the canonical error envelope (ADR 0143) so
 * callers can branch on a domain reason without re-parsing.
 */
export async function assertSynced(res: Response, allowStatuses: number[] = []): Promise<Response> {
  if (res.ok || allowStatuses.includes(res.status)) return res;
  const body = (await res.json().catch(() => undefined)) as
    | { details?: { reason?: string }; error?: string }
    | undefined;
  // ADR 0621 D5 — a refused session is never "held for later sync".
  noteSessionRefusal(res.status, body);
  throw new SyncFailureError(res.status, body?.details?.reason ?? body?.error);
}

/** Per-call fetch options. Includes `credentials: 'include'` in cookie
 *  mode AND when an ID token is present (defense-in-depth: if the
 *  token is rejected, the cookie fallback still works on the same
 *  request thanks to backend's bearer-then-cookie order). */
export function fetchOpts(init?: RequestInit): RequestInit {
  if (config.authMode === 'cookie' || cachedIdToken) {
    return { ...(init ?? {}), credentials: 'include' };
  }
  return init ?? {};
}
