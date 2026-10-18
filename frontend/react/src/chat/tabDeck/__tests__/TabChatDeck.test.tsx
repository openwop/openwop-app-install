import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

/**
 * ADR 0140 P3 — the keep-alive CONTRACT test. The load-bearing property: switching
 * the active tab must NOT unmount background tabs (that's what keeps their SSE stream
 * alive) — the inactive panel is hidden with display:none instead. TabSession is
 * stubbed so this targets the deck's mount behavior, not the conversation machinery.
 * Breaks if the deck mounts only the active tab, stops hiding inactive panels, skips
 * the first-mount bootstrap tab, or closes a tab other than the one asked for.
 */

// Stub TabSession to a lightweight marker — presence in the DOM == mounted.
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({ useChatSessions: () => sessionsStub() }));
vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null }), // no persistence in the keep-alive contract test
}));
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

beforeEach(() => { localStorage.clear(); });

function sids(): string[] {
  return screen.getAllByTestId('tabsession').map((el) => el.getAttribute('data-sid')!).sort();
}
const convTabs = (): HTMLElement[] =>
  within(screen.getByRole('tablist', { name: 'Open chat tabs' })).getAllByRole('tab');
const wrapperOf = (sid: string): HTMLElement =>
  screen.getAllByTestId('tabsession').find((el) => el.getAttribute('data-sid') === sid)!.parentElement!;

// Two "New chat" buttons exist now — the tab-strip launcher AND the persistent
// Conversations rail's empty-state action. Target the strip's (outside the rail).
function clickStripNewTab(): void {
  const btn = screen.getAllByRole('button', { name: 'New chat' }).find((b) => !b.closest('.conversations-rail'))!;
  fireEvent.click(btn);
}

async function mount(): Promise<void> {
  await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
}

describe('TabChatDeck — keep-alive', () => {
  it('bootstraps one tab, and opening a second keeps BOTH mounted', async () => {
    await mount();
    expect(screen.getAllByTestId('tabsession')).toHaveLength(1); // bootstrap

    await act(async () => { clickStripNewTab(); });
    expect(screen.getAllByTestId('tabsession')).toHaveLength(2); // both mounted
  });

  it('switching the active tab does NOT unmount the background tab (keep-alive)', async () => {
    await mount();
    await act(async () => { clickStripNewTab(); });

    const before = sids();
    expect(before).toHaveLength(2);
    // Strip order = insertion order: [bootstrap, new]; the NEW one is active.
    const [first, second] = convTabs().map((el) => el.getAttribute('data-sid')!);
    expect(wrapperOf(first!).style.display).toBe('none'); // inactive: hidden, still mounted
    expect(wrapperOf(second!).style.display).not.toBe('none');

    await act(async () => { fireEvent.click(convTabs()[0]!); });

    // Both tabs are STILL mounted after the switch (the invariant)…
    expect(sids()).toEqual(before);
    // …and visibility flipped: the clicked tab shows, the other is hidden.
    expect(wrapperOf(first!).style.display).not.toBe('none');
    expect(wrapperOf(second!).style.display).toBe('none');
  });

  it('closing a tab removes exactly that one; the other stays mounted', async () => {
    await mount();
    await act(async () => { clickStripNewTab(); });
    expect(screen.getAllByTestId('tabsession')).toHaveLength(2);

    const [closed, kept] = convTabs().map((el) => el.getAttribute('data-sid')!);
    // Scope to the conversation tab strip so the rail's "Close conversations" and the
    // strip's "Close chat tools" rail-toggle don't shadow the per-tab close buttons.
    const closeButtons = within(screen.getByRole('tablist', { name: 'Open chat tabs' })).getAllByRole('button', { name: /^Close / });
    await act(async () => { fireEvent.click(closeButtons[0]!); });
    expect(sids()).toEqual([kept]);
    expect(sids()).not.toContain(closed);
  });
});
