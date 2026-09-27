/**
 * Walkthrough launch bus (ADR 0368 Phase 3) — any surface (the /test runner's Play,
 * a per-feature affordance) requests a tour without prop-drilling to the one
 * `WalkthroughOverlayHost` mounted in the app chrome. Module-scoped event target;
 * no state, no store — the durable run is the state.
 */

type Listener = (walkthroughId: string) => void;
const listeners = new Set<Listener>();

export function requestWalkthroughLaunch(walkthroughId: string): void {
  for (const l of listeners) l(walkthroughId);
}

export function onWalkthroughLaunchRequest(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// ── Record mode (ADR 0368 Phase 6b) — the same bus so the ONE overlay host
//    owns both play and record (mutual exclusion lives there). ────────────────
type RecordListener = () => void;
const recordListeners = new Set<RecordListener>();

export function requestWalkthroughRecord(): void {
  for (const l of recordListeners) l();
}

export function onWalkthroughRecordRequest(l: RecordListener): () => void {
  recordListeners.add(l);
  return () => { recordListeners.delete(l); };
}
