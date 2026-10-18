/**
 * ADR 0363 P4 — the global screen-reader announcer. What breaks if this fails:
 *   - a repeat of the SAME message stops changing string identity, so the live
 *     region never mutates and the screen reader stays silent on the second
 *     press (the MAJOR bug the alternating marker fixes — toggle, not append);
 *   - an assertive message also lands in (or replaces) the polite slot, which
 *     double-announces it or drops the polite message.
 * The slots are module-level state, so every case starts from a reset.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { announce, currentAnnouncements } from '../announce.js';

const MARK = '​';

beforeEach(() => {
  announce('');
  announce('', { assertive: true });
});

describe('announce (ADR 0363 P4)', () => {
  it('changes identity on EVERY repeat of the same message (the marker toggles, not one-shot)', () => {
    announce('Assistant replied');
    const a = currentAnnouncements().polite;
    announce('Assistant replied');
    const b = currentAnnouncements().polite;
    announce('Assistant replied');
    const c = currentAnnouncements().polite;
    announce('Assistant replied');
    const d = currentAnnouncements().polite;
    // Each consecutive identical announcement must differ from the one before it,
    // or the screen reader stops re-reading (the MAJOR bug this guards).
    expect(b).not.toBe(a);
    expect(c).not.toBe(b);
    expect(d).not.toBe(c);
    // The exact alternation: the marker toggles on and off.
    expect(a).toBe('Assistant replied');
    expect(b).toBe(`Assistant replied${MARK}`);
    expect(c).toBe('Assistant replied');
    expect(d).toBe(`Assistant replied${MARK}`);
  });

  it('routes assertive separately from polite', () => {
    announce('Calm');
    announce('Boom', { assertive: true });
    expect(currentAnnouncements().assertive).toBe('Boom');
    // The polite slot is untouched by an assertive message (no double announce).
    expect(currentAnnouncements().polite).toBe('Calm');
  });
});
