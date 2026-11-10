/**
 * ADR 1034 D11 — the caller's effective scopes in one org, so a page offers only the
 * controls the server will let the caller use. Read once per org from the same
 * effective-access answer `requireOrgScope` decides on.
 *
 * The per-feature hooks (`useCrmOrgAccess`, `useKbOrgAccess`, `useCmsOrgAccess`) each
 * trim this to one scope; sales ops needs a manage scope per feature, so it reads the
 * whole list once. Same posture as those hooks: until the answer is in, `has()` is false
 * (no control flashes on and off), and a FAILED read is reported as `failed` with a retry,
 * never silently treated as "you may not".
 */
import { useCallback, useEffect, useState } from 'react';
import { getEffectiveAccess } from '../client/accessClient.js';

export interface OrgScopes {
  has: (scope: string) => boolean;
  resolved: boolean;
  failed: boolean;
  retry: () => void;
}

export function useOrgScopes(orgId: string): OrgScopes {
  const [scopes, setScopes] = useState<readonly string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  useEffect(() => {
    if (!orgId) { setScopes(null); setFailed(false); return; }
    let live = true;
    // Clear the previous org's answer FIRST: org A's manage scope must never light up org B.
    setScopes(null); setFailed(false);
    void getEffectiveAccess({ orgId })
      .then((a) => { if (live) setScopes(a.scopes); })
      .catch((e: unknown) => {
        if (!live) return;
        console.warn('[orgs] effective-access read failed:', e instanceof Error ? e.message : e);
        setFailed(true);
      });
    return () => { live = false; };
  }, [orgId, reload]);
  const has = useCallback((scope: string) => scopes?.includes(scope) ?? false, [scopes]);
  return { has, resolved: scopes !== null, failed, retry };
}
