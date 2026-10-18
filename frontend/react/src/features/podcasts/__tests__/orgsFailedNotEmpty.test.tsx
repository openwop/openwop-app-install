/**
 * HG-4 — the Podcast Studio was one of the three surfaces still shipping the
 * FALSE CLAIM after the shared card landed everywhere else, and its variant was
 * the loudest of the family: `orgs` was NON-NULLABLE (`useState<Org[]>([])`), so
 * the zero-org branch was true FROM THE FIRST PAINT, before the read had even
 * been issued. Every visitor saw
 *
 *     "No workspace yet — create one to manage podcasts."
 *
 * for as long as `listOrgs` took, about a collection nobody had asked the server
 * for yet — and "workspace" is a DIFFERENT collection from the one it reads
 * (`listOrgs`). The picker three lines above it was labelled "Workspace".
 *
 * The page is now a `ui/useOrgSelection` + `ui/OrgSelectionState` adopter, so
 * `orgs` stays `null` until the server answers and the three states are the
 * shared ones. The assertions are the SHARED strings deliberately: a page that
 * re-grows its own copy, and a regression in the shared frame, both go red here.
 *
 * SP-9 (ADR 0603) — the studio's write affordances follow the `canWrite` the
 * episodes read reports (the same predicate the server's writes enforce); the
 * Shows panel reads its OWN capability (`listShowsWithCapability`) and is
 * mocked here so the file makes no live fetch (ADR 0661; it was allowlisted).
 *
 * Sabotage-witnessed (/grade-tests w52): the empty clause in the failed card, an
 * inert Retry, the zero-org card while `orgs` is null, an inverted read-only
 * Notice, `canWrite` pinned true, and an ungated generate form / delete button
 * each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Org, EpisodesList, SpeakerProfile, ShowsList } from '../podcastsClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const listOrgs = vi.fn<() => Promise<Org[]>>();
const listEpisodesWithCapability = vi.fn<(orgId: string) => Promise<EpisodesList>>();
const listSpeakerProfiles = vi.fn<(orgId: string) => Promise<SpeakerProfile[]>>();
const listShowsWithCapability = vi.fn<(orgId: string) => Promise<ShowsList>>();

vi.mock('../podcastsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: () => listOrgs(),
  listEpisodesWithCapability: (orgId: string) => listEpisodesWithCapability(orgId),
  listSpeakerProfiles: (orgId: string) => listSpeakerProfiles(orgId),
  // ShowsManager's own read — unmocked, it was a live fetch on every case with an org.
  listShowsWithCapability: (orgId: string) => listShowsWithCapability(orgId),
  listEpisodeProfiles: vi.fn(async () => []),
  listShows: vi.fn(async () => []),
  // ADR 0603 `PODU-8` — the shape carries the OFF flag beside the list now.
  listNotebooksForPodcasts: vi.fn(async () => ({ notebooks: [], featureUnavailable: false })),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { PodcastStudioPage } from '../PodcastStudioPage.js';

const FAILED = 'The cast profiles, show formats and episodes were never requested. This is a failed read, not an empty organization list.';
const EMPTY = 'Podcast shows, cast profiles and episodes belong to an organization.';

const ACME: Org = { orgId: 'org-1', name: 'Acme' };
const CAST_A: SpeakerProfile = {
  id: 'sp1', orgId: 'org-1', name: 'Cast A', provider: 'minimax', speakers: [{ name: 'Ana', voiceId: 'v1' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const mount = async (): Promise<void> => {
  render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
  await act(async () => {});
};

beforeEach(() => {
  listOrgs.mockReset(); listEpisodesWithCapability.mockReset(); listSpeakerProfiles.mockReset(); listShowsWithCapability.mockReset();
  listOrgs.mockResolvedValue([ACME]);
  listEpisodesWithCapability.mockResolvedValue({ episodes: [], canWrite: true });
  listSpeakerProfiles.mockResolvedValue([]);
  listShowsWithCapability.mockResolvedValue({ shows: [], canWrite: true });
});
afterEach(cleanup);

describe('podcasts — a failed organization read is not an empty account', () => {
  it('read FAILS: the honest, retryable card — and NEVER the workspace claim', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(FAILED);
    // The two sightings of the wrong collection, pinned as absences.
    expect(document.body.textContent).not.toContain('No workspace yet');
    expect(document.body.textContent).not.toContain('Workspace');
    // …and never the zero-org claim, which is a different fact entirely.
    expect(document.body.textContent).not.toContain('No organizations');
    // Every panel is org-scoped, so none of their instructions may render over
    // a read that never started ("create one below" mints a duplicate cast).
    expect(document.body.textContent).not.toContain('No cast profiles yet');
    expect(listSpeakerProfiles).not.toHaveBeenCalled();
  });

  it('the retry re-runs the organization read', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ACME]);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(FAILED);
    // …and the retried read actually lands: the org-scoped panels load for org-1.
    expect(document.body.textContent).toContain('No cast profiles yet');
    expect(listSpeakerProfiles).toHaveBeenCalledWith('org-1');
  });

  it('read SUCCEEDS with []: the real zero-organization state, and it does not INSTRUCT', async () => {
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No organizations');
    expect(document.body.textContent).toContain(EMPTY);
    expect(document.body.textContent).not.toContain(FAILED);
    // §4.6 rule 7 — the CTA offers the recovery; the body must not narrate it.
    expect(document.body.textContent).not.toContain('Create an organization first');
    expect(document.body.textContent).not.toContain('No cast profiles yet');
  });

  it('an organization with genuinely no cast profiles still reads as its own empty state', async () => {
    // The failure mode of this fix: a real empty state replaced by an org claim.
    await mount();
    expect(document.body.textContent).toContain('No cast profiles yet');
    expect(document.body.textContent).not.toContain(FAILED);
    expect(document.body.textContent).not.toContain('No organizations');
  });

  it('while the read is IN FLIGHT it claims nothing — the defect that shipped on every paint', async () => {
    // `orgs` used to start at `[]`, so the zero-org card rendered before the
    // request was issued. `null` means "not read yet", and the page owns the
    // screen until the server answers.
    let settle: (v: Org[]) => void = () => undefined;
    listOrgs.mockReturnValue(new Promise<Org[]>((res) => { settle = res; }));
    render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
    expect(document.body.textContent).not.toContain('No organizations');
    expect(document.body.textContent).not.toContain(EMPTY);
    await act(async () => { settle([]); });
    expect(document.body.textContent).toContain('No organizations');
  });
});

describe('SP-9 (round 3) — the studio hides every write affordance when the episodes read reports canWrite:false', () => {
  it('canWrite:false — profile/generate forms and delete buttons are GONE; ONE read-only disclosure renders', async () => {
    listEpisodesWithCapability.mockResolvedValue({ episodes: [], canWrite: false });
    // The Shows panel reports the same member's capability through its own read.
    listShowsWithCapability.mockResolvedValue({ shows: [], canWrite: false });
    listSpeakerProfiles.mockResolvedValue([CAST_A]);
    await mount();
    expect(document.body.textContent).toContain('Cast A'); // the read is not narrowed
    expect(screen.getByText(/read-only access/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create cast profile/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create show format/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /generate episode/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^create show$/i })).toBeNull();
  });

  it('canWrite:true (paired polarity) — the SAME queries find the forms and no disclosure renders', async () => {
    listSpeakerProfiles.mockResolvedValue([CAST_A]);
    await mount();
    expect(screen.getByRole('button', { name: /create cast profile/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^create show$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /create show format/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate episode/i })).toBeTruthy();
    expect(screen.queryByText(/read-only access/i)).toBeNull();
  });
});
