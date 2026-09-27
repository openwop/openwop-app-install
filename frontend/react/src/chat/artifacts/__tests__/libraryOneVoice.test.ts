/**
 * ONE VOICE PER FAILURE — `chat/artifacts/LibraryPage`.
 *
 * Found by openwop-app-2 in the intersection of two sweeps: the warning Notice
 * (Notice-announce tranche) and the empty-state StateCard (failure-card announce
 * sweep) were both gated on the same `error` and both called `announce()`. Two
 * callers of ONE polite region for ONE event race; the later render wins, so a
 * screen-reader user hears whichever landed last and can lose the other.
 *
 * Neither sweep could see it alone — one could not see which cards already had a
 * voice, the other could not see Notices that did not announce yet. It existed only
 * in the overlap.
 *
 * The naive fix is wrong. "When both are present the CARD announces" is the house
 * rule, but the card renders only on `loaded && rowCount === 0`. With rows on screen
 * and a refresh failure the card never mounts, so deferring unconditionally would
 * trade the race for SILENCE. These cases pin BOTH directions, because a fix that
 * only prevents the double-announce would pass a test that only checked for one.
 */
import { describe, it, expect } from 'vitest';
import { noticeCarriesTheVoice } from '../LibraryPage.js';

describe('LibraryPage — exactly one voice per failure', () => {
  it('DEFERS to the card when the card will render (loaded + empty)', () => {
    // The card mounts with `announce={!!error}`, so the Notice must stay silent or the
    // two race for the polite slot.
    expect(noticeCarriesTheVoice(true, 0)).toBe(false);
  });

  it('SPEAKS when rows are on screen — the card does not render, so silence is the risk', () => {
    // A refresh/"load more" failure with existing rows. The empty-state card is not in
    // the tree at all; if the Notice also stayed quiet the failure would be inaudible.
    expect(noticeCarriesTheVoice(true, 1)).toBe(true);
    expect(noticeCarriesTheVoice(true, 42)).toBe(true);
  });

  it('SPEAKS before the first load resolves — the loading card carries no announce', () => {
    // `!loaded` renders `<StateCard title={libraryLoading} loading />`, which has no
    // `announce` prop, so an error arriving in that window has no other voice.
    expect(noticeCarriesTheVoice(false, 0)).toBe(true);
    expect(noticeCarriesTheVoice(false, 5)).toBe(true);
  });

  it('is exhaustive over the card render condition — never both, never neither', () => {
    // The invariant, stated as one assertion over the whole input space that matters:
    // the Notice speaks IF AND ONLY IF the announcing card is absent.
    for (const loaded of [true, false]) {
      for (const rowCount of [0, 1, 7]) {
        const cardAnnounces = loaded && rowCount === 0;
        const noticeAnnounces = noticeCarriesTheVoice(loaded, rowCount);
        expect(noticeAnnounces).toBe(!cardAnnounces); // exactly one, always
      }
    }
  });
});
