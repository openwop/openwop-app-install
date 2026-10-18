/**
 * ADR 0773 — the three generic embed seams the builder's Pair tab relies on:
 *   - `beforeSend` runs at the ONE submit choke, and a refusal BLOCKS the turn
 *     (and shows why) — the can-see strip is honest only if this holds;
 *   - `prompt` is sent once per id through the same choke;
 *   - `onToolActivity` reports each call/return once (the SSE replays from seq 0).
 *
 * Sabotage witnesses (w43): a refusal that does not return or does not show its
 * reason, skipping beforeSend, a submit that bypasses runCoreSubmit, dropping the
 * once-per-id guard, the scoped/loading/absent readiness terms, the replay dedupe
 * (`prior === phase`), the returned phase, or the session id each turn a case red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import type { AgentToolCall, ChatMessage } from '../types.js';

const runCoreSubmit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../lib/chatSubmit.js', () => ({ runCoreSubmit: (...a: unknown[]) => runCoreSubmit(...a) }));

let messages: Array<Pick<ChatMessage, 'id' | 'agentEvents'>> = [];
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

import { EmbeddedConversation, type EmbedToolActivity } from '../EmbeddedConversation.js';

const config: BYOKActiveConfig = { provider: 'anthropic', model: 'claude-opus-5-5', credentialRef: 'byok:anthropic' };
const base = { agentId: 'a', config, onReconfigureBYOK: vi.fn() };

beforeEach(() => { runCoreSubmit.mockClear(); messages = []; mentions = { entries: [], isLoading: false }; scoped = false; });
afterEach(cleanup);

describe('ADR 0773 — embed pre-send gate', () => {
  it('a refused beforeSend blocks the turn and shows the reason', async () => {
    const beforeSend = vi.fn(async () => ({ ok: false as const, reason: 'Your edits are not saved yet.' }));
    render(<EmbeddedConversation {...base} beforeSend={beforeSend} />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(beforeSend).toHaveBeenCalledWith('sess-1', undefined));
    expect(await screen.findByText('Your edits are not saved yet.')).toBeTruthy();
    // Asserted AFTER the reason renders, i.e. after the verdict resolved — the
    // point at which a gate that only warned would already have submitted.
    expect(runCoreSubmit).not.toHaveBeenCalled();
  });

  it('an accepted beforeSend lets the turn through the one submit path', async () => {
    const beforeSend = vi.fn(async () => ({ ok: true as const }));
    render(<EmbeddedConversation {...base} beforeSend={beforeSend} />);
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(runCoreSubmit).toHaveBeenCalledTimes(1));
    expect(runCoreSubmit.mock.calls[0]?.[0]).toBe('hello'); // the composer's text, unaltered
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
    const onToolActivity = vi.fn<(activity: EmbedToolActivity) => void>();
    const onConversationId = vi.fn<(conversationId: string) => void>();
    // Each step is a FRESH array: the effect keys on `session.messages`, and the
    // SSE replay from seq 0 re-delivers rows the embed has already seen.
    const turn = (call: AgentToolCall): Array<Pick<ChatMessage, 'id' | 'agentEvents'>> =>
      [{ id: 'm1', agentEvents: { toolCalls: [call], handoffs: [], decisions: [] } }];
    const called: AgentToolCall = { callId: 'c1', toolName: 'openwop:x', agentId: 'a', startedAt: '2026-01-01T00:00:00.000Z' };
    const returned: AgentToolCall = { ...called, finishedAt: '2026-01-01T00:00:01.000Z' };
    const view = (): JSX.Element => <EmbeddedConversation {...base} onToolActivity={onToolActivity} onConversationId={onConversationId} />;
    messages = turn(called);
    const { rerender } = render(view());
    expect(onConversationId).toHaveBeenCalledWith('sess-1');
    messages = turn(called);    // replayed `called` — must not report again
    rerender(view());
    messages = turn(returned);
    rerender(view());
    messages = turn(returned);  // replayed `returned` — must not report again
    rerender(view());
    expect(onToolActivity.mock.calls.map(([activity]) => activity.phase)).toEqual(['called', 'returned']);
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

