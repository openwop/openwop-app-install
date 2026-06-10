/**
 * Demo-mode signal for the frontend — is this the public showcase deployment
 * (vs a clean / white-label install)? The backend advertises `demoMode` in its
 * discovery doc (see backend host/demoMode.ts). When false, the app must show
 * NO built-in sample/demo content (sample workflows, etc.) — production-grade,
 * empty out of the gate.
 *
 * Fetched once and cached so synchronous consumers (e.g. the chat @-mention
 * catalog) can read `demoModeCached()` without threading async state. Call
 * `loadDemoMode()` once at app start to populate the cache.
 */
import { getCapabilities } from './runsClient.js';

let cached = false;
let loaded = false;
let inflight: Promise<boolean> | null = null;

/** Synchronous read of the cached flag (false until {@link loadDemoMode} resolves). */
export function demoModeCached(): boolean {
  return cached;
}

/** Fetch + cache the host's demoMode once. Safe to call repeatedly. */
export async function loadDemoMode(): Promise<boolean> {
  if (loaded) return cached;
  if (!inflight) {
    inflight = getCapabilities()
      .then((c) => { cached = (c as { demoMode?: boolean }).demoMode === true; loaded = true; return cached; })
      .catch(() => { cached = false; loaded = true; return cached; });
  }
  return inflight;
}
