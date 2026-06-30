import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { saveTabDeck } from '../tabDeckPersistence.js';

/** ADR 0140 P7 — deep-link, keyboard shortcuts, and the library picker. */

vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId, scopeAgentId }: { sessionId: string; scopeAgentId?: string }) => <div data-testid="tabsession" data-sid={sessionId} data-scope={scopeAgentId ?? ''} />,
}));
let sessionsState = { sessions: [{ sessionId: 'a', title: 'Alpha' }, { sessionId: 'b', title: 'Beta' }], isLoading: false, error: null as string | null };
const removeSpy = vi.fn(() => Promise.resolve());
const renameSpy = vi.fn(() => Promise.resolve());
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => ({ ...sessionsState, markRead: vi.fn(), createSession: vi.fn(), rename: renameSpy, remove: removeSpy }),
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

import { TabChatDeck } from '../TabChatDeck.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' } as never;
const tabSids = () => screen.getAllByRole('tab').map((el) => el.getAttribute('data-sid'));

function renderDeck(initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  sessionsState = { sessions: [{ sessionId: 'a', title: 'Alpha' }, { sessionId: 'b', title: 'Beta' }], isLoading: false, error: null };
  removeSpy.mockClear();
  renameSpy.mockClear();
});
afterEach(() => cleanup()); // unmount + tear down any open modal portal between tests

describe('TabChatDeck P7 — deep-link', () => {
  it('opens a tab for ?conversation=<id> (known conversation)', async () => {
    await act(async () => { renderDeck('/?conversation=b'); });
    expect(tabSids()).toContain('b');
  });

  it('does NOT duplicate when the deep-linked conversation is already a restored tab', async () => {
    saveTabDeck({ tabs: [{ sessionId: 'b', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'b', seq: 1 }, 'u1');
    await act(async () => { renderDeck('/?conversation=b'); });
    expect(tabSids().filter((s) => s === 'b')).toHaveLength(1); // focus, not duplicate
  });

  it('?agent=<id> opens a NEW tab scoped to that agent (ADR 0140 G3)', async () => {
    await act(async () => { renderDeck('/?agent=code-reviewer'); });
    const scoped = screen.getAllByTestId('tabsession').find((el) => el.getAttribute('data-scope') === 'code-reviewer');
    expect(scoped).toBeTruthy(); // a tab carries the agent scope
  });
});

describe('TabChatDeck P7 — keyboard shortcuts (Alt-based)', () => {
  it('Alt+N opens a new tab', async () => {
    await act(async () => { renderDeck(); });
    const before = tabSids().length;
    await act(async () => { fireEvent.keyDown(window, { altKey: true, code: 'KeyN' }); });
    expect(tabSids().length).toBe(before + 1);
  });

  it('Alt+Digit focuses the Nth tab', async () => {
    await act(async () => { renderDeck(); });
    await act(async () => { fireEvent.keyDown(window, { altKey: true, code: 'KeyN' }); }); // 2 tabs now
    const sids = tabSids();
    await act(async () => { fireEvent.keyDown(window, { altKey: true, code: 'Digit1' }); });
    const active = screen.getAllByRole('tab').find((el) => el.getAttribute('aria-selected') === 'true');
    expect(active?.getAttribute('data-sid')).toBe(sids[0]);
  });
});

describe('TabChatDeck P7 — library picker', () => {
  it('opens the library and selecting a conversation opens it as a tab', async () => {
    await act(async () => { renderDeck(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Conversations' })); });
    // The picker lists the conversations; the open button's name is the title exactly
    // ("Rename Beta"/"Delete Beta" are the other row controls).
    const betaRow = screen.getByRole('button', { name: 'Beta' });
    await act(async () => { fireEvent.click(betaRow); });
    expect(tabSids()).toContain('b');
  });

  // Rename/delete logic is unit-tested directly in TabLibraryPicker.test.tsx.
});
