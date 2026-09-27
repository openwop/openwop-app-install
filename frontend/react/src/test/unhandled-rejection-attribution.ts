/**
 * Attribute an UNHANDLED REJECTION to the test that was running when it landed —
 * without letting the run stop failing.
 *
 * THE PROBLEM, measured 2026-08-08. `npm run ci` — the declared merge gate — was
 * red on `main` while the report said this:
 *
 *     Test Files  586 passed (586)
 *     Tests       3794 passed (3794)
 *     Errors      1 error            ← exit 1
 *
 * Every test green, the run failed. Vitest names the FILE the rejection came
 * from, but nothing names the TEST, and the counts flatly disagree with the exit
 * code. A reader who trusts the counts concludes "flake" and re-runs; a reader
 * who trusts the exit code cannot tell what to fix. Both train the same habit —
 * merge through it — which is how a permanently red gate happens.
 *
 * The rejections were real: `void fn().then(setX)` continuations landing after
 * their component unmounted, where jsdom has torn down `window`, so React's
 * `getCurrentEventPriority` throws `ReferenceError: window is not defined`. Two
 * were found by hand (`tutorials/TutorialsPage`, `kicktodo/GuidePage`), and
 * finding the second cost a whole extra gate cycle purely because the report did
 * not say which test was running.
 *
 * THE TRAP THIS MODULE FELL INTO FIRST, kept because it is the reason the last
 * line of the handler exists. Node suppresses its DEFAULT unhandled-rejection
 * behaviour as soon as ANY listener is installed — and vitest's detection goes
 * with it. Measured on a deliberately-leaking probe:
 *
 *     no listener   → exit 1, "Unhandled Errors", `Errors 1`
 *     listener only → exit 0, no Errors block            ← silently gate-disabling
 *
 * So an attribution-only handler would have deleted the gate's ability to see
 * this entire class, which is strictly worse than the confusing red it was
 * written to fix. It was caught by probing the EXIT CODE, not by reading the
 * diff. The handler therefore re-asserts the failure itself and prints the full
 * stack, since vitest's block — the part that named the source file — no longer
 * renders.
 *
 * It does NOT use `dangerouslyIgnoreUnhandledErrors`: that hides the signal by
 * design. The run must still fail; it should just say what to look at.
 *
 * Registered once per worker from `i18n-setup.ts` (already in `setupFiles`).
 */
import { expect } from 'vitest';

/** Vitest exposes the running test through `expect.getState()`. Typed loosely on
 *  purpose: this is diagnostics, and a shape change must not itself fail a run. */
function currentTestName(): string {
  try {
    const s = expect.getState() as { currentTestName?: string };
    return s?.currentTestName ?? '(no test running — the rejection landed between tests)';
  } catch {
    return '(test name unavailable)';
  }
}

let installed = false;

export function installUnhandledRejectionAttribution(): void {
  if (installed) return; // setupFiles runs per FILE; the handler is per PROCESS
  installed = true;

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(
      `\n[33m⚠ unhandled rejection during: ${currentTestName()}[0m\n`
      + `  ${err.stack ?? `${err.name}: ${err.message}`}\n`
      + '  This FAILS the run even though every test may report passing.\n'
      + '  Most common cause here: a fire-and-forget `void fn().then(setX)` whose\n'
      + '  continuation lands after the component unmounted — jsdom has torn down\n'
      + '  `window` by then, so React throws. Guard it with a mounted ref that is\n'
      + '  RE-ARMED inside the effect (StrictMode remounts), as in\n'
      + '  `memory/MemoryBrowser.tsx`.\n',
    );
    // PRESERVE THE FAILURE — see the trap in the module docstring. Installing the
    // listener silences vitest's own detection, and `process.exitCode = 1` does
    // NOT survive: the worker is forked and the MAIN process owns the exit code
    // (measured — the leaking probe still exited 0). Re-raising OUT of the
    // handler turns it into an uncaught exception, which vitest does report and
    // does fail on.
    setTimeout(() => { throw err; });
  });
}
