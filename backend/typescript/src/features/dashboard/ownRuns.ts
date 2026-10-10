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
 * There is no owner column to index, so ownership is decided in JS over a
 * BOUNDED newest-first scan of the existing `(tenant_id, created_at DESC)`
 * index (`listRuns` keyset pages): one page of `limit` rows in the personal
 * workspace, at most five pages of 200 in a shared one — never O(tenant). `truncated` says when older owned runs may exist that
 * were not reached, so the tiles can keep their "sample, not the whole period"
 * honesty (`runsWindow.ts`).
 */
import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import { opaquePrincipal, runOwner } from '../../host/runOwner.js';

export interface OwnRunRow {
  runId: string;
  workflowId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

/** The tiles' window (`RUN_WINDOW` frontend-side, one v2 page). */
export const OWN_RUNS_MAX = 100;
const SCAN_PAGE = 200;
/** Rows examined before giving up — bounds a shared workspace with many
 *  other people's runs to five indexed pages. */
export const OWN_RUNS_SCAN_CAP = 1000;

function slim(r: RunRecord): OwnRunRow {
  return {
    runId: r.runId,
    workflowId: r.workflowId,
    status: r.status,
    startedAt: r.createdAt,
    ...(r.completedAt ? { completedAt: r.completedAt } : {}),
  };
}

export async function listOwnRuns(
  storage: Storage,
  args: { tenantId: string; subject: string; wholeTenant: boolean; limit: number },
): Promise<{ runs: OwnRunRow[]; truncated: boolean }> {
  const principal = opaquePrincipal(args.subject);
  const owned = (r: RunRecord): boolean => args.wholeTenant || runOwner(r)?.principal === principal;
  // Every row is owned in the personal workspace, so read exactly the window —
  // the same one indexed page `GET /runs` reads. Only a shared workspace scans.
  const pageSize = args.wholeTenant ? args.limit : SCAN_PAGE;
  const out: OwnRunRow[] = [];
  let scanned = 0;
  let before: { createdAt: string; runId: string } | undefined;
  for (;;) {
    const page = await storage.listRuns({ tenantId: args.tenantId, limit: pageSize, ...(before ? { before } : {}) });
    for (const r of page) {
      scanned += 1;
      if (!owned(r)) continue;
      out.push(slim(r));
      // A full window: older owned runs may exist beyond it.
      if (out.length >= args.limit) return { runs: out, truncated: true };
    }
    const last = page[page.length - 1];
    // The list ended: every owned run there is has been seen.
    if (page.length < pageSize || last === undefined) return { runs: out, truncated: false };
    // The scan budget ran out before the list did.
    if (scanned >= OWN_RUNS_SCAN_CAP) return { runs: out, truncated: true };
    before = { createdAt: last.createdAt, runId: last.runId };
  }
}
