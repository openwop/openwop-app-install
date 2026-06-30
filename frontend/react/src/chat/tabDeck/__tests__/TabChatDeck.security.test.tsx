import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { loadTabDeck } from '../tabDeckPersistence.js';
import { tabDeckKey } from '../../lib/storageKeys.js';

/**
 * ADR 0140 (security) — per-user persistence isolation. The deck is keyed on the uid
 * in ChatTab, so an in-page identity switch on a shared browser remounts it fresh from
 * the new user's key; user A's tab ids must never be written under user B's key.
 */

let mockUid: string | null = 'A';
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => ({ sessions: [], isLoading: false, error: null, markRead: vi.fn(), createSession: vi.fn(), rename: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: mockUid ? { uid: mockUid } : null }) }));

import { TabChatDeck } from '../TabChatDeck.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' } as never;
// Mirror ChatTab: the deck is keyed on the uid.
const Surface = () => (
  <MemoryRouter><TabChatDeck key={mockUid ?? 'anon'} config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>
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

    const bRaw = localStorage.getItem(tabDeckKey('B'));
    const bTabs = loadTabDeck('B')?.tabs.map((t) => t.sessionId) ?? [];
    // B's key must contain ONLY B's own (fresh) tabs — never any of A's ids.
    for (const aId of aTabs) {
      expect(bRaw ?? '').not.toContain(aId);
      expect(bTabs).not.toContain(aId);
    }
    // A's key is untouched by the switch.
    expect(loadTabDeck('A')?.tabs.map((t) => t.sessionId)).toEqual(aTabs);
  });

  it('a logged-out (no uid) deck persists nothing', async () => {
    mockUid = null;
    render(<Surface />);
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(500); });
    expect(localStorage.length).toBe(0); // saveTabDeck no-ops without a subject
  });
});
