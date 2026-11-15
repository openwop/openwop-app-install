/**
 * CC-UX-2 — a surface stages a composer draft and deep-links `/?agent=<id>` (the
 * Campaign Brief's "Run research with the Strategist", the creative brief's "Ask the
 * Creative Director", CMS, CRM, CSM, evals …). The draft must land in the composer
 * of the tab that link opens, and must survive that tab's re-key.
 *
 * Two ways it was lost on prod (f501a7fbe / f1b882654):
 *  1. The deck mounts EVERY tab, so the restored, previously active tab's composer
 *     mounted first and consumed the one-shot stage.
 *  2. The agent tab is minted client-side with no backend row, so its first history
 *     read 404s and the recovery re-keys it (`onSessionIdChange`), which REMOUNTS the
 *     tab (`key={sessionId}`); its composer re-seeded from the new key's empty draft.
 *
 * The REAL `ChatInput` renders inside each tab. Only `TabSession`'s conversation
 * machinery is stubbed: the stub renders the composer exactly as TabSession does
 * (same draft-key spelling) and, for the agent-scoped tab, performs the documented
 * not_found recovery once — `onSessionIdChange(oldId, freshId)` after mount.
 *
 * Red when: the deck does not claim the stage before the tabs mount (case 1), or a
 * re-key does not carry the composer's live text to the new key (case 2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { UseChatSessionsResult } from '../../hooks/useChatSessions.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

const rekey = { enabled: false };

vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/workspaceClient.js')>()),
  listMyWorkspaces: async () => ({ workspaces: [], active: 'ws-test', personal: 'ws-test' }),
}));
vi.mock('../../hooks/useChatSessions.js', () => ({ useChatSessions: () => sessionsStub() }));
// Signed in, so the deck restores the saved working set: the previously active tab
// mounts on the deck's FIRST render, before the ?agent= effect opens the agent tab.
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('../../conversations/useRunningConversations.js', () => ({ useRunningConversations: () => new Set<string>() }));
vi.mock('../../reviews/reviewClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reviews/reviewClient.js')>()),
  listReviews: async () => [],
  getReview: async () => { throw new Error('not used in this test'); },
}));
// ChatInput's mount-time readers (picker directories, the workflow mention cache)
// are not under test; mock them so nothing fetches.
vi.mock('../../AgentMentionAutocomplete.js', () => ({ AgentMentionAutocomplete: () => null }));
vi.mock('../../SlashAutocomplete.js', () => ({ SlashAutocomplete: () => null }));
vi.mock('../../BoardMentionAutocomplete.js', () => ({ BoardMentionAutocomplete: () => null }));
vi.mock('../../lib/workflowMentions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
}));
vi.mock('../TabSession.js', async () => {
  const { ChatInput } = await import('../../ChatInput.js');
  function TabSession({ sessionId, tenantId = 'anon', scopeAgentId, onSessionIdChange }: {
    sessionId: string; tenantId?: string; scopeAgentId?: string; onSessionIdChange: (oldId: string, newId: string) => void;
  }): JSX.Element {
    // The not_found recovery of a client-minted agent tab (useSessionPersistence).
    useEffect(() => {
      if (rekey.enabled && scopeAgentId && !sessionId.startsWith('fresh-')) onSessionIdChange(sessionId, `fresh-${sessionId}`);
    }, [sessionId, scopeAgentId, onSessionIdChange]);
    return (
      <div data-testid="tabsession" data-sid={sessionId} data-agent={scopeAgentId ?? ''}>
        {/* The draft key spelling TabSession passes (`openwop-app.chat.draft:<scope>:<sid>`). */}
        <ChatInput onSend={() => undefined} draftKey={`openwop-app.chat.draft:${tenantId}:${sessionId}`} />
      </div>
    );
  }
  return { TabSession };
});

import { TabChatDeck } from '../TabChatDeck.js';
import { stageComposerDraft, takeStagedComposerDraft } from '../../composerSeed.js';
import { saveTabDeck } from '../tabDeckPersistence.js';

const row = (o: Partial<ChatSessionHeader> & { sessionId: string }): ChatSessionHeader => ({
  tenantId: 't1', title: 'New chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1, ...o,
});
function sessionsStub(): UseChatSessionsResult {
  return {
    sessions: [row({ sessionId: 'previous' })], isLoading: false, error: null,
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
  };
}
const CONFIG: BYOKActiveConfig = { provider: 'demo', model: 'demo-model', credentialRef: 'managed:demo' };
const AGENT = 'openwop-app.agents.brief-strategist';
const DRAFT = 'Read campaign brief “QA-CC KickTodo launch” (0cf0f586) and research the market.';

const composerOf = (el: HTMLElement): HTMLTextAreaElement => {
  const ta = el.querySelector('textarea');
  if (!(ta instanceof HTMLTextAreaElement)) throw new Error('Expected a composer textarea in the tab');
  return ta;
};
const agentTab = (): HTMLElement => {
  const tab = screen.getAllByTestId('tabsession').find((el) => el.getAttribute('data-agent') === AGENT);
  if (!tab) throw new Error('The ?agent= link opened no agent-scoped tab');
  return tab;
};

async function openAgentLink(): Promise<void> {
  saveTabDeck({ tabs: [{ sessionId: 'previous', pinned: false, lastActiveSeq: 1 }], activeSessionId: 'previous', seq: 1 }, 'u1');
  stageComposerDraft(DRAFT);
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[`/?agent=${encodeURIComponent(AGENT)}`]}>
        <TabChatDeck config={CONFIG} byokStored onReconfigureBYOK={vi.fn()} />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => { localStorage.clear(); rekey.enabled = false; takeStagedComposerDraft(); });
afterEach(() => { cleanup(); takeStagedComposerDraft(); });

describe('CC-UX-2 — a staged draft reaches the tab a ?agent= link opens', () => {
  it('lands in the agent tab’s composer, not in another tab that mounted first', async () => {
    await openAgentLink();
    await waitFor(() => expect(composerOf(agentTab()).value).toBe(DRAFT));
    const others = screen.getAllByTestId('tabsession').filter((el) => el.getAttribute('data-agent') !== AGENT);
    expect(others.map((el) => el.getAttribute('data-sid')), 'the restored tab stays mounted').toContain('previous');
    for (const el of others) expect(composerOf(el).value).toBe('');
  });

  it('survives the agent tab’s not_found re-key (the remount keeps the text)', async () => {
    rekey.enabled = true;
    await openAgentLink();
    await waitFor(() => expect(agentTab().getAttribute('data-sid')).toMatch(/^fresh-/));
    expect(composerOf(agentTab()).value).toBe(DRAFT);
  });
});
