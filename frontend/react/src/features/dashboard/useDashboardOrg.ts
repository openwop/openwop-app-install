/**
 * useDashboardOrg (ADR 0375 Phase 3) — the ONE resolver for "which org this
 * dashboard shows". Org-scoped tiles (documents, scheduled agents, CRM, commerce,
 * campaign KPIs, funnels) need an `orgId`; the app has no shared current-org
 * context and is effectively one-org-per-tenant (ADR 0015), so every surface
 * resolves via `listOrgs()[0]` (chat, publishing, commerce all do this). This
 * centralizes that heuristic in a single place so tiles never each re-derive it.
 *
 * Pins from the Phase-3 architect review:
 *  - Source is the CORE, non-feature-gated `accessClient.listOrgs` (the org SSoT).
 *    A feature's own `listOrgs` would 404 when that feature is toggled off and
 *    break every org-scoped tile.
 *  - The in-flight PROMISE is memoized module-wide, so N tiles mounting together
 *    share ONE request (not N — the fan-out guard's partner). A rejection CLEARS
 *    the memo so a transient failure is retryable on the next mount.
 */
import { useEffect, useState } from 'react';
import { listOrgs } from '../../client/accessClient.js';
import { onAuthChange } from '../../client/config.js';

let orgPromise: Promise<string | null> | null = null;
// ADR 0846 D5 — the org belongs to the identity that resolved it. A sign-out /
// sign-in / workspace switch drops it (the `requestCache` SHELL-8 pattern). A
// resolve still in flight across the change cannot write it back: the memo is
// only ever assigned synchronously below, never from the settled promise.
onAuthChange(() => { orgPromise = null; });

/** Resolve (and cache) the dashboard's org id. Shared across all tiles. */
function resolveOrgId(): Promise<string | null> {
  if (!orgPromise) {
    const p: Promise<string | null> = listOrgs()
      .then((orgs) => orgs[0]?.orgId ?? null)
      .catch((e) => {
        if (orgPromise === p) orgPromise = null; // clear so a transient failure can retry on remount
        throw e;
      });
    orgPromise = p;
  }
  return orgPromise;
}

export interface DashboardOrgState {
  orgId: string | null;
  loading: boolean;
  error: boolean;
}

export function useDashboardOrg(): DashboardOrgState {
  const [state, setState] = useState<DashboardOrgState>({ orgId: null, loading: true, error: false });

  useEffect(() => {
    let live = true;
    resolveOrgId()
      .then((orgId) => { if (live) setState({ orgId, loading: false, error: false }); })
      .catch(() => { if (live) setState({ orgId: null, loading: false, error: true }); });
    return () => { live = false; };
  }, []);

  return state;
}

/** Test seam: drop the memoized org promise so each test starts clean. */
export function __resetDashboardOrgMemo(): void {
  orgPromise = null;
}
