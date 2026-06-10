/**
 * Feature-access context — the FE read-only mirror of the backend's resolved
 * assignments (ADR 0001 §3.4). Loads the caller's assignments once at boot (and
 * on auth change), exposes `useFeatureAccess(id)` mirroring myndhyve's hook.
 *
 * The FE is NEVER the authority: it only renders based on what the backend
 * resolved. Anything that gates server behavior is enforced server-side.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchAssignments, type ResolvedAssignment } from '../client/featureTogglesClient.js';
import { onAuthChange } from '../client/config.js';

export interface FeatureAccess {
  status: 'on' | 'off' | 'beta';
  /** Active for this user (on, or beta + eligible). */
  enabled: boolean;
  /** Marked experimental — render a Beta badge. */
  isBeta: boolean;
  /** Assigned variant key (null when the toggle has no variants / is off). */
  variant: string | null;
}

interface FeatureAccessState {
  byId: Record<string, ResolvedAssignment>;
  loading: boolean;
  reload: () => void;
}

const FALLBACK: FeatureAccess = { status: 'off', enabled: false, isBeta: false, variant: null };

const Ctx = createContext<FeatureAccessState>({ byId: {}, loading: true, reload: () => {} });

export function FeatureAccessProvider({ children }: { children: ReactNode }): JSX.Element {
  const [byId, setById] = useState<Record<string, ResolvedAssignment>>({});
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchAssignments()
      .then((list) => {
        if (cancelled) return;
        const map: Record<string, ResolvedAssignment> = {};
        for (const a of list) map[a.id] = a;
        setById(map);
      })
      .catch(() => {
        // Resolution is best-effort presentation; on failure every feature
        // reads as its fallback (off). Server-side gating still holds.
        if (!cancelled) setById({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Re-resolve when the signed-in identity changes (a different user buckets
  // differently and may have different overrides).
  useEffect(() => onAuthChange(reload), [reload]);

  const value = useMemo<FeatureAccessState>(() => ({ byId, loading, reload }), [byId, loading, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Resolve one feature for the current user. Mirrors myndhyve's useFeatureAccess. */
export function useFeatureAccess(id: string): FeatureAccess & { loading: boolean } {
  const { byId, loading } = useContext(Ctx);
  const a = byId[id];
  if (!a) return { ...FALLBACK, loading };
  return { status: a.status, enabled: a.enabled, isBeta: a.status === 'beta' && a.enabled, variant: a.variant, loading };
}

/** Imperative read of every resolved assignment (e.g. for the admin preview). */
export function useAllFeatureAccess(): FeatureAccessState {
  return useContext(Ctx);
}

/**
 * A predicate for feature-gated nav visibility (ADR §3.4): items with a
 * `featureId` are hidden unless that feature resolves enabled for the caller;
 * items without one always show. Shared by the Sidebar AND the ⌘K palette so
 * the two nav surfaces can't drift.
 */
export function useFeatureVisible(): (featureId?: string) => boolean {
  const { byId } = useContext(Ctx);
  return (featureId?: string) => !featureId || byId[featureId]?.enabled === true;
}

/**
 * Maturity badge for a feature-gated nav item: `'Beta'` when the feature
 * resolves enabled AND its toggle is in the beta stage, else `null`. Shared by
 * the Sidebar, the admin rail, and the ⌘K palette so the badge can't drift
 * across the three nav surfaces. (An item is only ever rendered when it's
 * visible, so this only fires for enabled features.)
 */
export function useFeatureBadge(): (featureId?: string) => 'Beta' | null {
  const { byId } = useContext(Ctx);
  return (featureId?: string) => {
    if (!featureId) return null;
    const a = byId[featureId];
    return a?.enabled === true && a.status === 'beta' ? 'Beta' : null;
  };
}
