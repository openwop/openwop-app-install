/**
 * Feature-access context — the FE read-only mirror of the backend's resolved
 * assignments (ADR 0001 §3.4). Loads the caller's assignments once at boot (and
 * on auth change), exposes `useFeatureAccess(id)` mirroring myndhyve's hook.
 *
 * The FE is NEVER the authority: it only renders based on what the backend
 * resolved. Anything that gates server behavior is enforced server-side.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchAssignments, fetchEntitlements, type ResolvedAssignment } from '../client/featureTogglesClient.js';
import { onAuthChange } from '../client/config.js';
import { registerEntitlementReloader } from '../client/entitlementRefresh.js';
import { telemetry } from '../platform/telemetry.js';

export interface FeatureAccess {
  status: 'on' | 'off' | 'beta';
  /** Active for this user (on, or beta + eligible) — the TOGGLE state only. */
  enabled: boolean;
  /** Marked experimental — render a Beta badge. */
  isBeta: boolean;
  /** Assigned variant key (null when the toggle has no variants / is off). */
  variant: string | null;
  /** ADR 0419 — the tenant's plan/bundle ENTITLES this feature (true when billing
   *  is off / the plan is unrestricted). Distinct from `enabled` (the toggle). */
  entitled: boolean;
  /** ADR 0419 — the toggle is ON but the plan/bundles do NOT entitle it: a paid
   *  feature the tenant hasn't bought. Surfaces a "buy to unlock" state (never
   *  overloads `enabled`, so existing consumers are unchanged). */
  locked: boolean;
}

interface FeatureAccessState {
  byId: Record<string, ResolvedAssignment>;
  /** '*' = unrestricted (billing off / all-access plan); else the entitled ids. */
  allowedFeatures: '*' | string[];
  loading: boolean;
  /** TWIN-UX-1 (failed-read leg) — the LAST assignments resolution FAILED, so
   *  every `enabled:false` below is "unknown", not "off". Consent-grade surfaces
   *  branch on this instead of rendering a failed read as a resolved OFF. */
  resolutionFailed: boolean;
  reload: () => void;
}

const FALLBACK: Omit<FeatureAccess, 'entitled' | 'locked'> = { status: 'off', enabled: false, isBeta: false, variant: null };

const Ctx = createContext<FeatureAccessState>({ byId: {}, allowedFeatures: '*', loading: true, resolutionFailed: false, reload: () => {} });

/** Whether `allowedFeatures` entitles a given feature id. */
function isEntitled(allowed: '*' | string[], id: string): boolean {
  return allowed === '*' || allowed.includes(id);
}

export function FeatureAccessProvider({ children }: { children: ReactNode }): JSX.Element {
  const [byId, setById] = useState<Record<string, ResolvedAssignment>>({});
  const [allowedFeatures, setAllowed] = useState<'*' | string[]>('*');
  const [loading, setLoading] = useState(true);
  const [resolutionFailed, setResolutionFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /** True once the FIRST resolution has completed. A REFRESH must not flip
   *  `loading` back to true: `EntitlementGuard` renders a busy placeholder while
   *  loading, which UNMOUNTS its children — so a background re-resolve would
   *  destroy and remount whatever page the user is on, losing form input, editor
   *  content, scroll position and open modals. Stale-while-revalidate instead:
   *  keep serving the previous answer until the new one lands. (Found by
   *  /ux-review 2026-07-28 — UI-ENT-1b's 403 hook made every 403 in the app,
   *  including unrelated superadmin refusals, trigger exactly that unmount.) */
  const settledOnce = useRef(false);

  // UI-ENT-1b — let a mid-session 403 re-resolve entitlements through the ONE
  // existing path. Registered rather than imported by the client layer so the
  // dependency points inward (client/ must not import features/).
  useEffect(() => {
    registerEntitlementReloader(reload);
    return () => registerEntitlementReloader(null);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    if (!settledOnce.current) setLoading(true);
    // Resolve the toggle assignments AND the plan/bundle entitlements together
    // (ADR 0419). Entitlements degrade to '*' (unrestricted) on any failure /
    // billing-off, so a resolution error never spuriously LOCKS a feature.
    void Promise.all([fetchAssignments(), fetchEntitlements().catch(() => '*' as const)])
      .then(([list, allowed]) => {
        if (cancelled) return;
        const map: Record<string, ResolvedAssignment> = {};
        for (const a of list) map[a.id] = a;
        setById(map);
        setAllowed(allowed);
        setResolutionFailed(false);
      })
      .catch((err) => {
        // Resolution is best-effort presentation; on failure every feature
        // reads as its fallback (off). Server-side gating still holds. FP-3:
        // surface the failure to telemetry so an operator can see WHY features
        // silently vanished for a user instead of it being invisible — and
        // TWIN-UX-1: expose it as `resolutionFailed`, so a consent surface can
        // render "we couldn't check" instead of a silent OFF.
        telemetry.reportError(err, { region: 'feature-access-resolution' });
        if (!cancelled) { setById({}); setAllowed('*'); setResolutionFailed(true); }
      })
      .finally(() => {
        if (!cancelled) { settledOnce.current = true; setLoading(false); }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Re-resolve when the signed-in identity changes (a different user buckets
  // differently and may have different overrides).
  useEffect(() => onAuthChange(reload), [reload]);

  const value = useMemo<FeatureAccessState>(() => ({ byId, allowedFeatures, loading, resolutionFailed, reload }), [byId, allowedFeatures, loading, resolutionFailed, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Resolve one feature for the current user. Mirrors myndhyve's useFeatureAccess.
 *  `resolutionFailed` distinguishes "the read failed, this OFF is unknown" from a
 *  resolved OFF (TWIN-UX-1's failed-read leg). */
export function useFeatureAccess(id: string): FeatureAccess & { loading: boolean; resolutionFailed: boolean } {
  const { byId, allowedFeatures, loading, resolutionFailed } = useContext(Ctx);
  const entitled = isEntitled(allowedFeatures, id);
  const a = byId[id];
  if (!a) return { ...FALLBACK, entitled, locked: false, loading, resolutionFailed };
  return {
    status: a.status,
    enabled: a.enabled,
    isBeta: a.status === 'beta' && a.enabled,
    variant: a.variant,
    entitled,
    locked: a.enabled && !entitled, // toggle on, but not entitled → buy to unlock
    loading,
    resolutionFailed,
  };
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
 * ADR 0419 — whether a feature is LOCKED for the caller: its toggle is on but the
 * tenant's plan/bundles don't entitle it (a paid feature not yet bought). Surfaces
 * can render a "buy to unlock" state → the feature store (`/marketplace/bundles`).
 * Returns false when billing is off / the plan is unrestricted (nothing locked).
 */
export function useFeatureLocked(): (featureId?: string) => boolean {
  const { byId, allowedFeatures } = useContext(Ctx);
  return (featureId?: string) => !!featureId && byId[featureId]?.enabled === true && !isEntitled(allowedFeatures, featureId);
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
