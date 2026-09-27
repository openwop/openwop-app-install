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
let failed = false;
let inflight: Promise<boolean> | null = null;
// Bumped by `clearDemoModeCache`. An in-flight `getCapabilities()` continuation
// captures the generation it started in and refuses to write module state if a
// reset happened meanwhile — otherwise a reset is silently undone a tick later
// by a read nobody is waiting on any more.
let generation = 0;

/** Synchronous read of the cached flag (false until {@link loadDemoMode} resolves). */
export function demoModeCached(): boolean {
  return cached;
}

/**
 * UX-PRIV-1 — the boolean above deliberately collapses THREE states into
 * `false`: not-yet-resolved, resolved-as-clean, and the read FAILED. For
 * showcase content that is exactly right (hide demo chrome unless the host
 * proves it is the demo), and every existing consumer wants it.
 *
 * A DISCLOSURE surface cannot use it. `/privacy` forks its whole text on this
 * flag, and the clean/white-label arm deliberately makes no deployment-specific
 * claims — so it omits the 24-hour `openwop.session` anon-cookie disclosure. On
 * the real demo host a failed `getCapabilities()` therefore lands a visitor who
 * HAS that cookie on the arm that never mentions it, permanently (`loaded` is
 * set in the catch, so it never retries). Telling someone about the cookie you
 * gave them is not something to decide from an unread flag.
 *
 * This is additive: the boolean's semantics are untouched.
 */
/** Drop the memoized answer. Mirrors `clearCapabilitiesCache` /
 *  `clearPromptsSupportCache` — a test that stubs discovery needs the next call
 *  to actually read it, and `loaded` is deliberately set in the catch (so a
 *  failure never retries), which makes the cache sticky within a process. */
export function clearDemoModeCache(): void {
  cached = false; loaded = false; failed = false; inflight = null; generation += 1;
}

export type DemoModeStatus = 'unresolved' | 'demo' | 'clean' | 'unknown';
export function demoModeStatus(): DemoModeStatus {
  if (!loaded) return 'unresolved';
  if (failed) return 'unknown';
  return cached ? 'demo' : 'clean';
}

/** Fetch + cache the host's demoMode once. Safe to call repeatedly. */
export async function loadDemoMode(): Promise<boolean> {
  if (loaded) return cached;
  if (!inflight) {
    const gen = generation;
    inflight = getCapabilities()
      .then((c) => {
        const v = (c as { demoMode?: boolean }).demoMode === true;
        if (gen !== generation) return v;   // reset while in flight — do not write
        cached = v; failed = false; loaded = true;
        return cached;
      })
      .catch(() => {
        if (gen !== generation) return false;
        cached = false; failed = true; loaded = true;
        return cached;
      });
  }
  return inflight;
}
