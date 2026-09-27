/**
 * React read of the host's demo-mode flag (ADR 0196 Phase 3 / Gate A).
 *
 * `demoModeCached()` is synchronous-after-load, so a component that renders
 * before anything has called `loadDemoMode()` (the public front page, the
 * sign-in modal, the BYOK on-ramp) would read a permanent false. This hook
 * seeds from the cache and then resolves the flag itself — the same pattern
 * RunsIndexPage carried inline before it was extracted here.
 *
 * Fail-safe direction: `false` until resolved — showcase content stays HIDDEN
 * unless the host proves it is the demo (enterprise-clean by default). A brief
 * flash-in of demo chrome on the public demo is acceptable; the reverse is not.
 */
import { useEffect, useState } from 'react';
import { demoModeCached, demoModeStatus, loadDemoMode, type DemoModeStatus } from './demoMode.js';

export function useDemoMode(): boolean {
  const [demo, setDemo] = useState(demoModeCached());
  useEffect(() => {
    let live = true;
    void loadDemoMode().then((v) => { if (live) setDemo(v); });
    return () => { live = false; };
  }, []);
  return demo;
}

/**
 * UX-PRIV-1 — the tri-state read, for surfaces that must not treat "we couldn't
 * ask" as "no". Only `/privacy` needs this today; everything else wants the
 * fail-safe boolean above. See `demoMode.demoModeStatus` for why.
 */
export function useDemoModeStatus(): DemoModeStatus {
  const [status, setStatus] = useState<DemoModeStatus>(demoModeStatus());
  useEffect(() => {
    let live = true;
    void loadDemoMode().then(() => { if (live) setStatus(demoModeStatus()); });
    return () => { live = false; };
  }, []);
  return status;
}
