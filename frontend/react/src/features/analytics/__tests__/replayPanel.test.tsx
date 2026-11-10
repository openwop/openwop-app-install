/**
 * ADR 0951 P2.4 — the recording viewer is inert: it draws numbers as SVG
 * rectangles and never turns recording content into markup, links or requests.
 * The client is mocked; the panel's own states, playback and drawing run for real.
 *
 * Red when (sabotage-witnessed, /grade-tests wave 80): a move after release
 * counts as a drag, or an event AT t is excluded; the list is not sorted newest
 * first (the fixture arrives oldest first); the root node is drawn; masked
 * nodes lose the mask class; the viewport ignores scroll; anything but
 * rect/circle is drawn; only the first chunk is fetched; a 404 chunk is fatal;
 * a 403 on the list or on a chunk is not "no access"; the player waits for
 * every chunk, or drops the "loading the rest" status; "older" ignores the
 * cursor or keeps a spent one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../analyticsClient.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../analyticsClient.js')>();
  return { ...real, listReplaySessions: vi.fn(), getReplayChunk: vi.fn() };
});
import { getReplayChunk, listReplaySessions, ReplayRequestError, type ReplayEvent } from '../analyticsClient.js';
import { ReplayPanel, replayStateAt } from '../ReplayPanel.js';

const session = { sessionId: 's-1', startedAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:20.000Z', durationMs: 0, bytes: 15, chunkCount: 2 };
const frame = (at: number, extra = 0): ReplayEvent => ({ type: 'frame', at, viewport: { width: 800, height: 600 }, nodes: [
  { id: 1, parent: null, kind: 'box', x: 0, y: 0, width: 800, height: 1600 },
  { id: 2, parent: 1, kind: 'box', x: 16, y: 16, width: 400, height: 40 },
  { id: 3, parent: 2, kind: 'masked', x: 16, y: 16, width: 64, height: 16 },
  ...Array.from({ length: extra }, (_, i) => ({ id: 4 + i, parent: 1, kind: 'box' as const, x: 8, y: 80 + 8 * i, width: 8, height: 8 })),
] });

afterEach(() => { cleanup(); vi.mocked(listReplaySessions).mockReset(); vi.mocked(getReplayChunk).mockReset(); });

describe('ADR 0951 P2.4 — replay viewer', () => {
  it('replayStateAt picks the latest frame, scroll and pointer at or before t', () => {
    const events: ReplayEvent[] = [frame(0), { type: 'pointer', at: 10, action: 'down', x: 8, y: 8 },
      { type: 'pointer', at: 20, action: 'move', x: 16, y: 16 }, { type: 'scroll', at: 30, x: 0, y: 200 },
      { type: 'pointer', at: 40, action: 'up', x: 24, y: 24 }, { type: 'pointer', at: 45, action: 'move', x: 32, y: 32 }, frame(50, 1)];
    expect(replayStateAt(events, 25)).toMatchObject({ scroll: { x: 0, y: 0 }, pointer: { x: 16, y: 16, down: true } });
    expect(replayStateAt(events, 44)).toMatchObject({ scroll: { x: 0, y: 200 }, pointer: { x: 24, y: 24, down: false } });
    // A move after release is not a drag.
    expect(replayStateAt(events, 46)).toMatchObject({ pointer: { x: 32, y: 32, down: false } });
    expect(replayStateAt(events, 49).frame?.nodes).toHaveLength(3);
    expect(replayStateAt(events, 50).frame?.nodes).toHaveLength(4);
  });

  it('lists recordings newest first and plays one back as rectangles only', async () => {
    // Oldest first, as the server might page them: the panel must sort.
    vi.mocked(listReplaySessions).mockResolvedValue({ sessions: [{ ...session, sessionId: 's-0', startedAt: '2026-10-27T12:00:00.000Z' }, session] });
    vi.mocked(getReplayChunk).mockImplementation(async (_o, _s, index) => (index === 0
      ? [frame(0), { type: 'pointer', at: 10, action: 'move', x: 24, y: 40 }]
      : [frame(10_000, 2), { type: 'scroll', at: 10_010, x: 0, y: 400 }]));
    const { container } = render(<ReplayPanel orgId="org-1" />);
    const watch = await screen.findAllByRole('button', { name: 'Watch' });
    expect(watch).toHaveLength(2);
    fireEvent.click(watch[0]!);
    const figure = await screen.findByRole('img', { name: /Masked recording of a visit/ });
    expect(vi.mocked(getReplayChunk).mock.calls).toEqual([['org-1', 's-1', 0], ['org-1', 's-1', 1]]);
    expect(figure.querySelectorAll('rect')).toHaveLength(2);
    expect(figure.querySelectorAll('rect.replay-mask')).toHaveLength(1);
    expect(figure.getAttribute('viewBox')).toBe('0 0 800 600');
    // Seek to the second chunk's frame.
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '10000' } });
    expect(figure.querySelectorAll('rect')).toHaveLength(4);
    // The viewport follows the recorded scroll.
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '10010' } });
    expect(figure.getAttribute('viewBox')).toBe('0 400 800 600');
    // Inert: nothing but rect/circle elements inside the figure; no link, image, text or foreign markup.
    expect([...figure.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()).filter((tag) => tag !== 'rect' && tag !== 'circle')).toEqual([]);
    expect(container.querySelector('a, img, iframe, foreignObject, script')).toBeNull();
  });

  it('a missing chunk is skipped, not fatal', async () => {
    vi.mocked(listReplaySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(getReplayChunk).mockImplementation(async (_o, _s, index) => {
      if (index === 0) throw new ReplayRequestError(404);
      return [frame(10_000)];
    });
    render(<ReplayPanel orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    const figure = await screen.findByRole('img', { name: /Masked recording of a visit/ });
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '10000' } });
    expect(figure.querySelectorAll('rect')).toHaveLength(2);
  });

  it('a missing permission says so, and a failure says it did not load', async () => {
    vi.mocked(listReplaySessions).mockRejectedValueOnce(new ReplayRequestError(403));
    render(<ReplayPanel orgId="org-1" />);
    expect(await screen.findByText(/Only owners and admins/)).toBeTruthy();
    cleanup();
    vi.mocked(listReplaySessions).mockRejectedValueOnce(new ReplayRequestError(500));
    render(<ReplayPanel orgId="org-1" />);
    expect(await screen.findByText(/didn't load/)).toBeTruthy();
  });

  it('an access revoked while a recording loads stops the player', async () => {
    vi.mocked(listReplaySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(getReplayChunk).mockRejectedValue(new ReplayRequestError(403));
    render(<ReplayPanel orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(screen.getByText(/Only owners and admins/)).toBeTruthy());
    expect(screen.queryByRole('img')).toBeNull();
  });

  // ADR 0951 P2 review #4: the viewer used to fetch every chunk (up to 2048)
  // before showing anything. It now shows the first chunk while the rest load.
  it('shows the recording once its first chunk is in, while later chunks still load', async () => {
    vi.mocked(listReplaySessions).mockResolvedValue({ sessions: [{ ...session, chunkCount: 3 }] });
    vi.mocked(getReplayChunk).mockImplementation(async (_o, _s, index) => {
      if (index === 0) return [frame(0)];
      return new Promise<ReplayEvent[]>(() => {}); // still in flight
    });
    render(<ReplayPanel orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    const figure = await screen.findByRole('img', { name: /Masked recording of a visit/ });
    expect(figure.querySelectorAll('rect')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toMatch(/Loading the rest/);
    expect(vi.mocked(getReplayChunk).mock.calls.map((c) => c[2])).toEqual([0, 1]);
  });

  // ADR 0951 P2 review #11: the list showed only the newest page of 50.
  it('loads older recordings with the server cursor', async () => {
    vi.mocked(listReplaySessions)
      .mockResolvedValueOnce({ sessions: [session], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ sessions: [{ ...session, sessionId: 's-old', startedAt: '2026-10-01T12:00:00.000Z' }] });
    render(<ReplayPanel orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show older recordings' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Watch' })).toHaveLength(2));
    expect(vi.mocked(listReplaySessions).mock.calls).toEqual([['org-1'], ['org-1', 'cursor-1']]);
    expect(screen.queryByRole('button', { name: 'Show older recordings' })).toBeNull();
  });
});
