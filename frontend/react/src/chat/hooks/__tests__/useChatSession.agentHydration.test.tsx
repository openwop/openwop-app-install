import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScopeToAgent } from '../../activeAgents/useScopeToAgent.js';
import type { AgentMentionEntry } from '../../lib/agentMentions.js';
import { useChatSession } from '../useChatSession.js';
import { listChatSessionMessagesPage } from '../../../client/chatSessionsClient.js';

/**
 * STRATEGIST-1, ADR 0140 §CORRECTION 2026-11-06 (G3 agent-scoped hydration).
 * Campaign Strategist deep-link regression: actual session hydration and agent
 * activation hooks share one session. Only the HTTP clients are replaced; no
 * model request is made. A late empty history read must not erase the explicit
 * agent selected while that read was pending, or a later deliberate user choice.
 * Breaks if: the hydration updater replaces the same session's `activeAgents`
 * (cases 1, 3, 4); it keeps them for a DIFFERENT session id (case 5); scoping
 * gives up before the catalog entry arrives (case 2); scoping re-runs without its
 * once-per-agent guard (an unbounded effect loop, caught by RENDER_BOUND below as a
 * named red instead of a hang). `activateAgent` dedupes, so the lineup length checks
 * prove presence, not "exactly once".
 */
vi.mock('../../../client/chatSessionsClient.js', () => ({
  createChatSession: vi.fn(async () => undefined),
  appendChatMessage: vi.fn(async () => undefined),
  updateChatMessage: vi.fn(async () => undefined),
  listChatSessionMessagesPage: vi.fn(),
  getSessionFeedback: vi.fn(async () => ({})),
}));
vi.mock('../../../client/streamsClient.js', () => ({
  subscribeToRun: () => ({ close: vi.fn() }),
}));
vi.mock('../../../client/runsClient.js', () => ({
  createRun: vi.fn(), cancelRun: vi.fn(), getRun: vi.fn(), pollEvents: vi.fn(), getSdkClient: vi.fn(),
}));
vi.mock('../../../client/interruptsClient.js', () => ({
  listOpenInterrupts: vi.fn(async () => []), resolveByRun: vi.fn(),
}));

type History = Awaited<ReturnType<typeof listChatSessionMessagesPage>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const strategist: AgentMentionEntry = {
  agentId: 'vendor.openwop-app.campaign-orchestration.agents.campaign-strategist',
  displayName: 'Campaign Strategist', persona: 'RESEARCH', slug: 'research-9',
  description: 'Chat-driven Campaign Studio orchestrator',
  packName: 'vendor.openwop-app.campaign-orchestration.agents', packVersion: '1.4.2', modelClass: 'research',
};
const other: AgentMentionEntry = { ...strategist, agentId: 'user.qa.explicit-choice', displayName: 'Chosen advisor', slug: 'chosen-advisor' };
const emptyHistory: History = { messages: [], nextCursor: null };
interface Props { entries: readonly AgentMentionEntry[]; scope: string | null }
// A real scoping pass renders a handful of times; a re-activation loop renders forever
// and starves waitFor's timers, so it must fail by name rather than hang the gate.
const RENDER_BOUND = 200;
function useScopedSession({ entries, scope }: Props) {
  const renders = useRef(0);
  renders.current += 1;
  if (renders.current > RENDER_BOUND) throw new Error(`Scoping render loop: more than ${RENDER_BOUND} renders`);
  const chat = useChatSession({ sessionId: 'existing-new-tab' });
  useScopeToAgent(chat.activeAgents, entries, scope);
  return chat;
}
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(cleanup);

describe('explicit agent survives asynchronous session initialization', () => {
  it('retains the resolved Strategist when the empty history arrives after activation', async () => {
    const history = deferred<History>();
    vi.mocked(listChatSessionMessagesPage).mockReturnValue(history.promise);
    const tab = renderHook(useScopedSession, { initialProps: { entries: [strategist], scope: strategist.agentId } });
    await waitFor(() => expect(tab.result.current.activeAgents.currentAgentId).toBe(strategist.agentId));
    expect(tab.result.current.isHydrating).toBe(true);
    await act(async () => { history.resolve(emptyHistory); await history.promise; });
    await waitFor(() => expect(tab.result.current.isHydrating).toBe(false));
    expect(tab.result.current.session.messages).toEqual([]);
    expect(tab.result.current.activeAgents.currentAgentId).toBe(strategist.agentId);
    expect(tab.result.current.activeAgents.lineup.filter((row) => row.agentId === strategist.agentId)).toHaveLength(1);
  });

  it('also scopes once when history finishes before the catalog entry arrives', async () => {
    vi.mocked(listChatSessionMessagesPage).mockResolvedValue(emptyHistory);
    const tab = renderHook(useScopedSession, { initialProps: { entries: [] as readonly AgentMentionEntry[], scope: strategist.agentId } });
    await waitFor(() => expect(tab.result.current.isHydrating).toBe(false));
    tab.rerender({ entries: [strategist], scope: strategist.agentId });
    await waitFor(() => expect(tab.result.current.activeAgents.currentAgentId).toBe(strategist.agentId));
    tab.rerender({ entries: [strategist], scope: strategist.agentId });
    expect(tab.result.current.activeAgents.lineup.filter((row) => row.agentId === strategist.agentId)).toHaveLength(1);
  });

  it('retains a later explicit user choice instead of reactivating the original scope', async () => {
    const history = deferred<History>();
    vi.mocked(listChatSessionMessagesPage).mockReturnValue(history.promise);
    const tab = renderHook(useScopedSession, { initialProps: { entries: [strategist, other], scope: strategist.agentId } });
    await waitFor(() => expect(tab.result.current.activeAgents.currentAgentId).toBe(strategist.agentId));
    act(() => { tab.result.current.activeAgents.activateAgent(other); });
    expect(tab.result.current.activeAgents.currentAgentId).toBe(other.agentId);
    await act(async () => { history.resolve(emptyHistory); await history.promise; });
    await waitFor(() => expect(tab.result.current.isHydrating).toBe(false));
    expect(tab.result.current.activeAgents.currentAgentId).toBe(other.agentId);
    expect(tab.result.current.activeAgents.lineup.filter((row) => row.agentId === other.agentId)).toHaveLength(1);
  });

  it('does not override an existing user-selected lineup on a repeated same-session read', async () => {
    vi.mocked(listChatSessionMessagesPage).mockResolvedValue(emptyHistory);
    const tab = renderHook(useScopedSession, { initialProps: { entries: [strategist, other], scope: null } });
    await waitFor(() => expect(tab.result.current.isHydrating).toBe(false));
    act(() => { tab.result.current.activeAgents.activateAgent(other); });
    expect(tab.result.current.activeAgents.currentAgentId).toBe(other.agentId);
    await act(async () => { await tab.result.current.loadSessionFromBackend('existing-new-tab'); });
    expect(tab.result.current.activeAgents.currentAgentId).toBe(other.agentId);
    expect(tab.result.current.activeAgents.lineup.filter((row) => row.agentId === other.agentId)).toHaveLength(1);
  });

  it('does not carry the prior session agent into a different loaded conversation', async () => {
    vi.mocked(listChatSessionMessagesPage).mockResolvedValue(emptyHistory);
    const tab = renderHook(useScopedSession, { initialProps: { entries: [strategist, other], scope: null } });
    await waitFor(() => expect(tab.result.current.isHydrating).toBe(false));
    act(() => { tab.result.current.activeAgents.activateAgent(other); });
    expect(tab.result.current.activeAgents.currentAgentId).toBe(other.agentId);
    await act(async () => { await tab.result.current.loadSessionFromBackend('another-conversation'); });
    expect(tab.result.current.session.id).toBe('another-conversation');
    expect(tab.result.current.activeAgents.lineup.some((row) => row.agentId === other.agentId)).toBe(false);
    expect(tab.result.current.session.activeAgents).toBeUndefined();
  });

});
