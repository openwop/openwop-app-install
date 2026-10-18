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
import { isNetworkFailure, recordEntitlementAnswer, revokeLastKnownEntitlements } from './lastKnownEntitlement.js';

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
  /** ADR 0873 D12 — the last resolution failed to REACH the server (a network
   *  error, not an HTTP answer). `EntitlementGuard` fails closed on it, unless the
   *  feature opted into `offline.entitlement: 'last-known'` and holds a grant. */
  offline: boolean;
  reload: () => void;
}

const FALLBACK: Omit<FeatureAccess, 'entitled' | 'locked'> = { status: 'off', enabled: false, isBeta: false, variant: null };

const Ctx = createContext<FeatureAccessState>({ byId: {}, allowedFeatures: '*', loading: true, resolutionFailed: false, offline: false, reload: () => {} });

/** ADR 0873 D12 — the bounded backoff for re-resolving an offline answer while the
 *  browser still reports itself online. Three tries, then the notice's button. */
const AUTO_RETRY_MS = [2_000, 5_000, 15_000] as const;

/** A 401 or 403 — an authoritative refusal, which deletes last-known grants (D12). */
const isAuthRefusal = (err: unknown): boolean => {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
};

/** Whether `allowedFeatures` entitles a given feature id. */
function isEntitled(allowed: '*' | string[], id: string): boolean {
  return allowed === '*' || allowed.includes(id);
}

/**
 * `lastKnownFeatureIds` — the features declaring `offline.entitlement:
 * 'last-known'` (ADR 0873 D12). Each online resolution refreshes or deletes their
 * grants; no other feature is ever written to storage.
 */
export function FeatureAccessProvider({ children, lastKnownFeatureIds = [] }: { children: ReactNode; lastKnownFeatureIds?: readonly string[] }): JSX.Element {
  const [byId, setById] = useState<Record<string, ResolvedAssignment>>({});
  const [allowedFeatures, setAllowed] = useState<'*' | string[]>('*');
  const [loading, setLoading] = useState(true);
  const [resolutionFailed, setResolutionFailed] = useState(false);
  const [offline, setOffline] = useState(false);
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
  /** ADR 0873 D12 — the opted-in feature ids, read inside the resolution. */
  const lastKnownIds = useRef(lastKnownFeatureIds);
  lastKnownIds.current = lastKnownFeatureIds;
  /** ADR 0873 D12 — automatic re-resolves spent since the last success. */
  const autoRetries = useRef(0);

  // UI-ENT-1b — let a mid-session 403 re-resolve entitlements through the ONE
  // existing path. Registered rather than imported by the client layer so the
  // dependency points inward (client/ must not import features/).
  useEffect(() => {
    registerEntitlementReloader(reload);
    return () => registerEntitlementReloader(null);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    /** The entitlement read failed with an HTTP error: its '*' fallback is not an answer. */
    let notAnAnswer = false;
    if (!settledOnce.current) setLoading(true);
    // Resolve the toggle assignments AND the plan/bundle entitlements together
    // (ADR 0419). Entitlements degrade to '*' (unrestricted) on any failure /
    // billing-off, so a resolution error never spuriously LOCKS a feature.
    //
    // ADR 0873 D12 — except a NETWORK failure, which propagates so the guard can
    // fail closed offline. An HTTP failure still degrades to '*', but is never
    // recorded as a last-known grant, and a 401/403 deletes the grants held.
    void Promise.all([
      fetchAssignments(),
      fetchEntitlements().catch((err: unknown) => {
        if (isNetworkFailure(err)) throw err;
        notAnAnswer = true;
        if (isAuthRefusal(err)) revokeLastKnownEntitlements();
        return '*' as const;
      }),
    ])
      .then(([{ assignments: list, caller }, allowed]) => {
        // ADR 0873 D12 — record grants under the subject THIS answer was resolved
        // for (the server's echo: the ACTIVE workspace). Only a real answer, only
        // for opted-in features, and never without the echo (an older backend).
        const ids = lastKnownIds.current;
        if (!notAnAnswer && caller?.principalId && ids.length > 0) {
          recordEntitlementAnswer(
            { userId: caller.principalId, tenantId: caller.tenantId },
            ids.filter((id) => isEntitled(allowed, id)),
            ids.filter((id) => !isEntitled(allowed, id)),
          );
        }
        if (cancelled) return;
        const map: Record<string, ResolvedAssignment> = {};
        for (const a of list) map[a.id] = a;
        setById(map);
        setAllowed(allowed);
        setResolutionFailed(false);
        setOffline(false);
        autoRetries.current = 0;
      })
      .catch((err) => {
        // Resolution is best-effort presentation; on failure every feature
        // reads as its fallback (off). Server-side gating still holds. FP-3:
        // surface the failure to telemetry so an operator can see WHY features
        // silently vanished for a user instead of it being invisible — and
        // TWIN-UX-1: expose it as `resolutionFailed`, so a consent surface can
        // render "we couldn't check" instead of a silent OFF.
        telemetry.reportError(err, { region: 'feature-access-resolution' });
        const unreachable = isNetworkFailure(err);
        const refused = !unreachable && isAuthRefusal(err);
        if (refused) revokeLastKnownEntitlements();
        // ADR 0873 D12 follow-up — a failed REFRESH keeps the previous answer
        // (stale-while-revalidate, as `loading` does). Resetting here read every
        // feature as its fallback: `locked` false showed a paywalled feature
        // unlocked, and every toggle-gated feature vanished, on any 5xx or blip.
        // A 401/403 is the exception: the answer it would keep is no longer ours.
        if (settledOnce.current && !refused) return;
        if (!cancelled) {
          setById({}); setAllowed('*'); setResolutionFailed(true);
          // ADR 0873 D12 — only the FIRST resolution decides "offline". A refused
          // REFRESH leaves it as it was, so it never swaps a mounted page for the
          // notice (the same reason `loading` never flips back: UI-ENT-1b).
          if (!settledOnce.current) setOffline(unreachable);
        }
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

  // ADR 0873 D12 — offline is a state the browser announces the end of; re-resolve
  // then, so the offline notice clears without a manual retry.
  useEffect(() => {
    if (!offline || typeof window === 'undefined') return;
    window.addEventListener('online', reload);
    return () => window.removeEventListener('online', reload);
  }, [offline, reload]);

  // ADR 0873 D12 — a blip the browser never called offline (`navigator.onLine`
  // stayed true: a reset connection, a captive portal) fires no `online` event, so
  // re-resolve on a short bounded backoff instead of waiting for a click.
  useEffect(() => {
    if (!offline || autoRetries.current >= AUTO_RETRY_MS.length) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // the `online` event covers it
    const t = setTimeout(() => { autoRetries.current += 1; reload(); }, AUTO_RETRY_MS[autoRetries.current]);
    return () => clearTimeout(t);
  }, [offline, nonce, reload]);

  const value = useMemo<FeatureAccessState>(() => ({ byId, allowedFeatures, loading, resolutionFailed, offline, reload }), [byId, allowedFeatures, loading, resolutionFailed, offline, reload]);
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

/** ADR 0873 D12 — whether the last resolution failed to reach the server, and the
 *  re-resolve to offer as "retry". Kept out of `useFeatureAccess`'s return so its
 *  eight-field shape (and every typed mock of it) is unchanged. */
export function useAccessOffline(): { offline: boolean; retry: () => void } {
  const { offline, reload } = useContext(Ctx);
  return { offline, retry: reload };
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
