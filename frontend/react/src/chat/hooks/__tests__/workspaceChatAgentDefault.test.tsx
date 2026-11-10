import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';
import type { AgentMentionEntry } from '../../lib/agentMentions.js';
import type { ChatMessagePersisted, ConversationType } from '../../../client/chatSessionsClient.js';

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
 * Red when (sabotage-witnessed, w93): the hook does not activate; it ignores
 * history (re-points an existing conversation); it runs while hydrating (a saved
 * conversation WITH history looks empty until it loads, and since e907b2fef the
 * load keeps an activation made meanwhile, so it would be re-pointed); it guards
 * once per agent instead of once per session (`/clear` loses it); it re-activates
 * after the user chose the assistant (a catalog refresh re-runs the effect); an
 * explicit scope or a typed conversation does not win; it reads a non-active
 * workspace's declaration.
 * Recorded double guard: with no declared agent, both `!agentId` and the entry
 * lookup stop activation, so dropping either alone stays green (structural).
 */

vi.mock('../../../client/streamsClient.js', () => ({ subscribeToRun: () => ({ close: () => undefined }) }));
// The workflow-run lane is never reached here (no workflow mention, no
// workflow_run message): its stubs THROW, so reaching it reds the case instead
// of riding an untyped fake.
type Runs = typeof import('../../../client/runsClient.js');
type Interrupts = typeof import('../../../client/interruptsClient.js');
const unreached = (what: string): never => { throw new Error(`${what} is not reached by a conversation turn`); };
vi.mock('../../../client/runsClient.js', () => ({
  createRun: vi.fn<Runs['createRun']>(async () => unreached('createRun')),
  cancelRun: vi.fn<Runs['cancelRun']>(async () => unreached('cancelRun')),
  getRun: vi.fn<Runs['getRun']>(async () => unreached('getRun')),
  pollEvents: vi.fn<Runs['pollEvents']>(async () => unreached('pollEvents')),
  getSdkClient: vi.fn<Runs['getSdkClient']>(() => unreached('getSdkClient')),
}));
vi.mock('../../../client/interruptsClient.js', () => ({
  listOpenInterrupts: vi.fn<Interrupts['listOpenInterrupts']>(async () => unreached('listOpenInterrupts')),
  resolveByRun: vi.fn<Interrupts['resolveByRun']>(async () => unreached('resolveByRun')),
}));
type ChatSessions = typeof import('../../../client/chatSessionsClient.js');
vi.mock('../../../client/chatSessionsClient.js', () => ({
  // Typed against the real client, so a fixture cannot drift from its shape.
  createChatSession: vi.fn<ChatSessions['createChatSession']>(async (opts) => ({ sessionId: opts?.sessionId ?? 's-new', tenantId: 't1', title: opts?.title ?? 'New chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 })),
  appendChatMessage: vi.fn<ChatSessions['appendChatMessage']>(async (sessionId, msg) => ({ messageId: msg.messageId, sessionId, role: 'user', content: msg.content, meta: msg.meta ?? null, createdAt: '2026-01-01T00:00:00.000Z' })),
  listChatSessionMessages: vi.fn<ChatSessions['listChatSessionMessages']>(async () => []),
  listChatSessionMessagesPage: vi.fn<ChatSessions['listChatSessionMessagesPage']>(async () => ({ messages: [], nextCursor: null })),
  setConversationRun: vi.fn<ChatSessions['setConversationRun']>(async () => undefined),
  updateChatMessage: vi.fn<ChatSessions['updateChatMessage']>(async () => undefined),
  getSessionFeedback: vi.fn<ChatSessions['getSessionFeedback']>(async () => ({})),
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
const KICKBOT = 'user.acme-guide';
const entry = (agentId: string, slug: string, displayName: string): AgentMentionEntry => ({
  agentId, slug, displayName, persona: displayName, description: '', packName: 'p', packVersion: '1.0.0', modelClass: 'chat',
});
const ENTRIES = [entry(KICKBOT, 'kickbot', 'KickBot'), entry('vendor.openwop-app.example.agents.coach', 'coach', 'Coach')];

interface Props { agentId: string | null; explicit?: string | null; type?: ConversationType; sessionId?: string; entries?: readonly AgentMentionEntry[] }
function useHarness({ agentId, explicit = null, type, sessionId, entries = ENTRIES }: Props) {
  const cs = useChatSession(sessionId ? { sessionId } : undefined);
  useDefaultChatAgent({
    agentId, explicitScope: explicit, activateAgent: cs.activeAgents.activateAgent,
    agentEntries: entries, session: cs.session, isHydrating: cs.isHydrating, ...(type ? { conversationType: type } : {}),
  });
  return cs;
}
type Harness = ReturnType<typeof useHarness>;
const submit = (cs: Harness, text: string) => runCoreSubmit(text, undefined, {
  config: CONFIG, send: cs.send, reset: cs.reset, cancel: cs.cancel, emitSystem: cs.emitSystem,
  runWorkflowMention: cs.runWorkflowMention, activeAgents: cs.activeAgents, agentEntries: ENTRIES,
});
const turnTo = (call: number): string | undefined => turnMock.mock.calls[call]?.[2].to;

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
    const initialProps: Props = { agentId: KICKBOT };
    const { result, rerender } = renderHook((p: Props) => useHarness(p), { initialProps });
    await waitFor(() => expect(result.current.activeAgents.currentAgentId).toBe(KICKBOT));
    act(() => { result.current.activeAgents.switchTo(DEFAULT_ASSISTANT_ID); });
    // A catalog refresh re-runs the effect while the chat is still empty: only the
    // once-per-session guard keeps the user's choice.
    rerender({ agentId: KICKBOT, entries: [...ENTRIES] });
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
    // The tab is backend-keyed, so it hydrates first; once the (empty) history
    // lands, the default applies. Positive half of the hydration claim; the
    // case below is the half the isHydrating guard alone holds.
    let release!: () => void;
    vi.mocked(listChatSessionMessagesPage).mockImplementationOnce(() => new Promise((r) => { release = () => r({ messages: [], nextCursor: null }); }));
    const { result } = renderHook(() => useHarness({ agentId: KICKBOT, sessionId: 's-saved' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.isHydrating).toBe(true);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(result.current.activeAgents.currentAgentId).toBe(KICKBOT));
  });

  it('a restored tab WITH history is not re-pointed while it loads', async () => {
    // While hydrating, the session looks empty. The load keeps an activation made
    // meanwhile (e907b2fef, ADR 0140 G3), so only the isHydrating guard stops the
    // default from re-pointing a conversation that already has history.
    let release!: () => void;
    const history: ChatMessagePersisted[] = [{ messageId: 'm-1', sessionId: 's-history', role: 'user', content: 'an earlier question', meta: null, createdAt: '2026-01-01T00:00:00.000Z' }];
    vi.mocked(listChatSessionMessagesPage).mockImplementationOnce(() => new Promise((r) => { release = () => r({ messages: history, nextCursor: null }); }));
    const { result } = renderHook(() => useHarness({ agentId: KICKBOT, sessionId: 's-history' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.isHydrating).toBe(true);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(result.current.isHydrating).toBe(false));
    expect(result.current.session.messages).toHaveLength(1); // the history landed
    expect(result.current.activeAgents.currentAgentId).toBe(DEFAULT_ASSISTANT_ID);
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
      { workspaceId: 'host-acme', name: 'Acme', slug: 'acme', roles: ['viewer'], kind: 'shared' as const, active: true, chatAgent: KICKBOT },
    ];
    expect(activeWorkspaceChatAgent({ workspaces, active: 'host-acme' })).toBe(KICKBOT);
    expect(activeWorkspaceChatAgent({ workspaces, active: 'user:me' })).toBeNull();
  });
});
