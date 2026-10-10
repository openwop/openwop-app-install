/**
 * KB2UX-1 — what the caller may DO in the selected organization's knowledge base.
 *
 * `/kb` is an admin-tier page, and the admin tier admits any caller for whom
 * `isAdminCaller` holds: the built-in `admin` role, or ANY custom role carrying a
 * `host:*:manage` scope. The KB doors ask different questions, per org:
 *
 *   - document / collection / retrieval-config writes → `workspace:write`
 *   - start / continue / discard a reindex            → `host:org:manage`, which
 *     is OWNER-only (`OWNER_SCOPES` in `host/accessControlService.ts`)
 *
 * So the page offered an `admin` the whole Reindex panel, and offered a
 * `host:teams:manage` member every write on the page, and each of those controls
 * could only answer with a 403. The backend stays the authority; this hook only
 * stops the page from offering a control whose one possible outcome is a refusal.
 *
 * It reads `GET /access/effective?orgId=` — the same `resolveEffectiveAccess`
 * that `requireOrgScope` → `assertOrgScope` decides with — once per selected org.
 *
 * Fail-CLOSED on a failed read, but never silently (the `ProjectsPage` PRJ2-M4
 * lesson): `failed` is its own state so the page can say "we could not confirm
 * your permissions" instead of implying "you have none".
 */
import { useCallback, useEffect, useState } from 'react';
import { getEffectiveAccess } from '../../client/accessClient.js';

export type KbOrgAccessState = 'loading' | 'ready' | 'failed';

export interface KbOrgAccess {
  state: KbOrgAccessState;
  /** `workspace:write` in this org — every document / collection / config write. */
  canWrite: boolean;
  /** `host:org:manage` in this org — the reindex routes (owner-only by default). */
  canReindex: boolean;
  retry: () => void;
}

export function useKbOrgAccess(orgId: string): KbOrgAccess {
  const [state, setState] = useState<KbOrgAccessState>('loading');
  const [scopes, setScopes] = useState<readonly string[]>([]);
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    if (!orgId) { setState('loading'); setScopes([]); return; }
    let live = true;
    // Clear the previous org's answer FIRST: org A's `workspace:write` must never
    // light up org B's controls for the length of the read.
    setState('loading'); setScopes([]);
    void getEffectiveAccess({ orgId })
      .then((a) => { if (live) { setScopes(a.scopes); setState('ready'); } })
      .catch((e: unknown) => {
        if (!live) return;
        console.warn('[kb] effective-access read failed:', e instanceof Error ? e.message : e);
        setScopes([]); setState('failed');
      });
    return () => { live = false; };
  }, [orgId, reload]);

  return {
    state,
    canWrite: state === 'ready' && scopes.includes('workspace:write'),
    canReindex: state === 'ready' && scopes.includes('host:org:manage'),
    retry,
  };
}
