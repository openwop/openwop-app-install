/**
 * ADR 1115 D10 — the Studio tells the truth about an episode's state.
 *
 *   - `PODUX93-2` a failed episode says what happened in the reader's language, from
 *     the run's typed `errorCode`; the run's own English is behind "Details";
 *   - `PODUX93-4` Retry only on a failure; a done episode offers Regenerate (asks
 *     first); a published one offers neither;
 *   - `PODUX93-5` Publish only with audio; a published chip on a DRAFT show warns;
 *     unpublish asks first;
 *   - `PODUX93-3` the clip playlist keeps playing after the first turn;
 *   - `PODUX93-6` no write control before the capability is known;
 *   - `PODUX93-7` a status transition from polling is announced.
 *
 * Sabotage (each reds the named case): rendering `e.error` instead of the code's copy
 * reds "failure copy"; restoring Retry on done episodes reds "regenerate"; dropping the
 * `audioMediaRef` publish guard reds "publish needs audio"; dropping the draft-show
 * branch reds "draft chip"; removing the `idx` play effect reds "playlist"; defaulting
 * `canWrite` to true reds "unknown capability"; removing the transition effect reds
 * "announce".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PodcastEpisode, PodcastShow } from '../podcastsClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  listShowsWithCapability, listShows, listEpisodes, listEpisodesWithCapability,
  listSpeakerProfiles, listEpisodeProfiles, listOrgs, listNotebooksForPodcasts,
  retryEpisode, setEpisodePublished, setShowPublished,
} = vi.hoisted(() => ({
  listShowsWithCapability: vi.fn(), listShows: vi.fn(), listEpisodes: vi.fn(),
  listEpisodesWithCapability: vi.fn(), listSpeakerProfiles: vi.fn(),
  listEpisodeProfiles: vi.fn(), listOrgs: vi.fn(), listNotebooksForPodcasts: vi.fn(),
  retryEpisode: vi.fn(), setEpisodePublished: vi.fn(), setShowPublished: vi.fn(),
}));
vi.mock('../podcastsClient.js', async (orig) => ({
  ...(await orig<typeof import('../podcastsClient.js')>()),
  listShowsWithCapability, listShows, listEpisodes, listEpisodesWithCapability,
  listSpeakerProfiles, listEpisodeProfiles, listOrgs, listNotebooksForPodcasts,
  retryEpisode, setEpisodePublished, setShowPublished,
}));
const { announceSpy, confirmSpy } = vi.hoisted(() => ({ announceSpy: vi.fn(), confirmSpy: vi.fn() }));
vi.mock('../../../ui/announce.js', () => ({ announce: announceSpy }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmSpy }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: toastError, info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { PodcastStudioPage } from '../PodcastStudioPage.js';
import { ShowsManager } from '../ShowsManager.js';

const SHOW = (over: Partial<PodcastShow> = {}): PodcastShow => ({
  id: 'sh1', orgId: 'o1', slug: 'acme-hour', title: 'The Acme Hour', author: 'Acme',
  description: 'Weekly talk', languageCode: 'en', explicit: false,
  type: 'episodic', published: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', ...over,
});
const EPISODE = (over: Partial<PodcastEpisode> = {}): PodcastEpisode => ({
  id: 'ep1', orgId: 'o1', notebookId: 'nb1', episodeProfileId: 'epp1',
  title: 'Episode One', status: 'done', runId: 'run-1', clips: [],
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', ...over,
});

function arm(episodes: () => PodcastEpisode[], opts: { canWrite?: boolean; shows?: PodcastShow[]; episodesFail?: boolean } = {}): void {
  const shows = opts.shows ?? [SHOW()];
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listShowsWithCapability.mockResolvedValue({ shows, canWrite: opts.canWrite ?? true });
  listNotebooksForPodcasts.mockResolvedValue({ notebooks: [{ id: 'nb1', name: 'Research' }], featureUnavailable: false });
  listSpeakerProfiles.mockResolvedValue([]);
  listEpisodeProfiles.mockResolvedValue([]);
  listShows.mockResolvedValue(shows);
  if (opts.episodesFail) listEpisodesWithCapability.mockRejectedValue(new Error('down'));
  else listEpisodesWithCapability.mockImplementation(async () => ({ episodes: episodes(), canWrite: opts.canWrite ?? true }));
  listEpisodes.mockImplementation(async () => episodes());
}

async function mount(): Promise<void> {
  render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const episodeItem = (): HTMLElement => screen.getByText('Episode One').closest('li') as HTMLElement;

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => vi.clearAllMocks());

describe('ADR 1115 D10 — failure copy', () => {
  it('a failed episode explains its typed code, with the run\'s English behind Details', async () => {
    arm(() => [EPISODE({ status: 'failed', errorCode: 'podcast_content_empty', error: 'the notebook has no sources to ground the episode on' })]);
    await mount();
    const li = episodeItem();
    expect(within(li).getByText(/the notebook had nothing to ground the episode on/i)).toBeTruthy();
    expect(within(li).getByText(/details from the run/i)).toBeTruthy();
    // CONTROL — an unknown code falls back to the generic line.
    cleanup();
    arm(() => [EPISODE({ status: 'failed', errorCode: 'podcast_something_new', error: 'x' })]);
    await mount();
    expect(within(episodeItem()).getByText(/generation failed/i)).toBeTruthy();
  });
});

describe('ADR 1115 D10 — retry, regenerate, publish', () => {
  it('regenerate: a done episode asks first, and a declined confirm starts nothing', async () => {
    arm(() => [EPISODE({ audioMediaRef: '/assets/a' })]);
    confirmSpy.mockResolvedValue(false);
    await mount();
    const li = episodeItem();
    expect(within(li).queryByRole('button', { name: /^retry$/i }), 'Retry is for failures').toBeNull();
    fireEvent.click(within(li).getByRole('button', { name: /regenerate/i }));
    await act(async () => {});
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(retryEpisode).not.toHaveBeenCalled();
  });

  it('a published episode offers neither Retry nor Regenerate', async () => {
    arm(() => [EPISODE({ audioMediaRef: '/assets/a', published: true, showId: 'sh1' })]);
    await mount();
    const li = episodeItem();
    expect(within(li).queryByRole('button', { name: /regenerate|^retry$/i })).toBeNull();
    expect(within(li).getByText(/unpublish to regenerate/i)).toBeTruthy();
  });

  it('publish needs audio: a done episode with no audio file offers no Publish', async () => {
    arm(() => [EPISODE({ clips: [{ speaker: 'A', voiceId: 'v', url: '/assets/c1', mimeType: 'audio/mpeg' }] })]);
    await mount();
    const li = episodeItem();
    expect(within(li).queryByRole('button', { name: /^publish$/i })).toBeNull();
    expect(within(li).getByText(/could not be joined into one audio file/i)).toBeTruthy();
  });

  it('draft chip: published onto a draft show reads as a warning, not "Published"', async () => {
    arm(() => [EPISODE({ audioMediaRef: '/assets/a', published: true, showId: 'sh1' })], { shows: [SHOW({ published: false })] });
    await mount();
    const chip = within(episodeItem()).getByText(/published \(show is a draft\)/i);
    expect(chip.className).toContain('chip--warning');
  });

  it('unpublish asks first', async () => {
    arm(() => [EPISODE({ audioMediaRef: '/assets/a', published: true, showId: 'sh1' })]);
    confirmSpy.mockResolvedValue(false);
    await mount();
    fireEvent.click(within(episodeItem()).getByRole('button', { name: /^unpublish$/i }));
    await act(async () => {});
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(setEpisodePublished).not.toHaveBeenCalled();
  });
});

describe('ADR 1115 D10 — capability and announcements', () => {
  it('unknown capability: a failed episodes read offers no write control', async () => {
    arm(() => [], { episodesFail: true });
    await mount();
    expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
  });

  it('a pending → done transition from polling is announced', async () => {
    vi.useFakeTimers();
    let status: PodcastEpisode['status'] = 'running';
    arm(() => [EPISODE({ status, ...(status === 'done' ? { audioMediaRef: '/assets/a' } : {}) })]);
    render(<MemoryRouter><PodcastStudioPage /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    status = 'done';
    await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/episode one.*is ready/i));
  });
});

describe('ADR 1115 D10 — the playlist plays through', () => {
  it('after the listener starts, each advance calls play()', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
    arm(() => [EPISODE({ clips: [
      { speaker: 'A', voiceId: 'v', url: '/assets/c1', mimeType: 'audio/mpeg' },
      { speaker: 'B', voiceId: 'w', url: '/assets/c2', mimeType: 'audio/mpeg' },
    ] })]);
    await mount();
    const audio = episodeItem().querySelector('audio') as HTMLAudioElement;
    fireEvent.play(audio);
    play.mockClear();
    fireEvent.ended(audio);
    await act(async () => {});
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });
});

describe('ADR 1115 D10 — regrade fixes', () => {
  it('a door refusal reads as translated copy, not the server\'s English', async () => {
    arm(() => [EPISODE({ status: 'failed', errorCode: 'podcast_content_empty', error: 'x' })]);
    retryEpisode.mockRejectedValue(Object.assign(new Error('This episode is published. Unpublish it first'), { status: 409, reason: 'generation_in_progress' }));
    await mount();
    fireEvent.click(within(episodeItem()).getByRole('button', { name: /^retry$/i }));
    await act(async () => {});
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/already being generated/i));
  });

  it('an episode whose notebook was deleted offers no Retry or Regenerate, and says why', async () => {
    arm(() => [EPISODE({ status: 'failed', notebookMissing: true, errorCode: 'podcast_notebook_unavailable' })]);
    await mount();
    const li = episodeItem();
    expect(within(li).queryByRole('button', { name: /regenerate|^retry$/i })).toBeNull();
    expect(within(li).getByText(/its notebook was deleted/i)).toBeTruthy();
  });

  it('a failed row is plain text, never a live alert region', async () => {
    arm(() => [EPISODE({ status: 'failed', errorCode: 'podcast_content_empty' })]);
    await mount();
    expect(episodeItem().querySelector('[role="alert"]')).toBeNull();
  });

  it('show unpublish asks first', async () => {
    arm(() => []);
    confirmSpy.mockResolvedValue(false);
    render(<MemoryRouter><ShowsManager orgId="o1" /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /^unpublish$/i }));
    await act(async () => {});
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(setShowPublished).not.toHaveBeenCalled();
  });
});
