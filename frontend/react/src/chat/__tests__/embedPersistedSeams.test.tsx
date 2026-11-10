/**
 * ADR 1040 D1/D3 — the persisted, agent-scoped embed and its consumer chrome.
 *
 *  - Which conversation is open is FROZEN per mount: echoing the embed's own
 *    reported id back (URL sync) changes nothing, even under StrictMode; a
 *    different id opens it; going back to no id starts a fresh one.
 *  - A persisted embed runs the session DETACHED and stamps `agent:<agentId>`;
 *    a default embed stays ephemeral, exactly as before.
 *  - Composer wording / modifiers reach the view; "Continue in full chat" can
 *    be hidden; tool rows show a consumer's label (display only).
 *
 * Red when: EmbeddedConversation passes the live `conversationId` prop to the
 * hook (or drops the echo guard); the detached/participants options are not
 * passed; the composer props are not forwarded; `hideContinueInFullChat` is
 * ignored; or ToolCallCard stops reading `ToolLabelsContext`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { StrictMode, useState, type ReactNode } from 'react';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import type { AgentToolCall } from '../types.js';

type Opts = { persist?: boolean; detached?: boolean; sessionId?: string; participants?: readonly string[] };
const hookCalls: Opts[] = [];
// Each MOUNT of the session mints its own id (as the real hook does), so a
// spurious remount is visible as a second id.
let minted = 0;
let hydrating = false;
vi.mock('../hooks/useChatSession.js', () => ({
  useChatSession: (opts: Opts) => {
    hookCalls.push(opts);
    const [id] = useState(() => opts.sessionId ?? `minted-${++minted}`);
    return {
      session: { id, messages: [] },
      isSending: false, isHydrating: hydrating, error: null, send: vi.fn(), cancel: vi.fn(), reset: vi.fn(), resolveInterrupt: vi.fn(),
      runWorkflowMention: vi.fn(), regenerate: vi.fn(), setFeedback: vi.fn(), hasOlderMessages: false,
      isLoadingEarlier: false, loadEarlierMessages: vi.fn(), activeAgents: [],
    };
  },
}));
vi.mock('../lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: [], isLoading: false }) }));
vi.mock('../activeAgents/useScopeToAgent.js', () => ({ useScopeToAgent: () => true }));
vi.mock('../reviews/ConversationReviewsStrip.js', () => ({ ConversationReviewsStrip: () => null }));
vi.mock('../ContinueInFullChat.js', () => ({ ContinueInFullChat: () => <span>continue-in-full-chat</span> }));
let viewProps: Record<string, unknown> = {};
vi.mock('../ConversationView.js', () => ({
  ConversationView: (p: Record<string, unknown> & { footerSlot?: ReactNode }) => { viewProps = p; return <div>{p.footerSlot}</div>; },
}));

import { EmbeddedConversation } from '../EmbeddedConversation.js';
import { ToolCallCard } from '../AgentEventCards.js';
import { ToolLabelsContext } from '../lib/toolLabels.js';

const config: BYOKActiveConfig = { provider: 'anthropic', model: 'claude-opus-5-5', credentialRef: 'byok:anthropic' };
const base = { agentId: 'host:guide', config, onReconfigureBYOK: vi.fn() };
const sessionIds = (): Array<string | undefined> => [...new Set(hookCalls.map((o) => o.sessionId))];

beforeEach(() => { hookCalls.length = 0; minted = 0; hydrating = false; viewProps = {}; });
afterEach(cleanup);

describe('ADR 1040 D1 — the opened conversation is frozen per mount', () => {
  it('echoing the embed\'s own id back never reaches the hook (no mode flip), under StrictMode', async () => {
    const onConversationId = vi.fn();
    const ui = (id?: string) => (
      <StrictMode><EmbeddedConversation {...base} persist {...(id ? { conversationId: id } : {})} onConversationId={onConversationId} /></StrictMode>
    );
    const { rerender } = render(ui());
    await act(async () => { await Promise.resolve(); });
    const first = onConversationId.mock.calls.at(-1)?.[0] as string;
    rerender(ui(first)); // the consumer synced its URL and passes the id back
    await act(async () => { await Promise.resolve(); });
    expect(sessionIds()).toEqual([undefined]);
    // ONE session for the whole life of the embed: no StrictMode remount, no
    // remount on the echo (each mount would mint and report a new id).
    expect(new Set(onConversationId.mock.calls.map((c) => c[0] as string))).toEqual(new Set([first]));
    expect(hookCalls.every((o) => o.detached === true && o.persist === true)).toBe(true);
  });

  it('a DIFFERENT id opens that conversation; clearing it starts a fresh one', async () => {
    const { rerender } = render(<EmbeddedConversation {...base} persist />);
    rerender(<EmbeddedConversation {...base} persist conversationId="other-7" />);
    await act(async () => { await Promise.resolve(); });
    expect(hookCalls.at(-1)?.sessionId).toBe('other-7');
    hookCalls.length = 0;
    rerender(<EmbeddedConversation {...base} persist />);
    await act(async () => { await Promise.resolve(); });
    expect(hookCalls.length).toBeGreaterThan(0);
    expect(hookCalls.at(-1)?.sessionId).toBeUndefined();
  });

  it('opening an id passed on mount is backend-keyed, detached and agent-stamped', () => {
    render(<EmbeddedConversation {...base} conversationId="saved-3" />);
    expect(hookCalls.at(-1)).toEqual({ persist: true, detached: true, participants: ['agent:host:guide'], sessionId: 'saved-3' });
  });

  it('a reopened conversation shows the loading state while it hydrates', () => {
    hydrating = true;
    render(<EmbeddedConversation {...base} conversationId="saved-4" />);
    expect(viewProps.isHydrating).toBe(true);
  });

  it('changing the agent starts a session for that agent', async () => {
    const onConversationId = vi.fn();
    const { rerender } = render(<EmbeddedConversation {...base} persist onConversationId={onConversationId} />);
    rerender(<EmbeddedConversation {...base} agentId="host:other" persist onConversationId={onConversationId} />);
    await act(async () => { await Promise.resolve(); });
    expect(hookCalls.at(-1)?.participants).toEqual(['agent:host:other']);
    expect(new Set(onConversationId.mock.calls.map((c) => c[0] as string)).size).toBe(2);
  });

  it('a default embed stays ephemeral (unchanged)', () => {
    render(<EmbeddedConversation {...base} />);
    expect(hookCalls.at(-1)).toEqual({ persist: false });
  });
});

describe('ADR 1040 D3 — the consumer owns the chrome', () => {
  it('forwards composer wording and modifiers', () => {
    render(<EmbeddedConversation {...base} composerPlaceholder="Ask about your book" composerModifiers={<span>mods</span>} />);
    expect(viewProps.composerPlaceholder).toBe('Ask about your book');
    expect(viewProps.composerModifiers).toBeTruthy();
  });

  it('"Continue in full chat" shows by default and hides on request', () => {
    render(<EmbeddedConversation {...base} />);
    expect(screen.queryByText('continue-in-full-chat')).toBeTruthy();
    cleanup();
    render(<EmbeddedConversation {...base} hideContinueInFullChat />);
    expect(screen.queryByText('continue-in-full-chat')).toBeNull();
  });

  it('a tool row shows the consumer\'s label; an unlabelled one keeps its id', () => {
    const call = (toolName: string): AgentToolCall => ({ callId: toolName, toolName, agentId: 'agent-1', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' });
    render(
      <ToolLabelsContext.Provider value={{ 'feature.bookai.nodes.get-book': 'Read your book' }}>
        <ToolCallCard call={call('feature.bookai.nodes.get-book')} />
        <ToolCallCard call={call('openwop:documents.get')} />
      </ToolLabelsContext.Provider>,
    );
    expect(screen.getByText('Read your book')).toBeTruthy();
    expect(screen.queryByText('feature.bookai.nodes.get-book')).toBeNull();
    expect(screen.getByText('openwop:documents.get')).toBeTruthy();
  });
});
