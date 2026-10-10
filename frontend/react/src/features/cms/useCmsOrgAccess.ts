/**
 * ADR 0836 (row 22 grade-ux H1) — does the caller hold the CMS admin tier
 * (`host:members:manage`) in this org?
 *
 * The CMS used to offer every member the schedule controls, Restore, and the
 * search fields of a live or scheduled page, and each could only answer an
 * editor with a 403. This reads `GET /access/effective?orgId=` — the resolver
 * `requireOrgScope` decides with — once per org (the `kb/useKbOrgAccess`
 * precedent). The backend stays the authority.
 *
 * `canAdmin` is TRI-STATE on purpose: `null` while loading or after a failed
 * read. The page hides a control only when it KNOWS the answer is no; an
 * unknown leaves the control offered and the server decides, so a failed read
 * can never lock an admin out of their own launch.
 *
 * The reserved system-site org has no members; a superadmin is its admin
 * (`cmsScope.ts`), so the caller passes that answer in and no read is made.
 */
import { useEffect, useState } from 'react';
import { getEffectiveAccess } from '../../client/accessClient.js';

export function useCmsOrgAccess(orgId: string, systemSiteAdmin: boolean | null): { canAdmin: boolean | null } {
  const [canAdmin, setCanAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    if (systemSiteAdmin !== null) { setCanAdmin(systemSiteAdmin); return; }
    if (!orgId) { setCanAdmin(null); return; }
    let live = true;
    setCanAdmin(null); // org A's answer must never stand in for org B's
    void getEffectiveAccess({ orgId })
      .then((a) => { if (live) setCanAdmin(a.scopes.includes('host:members:manage')); })
      .catch((e: unknown) => {
        if (!live) return;
        console.warn('[cms] effective-access read failed:', e instanceof Error ? e.message : e);
        setCanAdmin(null);
      });
    return () => { live = false; };
  }, [orgId, systemSiteAdmin]);
  return { canAdmin };
}
