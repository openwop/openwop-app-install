import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * ADR 0140 P3 — the keep-alive CONTRACT test. The load-bearing property: switching
 * the active tab must NOT unmount background tabs (that's what keeps their SSE stream
 * alive). TabSession is stubbed so this targets the deck's mount behavior, not the
 * full conversation machinery.
 */

// Stub TabSession to a lightweight marker — presence in the DOM == mounted.
vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId }: { sessionId: string }) => <div data-testid="tabsession" data-sid={sessionId} />,
}));
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => ({ sessions: [], isLoading: false, error: null, markRead: vi.fn(), createSession: vi.fn(), rename: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null }), // no persistence in the keep-alive contract test
}));

import { TabChatDeck } from '../TabChatDeck.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' } as never;

beforeEach(() => { localStorage.clear(); });

function sids(): string[] {
  return screen.getAllByTestId('tabsession').map((el) => el.getAttribute('data-sid')!).sort();
}

describe('TabChatDeck — keep-alive', () => {
  it('bootstraps one tab, and opening a second keeps BOTH mounted', async () => {
    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    expect(screen.getAllByTestId('tabsession')).toHaveLength(1); // bootstrap

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New chat' })); });
    expect(screen.getAllByTestId('tabsession')).toHaveLength(2); // both mounted
  });

  it('switching the active tab does NOT unmount the background tab (keep-alive)', async () => {
    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New chat' })); });

    const before = sids();
    expect(before).toHaveLength(2);

    // Exactly one wrapper is visible (active); the other is display:none but MOUNTED.
    const wrappers = screen.getAllByTestId('tabsession').map((el) => el.parentElement!);
    const hidden = wrappers.filter((w) => w.style.display === 'none');
    expect(hidden).toHaveLength(1); // the inactive tab is hidden, not unmounted

    // Switch to the hidden tab by clicking a tab. With useChatSessions mocked to no
    // sessions, every tab's title falls back to "New chat", so the two role=tab buttons
    // are the tab controls (the new-tab CTA is a button, not a tab).
    const hiddenSid = hidden[0]!.querySelector('[data-testid="tabsession"]')!.getAttribute('data-sid');
    const tabButtons = screen.getAllByRole('tab');
    expect(tabButtons).toHaveLength(2);
    await act(async () => { fireEvent.click(tabButtons[0]!); });

    // Both tabs are STILL mounted after the switch (the invariant).
    expect(sids()).toEqual(before);
    // And the visible/hidden split flipped to a single hidden tab still.
    const afterHidden = screen.getAllByTestId('tabsession').map((el) => el.parentElement!).filter((w) => w.style.display === 'none');
    expect(afterHidden).toHaveLength(1);
    expect(hiddenSid).toBeTruthy();
  });

  it('closing a tab removes exactly that one; the other stays mounted', async () => {
    await act(async () => { render(<MemoryRouter><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New chat' })); });
    expect(screen.getAllByTestId('tabsession')).toHaveLength(2);

    const closeButtons = screen.getAllByRole('button', { name: /^Close / });
    await act(async () => { fireEvent.click(closeButtons[0]!); });
    expect(screen.getAllByTestId('tabsession')).toHaveLength(1);
  });
});
