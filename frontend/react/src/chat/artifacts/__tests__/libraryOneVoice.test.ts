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
 *
 * Ids: DS-8 (one region, one voice — `toast.tsx:80`), UX-LIB-1 (the failed-read
 * card), the ADR 0363 announce contract Notice + StateCard delegate to. The first
 * four cases pin the predicate; the two PAGE cases pin the wiring (that the Notice
 * actually consults it and the card actually announces) — grade-tests w45 found the
 * predicate-only version could not see either wire cut.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ArtifactProjection } from '../artifactClient.js';

// Every announce() caller on the page (Notice + StateCard) goes through this one
// module; spying on it observes exactly which surface spoke, and how often.
const announceSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/announce.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../ui/announce.js')>()),
  announce: announceSpy,
}));
vi.mock('../artifactClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../artifactClient.js')>()),
  listArtifacts: vi.fn(),
}));

import { listArtifacts } from '../artifactClient.js';
import { LibraryPage, noticeCarriesTheVoice } from '../LibraryPage.js';

const mockList = vi.mocked(listArtifacts);
const ROW: ArtifactProjection = {
  artifactId: 'run-event:r:a', tenantId: 't', orgId: 'org', source: 'run-event', sourceId: 'r:a', title: 'First',
  kind: 'markdown', format: 'text/markdown', status: 'final', createdBy: { kind: 'run', id: 'run1' },
  createdAt: '2026-06-20T00:00:00.000Z', provenance: { runId: 'run1' },
};
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const view = (): void => { render(createElement(MemoryRouter, null, createElement(LibraryPage))); };

beforeEach(() => { announceSpy.mockReset(); mockList.mockReset(); });
afterEach(cleanup);

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

describe('LibraryPage — one voice per failure, on the mounted page', () => {
  it('PAGE: a failed FIRST load speaks once, through the card (polite), never the Notice', async () => {
    mockList.mockRejectedValueOnce(new Error('artifacts_500'));
    view();
    expect(await screen.findByText("Couldn't load your library")).toBeTruthy();
    expect(screen.getByText('Could not load the library. Please try again.')).toBeTruthy(); // the Notice IS shown
    await waitFor(() => expect(announceSpy).toHaveBeenCalled());
    await drain();
    // Flush passive effects: "exactly one voice" must not pass before a late second announce() lands.
    await act(async () => {});
    expect(announceSpy.mock.calls).toEqual([["Couldn't load your library"]]);
  });

  it('PAGE: a failed LOAD MORE with rows on screen speaks once, through the Notice', async () => {
    mockList
      .mockResolvedValueOnce({ artifacts: [ROW], nextCursor: 'c1' })
      .mockRejectedValueOnce(new Error('artifacts_500'));
    view();
    expect(await screen.findByText('First')).toBeTruthy();
    await drain();
    await act(async () => {});
    expect(announceSpy).not.toHaveBeenCalled(); // a healthy load is silent
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Could not load the library. Please try again.')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your library")).toBeNull(); // rows on screen: no card
    await waitFor(() => expect(announceSpy).toHaveBeenCalled());
    await drain();
    await act(async () => {});
    expect(announceSpy.mock.calls).toEqual([['Could not load the library. Please try again.', { assertive: false }]]);
  });
});
