/**
 * ADR 1040 D7 F3 — per-call display summaries on the turn receipt.
 *
 *  - Asked for only when the receipt is OPEN on a SETTLED turn that ran a tool;
 *  - shown under its own call's row, matched by call id;
 *  - rendered as TEXT (a summary carrying markup shows the characters);
 *  - a failed read leaves the receipt as it was.
 *
 * Red when: TurnReceipt asks while collapsed or streaming, joins by anything but
 * the call id, or renders the summary as HTML (chat/TurnReceipt.tsx,
 * chat/lib/toolSummaries.ts).
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { count?: unknown }) => (o && o.count !== undefined ? `${k}:${String(o.count)}` : k) }),
}));
vi.mock('../lib/toolEffects.js', () => ({ useToolEffects: () => new Map() }));
const asked: string[] = [];
let rows: Array<{ callId: string; toolName: string; summary: string }> = [];
let fail = false;
vi.mock('../artifacts/artifactClient.js', () => ({
  listChatTurnToolSummaries: async (runId: string, turn: string) => { asked.push(`${runId}/${turn}`); if (fail) throw new Error('500'); return rows; },
  listChatTurnArtifacts: async () => [],
}));

import type { ChatMessage } from '../types.js';
import { TurnReceipt } from '../TurnReceipt.js';

const call = (callId: string) => ({ callId, toolName: 'bookai.get-book', agentId: 'guide', startedAt: '2026-11-03T10:00:00Z', finishedAt: '2026-11-03T10:00:01Z' });
// Summaries are cached per turn for the session, so every case uses its own turn.
let turnN = 0;
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a1', role: 'assistant', content: 'done', createdAt: '2026-11-03T10:00:00Z',
  turnRef: { conversationRunId: 'conv-run-1', turnMessageId: `turn-${++turnN}` },
  agentEvents: { toolCalls: [call('c1'), call('c2')], handoffs: [], decisions: [] },
  ...over,
} as ChatMessage);
async function drain(): Promise<void> {
  await act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => { asked.length = 0; fail = false; rows = [{ callId: 'c2', toolName: 'bookai.get-book', summary: 'Read chapter 3 <b>bold</b>' }]; });
afterEach(cleanup);

describe('turn receipt summaries', () => {
  it('collapsed: nothing is asked; opened: the summary shows under its own call, as text', async () => {
    const { container } = render(<TurnReceipt message={msg()} />);
    await drain();
    expect(asked).toEqual([]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await drain();
    expect(asked).toEqual([`conv-run-1/turn-${turnN}`]);
    expect(screen.getByText('Read chapter 3 <b>bold</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    // Under c2's row, not c1's.
    const rowsEl = container.querySelectorAll('.turn-receipt-tool');
    expect(rowsEl[0]?.textContent).not.toContain('Read chapter 3');
    expect(rowsEl[1]?.textContent).toContain('Read chapter 3');
  });

  it('a reopened receipt does not ask again (cached per turn)', async () => {
    render(<TurnReceipt message={msg()} />);
    const toggle = screen.getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    await drain();
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await drain();
    expect(asked).toEqual([`conv-run-1/turn-${turnN}`]);
    expect(screen.getByText('Read chapter 3 <b>bold</b>')).toBeTruthy();
  });

  it('a streaming turn asks nothing even when open', async () => {
    render(<TurnReceipt message={msg({ isStreaming: true })} />);
    await drain();
    expect(asked).toEqual([]);
  });

  it('a failed read leaves the rows unchanged', async () => {
    fail = true;
    render(<TurnReceipt message={msg()} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await drain();
    expect(asked).toEqual([`conv-run-1/turn-${turnN}`]);
    expect(screen.queryByText(/Read chapter 3/)).toBeNull();
    expect(screen.getAllByText('bookai.get-book').length).toBe(2);
  });
});
