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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listOrgs = vi.fn();
const listEpisodesWithCapability = vi.fn();
const listSpeakerProfiles = vi.fn();

vi.mock('../podcastsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: () => listOrgs(),
  listEpisodesWithCapability: (...a: unknown[]) => listEpisodesWithCapability(...a),
  listSpeakerProfiles: (...a: unknown[]) => listSpeakerProfiles(...a),
  listEpisodeProfiles: vi.fn(async () => []),
  listShows: vi.fn(async () => []),
  // ADR 0603 `PODU-8` — the shape carries the OFF flag beside the list now.
  listNotebooksForPodcasts: vi.fn(async () => ({ notebooks: [], featureUnavailable: false })),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { PodcastStudioPage } from '../PodcastStudioPage.js';

const FAILED = 'The cast profiles, show formats and episodes were never requested. This is a failed read, not an empty organization list.';
const EMPTY = 'Podcast shows, cast profiles and episodes belong to an organization.';

const mount = async (): Promise<void> => {
  render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
  await act(async () => {});
};

beforeEach(() => {
  listOrgs.mockReset(); listEpisodesWithCapability.mockReset(); listSpeakerProfiles.mockReset();
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  listEpisodesWithCapability.mockResolvedValue({ episodes: [], canWrite: true });
  listSpeakerProfiles.mockResolvedValue([]);
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
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(FAILED);
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
    let settle: (v: unknown) => void = () => undefined;
    listOrgs.mockReturnValue(new Promise((res) => { settle = res; }));
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
    listSpeakerProfiles.mockResolvedValue([{ id: 'sp1', name: 'Cast A', provider: 'minimax', speakers: [{ name: 'Ana', voiceId: 'v1' }] }]);
    await mount();
    expect(document.body.textContent).toContain('Cast A'); // the read is not narrowed
    expect(screen.getByText(/read-only access/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create cast profile/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create show format/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /generate episode/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('canWrite:true (paired polarity) — the SAME queries find the forms and no disclosure renders', async () => {
    listSpeakerProfiles.mockResolvedValue([{ id: 'sp1', name: 'Cast A', provider: 'minimax', speakers: [{ name: 'Ana', voiceId: 'v1' }] }]);
    await mount();
    expect(screen.getByRole('button', { name: /create cast profile/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /create show format/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate episode/i })).toBeTruthy();
    expect(screen.queryByText(/read-only access/i)).toBeNull();
  });
});
