/**
 * CS-4 + KTF-FE-1 (KickTodo UX-ASSESSMENT) — Studio overview failed reads.
 *
 *  - A failed studio load offers Retry (DESIGN.md §4.6), and the in-flight retry
 *    shows loading, never the first-candidate empty state.
 *  - A failed PUBLICATION read is not an absent one. `getPublication` returns
 *    null only for a 404 and throws otherwise; the row used to `.catch(() =>
 *    null)` it, so a 500 read exactly like "nothing submitted". It now says the
 *    status is unavailable and offers a retry of just those reads.
 *  - KTF-FE-1: there is no batched publication read on the creator routes, so the
 *    per-candidate fan-out is bounded to 4 reads in flight.
 *
 * Breaks it (sabotage-witnessed): restoring `.catch(() => null)` on the
 * publication read (the "unavailable" chip assertion goes red); dropping the
 * studio Retry button; replacing the bounded loop with `Promise.all` (the
 * in-flight peak goes to 10).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as StudioClient from '../../../client/kicktodoStudioClient.js';
import type { FactoryCandidate, PublicationState } from '../../../client/kicktodoStudioClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as commonEn } from '../../../i18n/locales/en/common.js';

const api = vi.hoisted(() => ({
  listCandidates: vi.fn<typeof StudioClient.listCandidates>(),
  getPublication: vi.fn<typeof StudioClient.getPublication>(),
  getNeedsYou: vi.fn<typeof StudioClient.getNeedsYou>(async () => []),
  getChallengeAuthor: vi.fn<typeof StudioClient.getChallengeAuthor>(async () => null),
}));
vi.mock('../../../client/kicktodoStudioClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoStudioClient.js')>()),
  ...api,
}));
vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({ EmbeddedChatPanel: () => null }));

import { StudioPage } from '../StudioPage.js';
import { StudioRequestError } from '../../../client/kicktodoStudioClient.js';

const cand = (id: string, topic: string): FactoryCandidate => ({
  id, topic, audience: 'desk workers', transformation: 'a habit', durationDaysTarget: 7,
  dailyMinutesTarget: 15, riskTier: 'low', riskSignals: [], state: 'planned', createdAt: '2026-10-01T00:00:00Z',
});
const SUBMITTED: PublicationState = { state: 'submitted', submittedBy: 'creator@example.com' };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const rowOf = (topic: string): HTMLElement => screen.getByRole('link', { name: topic }).closest('li') as HTMLElement;

describe('StudioPage — failed reads (CS-4 / KTF-FE-1)', () => {
  it('a failed studio load offers Retry; the retry shows loading, then the portfolio', async () => {
    let release: (v: FactoryCandidate[]) => void = () => {};
    api.listCandidates
      .mockRejectedValueOnce(new StudioRequestError(503))
      .mockImplementationOnce(() => new Promise<FactoryCandidate[]>((r) => { release = r; }));
    api.getPublication.mockResolvedValue(null);
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(en.loadError)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: commonEn.retry }));
    await waitFor(() => expect(screen.queryByText(en.loadError)).toBeNull());
    // Mid-retry the failed read is not re-presented as "no candidates yet".
    expect(screen.queryByText(en.emptyTitle)).toBeNull();

    release([cand('cand:1', 'Morning Walks')]);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Morning Walks' })).toBeTruthy());
  });

  it('a failed publication read says unavailable (not absent), and Retry re-reads only those', async () => {
    api.listCandidates.mockResolvedValue([cand('cand:1', 'Morning Walks'), cand('cand:2', 'Deep Reading')]);
    api.getPublication.mockImplementation(async (id: string) => {
      if (id === 'cand:1') throw new StudioRequestError(500);
      return null; // 404 → honestly nothing submitted
    });
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    await waitFor(() => expect(within(rowOf('Morning Walks')).getByText(en.publicationUnavailable)).toBeTruthy());
    // The 404 candidate is NOT reported as failed.
    expect(within(rowOf('Deep Reading')).queryByText(en.publicationUnavailable)).toBeNull();
    expect(screen.getByText('Couldn’t load the publication status of 1 candidate. That is not the same as it having none.')).toBeTruthy();
    const listCalls = api.listCandidates.mock.calls.length;

    api.getPublication.mockResolvedValue(SUBMITTED);
    fireEvent.click(screen.getByRole('button', { name: commonEn.retry }));
    await waitFor(() => expect(within(rowOf('Morning Walks')).queryByText(en.publicationUnavailable)).toBeNull());
    expect(within(rowOf('Morning Walks')).getByText(/^publication: /)).toBeTruthy();
    // Recovering the publication reads does not reload (and unmount) the page.
    expect(api.listCandidates.mock.calls.length).toBe(listCalls);
  });

  it('bounds the per-candidate publication fan-out to 4 reads in flight (no batch endpoint exists)', async () => {
    const many = Array.from({ length: 10 }, (_, i) => cand(`cand:${i}`, `Topic ${i}`));
    api.listCandidates.mockResolvedValue(many);
    let inFlight = 0;
    let peak = 0;
    api.getPublication.mockImplementation(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return null;
    });
    render(<MemoryRouter><StudioPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Topic 9' })).toBeTruthy());
    expect(api.getPublication).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });
});
