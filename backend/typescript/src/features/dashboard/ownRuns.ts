/**
 * The caller's OWN recent runs, slim (issue #4511 / ADR 0844 follow-up).
 *
 * The home tiles a MEMBER sees (Needs you, Get started) used to read the
 * workspace-wide `GET /runs` page: every member's browser received full run
 * snapshots (inputs, variables, error, configurable) of runs other people
 * started, and Needs you labelled someone else's failure "blocked on you".
 * This read answers the question those tiles actually ask — "what did I run?" —
 * and nothing more:
 *
 *   - OWNERSHIP is the RFC 0165 owner principal the run was stamped with at
 *     creation (`runOwner`, ADR 0625), compared against the same opaque
 *     projection of the SAME session subject (`opaquePrincipal(callerSubject)`).
 *     It never aliases across tenants: the scan is pinned to the active tenant.
 *   - In the caller's own personal workspace every run is theirs by
 *     construction (single-principal, `isOwnPersonalWorkspace`), including
 *     host-fired runs that carry no stamp.
 *   - The row is a five-field projection. Inputs, variables, configurable and
 *     error text never leave the server on this path.
 *
 * There is no owner column to index, so the read is a BOUNDED newest-first scan
 * of the `(tenant_id, created_at DESC)` index done in the database (#4531,
 * `Storage.listRunSummaries`): the inner LIMIT caps the scan at
 * `OWN_RUNS_SCAN_CAP` rows (the personal workspace scans exactly `limit`), the
 * owner predicate runs outside it, and only five columns plus the owner keys of
 * `metadata` come back — never O(tenant), never a full row. The store's
 * predicate is a superset; `runOwner` re-decides each row exactly here, so the
 * SQL can only over-fetch, never grant. `truncated` says when older owned runs
 * may exist that were not reached, so the tiles can keep their "sample, not the
 * whole period" honesty (`runsWindow.ts`).
 */
import type { Storage } from '../../storage/storage.js';
import { isRunOwnedBy, opaquePrincipal } from '../../host/runOwner.js';

export interface OwnRunRow {
  runId: string;
  workflowId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

/** The tiles' window (`RUN_WINDOW` frontend-side, one v2 page). */
export const OWN_RUNS_MAX = 100;
/** Rows examined before giving up — the store's inner LIMIT in a shared
 *  workspace with many other people's runs. */
export const OWN_RUNS_SCAN_CAP = 1000;

export async function listOwnRuns(
  storage: Storage,
  args: { tenantId: string; subject: string; wholeTenant: boolean; limit: number },
): Promise<{ runs: OwnRunRow[]; truncated: boolean }> {
  const principal = opaquePrincipal(args.subject);
  // Every row is owned in the personal workspace, so scan exactly the window.
  const scanCap = args.wholeTenant ? args.limit : OWN_RUNS_SCAN_CAP;
  const { runs, scanExhausted } = await storage.listRunSummaries({
    tenantId: args.tenantId,
    ...(args.wholeTenant ? {} : { owner: { principal, subject: args.subject } }),
    scanCap,
    limit: args.limit + 1, // one past the window: says whether older owned runs exist
  });
  const owned = runs.filter((r) => args.wholeTenant || isRunOwnedBy(r, args.subject));
  return {
    runs: owned.slice(0, args.limit).map((r) => ({
      runId: r.runId,
      workflowId: r.workflowId,
      status: r.status,
      startedAt: r.createdAt,
      ...(r.completedAt ? { completedAt: r.completedAt } : {}),
    })),
    // A full window, or a scan that stopped before the tenant's oldest run.
    truncated: runs.length > args.limit || scanExhausted,
  };
}
