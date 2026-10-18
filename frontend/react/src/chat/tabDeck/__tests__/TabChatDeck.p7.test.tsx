import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { saveTabDeck } from '../tabDeckPersistence.js';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

/**
 * ADR 0140 P7 (+ G3, amend) — deep links (`?conversation=` opens or focuses without
 * duplicating; `?agent=` opens a NEW tab scoped to that agent, and the scope follows
 * a re-key), the Alt-based deck shortcuts, and opening a rail row as a tab. Breaks if
 * a deep link is dropped, the scope is lost on re-key, or a shortcut/row is unwired.
 */

// `rekeyOnMount` stands in for useSessionPersistence's mount-404 recovery: a
// deck-minted tab has no BE row, so its first history read 404s and the session
// re-keys to a fresh id. Off by default; the re-key test turns it on.
const rekey = vi.hoisted(() => ({ on: false, done: new Set<string>() }));
vi.mock('../TabSession.js', async () => {
  const { useEffect } = await import('react');
  return {
    TabSession: ({ sessionId, scopeAgentId, onSessionIdChange }: { sessionId: string; scopeAgentId?: string; onSessionIdChange?: (oldId: string, newId: string) => void }) => {
      useEffect(() => {
        if (!rekey.on || rekey.done.has(sessionId) || sessionId.startsWith('rekeyed-')) return;
        rekey.done.add(sessionId);
        onSessionIdChange?.(sessionId, `rekeyed-${sessionId}`);
      }, [sessionId, onSessionIdChange]);
      return <div data-testid="tabsession" data-sid={sessionId} data-scope={scopeAgentId ?? ''} />;
    },
  };
});
// messageCount > 0 — the rail hides empty conversations that aren't open as tabs.
const listed = (): ChatSessionHeader[] => [row({ sessionId: 'a', title: 'Alpha', messageCount: 2 }), row({ sessionId: 'b', title: 'Beta', messageCount: 5 })];
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
// Conversation tabs carry data-sid; the persistent Conversations rail also renders a
// mode tablist (Conversations/Workflow/Reviews) whose tabs have none — filter them out.
const convTabs = () => screen.getAllByRole('tab').filter((el) => el.getAttribute('data-sid'));
const tabSids = () => convTabs().map((el) => el.getAttribute('data-sid'));

function renderDeck(initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  sessionsState = { sessions: listed(), isLoading: false, error: null };
  rekey.on = false;
  rekey.done.clear();
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
    const scoped = screen.getAllByTestId('tabsession').filter((el) => el.getAttribute('data-scope') === 'code-reviewer');
    expect(scoped).toHaveLength(1); // exactly one tab carries the agent scope
    const sid = scoped[0]!.getAttribute('data-sid');
    expect(sid).not.toBe('a'); // a NEW tab, not a listed conversation
    expect(sid).not.toBe('b');
    // …and it is the tab the user lands on.
    expect(convTabs().find((el) => el.getAttribute('data-sid') === sid)?.getAttribute('aria-selected')).toBe('true');
  });

  it('?agent=<id> keeps its scope when the new tab re-keys to the BE-minted session id', async () => {
    rekey.on = true;
    await act(async () => { renderDeck('/?agent=code-reviewer'); });
    const scoped = screen.getAllByTestId('tabsession').filter((el) => el.getAttribute('data-scope') === 'code-reviewer');
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.getAttribute('data-sid')).toMatch(/^rekeyed-/); // the scope followed the re-key
  });
});

describe('TabChatDeck — ?conversation= + ?agent= scopes THAT tab (ADR 0896 IL2UX-2)', () => {
  it('scopes the named conversation\'s tab to the agent and opens no new tab', async () => {
    await act(async () => { renderDeck('/?conversation=b'); });
    const baseline = tabSids().length; // the deck's own tabs + b
    cleanup(); localStorage.clear();
    await act(async () => { renderDeck('/?conversation=b&agent=chief-of-staff'); });
    const scoped = screen.getAllByTestId('tabsession').filter((el) => el.getAttribute('data-scope') === 'chief-of-staff');
    expect(scoped.map((el) => el.getAttribute('data-sid'))).toEqual(['b']);
    expect(tabSids()).toHaveLength(baseline); // no extra tab was minted for the agent
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
