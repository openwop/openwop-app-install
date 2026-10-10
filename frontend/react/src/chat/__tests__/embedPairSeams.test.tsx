/**
 * ADR 0773 — the three generic embed seams the builder's Pair tab relies on:
 *   - `beforeSend` runs at the ONE submit choke, and a refusal BLOCKS the turn
 *     (and shows why) — the can-see strip is honest only if this holds;
 *   - `prompt` is sent once per id through the same choke;
 *   - `onToolActivity` reports each call/return once (the SSE replays from seq 0).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const runCoreSubmit = vi.fn(async () => undefined);
vi.mock('../lib/chatSubmit.js', () => ({ runCoreSubmit: (...a: unknown[]) => runCoreSubmit(...(a as [])) }));

let messages: unknown[] = [];
vi.mock('../hooks/useChatSession.js', () => ({
  useChatSession: () => ({
    session: { id: 'sess-1', messages },
    isSending: false, error: null, send: vi.fn(), cancel: vi.fn(), reset: vi.fn(), resolveInterrupt: vi.fn(),
    runWorkflowMention: vi.fn(), regenerate: vi.fn(), setFeedback: vi.fn(), hasOlderMessages: false,
    isLoadingEarlier: false, loadEarlierMessages: vi.fn(), activeAgents: [],
  }),
}));
// Controllable per test: the agent catalog's state and whether scoping landed.
let mentions: { entries: Array<{ agentId: string; slug: string }>; isLoading: boolean } = { entries: [], isLoading: false };
let scoped = false;
vi.mock('../lib/agentMentions.js', () => ({ useAgentMentions: () => mentions }));
vi.mock('../activeAgents/useScopeToAgent.js', () => ({ useScopeToAgent: () => scoped }));
vi.mock('../reviews/ConversationReviewsStrip.js', () => ({ ConversationReviewsStrip: () => null }));
vi.mock('../ContinueInFullChat.js', () => ({ ContinueInFullChat: () => null }));
vi.mock('../ConversationView.js', () => ({
  ConversationView: ({ onSend, footerSlot }: { onSend: (t: string) => Promise<void>; footerSlot?: ReactNode }) => (
    <div>
      <button type="button" onClick={() => { void onSend('hello'); }}>send</button>
      {footerSlot}
    </div>
  ),
}));

import { EmbeddedConversation } from '../EmbeddedConversation.js';

const config = { provider: 'anthropic', model: 'claude-opus-5-5' } as never;
const base = { agentId: 'a', config, onReconfigureBYOK: vi.fn() };

beforeEach(() => { runCoreSubmit.mockClear(); messages = []; mentions = { entries: [], isLoading: false }; scoped = false; });
afterEach(cleanup);

describe('ADR 0773 — embed pre-send gate', () => {
  it('a refused beforeSend blocks the turn and shows the reason', async () => {
    const beforeSend = vi.fn(async () => ({ ok: false as const, reason: 'Your edits are not saved yet.' }));
    render(<EmbeddedConversation {...base} beforeSend={beforeSend} />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(beforeSend).toHaveBeenCalledWith('sess-1', undefined));
    expect(runCoreSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText('Your edits are not saved yet.')).toBeTruthy();
  });

  it('an accepted beforeSend lets the turn through the one submit path', async () => {
    const beforeSend = vi.fn(async () => ({ ok: true as const }));
    render(<EmbeddedConversation {...base} beforeSend={beforeSend} />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(runCoreSubmit).toHaveBeenCalledTimes(1));
  });

  it('a consumer prompt is sent once per id, through beforeSend', async () => {
    const beforeSend = vi.fn(async () => ({ ok: true as const }));
    const { rerender } = render(<EmbeddedConversation {...base} beforeSend={beforeSend} prompt={{ id: 1, text: 'Explain' }} />);
    await waitFor(() => expect(runCoreSubmit).toHaveBeenCalledTimes(1));
    rerender(<EmbeddedConversation {...base} beforeSend={beforeSend} prompt={{ id: 1, text: 'Explain' }} />);
    await act(async () => { await Promise.resolve(); });
    expect(runCoreSubmit).toHaveBeenCalledTimes(1);
    expect(beforeSend).toHaveBeenCalledTimes(1);
  });

  it('reports each tool call and return once, and the session id', async () => {
    const onToolActivity = vi.fn();
    const onConversationId = vi.fn();
    messages = [{ id: 'm1', agentEvents: { toolCalls: [{ callId: 'c1', toolName: 'openwop:x', agentId: 'a', startedAt: 't' }], handoffs: [], decisions: [] } }];
    const { rerender } = render(<EmbeddedConversation {...base} onToolActivity={onToolActivity} onConversationId={onConversationId} />);
    expect(onConversationId).toHaveBeenCalledWith('sess-1');
    messages = [{ id: 'm1', agentEvents: { toolCalls: [{ callId: 'c1', toolName: 'openwop:x', agentId: 'a', startedAt: 't', finishedAt: 'u' }], handoffs: [], decisions: [] } }];
    rerender(<EmbeddedConversation {...base} onToolActivity={onToolActivity} onConversationId={onConversationId} />);
    rerender(<EmbeddedConversation {...base} onToolActivity={onToolActivity} onConversationId={onConversationId} />);
    expect(onToolActivity.mock.calls.map((c) => (c[0] as { phase: string }).phase)).toEqual(['called', 'returned']);
  });
});

describe('ADR 0773 — a prompt waits for the embed to be scoped to its agent', () => {
  // Measured: the builder's empty-sheet "Draft it", clicked right after load,
  // reached the model with tools=0 — the prompt went out before the agent
  // catalog loaded, i.e. as plain chat without the Architect's tools.
  it('holds the prompt while the catalog loads and until the agent is scoped, then sends it once', async () => {
    mentions = { entries: [], isLoading: true };
    const { rerender } = render(<EmbeddedConversation {...base} prompt={{ id: 7, text: 'Draft it' }} />);
    await act(async () => { await Promise.resolve(); });
    expect(runCoreSubmit).not.toHaveBeenCalled();
    // The catalog lands with the agent in it, but scoping has not happened yet.
    mentions = { entries: [{ agentId: 'a', slug: 'a' }], isLoading: false };
    rerender(<EmbeddedConversation {...base} prompt={{ id: 7, text: 'Draft it' }} />);
    await act(async () => { await Promise.resolve(); });
    expect(runCoreSubmit, 'sent before the agent was scoped').not.toHaveBeenCalled();
    scoped = true;
    rerender(<EmbeddedConversation {...base} prompt={{ id: 7, text: 'Draft it' }} />);
    await waitFor(() => expect(runCoreSubmit).toHaveBeenCalledTimes(1));
  });

  it('does not hold it forever when the agent is not in the catalog', async () => {
    mentions = { entries: [{ agentId: 'other', slug: 'other' }], isLoading: false };
    render(<EmbeddedConversation {...base} prompt={{ id: 8, text: 'Draft it' }} />);
    await waitFor(() => expect(runCoreSubmit).toHaveBeenCalledTimes(1));
  });
});

