/**
 * ADR 1158 — the active workspace, carried to a request sent straight to the
 * backend host (the SSE base) instead of through `/api`.
 *
 * Cookies are per host. The workspace switch goes through `/api`, so the backend
 * host's own cookie (or none, when third-party cookies are blocked) never learns
 * it, and a signed-in caller in a shared workspace resolves their personal one
 * there. `/me/workspaces` hands out a short-lived selection token for exactly
 * this; a direct request presents it in a header and the host runs the same
 * membership check the cookie's selection gets.
 */
import { authedHeaders, config, onAuthChange } from './config.js';
import { listMyWorkspaces, WORKSPACE_SELECTION_HEADER } from './workspaceClient.js';

/** Renew a cached selection this long before its token expires. */
const RENEW_MARGIN_MS = 60_000;
/** How long "no shared workspace is active" is trusted before a re-read. */
const NONE_TTL_MS = 5 * 60_000;
/** After a failed read, no re-read for this long, doubling per failure up to the cap.
 *  Every direct stream fails at once when `/me/workspaces` is down; this keeps their
 *  reconnects from turning into a read storm. */
const COOLDOWN_START_MS = 2_000;
const COOLDOWN_MAX_MS = 60_000;

let cache: { headers: Record<string, string>; until: number } | null = null;
let inFlight: Promise<Record<string, string>> | null = null;
let generation = 0;
let watching = false;
let failures = 0;
let retryAt = 0;

function watchAuth(): void {
  if (watching) return;
  onAuthChange(() => { cache = null; inFlight = null; generation += 1; failures = 0; retryAt = 0; });
  watching = true;
}

/** True when the SSE base is another host than the API, so this origin's cookie does not reach it. */
function directBaseIsCrossHost(): boolean {
  const here = window.location.href;
  return new URL(config.sseBaseUrl || config.baseUrl, here).origin !== new URL(config.baseUrl, here).origin;
}

/** The expiry (ms) a selection token carries in its third field, or undefined. */
function tokenExpiryMs(token: string): number | undefined {
  const exp = Number(token.split('.')[2]);
  return Number.isInteger(exp) ? exp * 1000 : undefined;
}

/**
 * The active workspace's selection could not be read, so a direct-host request
 * cannot say which workspace it is for. Callers treat it exactly like a failed
 * fetch (their reconnect and backoff): sending the request without the header
 * would silently read the personal workspace, which is the defect this fixes.
 */
export class WorkspaceSelectionUnavailableError extends Error {
  constructor() {
    super('The active workspace could not be confirmed. Retrying.');
    this.name = 'WorkspaceSelectionUnavailableError';
  }
}

/**
 * The selection header a direct-host request needs to land in the active
 * workspace. `{}` without a read when the request carries no bearer (the host
 * reads the header on the bearer lane only) or the SSE base is the API's own host
 * (the cookie already travels), and `{}` when the read finds no shared workspace
 * active. Cached until shortly before the token expires, and dropped on every
 * auth change (a workspace switch is one).
 *
 * Fails CLOSED: when the read throws, or straddles an auth change (it then
 * describes the session before it), this throws
 * {@link WorkspaceSelectionUnavailableError} and the caller must not send the
 * request. Failing open would keep the silent wrong-workspace read. After a
 * failed read it throws at once, without reading, for a cool-down of 2 s doubling
 * to 60 s; a successful read or an auth change resets it.
 */
export async function directHostSelectionHeaders(nowMs: number = Date.now()): Promise<Record<string, string>> {
  if (!authedHeaders().authorization || !directBaseIsCrossHost()) return {};
  try {
    watchAuth();
  } catch {
    throw new WorkspaceSelectionUnavailableError();
  }
  if (cache && nowMs < cache.until) return cache.headers;
  if (inFlight) return await inFlight;
  if (nowMs < retryAt) throw new WorkspaceSelectionUnavailableError();
  const started = generation;
  const read = (async (): Promise<Record<string, string>> => {
    let selectionToken: string | undefined;
    try {
      ({ selectionToken } = await listMyWorkspaces({ rememberTenant: false }));
    } catch {
      // A read that straddled an auth change was reset by it; it starts no cool-down.
      if (started === generation) {
        retryAt = nowMs + Math.min(COOLDOWN_START_MS * 2 ** failures, COOLDOWN_MAX_MS);
        failures += 1;
      }
      throw new WorkspaceSelectionUnavailableError();
    }
    if (started !== generation) throw new WorkspaceSelectionUnavailableError();
    failures = 0;
    retryAt = 0;
    const headers: Record<string, string> = selectionToken ? { [WORKSPACE_SELECTION_HEADER]: selectionToken } : {};
    const until = selectionToken ? (tokenExpiryMs(selectionToken) ?? nowMs) - RENEW_MARGIN_MS : nowMs + NONE_TTL_MS;
    cache = { headers, until };
    return headers;
  })();
  inFlight = read;
  try { return await read; } finally { if (inFlight === read) inFlight = null; }
}

/** Test seam: forget the cached selection. */
export function resetDirectHostSelectionForTests(): void {
  cache = null; inFlight = null; generation += 1; failures = 0; retryAt = 0;
}
