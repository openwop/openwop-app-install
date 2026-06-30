import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { saveTabDeck } from '../tabDeckPersistence.js';

/**
 * ADR 0140 P6 deck-level integration: restore + lazy-mount-then-keep-alive + dead-tab
 * prune. TabSession is stubbed (presence == mounted) so the test targets the deck's
 * mount/prune behaviour, not the conversation machinery.
 */

vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
// Configurable sessions mock (drives the dead-tab prune).
let sessionsState: { sessions: { sessionId: string; title?: string }[]; isLoading: boolean; error: string | null } =
  { sessions: [], isLoading: false, error: null };
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => ({ ...sessionsState, markRead: vi.fn(), createSession: vi.fn(), rename: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

import { TabChatDeck } from '../TabChatDeck.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' } as never;
const mountedSids = () => screen.queryAllByTestId('tabsession').map((el) => el.getAttribute('data-sid'));

beforeEach(() => {
  localStorage.clear();
  sessionsState = { sessions: [], isLoading: false, error: null };
});

describe('TabChatDeck P6 — lazy-mount-then-keep-alive', () => {
  it('a restored BACKGROUND tab stays unmounted until visited, then keep-alive', async () => {
    // Both restored conversations exist server-side (so the prune keeps them).
    sessionsState = { sessions: [{ sessionId: 'a' }, { sessionId: 'b' }], isLoading: false, error: null };
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 2 }, { sessionId: 'b', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 2 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
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
    sessionsState = { sessions: [{ sessionId: 'a' }], isLoading: false, error: null }; // 'b' is gone
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 2 }, { sessionId: 'b', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 2 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    // 'b' pruned (absent from the loaded list); 'a' survives.
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid'))).toEqual(['a']);
  });

  it('does NOT prune while the sessions list is still loading (offline safety)', async () => {
    sessionsState = { sessions: [], isLoading: true, error: null }; // not yet loaded
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 2 }, { sessionId: 'b', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 2 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    // Both restored tabs survive — pruning waits for a successful load.
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid')).sort()).toEqual(['a', 'b']);
  });
});

describe('TabChatDeck P6 — restore mount-gate (no doomed messages fetch)', () => {
  it('never mounts a restored ACTIVE tab whose conversation is gone — it is pruned instead', async () => {
    // 'dead' is the active restored tab but absent from the loaded list (deleted /
    // reset backend). Pre-fix it mounted, fired listChatSessionMessagesPage, and 404'd
    // (in bulk across a stale deck). It must now never mount: TabSession (its backend
    // hydrate) is never rendered for it; the prune drops it and the live 'a' mounts.
    sessionsState = { sessions: [{ sessionId: 'a' }], isLoading: false, error: null };
    saveTabDeck({ tabs: [{ sessionId: 'dead', pinned: false, lastActiveSeq: 2 }, { sessionId: 'a', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'dead', seq: 2 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });

    expect(mountedSids()).not.toContain('dead'); // the doomed tab never mounted → never fetched
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid'))).toEqual(['a']); // pruned
    expect(mountedSids()).toEqual(['a']); // active falls to the live tab, which mounts
  });

  it('gates a restored tab mount until the list resolves (nothing mounts mid-load)', async () => {
    sessionsState = { sessions: [], isLoading: true, error: null }; // list not yet resolved
    saveTabDeck({ tabs: [{ sessionId: 'a', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'a', seq: 1 }, 'u1');

    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });

    // While the list is loading the restored active tab is NOT mounted, so no doomed
    // hydrate fires; it mounts only once the list confirms it (covered above).
    expect(mountedSids()).toEqual([]);
  });
});
