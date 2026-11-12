/**
 * ADR 1023 — may the caller WRITE funnels in this org? Read once per org from the
 * same effective-access answer the server's `requireOrgScope` decides on
 * (`workspace:write`), so a Viewer is not offered controls that can only end in a
 * 403. The CRM/KB precedent (`useCrmOrgAccess`): until the answer is in, `canWrite`
 * is false; a FAILED read is `failed` with a retry, never "you may not write".
 */
import { useCallback, useEffect, useState } from 'react';
import { getEffectiveAccess } from '../../client/accessClient.js';

export function useFunnelsOrgAccess(orgId: string): { canWrite: boolean; known: boolean; failed: boolean; retry: () => void } {
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
        console.warn('[funnels] effective-access read failed:', e instanceof Error ? e.message : e);
        setFailed(true);
      });
    return () => { live = false; };
  }, [orgId, reload]);
  return { canWrite: scopes?.includes('workspace:write') ?? false, known: scopes !== null, failed, retry };
}
