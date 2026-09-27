import { describe, it, expect } from 'vitest';
import { announce, currentAnnouncements } from '../announce.js';

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
    // The visible text (marker stripped) is stable.
    for (const v of [a, b, c, d]) expect(v.replace(/​$/, '')).toBe('Assistant replied');
  });

  it('routes assertive separately from polite', () => {
    announce('Boom', { assertive: true });
    expect(currentAnnouncements().assertive.replace(/​$/, '')).toBe('Boom');
  });
});
