/**
 * ADR 0692 — Discover's "Recommended for you": signed-in only, each row states
 * its reason verbatim, hidden when there is nothing to recommend, and never
 * shown to an anonymous visitor (the public catalog has no participant).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = { user: { uid: 'u1' } as { uid: string } | null, reco: [
  { id: 'chal:b', version: 1, title: 'Deep Work', depthLevel: 'intermediate', reason: 'next-depth' },
  { id: 'chal:c', version: 1, title: 'Focus Sprint', depthLevel: 'intermediate', reason: 'same-depth' },
] };

const catalog = [
  { id: 'chal:a', version: 1, status: 'published', title: 'Sleep Reset', summary: 's', outcome: 'o', durationDays: 7, activities: [] },
];

vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: state.user, loading: false }) }));
vi.mock('../../../client/kicktodoClient.js', () => ({
  PUBLIC_CATALOG_ORG: 'host-kicktodo',
  publicChallengeCatalog: vi.fn(async () => catalog),
  listChallengesForLocale: vi.fn(async () => catalog.map((c) => ({ challenge: c, servedLocale: 'en', requestedLocale: 'en' }))),
  listEnrollments: vi.fn(async () => []),
  recommendedChallenges: vi.fn(async () => state.reco),
  getChallengePrice: vi.fn(async () => null),
}));

import { DiscoverPage } from '../DiscoverPage.js';
import { recommendedChallenges } from '../../../client/kicktodoClient.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => { cleanup(); state.user = { uid: 'u1' }; });
const view = () => render(<MemoryRouter><DiscoverPage /></MemoryRouter>);

describe('Discover — recommended for you (ADR 0692)', () => {
  it('signed in: renders the section with each reason stated verbatim', async () => {
    view();
    await waitFor(() => expect(screen.getByText(en.discoverRecommendedHeading)).toBeTruthy());
    expect(screen.getByText('Deep Work')).toBeTruthy();
    expect(screen.getByText(en.discoverReasonNextDepth)).toBeTruthy();
    expect(screen.getByText(en.discoverReasonSameDepth)).toBeTruthy();
  });

  it('anonymous: the section never renders and the read is never made', async () => {
    state.user = null;
    vi.mocked(recommendedChallenges).mockClear();
    view();
    await waitFor(() => expect(screen.getByText('Sleep Reset')).toBeTruthy());
    expect(screen.queryByText(en.discoverRecommendedHeading)).toBeNull();
    expect(vi.mocked(recommendedChallenges)).not.toHaveBeenCalled();
  });

  it('nothing to recommend: no section, no empty placeholder', async () => {
    vi.mocked(recommendedChallenges).mockResolvedValueOnce([]);
    view();
    await waitFor(() => expect(screen.getByText('Sleep Reset')).toBeTruthy());
    expect(screen.queryByText(en.discoverRecommendedHeading)).toBeNull();
  });
});
