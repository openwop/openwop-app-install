/**
 * WALK-8 fixed the unhandled rejection and left the learner waiting.
 *
 * `guardedPerform` turned a non-benign step failure into `console.warn` and
 * nothing else: `status` stayed `running`, the interrupt stayed open, the overlay
 * kept highlighting the element. A step that will never advance, presented as a
 * step in progress — in the one surface whose entire job is telling someone what
 * to do next.
 *
 * This asserts the SOURCE contract rather than driving a live run: the player
 * needs a websocket-ish run stream, an interrupt, a registered action and a real
 * DOM target to reach `guardedPerform`, and a test that stubs all four proves
 * mostly that the stubs were wired. What is actually at stake is two facts about
 * the catch, and both are checkable directly.
 *
 * Named as a limitation rather than dressed up: this does not prove the learner
 * SEES the message, only that the state which renders it is set. The overlay's
 * `needs-update` rendering is covered by its own tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/walkthroughs/useWalkthroughPlayer.ts'), 'utf8');

/** The `guardedPerform` callback body. */
const guarded = (): string => {
  const i = SRC.indexOf('const guardedPerform');
  expect(i, 'guardedPerform is gone — this test is scanning nothing').toBeGreaterThan(-1);
  const end = SRC.indexOf('}, [performStep]', i);
  expect(end, 'guardedPerform no longer ends where expected').toBeGreaterThan(i);
  return SRC.slice(i, end);
};

describe('a failed walkthrough step tells the learner', () => {
  it('sets needs-update, not only a console warning', () => {
    const body = guarded();
    expect(body, 'the catch warns and says nothing to the user').toMatch(/setStatus\('needs-update'\)/);
    expect(body).toMatch(/setError\(/);
  });

  it('keeps the warning — it was there to stop an unhandled rejection', () => {
    // The fix ADDS to WALK-8 rather than replacing it. Dropping the warn would
    // lose the diagnostic that made this findable in the first place.
    expect(guarded()).toMatch(/console\.warn\('\[walkthroughs\] step perform failed'/);
  });

  it('stays silent when the run it belonged to is no longer in play', () => {
    // A step that fails because the learner stopped or navigated away must not
    // interrupt them. `performStep` has a local `live()`; this scope rebuilds the
    // same test by capturing the run id before the call.
    const body = guarded();
    expect(body).toMatch(/const startedFor = activeRef\.current\?\.runId/);
    expect(body).toMatch(/activeRef\.current\?\.runId !== startedFor\) return/);
  });

  it('is not vacuous — the file and the callback are really being read', () => {
    expect(SRC.length).toBeGreaterThan(5_000);
    expect(guarded().length).toBeGreaterThan(200);
    // And the sibling failure modes this fix mirrors still exist, so
    // `needs-update` remains the file's established way of saying "stuck".
    expect((SRC.match(/setStatus\('needs-update'\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
