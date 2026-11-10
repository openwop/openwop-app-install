import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

/**
 * ADR 0997 D5 — the Conversations rail's message search states. Each case is a
 * gap round 2 found (CSU-2/3/4, the no-matches state, the snippet highlight):
 * - a failed search shows an error with Retry instead of reading as "no matches";
 * - a loading line shows while the request runs;
 * - a polite live region announces the count;
 * - "no matches" appears only when neither titles nor messages match;
 * - the matched words are wrapped in <mark>, from text nodes, never HTML;
 * - a capped search says so.
 *
 * Breaks (each witnessed by a sabotage probe, wave 79) if a rejected search
 * renders the no-matches line instead of the error + Retry, Retry stops
 * re-querying, the loading line or the polite live region is dropped, the
 * no-matches line ignores title matches, the highlight renders the snippet as
 * HTML or stops folding case, the truncated note shows when the server did not
 * cap (or not when it did), or the two-character floor moves either way. The
 * client half (the search THROWS instead of returning no matches) is
 * `client/__tests__/searchChatConversations.test.ts`; here the client is mocked.
 */
import type { ConversationSearchHit, ConversationSearchResult } from '../../../client/chatSessionsClient.js';

const search = vi.fn<(q: string, signal?: AbortSignal) => Promise<ConversationSearchResult>>();
vi.mock('../../../client/chatSessionsClient.js', () => ({
  searchChatConversations: (q: string, signal?: AbortSignal) => search(q, signal),
}));

const { MessageSearchResults, highlight } = await import('../MessageSearchResults.js');

beforeEach(() => { vi.useFakeTimers(); search.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

const HIT: ConversationSearchHit = { conversationId: 'c1', title: 'Launch plan', messageId: 'm1', snippet: 'the Harbour launch is friday', score: 2 };

describe('MessageSearchResults — designed states (ADR 0997 D5)', () => {
  it('shows a loading line, then results with a live count and highlighted words', async () => {
    let resolve!: (v: ConversationSearchResult) => void;
    search.mockReturnValue(new Promise<ConversationSearchResult>((r) => { resolve = r; }));
    const onOpen = vi.fn();
    render(<MessageSearchResults query="harbour launch" titleMatches={0} onOpen={onOpen} />);
    await settle();
    expect(screen.getByText('Searching messages…')).toBeTruthy();

    await act(async () => { resolve({ hits: [HIT], truncated: false }); });
    expect(screen.queryByText('Searching messages…')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('1 message match');
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    // Not capped: no truncation note.
    expect(screen.queryByText(/most recent messages/)).toBeNull();
    const marks = [...document.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['Harbour', 'launch']);
    fireEvent.click(screen.getByRole('button', { name: /Launch plan/ }));
    expect(onOpen).toHaveBeenCalledWith('c1');
  });

  it('a failed search shows an error with Retry, not "no matches"', async () => {
    search.mockRejectedValueOnce(new Error('http_error: HTTP 500')).mockResolvedValueOnce({ hits: [HIT], truncated: false });
    render(<MessageSearchResults query="harbour" titleMatches={0} onOpen={vi.fn()} />);
    await settle();
    expect(screen.getByText(/Couldn't search messages/)).toBeTruthy();
    expect(screen.queryByText('No conversations or messages match.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(search).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toBe('1 message match');
  });

  it('says "no matches" only when titles did not match either', async () => {
    search.mockResolvedValue({ hits: [], truncated: false });
    const { rerender } = render(<MessageSearchResults query="zzqx" titleMatches={0} onOpen={vi.fn()} />);
    await settle();
    expect(screen.getByText('No conversations or messages match.')).toBeTruthy();
    rerender(<MessageSearchResults query="zzqx" titleMatches={2} onOpen={vi.fn()} />);
    expect(screen.queryByText('No conversations or messages match.')).toBeNull();
  });

  it('says when only the newest messages were searched', async () => {
    search.mockResolvedValue({ hits: [HIT], truncated: true });
    render(<MessageSearchResults query="harbour" titleMatches={0} onOpen={vi.fn()} />);
    await settle();
    expect(screen.getByText('Showing matches from the most recent messages. Add a word to narrow it.')).toBeTruthy();
  });

  it('does not query below two characters', async () => {
    search.mockResolvedValue({ hits: [], truncated: false });
    const { rerender, container } = render(<MessageSearchResults query="h" titleMatches={0} onOpen={vi.fn()} />);
    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
    // Positive control at the floor: two characters do query.
    rerender(<MessageSearchResults query="ha" titleMatches={0} onOpen={vi.fn()} />);
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe('ha');
  });

  it('highlights from text nodes, never markup', () => {
    const { container } = render(<span>{highlight('<b>café</b> CAFÉ', ['café'])}</span>);
    expect(container.querySelector('b')).toBeNull();
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['café', 'CAFÉ']);
  });
});
