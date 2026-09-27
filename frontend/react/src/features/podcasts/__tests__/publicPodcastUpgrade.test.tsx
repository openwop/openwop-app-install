/**
 * UX_UPGRADE-podcasts — the visitor-facing show + episode pages (P-G1..P-G4).
 *
 * Three of the four gaps here are the same class: `publishedAt` and `explicit`
 * were ALREADY in the public payload and the UI threw them away. The head is
 * the deliberate counterpart to the share viewer's `noindex` — a podcast is
 * meant to be found.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicEpisode, PublicShow } from '../podcastsClient.js';

const getPublicShows = vi.fn();
const getPublicShow = vi.fn();
const getPublicEpisode = vi.fn();
vi.mock('../podcastsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPublicShows: (...a: unknown[]) => getPublicShows(...a),
  getPublicShow: (...a: unknown[]) => getPublicShow(...a),
  getPublicEpisode: (...a: unknown[]) => getPublicEpisode(...a),
}));

const { PublicPodcastPage } = await import('../PublicPodcastPage.js');

const SHOW: PublicShow = {
  slug: 'the-pod', title: 'The Pod', author: 'Ada', description: 'A show about things.',
  languageCode: 'en', explicit: false, type: 'episodic', episodeCount: 3,
  feedUrl: 'https://example.test/feed.xml',
};

const ep = (slug: string, title: string, publishedAt: string, explicit = false): PublicEpisode =>
  ({ slug, title, publishedAt, explicit, audioUrl: `https://a.test/${slug}.mp3`, pageUrl: `https://p.test/${slug}`, description: `About ${title}` });

/** Newest-first, as the show read returns them. */
const EPISODES = [ep('c', 'Third', '2026-07-20T00:00:00.000Z'), ep('b', 'Second', '2026-07-10T00:00:00.000Z', true), ep('a', 'First', '2026-07-01T00:00:00.000Z')];

const view = (showSlug?: string, episodeSlug?: string) =>
  ({ orgId: 'org:1', ...(showSlug ? { showSlug } : {}), ...(episodeSlug ? { episodeSlug } : {}) }) as Parameters<typeof PublicPodcastPage>[0]['view'];

const renderPod = (v: ReturnType<typeof view>) =>
  render(<MemoryRouter><PublicPodcastPage view={v} /></MemoryRouter>);

const metaDescription = () => document.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;
const feedLink = () => document.head.querySelector('link[rel="alternate"][type="application/rss+xml"]')?.getAttribute('href') ?? null;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.head.querySelectorAll('meta[name="description"], link[rel="alternate"]').forEach((el) => el.remove());
});

describe('public podcast — head (P-G1)', () => {
  it('titles the SHOW page, describes it, and advertises the feed — then restores on unmount', async () => {
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    const before = document.title;
    const v = renderPod(view('the-pod'));
    await screen.findByText('Third');

    await waitFor(() => expect(document.title).toBe('The Pod — Ada'));
    expect(metaDescription()).toBe('A show about things.');
    // Feed autodiscovery: a podcast app pointed at this page can find the feed.
    await waitFor(() => expect(feedLink()).toBe('https://example.test/feed.xml'));

    v.unmount();
    await waitFor(() => expect(document.title).toBe(before));
    expect(metaDescription()).toBeNull();
    expect(feedLink()).toBeNull();
  });

  it('titles the EPISODE page with its show', async () => {
    getPublicEpisode.mockResolvedValue({ show: { slug: 'the-pod', title: 'The Pod', author: 'Ada' }, episode: EPISODES[1]! });
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    renderPod(view('the-pod', 'b'));
    await screen.findByRole('heading', { name: 'Second' });
    await waitFor(() => expect(document.title).toBe('Second — The Pod'));
  });
});

describe('public podcast — payload data that was being thrown away (P-G2/P-G4)', () => {
  it('dates every episode row and LABELS explicit content', async () => {
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    const { container } = renderPod(view('the-pod'));
    await screen.findByText('Third');

    // One machine-readable <time> per episode — an undated podcast list reads
    // as though nothing has shipped in years.
    const times = Array.from(container.querySelectorAll('time')).map((el) => el.getAttribute('datetime'));
    expect(times).toEqual(['2026-07-20T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-01T00:00:00.000Z']);

    // Apple requires explicit content be LABELLED, not merely flagged in the
    // feed — and only the one episode that is flagged.
    expect(screen.getAllByText('Explicit')).toHaveLength(1);
  });

  it('shows the date + explicit label on the episode page too', async () => {
    getPublicEpisode.mockResolvedValue({ show: { slug: 'the-pod', title: 'The Pod', author: 'Ada' }, episode: EPISODES[1]! });
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    const { container } = renderPod(view('the-pod', 'b'));
    await screen.findByRole('heading', { name: 'Second' });
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2026-07-10T00:00:00.000Z');
    expect(screen.getByText('Explicit')).toBeTruthy();
  });
});

describe('public podcast — episode pager (P-G3)', () => {
  it('links the adjacent episodes and drops the edge at each end', async () => {
    getPublicEpisode.mockResolvedValue({ show: { slug: 'the-pod', title: 'The Pod', author: 'Ada' }, episode: EPISODES[1]! });
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    renderPod(view('the-pod', 'b'));
    await screen.findByRole('heading', { name: 'Second' });

    const pager = await screen.findByRole('navigation', { name: /nearby episodes/i });
    // Newest-first list ⇒ 'Third' is newer, 'First' is older.
    expect(within(pager).getByText('Third')).toBeTruthy();
    expect(within(pager).getByText('First')).toBeTruthy();

    cleanup();
    getPublicEpisode.mockResolvedValue({ show: { slug: 'the-pod', title: 'The Pod', author: 'Ada' }, episode: EPISODES[0]! });
    renderPod(view('the-pod', 'c'));
    await screen.findByRole('heading', { name: 'Third' });
    const first = await screen.findByRole('navigation', { name: /nearby episodes/i });
    expect(first.textContent).not.toContain('Next episode'); // nothing newer
    expect(first.textContent).toContain('Second');
  });

  it('still renders the episode when the sibling read FAILS — just without a pager', async () => {
    getPublicEpisode.mockResolvedValue({ show: { slug: 'the-pod', title: 'The Pod', author: 'Ada' }, episode: EPISODES[1]! });
    getPublicShow.mockRejectedValue(new Error('boom'));
    renderPod(view('the-pod', 'b'));
    await screen.findByRole('heading', { name: 'Second' });
    expect(screen.queryByRole('navigation', { name: /nearby episodes/i })).toBeNull();
    // The important part: a failed SIDE read must not take the page down.
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });
});

describe('R2 SP-10 — a failed read is not "not published"', () => {
  it('a 500 renders the RETRYABLE card (never the publish-state claim), and Retry re-reads', async () => {
    getPublicShow
      .mockRejectedValueOnce(Object.assign(new Error('http 500'), { status: 500 }))
      .mockResolvedValueOnce({ show: SHOW, episodes: EPISODES });
    renderPod(view('the-pod'));
    await screen.findByText(/couldn.t load this page/i);
    expect(screen.queryByText(/not published|no longer valid/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('The Pod');
    expect(getPublicShow).toHaveBeenCalledTimes(2);
  });

  it('a real 404 keeps the unavailable claim (the positive case — the fix must not degrade it)', async () => {
    getPublicShow.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    renderPod(view('the-pod'));
    await screen.findByText(/not published|no longer valid/i);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('R2 SP-6 — audio load failure has a WITNESS', () => {
  it('an audio error on the episode page renders the visible notice', async () => {
    getPublicEpisode.mockResolvedValue({ show: { slug: 'the-pod', title: 'The Pod', author: 'Ada' }, episode: EPISODES[0] });
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    const { container } = renderPod(view('the-pod', 'c'));
    await screen.findByText('Third');
    expect(screen.queryByText(/audio couldn.t be loaded/i)).toBeNull();
    fireEvent.error(container.querySelector('audio')!);
    await screen.findByText(/audio couldn.t be loaded/i);
  });
});

describe('R2 SP-7 / PR2-4 — reach: episode-page feed autodiscovery + Listen on', () => {
  it('an EPISODE page advertises the RSS feed (the URL people actually share)', async () => {
    getPublicEpisode.mockResolvedValue({ show: { slug: 'the-pod', title: 'The Pod', author: 'Ada' }, episode: EPISODES[0] });
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    renderPod(view('the-pod', 'c'));
    await screen.findByText('Third');
    await waitFor(() => expect(feedLink()).toBe('https://example.test/feed.xml'));
  });

  it('the show page renders "Listen on" buttons ONLY for directories the operator linked', async () => {
    getPublicShow.mockResolvedValue({
      show: { ...SHOW, appleUrl: 'https://podcasts.apple.com/us/podcast/id123', spotifyUrl: 'https://open.spotify.com/show/x' },
      episodes: EPISODES,
    });
    renderPod(view('the-pod'));
    await screen.findByText('The Pod');
    expect((screen.getByRole('link', { name: /apple podcasts/i }) as HTMLAnchorElement).href).toContain('podcasts.apple.com');
    expect(screen.getByRole('link', { name: /spotify/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /amazon/i })).toBeNull(); // not linked → not offered
  });
});

describe('R2 PR2-3 — the show page bounds its episode list (the leader pattern, closes P-G5)', () => {
  it('renders 20 of 25, and "Show all" reveals the rest', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ep(`e${i}`, `Episode ${i + 1}`, '2026-07-01T00:00:00.000Z'));
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: many });
    renderPod(view('the-pod'));
    await screen.findByText('Episode 1');
    expect(screen.queryByText('Episode 21')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show all 25 episodes/i }));
    await screen.findByText('Episode 25');
  });

  it('a short list renders whole with no Show-all button (the positive case)', async () => {
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: EPISODES });
    renderPod(view('the-pod'));
    await screen.findByText('Third');
    expect(screen.queryByRole('button', { name: /show all/i })).toBeNull();
  });
});

// ─────────────────────── `L6` (ADR 0603 R1) ────────────────────────
//
// Three a11y nits INSIDE the PODU-1 a11y fix. Each is asserted on its own
// mechanism, and each with the discriminating half — the whole point of the
// finding is that a11y attributes present unconditionally look like a fix.

describe('L6 — the transcript panel\'s a11y plumbing', () => {
  const withTranscript = (over: Partial<PublicEpisode> = {}): PublicEpisode =>
    ({ ...ep('a', 'First', '2026-07-01T00:00:00.000Z'), transcript: 'Line one.\n\nLine two.', ...over } as PublicEpisode);

  /** jsdom reports 0 for both, so overflow is stubbed at the prototype. */
  const setOverflow = (scrolls: boolean): (() => void) => {
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => (scrolls ? 500 : 100) });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100 });
    return () => {
      if (sh) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', sh);
      if (ch) Object.defineProperty(HTMLElement.prototype, 'clientHeight', ch);
    };
  };

  it('the scroll container is focusable + named ONLY when it actually scrolls', async () => {
    const restore = setOverflow(true);
    try {
      getPublicEpisode.mockResolvedValue({ show: SHOW, episode: withTranscript() });
      getPublicShow.mockResolvedValue({ show: SHOW, episodes: [] });
      renderPod(view('the-pod', 'a'));
      await screen.findByText('Line one.');
      // SC 2.1.1 — a scrollable region needs a keyboard route in.
      const region = await waitFor(() => {
        const r = document.querySelector('.pod-transcript');
        expect(r?.getAttribute('tabindex')).toBe('0');
        return r!;
      });
      expect(region.getAttribute('role')).toBe('region');
      // ...and its name is DISTINCT from the section's own name. Two nested
      // regions both called "Transcript" tell a screen-reader user nothing about
      // which one they landed in.
      const sectionName = document.getElementById(
        document.querySelector('section[aria-labelledby]')!.getAttribute('aria-labelledby')!,
      )!.textContent;
      expect(region.getAttribute('aria-label')).not.toBe(sectionName);
      expect(region.getAttribute('aria-label')).toBeTruthy();
    } finally { restore(); }
  });

  it('CONTROL — a transcript that does NOT overflow adds no tab stop and no region', async () => {
    // The discriminating half. Without it the assertion above would be satisfied by
    // the unconditional `tabIndex={0}` this replaces — a tab stop that announces a
    // region with nothing behind it.
    const restore = setOverflow(false);
    try {
      getPublicEpisode.mockResolvedValue({ show: SHOW, episode: withTranscript() });
      getPublicShow.mockResolvedValue({ show: SHOW, episodes: [] });
      renderPod(view('the-pod', 'a'));
      await screen.findByText('Line one.');
      const region = document.querySelector('.pod-transcript')!;
      expect(region.getAttribute('tabindex')).toBeNull();
      expect(region.getAttribute('role')).toBeNull();
    } finally { restore(); }
  });

  it('the heading id is per-INSTANCE, not a document-global literal', async () => {
    getPublicEpisode.mockResolvedValue({ show: SHOW, episode: withTranscript() });
    getPublicShow.mockResolvedValue({ show: SHOW, episodes: [] });
    const a = renderPod(view('the-pod', 'a'));
    await within(a.container).findByText('Line one.');
    const b = renderPod(view('the-pod', 'a'));
    await within(b.container).findByText('Line one.');
    const ids = [a, b].map((r) => r.container.querySelector('section[aria-labelledby]')!.getAttribute('aria-labelledby'));
    expect(ids[0]).toBeTruthy();
    expect(ids[0], 'a hard-coded id makes `aria-labelledby` resolve to whichever panel won').not.toBe(ids[1]);
    // ...and each still RESOLVES, which a unique-but-dangling id would not.
    for (const r of [a, b]) {
      const id = r.container.querySelector('section[aria-labelledby]')!.getAttribute('aria-labelledby')!;
      expect(r.container.querySelector(`h2[id="${id}"]`)).not.toBeNull();
    }
  });
});
