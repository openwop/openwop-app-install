/**
 * ADR 0074 — transient signal bus.
 *
 * The notifications SSE stream is the app's ONE global live connection. It now
 * also carries non-persisted `review.updated` "signal" frames (the emitter's
 * `signal()` path, never an inbox row). The notification store owns that single
 * connection; rather than have it depend *up* on the review-status store (a
 * cycle / boundary violation), it forwards signal frames to this module-level
 * bus, and the review-status store subscribes here.
 *
 * Keeps the connection count at one and the dependency direction clean:
 *   notificationStore → signalBus ← reviewStatusStore
 */

import type { Notification } from './types.js';

type SignalListener = (frame: Notification) => void;

const listeners = new Set<SignalListener>();

/** Forward a transient signal frame to every subscriber. Called by the
 *  notification store when an SSE frame's type is a signal (not an inbox row). */
export function publishReviewSignal(frame: Notification): void {
  for (const fn of listeners) {
    try { fn(frame); } catch { /* a listener throwing must not starve the others */ }
  }
}

/** Subscribe to review signal frames. Returns an unsubscribe function. */
export function subscribeReviewSignal(fn: SignalListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
