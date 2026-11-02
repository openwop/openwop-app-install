import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';
import type { MyWorkspaces } from '../../../client/workspaceClient.js';

/**
 * ADR 0975 D12 — the deck hands every tab the ACTIVE workspace's declared chat
 * agent, so each TabSession can open its empty plain chat on it
 * (`useDefaultChatAgent`, pinned end to end in
 * `hooks/__tests__/workspaceChatAgentDefault.test.tsx`). Breaks if the deck stops
 * reading it, reads another workspace's row, or passes it where none is declared.
 */

const KICKBOT = 'user.kicktodo-guide';
const ws = vi.hoisted(() => ({ value: null as MyWorkspaces | null }));
vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/workspaceClient.js')>()),
  listMyWorkspaces: async () => ws.value!,
}));
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId, defaultAgentId }: { sessionId: string; defaultAgentId?: string }) =>
    <div data-testid="tabsession" data-sid={sessionId} data-default={defaultAgentId ?? ''} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({ useChatSessions: () => sessionsStub() }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../../conversations/useRunningConversations.js', () => ({ useRunningConversations: () => new Set<string>() }));
vi.mock('../../reviews/reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reviews/reviewClient.js')>()),
  listReviews: async () => [],
  getReview: async () => { throw new Error('not used in this test'); },
}));

import { TabChatDeck } from '../TabChatDeck.js';

const row = (o: Partial<ChatSessionHeader> & { sessionId: string }): ChatSessionHeader => ({
  tenantId: 't1', title: 'New chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1, ...o,
});
function sessionsStub(over: Partial<UseChatSessionsResult> = {}): UseChatSessionsResult {
  return {
    sessions: [], isLoading: false, error: null,
    refresh: vi.fn(async () => undefined),
    createSession: vi.fn(async () => row({ sessionId: 'created' })),
    openWith: vi.fn(async () => row({ sessionId: 'opened' })),
    createConversation: vi.fn(async () => row({ sessionId: 'conversation' })),
    openWorkspace: vi.fn(async () => null),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    attachBoard: vi.fn(async () => undefined),
    addParticipant: vi.fn(async () => undefined),
    removeParticipant: vi.fn(async () => undefined),
    ...over,
  };
}
const CONFIG: BYOKActiveConfig = { provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free' };
const PERSONAL = { workspaceId: 'user:u1', name: 'Me', slug: 'me', roles: ['owner'], kind: 'personal' as const, active: false };
const KICKTODO = { workspaceId: 'host-kicktodo', name: 'KickTodo', slug: 'kicktodo', roles: ['viewer'], kind: 'shared' as const, active: false, chatAgent: KICKBOT };
const renderDeck = () => render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>);
const defaults = () => screen.getAllByTestId('tabsession').map((el) => el.getAttribute('data-default'));

beforeEach(() => { localStorage.clear(); });
afterEach(() => cleanup());

describe('ADR 0975 D12 — the deck passes the active workspace\'s chat agent to its tabs', () => {
  it('in the participant workspace, the new tab is handed KickBot', async () => {
    ws.value = { workspaces: [PERSONAL, { ...KICKTODO, active: true }], active: 'host-kicktodo', personal: 'user:u1' };
    await act(async () => { renderDeck(); });
    await waitFor(() => expect(defaults()).toEqual([KICKBOT]));
  });

  it('in another workspace (the declaring one only listed, not active), no tab is handed a default', async () => {
    ws.value = { workspaces: [{ ...PERSONAL, active: true }, KICKTODO], active: 'user:u1', personal: 'user:u1' };
    await act(async () => { renderDeck(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(defaults()).toEqual(['']);
  });
});
