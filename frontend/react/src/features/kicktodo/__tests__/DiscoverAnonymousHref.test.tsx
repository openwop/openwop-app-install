/**
 * Measured on production 2026-09-15 (kicktodo-2, headless Chromium, `00027-drb`):
 * every Discover card rendered from the PUBLIC catalog linked to
 * `/discover/undefined`. The anonymous wire names the id `challengeId`
 * (`PublicChallenge`, publicCatalogService.ts); the card model names it `id`; a
 * bare cast in `publicChallengeCatalog()` hid the mismatch from tsc.
 *
 * This test drives the REAL client through a mocked `fetch` with a
 * public-shaped body, renders the anonymous Discover branch, and asserts the
 * card hrefs carry the challenge id — the exact thing the API-level validation
 * pass could never see.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false }) }));

const PUBLIC_BODY = {
  orgId: 'host-kicktodo',
  locale: 'en',
  challenges: [
    { challengeId: 'chal:demo-kicktodo-deep-work', version: 1, title: 'Deep Work', summary: 's', outcome: 'o', durationDays: 30, servedLocale: 'en', exactLocale: true, activities: [], depthLevel: 'intermediate' },
    { challengeId: 'chal:demo-kicktodo-sleep-reset', version: 1, title: 'Sleep Reset', summary: 's', outcome: 'o', durationDays: 21, servedLocale: 'en', exactLocale: true, activities: [] },
  ],
};

import { publicChallengeToSummary, type PublicChallengeWire } from '../../../client/kicktodoClient.js';
import { DiscoverPage } from '../DiscoverPage.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('anonymous Discover — public catalog ids reach the card links', () => {
  it('publicChallengeToSummary maps the wire id to the card id and pins published', () => {
    const wire = PUBLIC_BODY.challenges[0] as PublicChallengeWire;
    const summary = publicChallengeToSummary(wire);
    expect(summary.id).toBe('chal:demo-kicktodo-deep-work');
    expect(summary.status).toBe('published');
    expect(summary.depthLevel).toBe('intermediate');
    expect(summary.activities).toEqual([]);
  });

  it('through the real client on a mocked fetch: no card links to /discover/undefined', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/public/host-kicktodo/challenges')) {
        return new Response(JSON.stringify(PUBLIC_BODY), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><DiscoverPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Deep Work')).toBeTruthy());
    expect(screen.getByRole('heading', { level: 1, name: 'Discover' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: /What do you want to change/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Challenge language' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Deep Work/ })).toBeTruthy();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href')).filter((h): h is string => !!h && h.startsWith('/discover/'));
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    expect(hrefs.some((h) => h.includes('undefined'))).toBe(false);
    expect(hrefs).toContain(`/discover/${encodeURIComponent('chal:demo-kicktodo-deep-work')}`);
    // Anonymous branch only: the authenticated catalog and enrolments were never requested.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/kicktodo/enrollments'))).toBe(false);
    expect(calls.some((u) => u.includes('/kicktodo/catalog'))).toBe(false);
  });
});
