/**
 * sharedRead (grade-code fix S3, ADR 0377) — a tiny promise memo for tile data
 * reads that MORE THAN ONE tile projects from (crm-pipeline + pipeline-trend
 * both call getPipelineReport; csm-health + health-distribution both call
 * listAccounts; etc.). Without it, enabling both tiles of a pair fires the same
 * request twice on one paint.
 *
 * Semantics: the IN-FLIGHT promise is shared (N tiles → 1 request), a rejection
 * clears the slot immediately (retryable), and a resolved value is reused for a
 * short TTL then refetched — a dashboard is a glanceable surface, not a live feed.
 *
 * ADR 0846 D5 — this is the app's ONE coalesce cache (`cachedRead`), not a second
 * one beside it. The module-level Map this used to keep had no auth-change reset,
 * so the next account to sign in on the same tab was served the previous
 * account's viewer-scoped reads (a CRM report, CSM accounts) for up to 30 s.
 * `cachedRead` drops everything on `onAuthChange` and never caches a load that was
 * in flight across the change.
 */
import { cachedRead, clearRequestCache, invalidate } from '../../client/requestCache.js';

const TTL_MS = 30_000;

export function sharedRead<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  return cachedRead(`dashboard:${key}`, TTL_MS, fetcher);
}

/** The caller's activity reads (issue 4511). Spelled here, not beside their
 *  readers, so the home page can drop them without importing those clients. */
export const RECENT_RUNS_KEY = 'dashboard:runs:recent';
export const MY_RUNS_KEY = 'dashboard:runs:mine';
export const CHAT_SESSIONS_KEY = 'dashboard:chat-sessions';
export const CONNECTIONS_KEY = 'dashboard:connections';

/**
 * Drop the caller's activity reads (runs, chats, connections) so the home
 * re-reads them. Called when the home mounts: a run, chat or connection is
 * created on ANOTHER page, and without this, coming straight back served the
 * pre-create answer for the rest of the TTL ("Run a workflow" still unticked
 * right after running one). It runs before the tiles mount, so the tiles on
 * one paint still share one request per key.
 */
export function invalidateHomeActivity(): void {
  for (const k of [RECENT_RUNS_KEY, MY_RUNS_KEY, CHAT_SESSIONS_KEY, CONNECTIONS_KEY]) invalidate(`dashboard:${k}`);
}

/** Test seam: drop all memoized slots. */
export function __resetSharedReads(): void {
  clearRequestCache();
}
