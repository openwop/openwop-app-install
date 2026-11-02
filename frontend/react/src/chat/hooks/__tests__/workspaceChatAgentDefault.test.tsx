import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';
import type { AgentMentionEntry } from '../../lib/agentMentions.js';
import type { ConversationType } from '../../../client/chatSessionsClient.js';

/**
 * ADR 0975 D12 — in a workspace that declares a chat agent (KickTodo: KickBot), a
 * participant who types straight into the composer, with no `@mention`, reaches
 * that agent. Measured on kicktodo.com (2026-10-31 13:25:23Z): the same message
 * went to the generic assistant and was refused `runs:create`, because D11 admits
 * a viewer only to a conversation scoped to KickBot.
 *
 * Runs the real chain from the default to the wire call: `useDefaultChatAgent` →
 * the real `useActiveAgents` lineup inside the real `useChatSession` → the real
 * submit pipeline (`runCoreSubmit`) → `openConversationSession` (`agentScope`) and
 * the turn (`to`). Only the network seams are stubbed.
 *
 * Red when (sabotage-witnessed in the PR): the hook does not activate; it ignores
 * history (re-points an existing conversation); it runs while hydrating (a saved
 * empty conversation is then left on the assistant); it guards once per agent
 * instead of once per session (`/clear` loses it); an explicit scope or a typed
 * conversation does not win.
 */

vi.mock('../../../client/streamsClient.js', () => ({ subscribeToRun: () => ({ close: () => undefined }) }));
vi.mock('../../../client/runsClient.js', () => ({
  createRun: vi.fn(() => Promise.resolve({ runId: 'run-1', status: 'running', eventsUrl: '/v1/runs/run-1/events' })),
  cancelRun: vi.fn(() => Promise.resolve()),
  getRun: vi.fn(() => Promise.resolve({ status: 'running' })),
  pollEvents: vi.fn(() => Promise.resolve({ events: [], runId: 'run-1', lastSequence: 0, status: 'running', isTerminal: true })),
  getSdkClient: vi.fn(),
}));
vi.mock('../../../client/interruptsClient.js', () => ({
  listOpenInterrupts: vi.fn(() => Promise.resolve([])),
  resolveByRun: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../client/chatSessionsClient.js', () => ({
  createChatSession: vi.fn(() => Promise.resolve()),
  appendChatMessage: vi.fn(() => Promise.resolve()),
  listChatSessionMessages: vi.fn(() => Promise.resolve([])),
  listChatSessionMessagesPage: vi.fn(() => Promise.resolve({ messages: [], nextCursor: null })),
  setConversationRun: vi.fn(() => Promise.resolve()),
  updateChatMessage: vi.fn(() => Promise.resolve()),
  getSessionFeedback: vi.fn(() => Promise.resolve({})),
}));
type Transport = typeof import('../../conversationTransport.js');
const { openMock, turnMock } = vi.hoisted(() => ({
  openMock: vi.fn<Transport['openConversationSession']>(),
  turnMock: vi.fn<Transport['sendConversationTurn']>(),
}));
vi.mock('../../conversationTransport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../conversationTransport.js')>()),
  openConversationSession: openMock,
  sendConversationTurn: turnMock,
  fetchTurns: vi.fn(() => Promise.resolve({ turns: [], lastSeq: 0 })),
}));

import { useChatSession } from '../useChatSession.js';
import { listChatSessionMessagesPage } from '../../../client/chatSessionsClient.js';
import { useDefaultChatAgent, activeWorkspaceChatAgent } from '../../useWorkspaceChatAgent.js';
import { runCoreSubmit } from '../../lib/chatSubmit.js';
import { DEFAULT_ASSISTANT_ID } from '../../activeAgents/constants.js';

const CONFIG: BYOKActiveConfig = { provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free' };
const KICKBOT = 'user.kicktodo-guide';
const entry = (agentId: string, slug: string, displayName: string): AgentMentionEntry => ({
  agentId, slug, displayName, persona: displayName, description: '', packName: 'p', packVersion: '1.0.0', modelClass: 'chat',
});
const ENTRIES = [entry(KICKBOT, 'kickbot', 'KickBot'), entry('vendor.openwop-app.example.agents.coach', 'coach', 'Coach')];

interface Props { agentId: string | null; explicit?: string | null; type?: ConversationType; sessionId?: string }
function useHarness({ agentId, explicit = null, type, sessionId }: Props) {
  const cs = useChatSession(sessionId ? { sessionId } : undefined);
  useDefaultChatAgent({
    agentId, explicitScope: explicit, activateAgent: cs.activeAgents.activateAgent,
    agentEntries: ENTRIES, session: cs.session, isHydrating: cs.isHydrating, ...(type ? { conversationType: type } : {}),
  });
  return cs;
}
type Harness = ReturnType<typeof useHarness>;
const submit = (cs: Harness, text: string) => runCoreSubmit(text, undefined, {
  config: CONFIG, send: cs.send, reset: cs.reset, cancel: cs.cancel, emitSystem: cs.emitSystem,
  runWorkflowMention: cs.runWorkflowMention, activeAgents: cs.activeAgents, agentEntries: ENTRIES,
});
const turnTo = (call: number): unknown => (JSON.stringify(turnMock.mock.calls[call]).match(/"to":"([^"]+)"/) ?? [])[1];

beforeEach(() => {
  localStorage.clear();
  openMock.mockReset();
  openMock.mockResolvedValue({ runId: 'conv-run-1', nodeId: 'gate' });
  turnMock.mockReset();
  turnMock.mockResolvedValue({ turns: [
    { messageId: 'c:1:user', role: 'user', turnIndex: 1, from: 'user', content: 'hi', ts: 0 },
    { messageId: 'c:2:agent', role: 'agent', turnIndex: 2, from: KICKBOT, content: 'Start with one tiny habit.', ts: 0 },
  ], lastSeq: 2 });
});

describe('ADR 0975 D12 — the workspace chat agent is the default for a new chat', () => {
  it('HEADLINE: a message with no @mention opens a conversation scoped to KickBot and addresses the turn to it', async () => {
    const { result } = renderHook(() => useHarness({ agentId: KICKBOT }));
    await waitFor(() => expect(result.current.activeAgents.currentAgentId).toBe(KICKBOT)); // the header shows KickBot
    await act(async () => { await submit(result.current, 'What habits can I learn?'); });
    expect(openMock).toHaveBeenCalledOnce();
    expect(openMock.mock.calls[0]![0]).toMatchObject({ agentScope: KICKBOT });
    expect(turnTo(0)).toBe(KICKBOT);
  });

  it('a workspace that declares no chat agent is unchanged: the generic assistant, no agentScope', async () => {
    const { result } = renderHook(() => useHarness({ agentId: null }));
    await act(async () => { await submit(result.current, 'hello'); });
    expect(result.current.activeAgents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
    expect(openMock.mock.calls[0]![0]).not.toHaveProperty('agentScope');
    expect(turnTo(0)).toBeUndefined();
  });

  it('switching still works: an @mention routes to the named agent, and choosing the assistant is not undone', async () => {
    const { result } = renderHook(() => useHarness({ agentId: KICKBOT }));
    await waitFor(() => expect(result.current.activeAgents.currentAgentId).toBe(KICKBOT));
    act(() => { result.current.activeAgents.switchTo(DEFAULT_ASSISTANT_ID); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.activeAgents.currentAgentId, 'the user\'s choice stands').toBe(DEFAULT_ASSISTANT_ID);
    await act(async () => { await submit(result.current, '@coach plan my week'); });
    expect(openMock.mock.calls[0]![0]).toMatchObject({ agentScope: 'vendor.openwop-app.example.agents.coach' });
    expect(turnTo(0)).toBe('vendor.openwop-app.example.agents.coach');
  });

  it('an explicit scope (?agent=) wins, and a typed conversation (a channel) is never defaulted', async () => {
    const a = renderHook(() => useHarness({ agentId: KICKBOT, explicit: 'coach' }));
    const b = renderHook(() => useHarness({ agentId: KICKBOT, type: 'channel' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(a.result.current.activeAgents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
    expect(b.result.current.activeAgents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
  });

  it('a conversation with history is never re-pointed', async () => {
    const initialProps: Props = { agentId: null };
    const { result, rerender } = renderHook((p: Props) => useHarness(p), { initialProps });
    await act(async () => { await submit(result.current, 'hello'); }); // history, on the assistant
    rerender({ agentId: KICKBOT }); // the workspace answer arrives late
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.activeAgents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
  });

  it('a restored tab waits for its history: an EMPTY saved conversation opens on KickBot once it has loaded', async () => {
    // The tab is backend-keyed, so it hydrates first. Activating before the load
    // lands is overwritten by the loaded session, and would leave the tab on the
    // assistant for good (the once-per-session guard has already fired).
    let release!: () => void;
    vi.mocked(listChatSessionMessagesPage).mockImplementationOnce(() => new Promise((r) => { release = () => r({ messages: [], nextCursor: null }); }));
    const { result } = renderHook(() => useHarness({ agentId: KICKBOT, sessionId: 's-saved' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.isHydrating).toBe(true);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(result.current.activeAgents.currentAgentId).toBe(KICKBOT));
  });

  it('/clear starts a fresh chat that opens on KickBot again (once per SESSION, not per agent)', async () => {
    const { result } = renderHook(() => useHarness({ agentId: KICKBOT }));
    await waitFor(() => expect(result.current.activeAgents.currentAgentId).toBe(KICKBOT));
    act(() => { result.current.reset(); });
    await waitFor(() => expect(result.current.activeAgents.currentAgentId).toBe(KICKBOT));
    await act(async () => { await submit(result.current, 'again'); });
    expect(openMock.mock.calls.at(-1)![0]).toMatchObject({ agentScope: KICKBOT });
  });
});

describe('ADR 0975 D12 — only the ACTIVE workspace\'s declaration counts', () => {
  it('reads chatAgent from the active row, never another workspace\'s', () => {
    const workspaces = [
      { workspaceId: 'user:me', name: 'Me', slug: 'me', roles: ['owner'], kind: 'personal' as const, active: false },
      { workspaceId: 'host-kicktodo', name: 'KickTodo', slug: 'kicktodo', roles: ['viewer'], kind: 'shared' as const, active: true, chatAgent: KICKBOT },
    ];
    expect(activeWorkspaceChatAgent({ workspaces, active: 'host-kicktodo' })).toBe(KICKBOT);
    expect(activeWorkspaceChatAgent({ workspaces, active: 'user:me' })).toBeNull();
  });
});
