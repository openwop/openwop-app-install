/**
 * ADR 0363 P4 — the consolidated screen-reader announcer. A module-level pub/sub
 * + ONE host (`GlobalLiveRegion`) mounted once at the app shell — the exact
 * `ui/toast.tsx` / `ui/confirm.tsx` pattern. Callers fire an imperative
 * `announce(msg)`; only the host subscribes (no re-render storms).
 *
 * BOUNDARY (do not become a 4th region): this is for INVISIBLE status where the
 * visible state lives elsewhere — a chat stream settling, a voice phase, a canvas
 * join. `toast` (every variant, PROF-UX-20) and a `Notice` given `announce=`
 * speak THROUGH this host and carry NO live role of their own; a `Notice` without
 * `announce=` keeps its inline `role=status/alert`. Never both for one message —
 * that is the DS-8 double-announce. Use `toast` for transient visible feedback,
 * `Notice` for inline status, `announce` for sr-only.
 *
 * Existing per-surface announcers migrate onto this incrementally (MessageFeed is
 * the reference adopter); nothing is ripped out in one shot.
 */
import { useCallback, useState, useSyncExternalStore } from 'react';

let politeMsg = '';
let assertiveMsg = '';
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

const MARK = '​'; // zero-width space — invisible, but changes string identity

/**
 * Make a repeat of the SAME message a DISTINCT string, so assistive tech
 * re-reads it.
 *
 * A live region only speaks on mutation. Every announcer that stores its
 * message in React state therefore goes silent on a repeat — `Object.is`-equal
 * state bails before the DOM is touched. That is wrong for any message a user
 * can legitimately trigger twice in a row ("no node in that direction", "all N
 * selected"): the second press says nothing, and silence reads as "nothing to
 * report".
 *
 * Alternating an invisible trailing marker (on↔off) keeps the spoken text
 * identical while changing string identity. Exported so the canvas chassis
 * shares this one implementation rather than growing a second copy of MARK.
 */
export function withRepeatMark(prev: string, next: string): string {
  const prevBase = prev.endsWith(MARK) ? prev.slice(0, -1) : prev;
  if (!next || next !== prevBase) return next;
  return prev.endsWith(MARK) ? next : next + MARK;
}

/**
 * A SURFACE-OWNED polite region whose repeats stay audible (`ANN-UX-2`).
 *
 * MEASURED — and got wrong three times before this. "~44", then "25", then
 * "58", each caught by review. Two distinct mistakes worth remembering: a file
 * containing BOTH `aria-live` and `useState('')` does not mean they are the
 * same variable; and a raw grep counts occurrences inside COMMENTS.
 *
 * The authoritative numbers are the gate's (`scripts/check-live-regions.mjs`,
 * which strips comments), not a grep's:
 *
 *     53 polite `aria-live` render sites outside tests
 *      7 of them variable-backed
 *      5 of those render a state variable a setter writes  <- the shape below
 *      4 of those have >1 call site, i.e. can actually repeat
 *
 * The other 46 render derived text or a constant, where the repeat bug cannot
 * bite because the value changes anyway. If you need this number, run the gate.
 *
 * Those 5 render their message as a bare text child of a `useState` string.
 * Setting the SAME string is a no-op end to end — React bails on
 * `Object.is`-equal state, and even on a render the reconciler skips an equal
 * text update — so the DOM never mutates and a live region only speaks on
 * mutation. The second identical message says nothing, which is exactly when a
 * user repeats an action to check whether it worked.
 *
 * This shares `withRepeatMark` with the global announcer rather than growing a
 * second copy of MARK. Returns `[text, set]`; render `text` into your own
 * `role=status aria-live=polite` node.
 *
 * `collapseRepeats` opts OUT for AMBIENT churn the user did not cause (a
 * flapping peer connection). A polite region QUEUES, so re-announcing noise
 * backs the queue up behind it. Repeats re-announce for user verbs, collapse
 * for ambient events.
 *
 * Contract pinned by `__tests__/useLiveRegion.test.tsx` against a real
 * MutationObserver — "the DOM changed" is the actual precondition for speech.
 */
export function useLiveRegion(): [string, (message: string, opts?: { collapseRepeats?: boolean }) => void] {
  const [text, setText] = useState('');
  const set = useCallback((message: string, { collapseRepeats = false }: { collapseRepeats?: boolean } = {}): void => {
    setText((prev) => (collapseRepeats ? message : withRepeatMark(prev, message)));
  }, []);
  return [text, set];
}

/** Announce `message` to assistive tech. `assertive` interrupts (errors/alerts);
 *  the default polite queue waits for a pause. Re-announcing the SAME string
 *  ALTERNATES an invisible trailing marker (on↔off) so every repeat is a distinct
 *  value and the screen reader re-reads it (not a one-shot append). */
export function announce(message: string, { assertive = false }: { assertive?: boolean } = {}): void {
  const prev = assertive ? assertiveMsg : politeMsg;
  const next = withRepeatMark(prev, message);
  if (assertive) assertiveMsg = next;
  else politeMsg = next;
  emit();
}

/** Hook form for components that prefer it — returns the stable `announce`. */
export function useAnnouncer(): typeof announce {
  return announce;
}

/** The current live-region values (observability seam — used by tests to assert
 *  that repeated identical announcements still change identity). */
export function currentAnnouncements(): { polite: string; assertive: string } {
  return { polite: politeMsg, assertive: assertiveMsg };
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The single mounted live-region pair. Mount once at the shell (App.tsx). */
export function GlobalLiveRegion(): JSX.Element {
  const polite = useSyncExternalStore(subscribe, () => politeMsg, () => '');
  const assertive = useSyncExternalStore(subscribe, () => assertiveMsg, () => '');
  return (
    <>
      {/* `data-owp-live` is a TEST HOOK, and it earns its place: the app has ~53
          `aria-live` nodes, so a spec selecting `[aria-live="polite"]` picks an
          arbitrary one and passes whatever the shell does. Targeting these two
          by name is what lets the e2e spec fail when the shell region is removed. */}
      <div className="sr-only" data-owp-live="polite" role="status" aria-live="polite" aria-atomic="true">{polite}</div>
      <div className="sr-only" data-owp-live="assertive" role="alert" aria-live="assertive" aria-atomic="true">{assertive}</div>
    </>
  );
}
