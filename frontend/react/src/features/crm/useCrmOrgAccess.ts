/**
 * ADR 0837 CRM2UX-2 — may the caller WRITE CRM records in this org? Read once per
 * org from the same effective-access answer the server's `requireOrgScope` decides
 * on (`workspace:write`), so a viewer is not offered controls that can only end in
 * a 403 toast. The KB precedent (`useKbOrgAccess`), trimmed to the one scope CRM
 * needs, INCLUDING its failure state: until the answer is in, `canWrite` is false
 * (no control flashes on and off); a FAILED read is reported as `failed` with a
 * retry, never silently treated as "you may not write" (the PRJ2-M4 lesson).
 */
import { useCallback, useEffect, useState } from 'react';
import { getEffectiveAccess } from '../../client/accessClient.js';

export function useCrmOrgAccess(orgId: string): { canWrite: boolean; failed: boolean; retry: () => void } {
  const [scopes, setScopes] = useState<readonly string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  useEffect(() => {
    if (!orgId) { setScopes(null); setFailed(false); return; }
    let live = true;
    // Clear the previous org's answer FIRST: org A's write must never light up org B.
    setScopes(null); setFailed(false);
    void getEffectiveAccess({ orgId })
      .then((a) => { if (live) setScopes(a.scopes); })
      .catch((e: unknown) => {
        if (!live) return;
        console.warn('[crm] effective-access read failed:', e instanceof Error ? e.message : e);
        setFailed(true);
      });
    return () => { live = false; };
  }, [orgId, reload]);
  return { canWrite: scopes?.includes('workspace:write') ?? false, failed, retry };
}
