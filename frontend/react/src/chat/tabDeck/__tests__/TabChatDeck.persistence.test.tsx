import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { saveTabDeck } from '../tabDeckPersistence.js';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

/**
 * ADR 0140 P6 deck-level integration: restore + lazy-mount-then-keep-alive + dead-tab
 * prune. TabSession is stubbed (presence == mounted) so the test targets the deck's
 * mount/prune behaviour, not the conversation machinery. The stub also LOGS every
 * mount, because "never mounted" (no doomed history fetch) is not the same claim as
 * "not mounted at the end" — a tab can mount and then be pruned. Breaks if restored
 * background tabs mount eagerly, the prune is skipped or runs mid-load, a kind tab
 * is pruned, or the mount gate lets a restored tab mount before the list confirms it.
 */

const mountLog = vi.hoisted((): string[] => []);
// ADR 0978 D4 — the deck resolves the active workspace before it restores.
vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/workspaceClient.js')>()),
  listMyWorkspaces: async () => ({ workspaces: [], active: 'ws-test', personal: 'ws-test' }),
}));
vi.mock('../TabSession.js', async () => {
  const { useEffect } = await import('react');
  return {
    TabSession: ({ sessionId }: { sessionId: string }) => {
      useEffect(() => { mountLog.push(sessionId); }, [sessionId]);
      return <div data-testid="tabsession" data-sid={sessionId} />;
    },
  };
});
// Configurable sessions mock (drives the dead-tab prune).
let sessionsState: Pick<UseChatSessionsResult, 'sessions' | 'isLoading' | 'error'> = { sessions: [], isLoading: false, error: null };
vi.mock('../../hooks/useChatSessions.js', () => ({ useChatSessions: () => sessionsStub(sessionsState) }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../../conversations/useRunningConversations.js', () => ({ useRunningConversations: () => new Set<string>() }));
vi.mock('../../reviews/reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reviews/reviewClient.js')>()),
  listReviews: async () => [],
  getReview: async () => { throw new Error('not used in this test'); },
}));

import { TabChatDeck } from '../TabChatDeck.js';

// Typed stand-ins for the deck's server reads (X4/X3): every UseChatSessionsResult
// member, production-shaped rows, and the two other server reads the deck makes
// (the reviews inbox poll and the running-conversations poll) — never live (ADR 0661).
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
const CONFIG: BYOKActiveConfig = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' };
const mountedSids = () => screen.queryAllByTestId('tabsession').map((el) => el.getAttribute('data-sid'));

beforeEach(() => {
  localStorage.clear();
  sessionsState = { sessions: [], isLoading: false, error: null };
  mountLog.length = 0;
});

describe('TabChatDeck P6 — lazy-mount-then-keep-alive', () => {
  it('a restored BACKGROUND tab stays unmounted until visited, then keep-alive', async () => {
    // Both restored conversations exist server-side (so the prune keeps them).
    sessionsState = { sessions: [row({ sessionId: 'a' }), row({ sessionId: 'b' })], isLoading: false, error: null };
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 2 }, { sessionId: 'b', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 2 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    // Only the active tab 'a' is mounted; background 'b' is NOT.
    expect(mountedSids()).toEqual(['a']);

    // Click tab 'b' → it mounts.
    const tabB = screen.getAllByRole('tab').find((el) => el.getAttribute('data-sid') === 'b')!;
    await act(async () => { fireEvent.click(tabB); });
    expect(mountedSids().sort()).toEqual(['a', 'b']);

    // Switch back to 'a' → 'b' STAYS mounted (keep-alive).
    const tabA = screen.getAllByRole('tab').find((el) => el.getAttribute('data-sid') === 'a')!;
    await act(async () => { fireEvent.click(tabA); });
    expect(mountedSids().sort()).toEqual(['a', 'b']);
  });
});

describe('TabChatDeck P6 — dead-tab prune', () => {
  it('prunes a restored tab whose conversation no longer exists, on a clean sessions load', async () => {
    sessionsState = { sessions: [row({ sessionId: 'a' })], isLoading: false, error: null }; // 'b' is gone
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 2 }, { sessionId: 'b', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 2 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    // 'b' pruned (absent from the loaded list); 'a' survives.
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid')).filter(Boolean)).toEqual(['a']);
  });

  it('never prunes a restored KIND tab — it names no conversation, and closing it stops the session (ADR 0785)', async () => {
    const { registerDeckTabKind, __clearDeckTabKindsForTest } = await import('../tabKindRegistry.js');
    const onClose = vi.fn();
    registerDeckTabKind({ kind: 'test-tool', label: () => 'Tool', featureId: 'claude-code', Component: () => <div data-testid="kind-surface" />, onClose });
    try {
      sessionsState = { sessions: [row({ sessionId: 'a' })], isLoading: false, error: null }; // the kind tab is NOT a conversation
      saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 1 }, { sessionId: 'tool-1', pinned: false, lastActiveSeq: 2, kind: 'test-tool' }], activeSessionId: 'tool-1', seq: 2 }, 'u1');
      await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
      // The prune calls closeTab, never handleClose, so a kind's onClose is not
      // reachable from it today; this line guards a future prune→handleClose change.
      // The tab list below is the witness (w44 probe dp-kindprune).
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid')).filter(Boolean).sort()).toEqual(['a', 'tool-1']);
    } finally { __clearDeckTabKindsForTest(); }
  });

  it('does NOT prune while the sessions list is still loading (offline safety)', async () => {
    sessionsState = { sessions: [], isLoading: true, error: null }; // not yet loaded
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 2 }, { sessionId: 'b', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 2 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    // Both restored tabs survive — pruning waits for a successful load.
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid')).filter(Boolean).sort()).toEqual(['a', 'b']);
  });
});

describe('TabChatDeck P6 — restore mount-gate (no doomed messages fetch)', () => {
  it('never mounts a restored ACTIVE tab whose conversation is gone — it is pruned instead', async () => {
    // 'dead' is the active restored tab but absent from the list (deleted / reset
    // backend). Pre-fix it mounted, fired listChatSessionMessagesPage, and 404'd (in
    // bulk across a stale deck). It must never mount: TabSession (its backend hydrate)
    // is never rendered for it; the prune drops it and the live 'a' mounts.
    //
    // The list must start LOADING (as it does in production — it is an async read).
    // If it were already loaded on the first render, the mount effect and the prune
    // effect would run in the same effect flush, and 'dead' would leave `tabs` before
    // any render could mount it — with or without the mount gate — so the case could
    // not fail (w44 probe dp-gate-dead-r2). The gate is what holds 'dead' back during
    // the load window.
    sessionsState = { sessions: [], isLoading: true, error: null };
    saveTabDeck({ tabs: [{ sessionId: 'dead', pinned: false, lastActiveSeq: 2 }, { sessionId: 'a', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'dead', seq: 2 }, 'u1');

    const view = (): JSX.Element => <MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>;
    let rerender: (ui: JSX.Element) => void = () => undefined;
    await act(async () => { ({ rerender } = render(view())); });
    expect(mountLog).toEqual([]); // held while the list loads

    // The list resolves WITHOUT 'dead'.
    sessionsState = { sessions: [row({ sessionId: 'a' })], isLoading: false, error: null };
    await act(async () => { rerender(view()); });

    expect(mountLog).not.toContain('dead'); // the doomed tab NEVER mounted (not just "gone by the end") → never fetched
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid')).filter(Boolean)).toEqual(['a']); // pruned
    expect(mountedSids()).toEqual(['a']); // active falls to the live tab, which mounts
  });

  it('gates a restored tab mount until the list resolves (nothing mounts mid-load)', async () => {
    sessionsState = { sessions: [], isLoading: true, error: null }; // list not yet resolved
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 1 }, 'u1');

    const view = (): JSX.Element => <MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>;
    let rerender: (ui: JSX.Element) => void = () => undefined;
    await act(async () => { ({ rerender } = render(view())); });

    // While the list is loading the restored active tab is NOT mounted, so no doomed
    // hydrate fires.
    expect(mountedSids()).toEqual([]);
    expect(mountLog).toEqual([]);

    // Positive control: the same deck mounts it as soon as the list confirms it, so
    // the empty result above was the gate, not a deck that never mounts anything.
    sessionsState = { sessions: [row({ sessionId: 'a' })], isLoading: false, error: null };
    await act(async () => { rerender(view()); });
    expect(mountedSids()).toEqual(['a']);
  });
});
