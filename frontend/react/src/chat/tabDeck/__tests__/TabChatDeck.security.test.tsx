import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTabDeck } from '../tabDeckPersistence.js';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

/**
 * ADR 0140 (security) — per-user persistence isolation. The deck is keyed on the uid
 * in ChatTab, so an in-page identity switch on a shared browser remounts it fresh from
 * the new user's key; user A's tab ids must never be written under user B's key.
 *
 * The REMOUNT is ChatTab's `key={user?.uid ?? 'anon'}` — the deck has no defence of
 * its own if its subject changes without a remount (useTabDeck's persist effect
 * would save the old state under the new key). The behavioural case below supplies
 * that key itself (as ChatTab does), so it cannot see the key being removed from
 * ChatTab; the literal case pins it there (w44 probe sec-chattab-key). Breaks if the
 * storage key drops the subject, ChatTab stops keying the deck on the uid, or a
 * logged-out deck persists.
 */

let mockUid: string | null = 'A';
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
// Mirror ChatTab: the deck is keyed on the uid.
const Surface = () => (
  <MemoryRouter><TabChatDeck key={mockUid ?? 'anon'} config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>
);

beforeEach(() => { localStorage.clear(); mockUid = 'A'; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('TabChatDeck — per-user persistence isolation', () => {
  it('does NOT write user A\'s tabs under user B\'s key when the identity switches in-page', async () => {
    const { rerender } = render(<Surface />);
    // A's deck bootstraps a tab; flush the debounced save.
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(500); });
    const aTabs = loadTabDeck('A')?.tabs.map((t) => t.sessionId) ?? [];
    expect(aTabs.length).toBeGreaterThan(0); // A persisted its working set

    // Switch identity in-page (no reload): mock uid → B and re-render. The key change
    // remounts the deck fresh from B's (empty) key.
    mockUid = 'B';
    rerender(<Surface />);
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(500); });

    // Literal keys — never computed with tabDeckKey, which is part of what is under test.
    expect(localStorage.getItem('openwop-app.chat.tabdeck:A')).not.toBeNull();
    const bRaw = localStorage.getItem('openwop-app.chat.tabdeck:B');
    expect(bRaw).not.toBeNull(); // B persisted its own fresh deck (so the checks below read something)
    const bTabs = loadTabDeck('B')?.tabs.map((t) => t.sessionId) ?? [];
    // B's key must contain ONLY B's own (fresh) tabs — never any of A's ids.
    for (const aId of aTabs) {
      expect(bRaw ?? '').not.toContain(aId);
      expect(bTabs).not.toContain(aId);
    }
    // A's key is untouched by the switch.
    expect(loadTabDeck('A')?.tabs.map((t) => t.sessionId)).toEqual(aTabs);
  });

  it('ChatTab keys the deck on the uid, so an identity switch remounts it fresh', () => {
    // The mechanism the case above relies on, asserted where it lives.
    const src = readFileSync(join(process.cwd(), 'src', 'chat', 'ChatTab.tsx'), 'utf8');
    expect(src).toMatch(/<TabChatDeck\s+key=\{user\?\.uid \?\? 'anon'\}/);
  });

  // DOUBLE GUARD: useTabDeck skips both save effects without a subject AND
  // saveTabDeck no-ops on a null subject; removing either alone stays green (w44
  // probe sec-loggedout-hook). saveTabDeck's copy is witnessed in
  // tabDeckPersistence.test.ts ("save is a no-op when logged out").
  it('a logged-out (no uid) deck persists nothing', async () => {
    mockUid = null;
    render(<Surface />);
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(500); });
    expect(localStorage.length).toBe(0); // saveTabDeck no-ops without a subject
  });
});
