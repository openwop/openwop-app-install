import { isAdminCaller, useEffectiveAccessState } from '../client/useEffectiveAccess.js';

/**
 * DESIGN.md §4.5 rule 17 / ADR 0844 D4 — no link a viewer cannot follow.
 * `/runs/:runId` is an admin-tier route (`chrome/features.tsx`), gated by
 * `AdminLayout` on this same predicate, so a member who followed a chat run
 * link landed on "Administrator access required". Chat run links render only
 * for a caller who can open the page; the dashboard's run rows do the same.
 */
export function useCanOpenRunDetail(): boolean {
  return isAdminCaller(useEffectiveAccessState().access);
}

export function runDetailPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}
