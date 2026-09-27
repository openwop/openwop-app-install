/**
 * useOrgResource (ADR 0375 Phase 3) — the shared load path for an org-scoped tile.
 * Resolves the dashboard org once (via `useDashboardOrg`), then runs the tile's
 * fetcher against it. Collapses the org-loading / no-org / fetch-error / fetch-ok
 * states every org-scoped tile would otherwise re-implement, and guarantees the
 * tile NEVER throws to the grid (errors become the `error` flag → the tile renders
 * its designed error state).
 *
 * `status`:
 *  - 'loading' — org or data still resolving (render a skeleton)
 *  - 'no-org'  — the caller has no workspace yet (render the empty state)
 *  - 'error'   — org or fetch failed (render the error state)
 *  - 'ready'   — `data` is populated
 */
import { useEffect, useState } from 'react';
import { useDashboardOrg } from './useDashboardOrg.js';

export type OrgResourceStatus = 'loading' | 'no-org' | 'error' | 'ready';

export interface OrgResource<T> {
  status: OrgResourceStatus;
  data: T | null;
}

export function useOrgResource<T>(
  fetcher: (orgId: string) => Promise<T>,
  deps: readonly unknown[] = [],
): OrgResource<T> {
  const { orgId, loading: orgLoading, error: orgError } = useDashboardOrg();
  const [state, setState] = useState<OrgResource<T>>({ status: 'loading', data: null });

  useEffect(() => {
    if (orgLoading) { setState({ status: 'loading', data: null }); return; }
    if (orgError) { setState({ status: 'error', data: null }); return; }
    if (!orgId) { setState({ status: 'no-org', data: null }); return; }
    // A `live` guard (not an AbortSignal) — these org clients don't accept a
    // signal, so we must gate the state write on mount rather than cancel the fetch.
    let live = true;
    setState({ status: 'loading', data: null });
    fetcher(orgId)
      .then((data) => { if (live) setState({ status: 'ready', data }); })
      .catch(() => { if (live) setState({ status: 'error', data: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher identity varies per render; deps is the tile's explicit trigger list
  }, [orgId, orgLoading, orgError, ...deps]);

  return state;
}
