/**
 * ADR 0784 P3 — the receipt says what a turn READ and what it CHANGED, from
 * each tool's declared effect; a tool with no known effect stays a neutral
 * "N tools", never guessed. Each tool row is tagged in the expanded receipt.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k) }) }));
let known: Record<string, 'read' | 'write'> = {};
vi.mock('../lib/toolEffects.js', () => ({
  useToolEffects: (names: string[]) => new Map(names.filter((n) => known[n]).map((n) => [n, known[n]!])),
}));

import { TurnReceipt, summarizeTurn } from '../TurnReceipt.js';
import type { ChatMessage } from '../types.js';

const call = (id: string, toolName: string) => ({ callId: id, toolName, agentId: 'iris', startedAt: 't', finishedAt: 'u' });
const turn = (names: string[]): ChatMessage => ({
  id: 'm', role: 'assistant', content: 'done', createdAt: 't',
  agentEvents: { toolCalls: names.map((n, i) => call(`c${i}`, n)), handoffs: [], decisions: [] },
} as unknown as ChatMessage);

beforeEach(() => { known = {}; });
afterEach(cleanup);

describe('receipt reads/changes (ADR 0784)', () => {
  it('counts declared reads and writes', () => {
    const effects = new Map<string, 'read' | 'write'>([['a', 'read'], ['b', 'write']]);
    expect(summarizeTurn(turn(['a', 'a', 'b', 'mcp_x']), effects)).toMatchObject({ tools: 4, reads: 2, writes: 1 });
  });

  it('says "2 reads · 1 change", and keeps an unknown tool as a neutral count', () => {
    known = { 'openwop:knowledge.search': 'read', 'openwop:kanban.add-todo': 'write' };
    render(<TurnReceipt message={turn(['openwop:knowledge.search', 'openwop:knowledge.search', 'openwop:kanban.add-todo', 'mcp__gh__issue'])} />);
    expect(screen.getByText('receiptReads:2')).toBeTruthy();
    expect(screen.getByText('receiptChanges:1')).toBeTruthy();
    expect(screen.getByText('receiptTools:1')).toBeTruthy();
  });

  it('with nothing known it is exactly the old neutral line', () => {
    render(<TurnReceipt message={turn(['x', 'y'])} />);
    expect(screen.getByText('receiptTools:2')).toBeTruthy();
    expect(screen.queryByText(/receiptReads|receiptChanges/)).toBeNull();
  });

  it('tags each tool row in the expanded receipt', () => {
    known = { r: 'read', w: 'write' };
    render(<TurnReceipt message={turn(['r', 'w', 'u'])} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('receiptEffectRead')).toBeTruthy();
    expect(screen.getByText('receiptEffectChange')).toBeTruthy();
    expect(document.querySelectorAll('.turn-receipt-effect')).toHaveLength(2);
  });
});
