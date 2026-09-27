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

const getBoardRanking = vi.fn();
vi.mock('../workSelectionClient.js', () => ({
  getBoardRanking: (...a: unknown[]) => getBoardRanking(...a),
}));

const { AgentUpNextPanel } = await import('../AgentUpNextPanel.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ok = (r: unknown[]) => ({ kind: 'ok', ranked: r });

const ranked = [
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
    expect(container.textContent).toBe('');
  });

  it('a FAILED read says so, instead of looking identical to "off" (UPN-2)', async () => {
    // Silence here made a broken route invisible: the user could not tell a
    // fault from a disabled feature, and neither could anyone debugging it.
    getBoardRanking.mockResolvedValue({ kind: 'error' });
    render(<AgentUpNextPanel boardId="b1" />);

    await screen.findByRole('heading', { name: /up next/i });
    expect(screen.getByRole('status').textContent, 'a failed read must be visible').toBeTruthy();
  });
});
