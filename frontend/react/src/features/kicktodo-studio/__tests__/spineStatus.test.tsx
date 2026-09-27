/**
 * Provenance-spine honesty invariants (ADR 0437 UX-2.2). The spine must never
 * over-claim a candidate's lifecycle: a withdrawn candidate shows no green
 * publication, a submitted-not-completed publication is in-progress (not done),
 * and research counts as done only when a dossier actually exists.
 */
import { describe, it, expect } from 'vitest';
import { spineStatus } from '../CandidateWorkspacePage.js';

describe('spineStatus', () => {
  it('fresh intake: only intake done, research is current, later stages pending', () => {
    const s = spineStatus('intake', false, null);
    expect(s.intake).toBe('done');
    expect(s.research).toBe('current');
    expect(s.plan).toBe('pending');
    expect(s.publication).toBe('pending');
    expect(s.monitor).toBe('pending');
  });

  it('research counts as done the moment a dossier exists', () => {
    expect(spineStatus('intake', true, null).research).toBe('done');
    // …and reaching the `researched` state without a dossier still marks it done
    expect(spineStatus('researched', false, null).research).toBe('done');
    expect(spineStatus('researched', false, null).plan).toBe('current');
  });

  it('a submitted-but-not-completed publication is current, never done', () => {
    const s = spineStatus('planned', true, { state: 'submitted' });
    expect(s.publication).toBe('current');
  });

  it('a completed publication (or published state) is done, and monitoring opens', () => {
    expect(spineStatus('planned', true, { state: 'completed' }).publication).toBe('done');
    const published = spineStatus('published', true, { state: 'completed' });
    expect(published.publication).toBe('done');
    expect(published.monitor).toBe('current');
  });

  it('a withdrawn candidate never shows a green publication — it is blocked', () => {
    const s = spineStatus('withdrawn', true, null);
    expect(s.publication).toBe('blocked');
    expect(s.publication).not.toBe('done');
  });
});

// Screen-polish hardening: an UNKNOWN candidate state fails CLOSED like
// withdrawn — a future terminal state must never render a live spine.
import { it as it2, expect as expect2, describe as describe2 } from 'vitest';
describe2('spineStatus unknown-state honesty', () => {
  it2('unknown states render blocked, never in-progress', () => {
    const spine = spineStatus('some-future-state', false, null);
    expect2(spine.research).toBe('blocked');
    expect2(spine.plan).toBe('blocked');
    expect2(spine.publication).toBe('blocked');
  });
});

