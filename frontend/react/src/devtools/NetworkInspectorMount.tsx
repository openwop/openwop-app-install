/**
 * Network-inspector mount, gated on the `developer-tools` toggle (ADR 0196
 * Phase 2 / Gate B). Owns BOTH halves of the inspector lifecycle so the
 * enterprise-clean posture holds:
 *
 *  - the fetch-interceptor install (`installNetworkRecorder`) runs ONLY once
 *    the toggle resolves `enabled` — a clean install never buffers
 *    request/response bodies at all. Calls made before resolution are lost,
 *    which is fine for a dev tool (the recorder is idempotent, so a late
 *    install is safe per its own contract);
 *  - the panel itself mounts only while enabled AND open — flipping the
 *    toggle off with the panel open unmounts it (fail-closed).
 *
 * Must render UNDER `FeatureAccessProvider` (App renders it inside); the
 * `netOpen` UI state stays in App, which also hosts the Sidebar button.
 */
import { lazy, Suspense, useEffect } from 'react';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { installNetworkRecorder } from './networkRecorder.js';

const NetworkPanel = lazy(() => import('./NetworkPanel.js').then((m) => ({ default: m.NetworkPanel })));

export function NetworkInspectorMount({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const devTools = useFeatureAccess('developer-tools');
  useEffect(() => {
    if (devTools.enabled) installNetworkRecorder();
    // Fail-closed hardening: if the toggle flips off while the panel is open,
    // also clear the caller's open-state so a later re-enable doesn't resurface
    // the panel un-summoned.
    if (!devTools.enabled && open) onClose();
  }, [devTools.enabled, open, onClose]);
  if (!devTools.enabled || !open) return null;
  return (
    <Suspense fallback={null}>
      <NetworkPanel open={open} onClose={onClose} />
    </Suspense>
  );
}
