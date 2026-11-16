import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTabDeck } from '../tabDeckPersistence.js';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

/**
 * ADR 0140 (security) + ADR 0978 D4 — per-user persistence isolation. An in-page
 * identity switch on a shared browser must remount the deck fresh from the new user's
 * key; user A's tab ids must never be written under user B's key
 * (`openwop-app.chat.tabdeck:<uid>@<workspace>`).
 *
 * DOUBLE GUARD, each half witnessed by its own case: ChatTab keys the deck on the uid
 * (`key={user?.uid ?? 'anon'}`, pinned literally by case 2), AND since ADR 0978 D4
 * TabChatDeck keys its inner deck on the persist subject (`key={subject ?? 'anon'}`).
 * Without either remount, useTabDeck's persist effect would save the old state under
 * the new key. The behavioural case renders the deck WITHOUT an outer key, so it
 * witnesses the deck's own inner key (w114 probe w114g3-sec-innerkey). Breaks if the
 * storage key drops the subject, either key stops following the identity, or a
 * logged-out deck persists.
 */

let mockUid: string | null = 'A';
// ADR 0978 D4 — the deck resolves the active workspace before it restores.
vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/workspaceClient.js')>()),
  listMyWorkspaces: async () => ({ workspaces: [], active: 'ws-test', personal: 'ws-test' }),
}));
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({ useChatSessions: () => sessionsStub() }));
vi.mock('../../conversations/useRunningConversations.js', () => ({ useRunningConversations: () => new Set<string>() }));
vi.mock('../../reviews/reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reviews/reviewClient.js')>()),
  listReviews: async () => [],
  getReview: async () => { throw new Error('not used in this test'); },
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: mockUid ? { uid: mockUid } : null }) }));

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
// NO outer key here (ChatTab's key is pinned by case 2): the switch must be survived by
// the deck's own inner `key={subject}` remount, which is what case 1 witnesses.
const Surface = () => (
  <MemoryRouter><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>
);

beforeEach(() => { localStorage.clear(); mockUid = 'A'; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

// ADR 0978 D4 — the deck first resolves the workspace (a few microtasks), THEN
// restores/bootstraps, THEN the debounced save fires.
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(500); });
}

describe('TabChatDeck — per-user persistence isolation', () => {
  it('does NOT write user A\'s tabs under user B\'s key when the identity switches in-page', async () => {
    const { rerender } = render(<Surface />);
    // A's deck bootstraps a tab; flush the debounced save.
    await settle();
    const aTabs = loadTabDeck('A@ws-test')?.tabs.map((t) => t.sessionId) ?? [];
    expect(aTabs).toHaveLength(1); // A persisted its working set (the one bootstrapped tab)

    // Switch identity in-page (no reload): mock uid → B and re-render. The subject
    // change remounts the inner deck fresh from B's (empty) key.
    mockUid = 'B';
    rerender(<Surface />);
    await settle();

    // Literal keys — never computed with tabDeckKey, which is part of what is under test.
    // ADR 0978 D4: the subject is `${uid}@${workspace}` (the workspace is mocked as ws-test).
    expect(localStorage.getItem('openwop-app.chat.tabdeck:A@ws-test')).not.toBeNull();
    const bRaw = localStorage.getItem('openwop-app.chat.tabdeck:B@ws-test');
    expect(bRaw).not.toBeNull(); // B persisted its own fresh deck (so the checks below read something)
    const bTabs = loadTabDeck('B@ws-test')?.tabs.map((t) => t.sessionId) ?? [];
    expect(bTabs).toHaveLength(1); // B bootstrapped its own one fresh tab
    // B's key must contain ONLY B's own (fresh) tabs — never any of A's ids.
    for (const aId of aTabs) {
      expect(bRaw ?? '').not.toContain(aId);
      expect(bTabs).not.toContain(aId);
    }
    // A's key is untouched by the switch.
    expect(loadTabDeck('A@ws-test')?.tabs.map((t) => t.sessionId)).toEqual(aTabs);
  });

  it('ChatTab keys the deck on the uid, so an identity switch remounts it fresh', () => {
    // The mechanism the case above relies on, asserted where it lives.
    const src = readFileSync(join(process.cwd(), 'src', 'chat', 'ChatTab.tsx'), 'utf8');
    expect(src).toMatch(/<TabChatDeck\s+key=\{user\?\.uid \?\? 'anon'\}/);
  });

  // DOUBLE GUARD: useTabDeck skips both save effects without a subject AND
  // saveTabDeck no-ops on a null subject; removing either alone stays green (w44
  // probe sec-loggedout-hook). saveTabDeck's copy is witnessed in
  // tabDeckPersistence.test.ts ("save is a no-op when logged out"). Both read the
  // subject TabChatDeck resolves (`uid ? … : null`), so a break there breaks both
  // (w114 probe w114g3-sec-loggedout).
  it('a logged-out (no uid) deck persists nothing', async () => {
    mockUid = null;
    render(<Surface />);
    await settle();
    // Positive control: the deck rendered and bootstrapped its tab, so the empty
    // storage below is the guard, not a deck that never got past loading.
    expect(screen.getAllByTestId('tabsession')).toHaveLength(1);
    expect(localStorage.length).toBe(0); // saveTabDeck no-ops without a subject
  });
});
