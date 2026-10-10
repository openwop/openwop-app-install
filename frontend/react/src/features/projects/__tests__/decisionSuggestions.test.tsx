/**
 * ADR 0853 D1 — "Possible decisions" on the Ledger tab.
 *   - lists open suggestions with where they came from; writers get Record /
 *     Dismiss, readers do not; nothing renders when there are none;
 *   - Record opens the shared dialog prefilled, and sends the suggestion id and
 *     its source (so the suggestion is marked recorded); Dismiss dismisses;
 *   - ADR 0855 D2: Dismiss asks why (optional) and sends it; a drift finding can
 *     be Sent back with a note, other kinds cannot; a failed send-back is said;
 *   - a failed read is said.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ list: vi.fn(), dismiss: vi.fn(async () => undefined), sendBack: vi.fn(async () => undefined), record: vi.fn(async () => ({ documentId: 'd1', accepted: false })) }));
vi.mock('../teamLedgerClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listDecisionSuggestions: h.list, dismissDecisionSuggestion: h.dismiss, sendBackDriftSuggestion: h.sendBack, recordDecision: h.record }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DecisionSuggestionsSection } from '../DecisionSuggestionsSection.js';

const S = { suggestionId: 's1', projectId: 'p1', title: 'Ship EU first', text: 'We agreed to ship the EU first.', source: { kind: 'message', ref: 'm1', link: '/chat?conversation=c1' }, suggestedBy: { kind: 'agent', id: 'suggester' }, status: 'open', createdAt: '2026-10-07T10:00:00Z' };

beforeEach(() => { h.list.mockReset(); h.dismiss.mockClear(); h.sendBack.mockReset(); h.record.mockClear(); h.list.mockResolvedValue([S]); });
afterEach(cleanup);

describe('DecisionSuggestionsSection', () => {
  it('lists with where it came from; a writer records from it (prefilled, suggestion id + source sent)', async () => {
    const onRecorded = vi.fn();
    render(<DecisionSuggestionsSection projectId="p1" canWrite isOwner={false} onRecorded={onRecorded} />);
    expect(await screen.findByText('Ship EU first')).toBeTruthy();
    expect(screen.getByText(/From a chat message/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Where it came from' }).getAttribute('href')).toBe('/chat?conversation=c1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Record' })[0]!);
    expect((screen.getByLabelText('Decision (short title)') as HTMLInputElement).value).toBe('Ship EU first');
    fireEvent.click(screen.getAllByRole('button', { name: 'Record' }).at(-1)!);
    await waitFor(() => expect(h.record).toHaveBeenCalledWith('p1', expect.objectContaining({ suggestionId: 's1', source: S.source, title: 'Ship EU first' })));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
  });

  it('a writer dismisses; a reader gets no actions', async () => {
    render(<DecisionSuggestionsSection projectId="p1" canWrite isOwner onRecorded={() => undefined} />);
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    expect(screen.queryByRole('button', { name: 'Send back' })).toBeNull(); // not a drift finding
    fireEvent.click(dismiss);
    fireEvent.change(screen.getByLabelText('Why dismiss it? (optional)'), { target: { value: 'Just brainstorming' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(h.dismiss).toHaveBeenCalledWith('p1', 's1', 'Just brainstorming'));
    cleanup();
    render(<DecisionSuggestionsSection projectId="p1" canWrite={false} isOwner={false} onRecorded={() => undefined} />);
    expect(await screen.findByText('Ship EU first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('nothing when there are none; a failed read is said', async () => {
    h.list.mockResolvedValue([]);
    const { container } = render(<DecisionSuggestionsSection projectId="p1" canWrite isOwner onRecorded={() => undefined} />);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();
    h.list.mockRejectedValue(new Error('503'));
    render(<DecisionSuggestionsSection projectId="p1" canWrite isOwner onRecorded={() => undefined} />);
    expect(await screen.findByText('Possible decisions could not be loaded.')).toBeTruthy();
  });

  it('a drift finding is sent back with a note; a failed send-back is said', async () => {
    h.list.mockResolvedValue([{ ...S, suggestionId: 'd1', source: { kind: 'drift', ref: 'run-1:0', link: '/runs/run-1' } }]);
    h.sendBack.mockRejectedValueOnce(new Error('409'));
    render(<DecisionSuggestionsSection projectId="p1" canWrite isOwner onRecorded={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send back' }));
    fireEvent.change(screen.getByLabelText(/What should change\?/), { target: { value: 'Drop the US line' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(await screen.findByText(/Could not send it back/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(h.sendBack).toHaveBeenLastCalledWith('p1', 'd1', 'Drop the US line'));
    expect(h.dismiss).not.toHaveBeenCalled();
  });

  it('keeps the live region mounted and announces the same failure again on retry', async () => {
    h.list.mockResolvedValue([{ ...S, suggestionId: 'd1', source: { kind: 'drift', ref: 'run-1:0', link: '/runs/run-1' } }]);
    h.sendBack.mockRejectedValue(new Error('409'));
    render(<DecisionSuggestionsSection projectId="p1" canWrite isOwner onRecorded={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send back' }));
    // A region that is inserted already containing the error may never speak.
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    let messages = 0;
    const observer = new MutationObserver(() => {
      if (region.textContent?.includes('Could not send it back')) messages++;
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
      await waitFor(() => expect(messages).toBe(1));
      const firstText = region.textContent;
      fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
      await waitFor(() => expect(messages).toBe(2));
      expect(screen.getByRole('status')).toBe(region);
      expect(region.textContent?.replace(/\u200b/g, '')).toBe(firstText?.replace(/\u200b/g, ''));
      expect(h.sendBack).toHaveBeenCalledTimes(2);
    } finally {
      observer.disconnect();
    }
  });
});
