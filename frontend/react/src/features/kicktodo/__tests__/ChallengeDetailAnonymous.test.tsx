/**
 * ADR 0684 phase 4 — the third link of the signed-out funnel, measured on
 * production 2026-09-16 (`bc51bbc`): after #3850 fixed the card ids and the
 * route param, a stranger who clicked a card still saw "Challenge not found",
 * because the detail page read through the tenant-scoped catalog and nothing
 * public backed it. Each defect was invisible until the one before it was fixed.
 *
 * Drives the REAL client through a mocked `fetch` with a public-shaped body and
 * asserts, signed out: the commitment preview renders from the public list, the
 * enrol CTA is replaced by the sign-in prompt, NOTHING tenant-scoped is
 * requested, and an unknown id is still honestly "not found". Signed in, the
 * page is unchanged (the existing suites cover that path).
 *
 * Sabotage: remove the `anonymous` branch from the load effect and the first
 * case reds on "Challenge not found" — the production symptom, reproduced.
 *
 * 2026-09-16 correction. The first fixture here carried `stableActivityId`,
 * `evidencePolicy` and `depthLevel` — fields the public wire NEVER sent — so
 * the test was green while production (`302a534`) showed a stranger "just
 * check in" for a challenge whose signed-in page said "note", under a sentence
 * promising the preview was exactly what they would commit to. The fixtures
 * below are shaped as `publicCatalogService.project` emits: the corrected wire
 * (evidence + depth carried) and the OLD wire (neither), which the page must
 * render as "shown after sign-in", never as the weakest policy.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false, isConfigured: true }) }));
vi.mock('../../../auth/SignInButton.js', () => ({ SignInButton: () => <button type="button">Sign in to KickTodo</button> }));

/** The corrected wire — exactly what `publicCatalogService.project` emits. */
const PUBLIC_BODY = {
  orgId: 'host-kicktodo',
  locale: 'en',
  challenges: [
    {
      challengeId: 'chal:demo-kicktodo-deep-work', version: 1, title: 'Deep Work', summary: 'Two focused hours a day.',
      outcome: 'A repeatable deep-work block.', durationDays: 30, servedLocale: 'en', exactLocale: true, depthLevel: 'intermediate',
      activities: [
        { day: 1, title: 'Block the calendar', instructions: 'i', estimatedMinutes: 20, evidencePolicy: 'note' },
        { day: 2, title: 'Block the calendar', instructions: 'i', estimatedMinutes: 20, evidencePolicy: 'note' },
      ],
    },
  ],
} satisfies PublicCatalogBody;

/** The wire BEFORE the correction (a backend older than this change): no
 *  evidence policy, no depth. This is what production served at `302a534`. */
const OLD_PUBLIC_BODY = {
  ...PUBLIC_BODY,
  challenges: PUBLIC_BODY.challenges.map(({ depthLevel: _d, ...c }) => ({
    ...c,
    activities: c.activities.map(({ evidencePolicy: _e, ...a }) => a),
  })),
} satisfies PublicCatalogBody;

import { ChallengeDetailPage } from '../ChallengeDetailPage.js';
import { messages as en } from '../i18n/en.js';
import type { PublicChallengeWire } from '../../../client/kicktodoClient.js';

/** The public list body, as the wire types it. `satisfies` (not a cast) keeps
 *  excess-property checking ON, so a fixture cannot carry a field the wire never
 *  sends — the 2026-09-16 failure mode above, made a compile error. Sabotage:
 *  add `stableActivityId` to an activity below and `tsc --noEmit` reds. */
type PublicCatalogBody = { orgId: string; locale: string; challenges: PublicChallengeWire[] };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(entry: string, body: unknown = PUBLIC_BODY): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/public/host-kicktodo/challenges')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/discover/:challengeId" element={<ChallengeDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  return fetchMock;
}

describe('signed-out challenge detail — the acquisition preview (ADR 0684 phase 4)', () => {
  it('renders the commitment preview from the public list and a sign-in prompt where the enrol CTA would be', async () => {
    const fetchMock = mount(`/discover/${encodeURIComponent('chal:demo-kicktodo-deep-work')}`);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Deep Work' })).toBeTruthy());
    expect(screen.getByText('A repeatable deep-work block.')).toBeTruthy();
    expect(screen.getAllByText('Block the calendar').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { name: en.challengeFirstWeekHeading })).toBeTruthy();
    const fullPlan = screen.getByText('View the full 30-day plan');
    fireEvent.click(fullPlan);
    expect(screen.getByText('Days 1–7')).toBeTruthy();
    // The prompt, not a dead button; and no "not found".
    expect(screen.getAllByText(en.signInToStart).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Sign in to KickTodo' })).toBeTruthy();
    expect(screen.queryByText(en.challengeNotFoundTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(en.previewAndStart) })).toBeNull();
    // Nothing tenant-scoped was asked for on behalf of a stranger.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/kicktodo/catalog'))).toBe(false);
    expect(calls.some((u) => u.includes('/kicktodo/enrollments'))).toBe(false);
    expect(calls.some((u) => u.includes('/entitlements/'))).toBe(false);
  });

  it('shows the SAME evidence requirement and depth as the signed-in page — never "just check in" by default', async () => {
    mount(`/discover/${encodeURIComponent('chal:demo-kicktodo-deep-work')}`);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Deep Work' })).toBeTruthy());
    // The evidence rail names the real policy, and the depth chip is present.
    expect(screen.getByText(en.evidenceNoteLabel)).toBeTruthy();
    expect(screen.queryByText(en.evidenceAttestationLabel)).toBeNull();
    expect(screen.queryByText(en.evidencePendingLabel)).toBeNull();
    expect(screen.getByText(en.depth_intermediate)).toBeTruthy();
  });

  it('a public list that predates the evidence field reads "shown after sign-in", not the weakest policy', async () => {
    mount(`/discover/${encodeURIComponent('chal:demo-kicktodo-deep-work')}`, OLD_PUBLIC_BODY);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Deep Work' })).toBeTruthy());
    expect(screen.getByText(en.evidencePendingLabel)).toBeTruthy();
    expect(screen.queryByText(en.evidenceAttestationLabel)).toBeNull();
    expect(screen.queryByText(en.evidenceNoteLabel)).toBeNull();
    expect(screen.queryByText(en.depth_intermediate)).toBeNull();
  });

  it('an id the public catalog does not carry is still honestly "not found"', async () => {
    mount(`/discover/${encodeURIComponent('chal:does-not-exist')}`);
    await waitFor(() => expect(screen.getByText(en.challengeNotFoundTitle)).toBeTruthy());
    expect(screen.queryByText(en.signInToStart)).toBeNull();
  });
});
