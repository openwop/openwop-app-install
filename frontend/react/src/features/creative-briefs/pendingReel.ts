/**
 * REEL-2 — the handle that lets a five-minute reel survive leaving the page.
 *
 * The problem it solves: `generateReel` returns a `runId` and the component polls it for
 * up to five minutes (150 × 2s). All of that lived in component state, and the poll's
 * unmount guard reads `if (!mountedRef.current) return; // stop silently`. So navigating
 * away abandoned the run — it completed server-side and the user was **never told**, with
 * nothing to come back to. Silence about something the system knows happened.
 *
 * Why client-side and not a server read: a `CreativeRender` only exists once the render is
 * COMPLETE (it is keyed by `mediaAssetId` + `compositeHash`), so there is no server-side
 * representation of an in-flight reel to list. The only durable handle is the run id, and
 * persisting that is the cheap half of the fix. A proper pending-render row would be a
 * backend change and is not attempted here.
 *
 * Scope, stated rather than hidden: `sessionStorage` is per-tab and per-origin. A reel
 * started in one tab is not resumable in another, and closing the tab still loses the
 * handle. That is a real limit — but it strictly improves on losing the run on every
 * in-app navigation, which is the common case.
 *
 * R2 CRB-SP-12 — the store is keyed PER BRIEF. The original was one global slot, so
 * starting a reel on brief B while brief A's was pending silently discarded A's handle —
 * A's outcome was never reported, which is the precise defect REEL-2 exists to fix,
 * reintroduced for the two-concurrent-reels case.
 */

const KEY_PREFIX = 'openwop:creative-briefs:pending-reel:';

export interface PendingReel {
  briefId: string;
  runId: string;
  /** ms epoch. Used to age out a handle whose run can no longer be meaningfully polled. */
  startedAt: number;
}

/**
 * A handle older than this is dropped rather than resumed. The poll itself caps at ~5
 * minutes; anything past double that is a run whose outcome we can no longer report
 * honestly (the server may have pruned it, or it failed while we were away). Dropping it
 * is the honest move — resuming would show a pending placeholder that can never resolve,
 * which is the "permanent spinner" defect this codebase keeps removing.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

function read(briefId: string): PendingReel | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + briefId);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingReel>;
    if (typeof p.briefId !== 'string' || typeof p.runId !== 'string' || typeof p.startedAt !== 'number') return null;
    return { briefId: p.briefId, runId: p.runId, startedAt: p.startedAt };
  } catch {
    // A malformed or unavailable store must not break the page. Returning null degrades to
    // the previous behaviour (no resume), never to a crash or a false pending state.
    return null;
  }
}

/** The pending reel for THIS brief, if it is still fresh enough to resolve honestly. */
export function getPendingReel(briefId: string): PendingReel | null {
  const p = read(briefId);
  if (!p || p.briefId !== briefId) return null;
  if (Date.now() - p.startedAt > MAX_AGE_MS) { clearPendingReel(briefId); return null; }
  return p;
}

export function setPendingReel(briefId: string, runId: string): void {
  try {
    sessionStorage.setItem(KEY_PREFIX + briefId, JSON.stringify({ briefId, runId, startedAt: Date.now() } satisfies PendingReel));
  } catch {
    // Storage full or blocked (private mode). The generate still proceeds and the in-tab
    // poll still works — only the resume-after-navigation is lost. Failing loudly here
    // would be worse than the degradation.
  }
}

export function clearPendingReel(briefId: string): void {
  try { sessionStorage.removeItem(KEY_PREFIX + briefId); } catch { /* see setPendingReel */ }
}
