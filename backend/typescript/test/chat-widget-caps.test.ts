/**
 * ADR 0127 Phase 2c — public-widget abuse caps.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkWidgetTurn } from '../src/features/chat-widget/capsTracker.js';
import type { WidgetConfig } from '../src/features/chat-widget/widgetService.js';

function widget(id: string, caps: WidgetConfig['caps']): WidgetConfig {
  return { widgetId: id, tenantId: 't', orgId: 'o', agentId: 'a', allowedDomains: ['x.com'], caps, token: 'wgt_x', enabled: true, createdBy: 'u', createdAt: 'x', updatedAt: 'x' };
}

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('checkWidgetTurn', () => {
  it('enforces the per-session turn cap', async () => {
    const w = widget('w1', { maxTurnsPerSession: 2 });
    expect((await checkWidgetTurn(w, 's1', '2026-06-24')).allowed).toBe(true);  // turn 1
    expect((await checkWidgetTurn(w, 's1', '2026-06-24')).allowed).toBe(true);  // turn 2
    const third = await checkWidgetTurn(w, 's1', '2026-06-24');
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('turn_cap');
  });

  it('enforces the per-day new-session cap', async () => {
    const w = widget('w2', { maxSessionsPerDay: 1, maxTurnsPerSession: 5 });
    expect((await checkWidgetTurn(w, 'sA', '2026-06-24')).allowed).toBe(true);  // session A (new)
    const sB = await checkWidgetTurn(w, 'sB', '2026-06-24');                    // session B (new) → over cap
    expect(sB.allowed).toBe(false);
    expect(sB.reason).toBe('session_cap');
    // a NEW day resets the session cap
    expect((await checkWidgetTurn(w, 'sC', '2026-06-25')).allowed).toBe(true);
  });

  it('ADR 0707 — an UNSET cap is BOUNDED by the secure default, not uncapped', async () => {
    // THIS TEST USED TO PIN THE DEFECT. It was called "uncapped widget always allows"
    // and asserted 20 consecutive turns on `caps: {}` — encoding `?? Infinity`, i.e.
    // that absence is a grant, on an internet-reachable operator-BILLED surface.
    //
    // Two notes on why it had to be rewritten rather than left alone:
    //  - It would have KEPT PASSING by coincidence: the new default is 20 turns and the
    //    loop did exactly 20, so a green run would have said nothing either way.
    //  - Its NAME would then have been false, which is how the next reader inherits the
    //    wrong model (the ADR 0470 P3 finding next door had already ruled that a public
    //    bound must not be operator-optional).
    const w = widget('w3', {});
    for (let i = 0; i < 20; i++) {
      expect((await checkWidgetTurn(w, 's', '2026-06-24')).allowed, `turn ${i + 1} is within the default`).toBe(true);
    }
    const overflow = await checkWidgetTurn(w, 's', '2026-06-24'); // the 21st
    expect(overflow.allowed, 'an unset cap is bounded by the secure default').toBe(false);
    expect(overflow.reason).toBe('turn_cap');
  });

  it('ADR 0707 — an EXPLICIT Infinity is still a genuine opt-out (unset !== unbounded)', async () => {
    // The distinction is the whole point, and it is copied from `checkAnonWrite`: an
    // operator MAY choose unbounded, but they must SAY so. Absence is not consent.
    const w = widget('w3-explicit', { maxTurnsPerSession: Infinity, maxSessionsPerDay: Infinity });
    for (let i = 0; i < 25; i++) {
      expect((await checkWidgetTurn(w, 's', '2026-06-24')).allowed, `turn ${i + 1} on an explicitly uncapped widget`).toBe(true);
    }
  });

  it('ADR 0707 — the per-DAY session default bounds a visitor rotating their session id', async () => {
    // `publicGateway.ts` states rotation is bounded by `maxSessionsPerDay` + the per-IP
    // limit. With the old `?? Infinity` that was true only of a CONFIGURED widget; this
    // pins it for the DEFAULT one, which is the configuration most widgets run.
    const w = widget('w3-rotate', {});
    let denied = 0;
    for (let i = 0; i < 205; i++) {
      const r = await checkWidgetTurn(w, `rotated-${i}`, '2026-06-26'); // a fresh session each time
      if (!r.allowed) { denied += 1; expect(r.reason).toBe('session_cap'); }
    }
    expect(denied, 'rotation runs into the per-day session default').toBeGreaterThan(0);
  });

  it('PUB-3: concurrent first-turns of the SAME session count ONE session (no double-count)', async () => {
    const w = widget('w4', { maxSessionsPerDay: 1, maxTurnsPerSession: 100 });
    // 5 concurrent first-turns of the same sessionId must NOT each increment the day count.
    const results = await Promise.all(Array.from({ length: 5 }, () => checkWidgetTurn(w, 'sameSession', '2026-06-24')));
    expect(results.every((r) => r.allowed)).toBe(true); // all same-session turns allowed (cap 100)
    // A DIFFERENT session is now over the per-day cap of 1 (the same session counted once).
    expect((await checkWidgetTurn(w, 'otherSession', '2026-06-24')).reason).toBe('session_cap');
  });

  it('PUB-3: concurrent turns of one session do not overshoot the turn cap', async () => {
    const w = widget('w5', { maxTurnsPerSession: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => checkWidgetTurn(w, 's', '2026-06-24')));
    expect(results.filter((r) => r.allowed).length).toBe(3); // exactly the cap, not more
  });
});
