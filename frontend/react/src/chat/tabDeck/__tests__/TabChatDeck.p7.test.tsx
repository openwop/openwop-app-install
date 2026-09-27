import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { saveTabDeck } from '../tabDeckPersistence.js';

/** ADR 0140 P7 — deep-link, keyboard shortcuts, and the library picker. */

vi.mock('../TabSession.js', () => ({
  TabSession: ({ sessionId, scopeAgentId }: { sessionId: string; scopeAgentId?: string }) => <div data-testid="tabsession" data-sid={sessionId} data-scope={scopeAgentId ?? ''} />,
}));
// messageCount > 0 — the rail hides empty conversations that aren't open as tabs.
let sessionsState = { sessions: [{ sessionId: 'a', title: 'Alpha', messageCount: 2 }, { sessionId: 'b', title: 'Beta', messageCount: 5 }], isLoading: false, error: null as string | null };
const removeSpy = vi.fn(() => Promise.resolve());
const renameSpy = vi.fn(() => Promise.resolve());
vi.mock('../../hooks/useChatSessions.js', () => ({
  useChatSessions: () => ({
    ...sessionsState, markRead: vi.fn(), createSession: vi.fn(), rename: renameSpy, remove: removeSpy,
    refresh: vi.fn(() => Promise.resolve()), openWorkspace: vi.fn(() => Promise.resolve(null)),
    addParticipant: vi.fn(), removeParticipant: vi.fn(), attachBoard: vi.fn(),
  }),
}));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

import { TabChatDeck } from '../TabChatDeck.js';

const CONFIG = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' } as never;
// Conversation tabs carry data-sid; the persistent Conversations rail also renders a
// mode tablist (Conversations/Workflow/Reviews) whose tabs have none — filter them out.
const convTabs = () => screen.getAllByRole('tab').filter((el) => el.getAttribute('data-sid'));
const tabSids = () => convTabs().map((el) => el.getAttribute('data-sid'));

function renderDeck(initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><TabChatDeck config={CONFIG} onReconfigureBYOK={vi.fn()} /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  sessionsState = { sessions: [{ sessionId: 'a', title: 'Alpha', messageCount: 2 }, { sessionId: 'b', title: 'Beta', messageCount: 5 }], isLoading: false, error: null };
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
    const active = convTabs().find((el) => el.getAttribute('aria-selected') === 'true');
    expect(active?.getAttribute('data-sid')).toBe(sids[0]);
  });
});

describe('TabChatDeck — persistent Conversations rail (ADR 0140 amend)', () => {
  it('opens on the Conversations panel by default; selecting a row opens it as a tab', async () => {
    await act(async () => { renderDeck(); });
    // The Conversations list is visible by default (non-mobile) — no launcher click.
    // The row's open action is a real <button> whose name is the title exactly
    // ("Rename Beta"/"Delete Beta" are the sibling row controls).
    const betaRow = screen.getByRole('button', { name: /Beta/ });
    await act(async () => { fireEvent.click(betaRow); });
    expect(tabSids()).toContain('b');
  });
});
