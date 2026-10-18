/**
 * EntitlementGuard (ADR 0419) — the deep-link counterpart to the R3 nav lock.
 * A tenant that navigates DIRECTLY to a paid-but-unbought feature's URL (bypassing
 * the nav) would otherwise load the page and hit a bare backend 403. This wraps a
 * feature route's element and, when the feature is LOCKED (toggle on, plan/bundles
 * don't entitle it), renders a designed "unlock in the feature store" state instead.
 *
 * Presentation only — the backend gate (the ADR 0419 central paywall) is the
 * authority. `locked` is false when billing is off / the plan is unrestricted, so
 * this is a passthrough for the reference host. Applied centrally at the App.tsx
 * route loops, keyed on the route's `ownerFeatureId` (so DETAIL routes are covered,
 * not just the nav index route).
 *
 * This guard is in the ENTRY chunk (it wraps every route), so the locked panel — and
 * its marketplace-client import — is LAZY (`./LockedState.js`), keeping that weight
 * off entry. The panel only ever loads on the rare locked path.
 *
 * ADR 0873 D12 — OFFLINE (the resolution never reached the server) the guard fails
 * closed to an offline notice (static, see its import). A feature that declares
 * `offline.entitlement: 'last-known'` renders instead while it holds an unexpired
 * grant from a positive online answer (`lastKnownEntitlement.ts`). Online, the grant
 * is never consulted, so it can never unlock a locked feature.
 */
import { type ReactElement, Suspense, lazy } from 'react';
import { Skeleton } from '../ui/Skeleton.js';
import { useAccessOffline, useFeatureAccess } from './FeatureAccessContext.js';
import { hasLastKnownEntitlement } from './lastKnownEntitlement.js';
// STATIC, unlike LockedState: it renders only offline, and the worker precaches the
// entry's STATIC graph alone (gen-service-worker `computePrecache`), so a lazy chunk
// here would itself fail to load at the one moment it is needed.
import { OfflineEntitlementState } from './OfflineEntitlementState.js';

const LockedState = lazy(() => import('./LockedState.js').then((m) => ({ default: m.LockedState })));
const busy = (): ReactElement => <div className="u-p-4" role="status"><Skeleton /></div>; // UX-419B — Skeleton is aria-hidden; announce busy here

export function EntitlementGuard({ featureId, offlineEntitlement, children }: {
  featureId: string;
  /** The owning feature's `offline.entitlement` (ADR 0873 D12); absent = fail closed. */
  offlineEntitlement?: 'fail-closed' | 'last-known' | undefined;
  children: ReactElement;
}): ReactElement {
  const { locked, loading } = useFeatureAccess(featureId);
  const { offline, retry } = useAccessOffline();
  // Resolve first — don't flash the feature content before locking it.
  if (loading) return busy();
  if (offline) {
    if (offlineEntitlement === 'last-known' && hasLastKnownEntitlement(featureId)) return children;
    return <OfflineEntitlementState onRetry={retry} />;
  }
  if (!locked) return children;
  return <Suspense fallback={busy()}><LockedState featureId={featureId} /></Suspense>;
}
