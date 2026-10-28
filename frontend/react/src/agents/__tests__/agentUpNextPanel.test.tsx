/**
 * ADR 0534 P5 — the "Up next" panel.
 *
 * The headline property is a NEGATIVE one: when ranked selection is off for the
 * workspace the panel must render NOTHING. An off feature is not an empty state,
 * and a "nothing queued" message would be a lie about why the list is absent.
 * That is also the state a component test is uniquely able to catch — the server
 * suites cannot see what the panel chooses to draw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { HeldCard, RankedCard, RankingResult } from '../workSelectionClient.js';

const { getBoardRanking } = vi.hoisted(() => ({
  getBoardRanking: vi.fn<typeof import('../workSelectionClient.js')['getBoardRanking']>(),
}));
vi.mock('../workSelectionClient.js', () => ({ getBoardRanking }));

const { AgentUpNextPanel } = await import('../AgentUpNextPanel.js');

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const ok = (r: RankedCard[], held: HeldCard[] = []): RankingResult => ({ kind: 'ok', ranked: r, held });

const ranked: RankedCard[] = [
  {
    cardId: 'c1', title: 'Ship the thing', rank: 1, score: 8.2,
    why: [{ criterionId: 'ws.priority', criterion: 'Stated priority', value: 10 }],
  },
  {
    cardId: 'c2', title: 'Later thing', rank: 2, score: 4.1,
    why: [{ criterionId: 'ws.priority', criterion: 'Stated priority', value: 2 }],
  },
];

describe('AgentUpNextPanel', () => {
  it('renders NOTHING when the feature is off', async () => {
    getBoardRanking.mockResolvedValue({ kind: 'disabled' });
    const { container } = render(<AgentUpNextPanel boardId="b1" />);

    await waitFor(() => expect(getBoardRanking).toHaveBeenCalled());
    // Wait for the RESOLUTION to render, not just the call. Until the `disabled`
    // result lands the panel shows its loading header ("Up next"), so asserting
    // right after the call raced the re-render — MEASURED 2026-09-23: red once at
    // load ~69 in the date-bomb lane, 6/6 green in isolation. Not vacuous: the
    // first render is non-empty, so this can only pass on the post-resolve state.
    await waitFor(() => expect(
      container.textContent,
      'an off feature must not render an empty state — that misreports why the list is absent',
    ).toBe(''));
  });

  it('lists the ranked cards in order, highest first', async () => {
    getBoardRanking.mockResolvedValue(ok(ranked));
    render(<AgentUpNextPanel boardId="b1" />);

    await screen.findByText('Ship the thing');
    const rows = screen.getAllByRole('button');
    expect(rows[0]!.textContent).toContain('Ship the thing');
    expect(rows[1]!.textContent).toContain('Later thing');
  });

  it('reveals the per-criterion reasons only when a row is opened', async () => {
    getBoardRanking.mockResolvedValue(ok(ranked));
    render(<AgentUpNextPanel boardId="b1" />);

    const first = await screen.findByText('Ship the thing');
    expect(screen.queryByText('Stated priority')).toBeNull();

    fireEvent.click(first);
    await screen.findByText('Stated priority');

    // Disclosure state must be announced, not just visual.
    const row = screen.getAllByRole('button')[0]!;
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('opening a second row closes the first — one explanation at a time', async () => {
    getBoardRanking.mockResolvedValue(ok(ranked));
    render(<AgentUpNextPanel boardId="b1" />);

    fireEvent.click(await screen.findByText('Ship the thing'));
    fireEvent.click(screen.getByText('Later thing'));

    await waitFor(() => {
      const rows = screen.getAllByRole('button');
      expect(rows[0]!.getAttribute('aria-expanded')).toBe('false');
      expect(rows[1]!.getAttribute('aria-expanded')).toBe('true');
    });
  });
  it('an EMPTY lane also renders nothing', async () => {
    getBoardRanking.mockResolvedValue(ok([]));
    const { container } = render(<AgentUpNextPanel boardId="b1" />);
    await waitFor(() => expect(getBoardRanking).toHaveBeenCalled());
    // Wait for the RESOLUTION, not the call: the loading state renders the
    // "Up next" header, so the empty string can only be the post-resolve state.
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('a FAILED read says so, instead of looking identical to "off" (UPN-2)', async () => {
    // Silence here made a broken route invisible: the user could not tell a
    // fault from a disabled feature, and neither could anyone debugging it.
    getBoardRanking.mockResolvedValue({ kind: 'error' });
    render(<AgentUpNextPanel boardId="b1" />);

    // The LOADING state carries the same heading and its own role=status
    // skeleton, so wait for the failure COPY itself — only the error state has it.
    expect(await screen.findByText("Couldn't load the work order. It'll retry shortly.")).toBeTruthy();
    expect(screen.getByRole('heading', { name: /up next/i })).toBeTruthy();
  });

  // ADR 0963 D3 — a held card is not in the order (the agent will not take it)
  // but must not vanish either: the panel names it and says how to release it.
  it('lists held cards apart from the order, with how to release them', async () => {
    getBoardRanking.mockResolvedValue(ok(ranked.slice(0, 1), [{ cardId: 'h1', title: 'Crashed thing' }]));
    render(<AgentUpNextPanel boardId="b1" />);

    await screen.findByText(/Crashed thing/);
    expect(screen.getAllByRole('list')[0]!.textContent, 'a held card is not in the order').not.toContain('Crashed thing');
    expect(screen.getByRole('group', { name: 'Held' }).textContent).toContain('Clear the note on a card to release it');
  });

  it('still renders when every To Do card is held', async () => {
    getBoardRanking.mockResolvedValue(ok([], [{ cardId: 'h1', title: 'Crashed thing' }]));
    render(<AgentUpNextPanel boardId="b1" />);
    expect(await screen.findByText(/Crashed thing/)).toBeTruthy();
  });
});
