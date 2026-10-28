import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

/**
 * ENG-14 — `?rail=` deep-link parity for the multi-tab deck.
 *
 * The deck already consumed `?agent=` and `?conversation=`; `?rail=` was the one
 * member of the ChatSidebar deep-link family it dropped. The symptom is silent:
 * a feature CTA that targets a rail (the Studio publication link → the reviews
 * inbox) still navigates and still renders a chat, so nothing looks broken —
 * the user just lands on whatever tab localStorage last held, and the CTA's
 * intent is gone. Nothing throws, so only a test pins it. Breaks if `reviews` is not
 * selected, `progress` does not open the Workbench Run tab, an unknown value blanks
 * the rail, or the param is not stripped from the URL.
 */

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
vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null }),
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

async function renderAt(url: string): Promise<void> {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} />
      </MemoryRouter>,
    );
  });
}

/** The RAIL's tablist exposes which rail tab is selected; read it rather than
 *  internals. Scoped to the rail: the chat-tab strip always has a selected tab too,
 *  so an unscoped query could never come back empty. */
function selectedRailTab(): string | null {
  const selected = within(screen.getByRole('tablist', { name: 'Chat tool tabs' })).queryAllByRole('tab', { selected: true });
  return selected.length > 0 ? (selected[0]!.textContent?.trim() ?? null) : null;
}

describe('TabChatDeck — ?rail= deep link (ENG-14)', () => {
  it('selects the reviews rail when deep-linked, instead of the Conversations default', async () => {
    // The deck opens on Conversations by default, so a pass requires the deep link
    // to actually move the selection.
    await renderAt('/chat?rail=reviews');
    expect(selectedRailTab()).toMatch(/review/i);
  });

  it('treats ?rail=progress as the Workbench Run tab (ADR 0768 P2 alias)', async () => {
    // Runs moved out of the rail; the old deep link must still land somewhere
    // real — the right-hand Workbench, on Run — not be silently dropped.
    await renderAt('/chat?rail=progress');
    screen.getByRole('complementary', { name: /workbench/i }); // throws if the Workbench is not open
    expect(screen.getByRole('tab', { name: /^run/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('ignores an unknown rail value rather than selecting nothing', async () => {
    await renderAt('/chat?rail=not-a-real-rail');
    // The guard only accepts the deck's own LeftRailTab union, so an unknown
    // value must leave the existing selection (the Conversations default) intact —
    // not blank the rail.
    expect(selectedRailTab()).toMatch(/conversations/i);
  });

  it('strips the param so reload/back/share does not re-trigger', async () => {
    // Observe the real router location rather than asserting on a proxy — the
    // strip is the half that keeps a shared URL clean, and an assertion that
    // cannot fail would be worse than no test.
    let search = '';
    function LocationSpy(): null {
      search = useLocation().search;
      return null;
    }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/chat?rail=progress']}>
          <LocationSpy />
          <TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} />
        </MemoryRouter>,
      );
    });
    expect(search).not.toContain('rail=');
  });
});
