/**
 * ADR 0577 — the AI briefing tile: a read-only projection of a scheduled
 * agent chat's latest ASSISTANT turn. Pinned, both polarities:
 *  - configured + messages ⇒ the latest assistant turn renders (NOT the
 *    trailing user turn) with provenance + the open-conversation deep-link;
 *  - a failed message read ⇒ the error state, never an empty briefing;
 *  - a deleted conversation ⇒ the gone state + the re-pick picker;
 *  - unconfigured + no scheduled chats ⇒ the create CTA, which SEEDS the ONE
 *    chat's composer (no bespoke create form);
 *  - unconfigured + scheduled chats ⇒ the picker; Save persists the pointer.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const getBriefingConfig = vi.fn<typeof import('../dashboardClient.js')['getBriefingConfig']>();
const putBriefingConfig = vi.fn<typeof import('../dashboardClient.js')['putBriefingConfig']>();
vi.mock('../dashboardClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dashboardClient.js')>()),
  getBriefingConfig: () => getBriefingConfig(),
  putBriefingConfig: (id: string) => putBriefingConfig(id),
}));

type ChatClient = typeof import('../../../client/chatSessionsClient.js');
const getChatSession = vi.fn<ChatClient['getChatSession']>();
const listChatSessionMessagesPage = vi.fn<ChatClient['listChatSessionMessagesPage']>();
vi.mock('../../../client/chatSessionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<ChatClient>()),
  getChatSession: (id: string) => getChatSession(id),
  listChatSessionMessagesPage: (id: string, opts: { limit: number; before?: string }) => listChatSessionMessagesPage(id, opts),
}));

type ScheduledClient = typeof import('../../../client/scheduledChatsClient.js');
const listScheduledChats = vi.fn<ScheduledClient['listScheduledChats']>();
vi.mock('../../../client/scheduledChatsClient.js', async (importOriginal) => ({
  ...(await importOriginal<ScheduledClient>()),
  listScheduledChats: (orgId: string) => listScheduledChats(orgId),
}));

vi.mock('../../../client/accessClient.js', () => ({
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));

import { __resetDashboardOrgMemo } from '../useDashboardOrg.js';
import { takeStagedComposerDraft } from '../../../chat/composerSeed.js';
import AiBriefingTile from '../tiles/AiBriefingTile.js';
import type { ChatMessagePersisted, ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import type { ScheduledChat } from '../../../client/scheduledChatsClient.js';
import type { DashboardBriefingConfig } from '../dashboardClient.js';

/** A persisted plain-text row (the agent-writer shape) with attribution meta. */
const row = (id: string, role: ChatMessagePersisted['role'], content: string, meta?: Record<string, unknown>): ChatMessagePersisted => ({
  messageId: id, sessionId: 'conv:1', role, content,
  meta: meta ? JSON.stringify(meta) : null, createdAt: '2026-08-15T08:00:00.000Z',
});
const page = (messages: ChatMessagePersisted[]) => ({ messages, nextCursor: null });
const config = (conversationId: string): DashboardBriefingConfig => ({ conversationId, updatedAt: '2026-08-15T07:00:00.000Z' });
const session = (sessionId: string, title = 'Briefing'): ChatSessionHeader => ({
  sessionId, tenantId: 't1', title, createdAt: '2026-08-15T07:00:00.000Z', updatedAt: '2026-08-15T08:00:00.000Z', messageCount: 1,
});
const SCHEDULED: ScheduledChat[] = [
  { chatId: 'c1', agentId: 'iris', prompt: 'daily summary', conversationId: 'conv:2', cronExpr: '0 8 * * *', enabled: true },
];

const renderTile = () => render(<MemoryRouter><AiBriefingTile compact={false} /></MemoryRouter>);

beforeEach(() => {
  // mockReset, not clearAllMocks: a case's implementation must never answer the next case.
  for (const m of [getBriefingConfig, putBriefingConfig, getChatSession, listChatSessionMessagesPage, listScheduledChats]) m.mockReset();
  __resetDashboardOrgMemo();
  takeStagedComposerDraft(); // drain residue
  listScheduledChats.mockResolvedValue([]);
});
afterEach(cleanup);

describe('ADR 0577 — AI briefing tile', () => {
  it('renders the latest ASSISTANT turn (not the trailing user turn) with provenance + deep-link', async () => {
    getBriefingConfig.mockResolvedValue(config('conv:1'));
    getChatSession.mockResolvedValue(session('conv:1', 'Morning briefing'));
    listChatSessionMessagesPage.mockResolvedValue(page([
      row('m1', 'assistant', 'Yesterday: 3 deals moved.', { agentPersona: 'Iris' }),
      row('m2', 'user', 'thanks, look into deal 2'),
    ]));
    renderTile();
    await screen.findByText(/3 deals moved/);
    expect(screen.queryByText(/look into deal 2/)).toBeNull(); // the user turn is NOT the briefing
    expect(screen.getByText('Iris')).toBeTruthy();             // provenance chip names the agent
    const open = screen.getByRole('link', { name: /open conversation/i });
    expect(open.getAttribute('href')).toBe('/chat?conversation=conv%3A1');
  });

  it('a failed message read shows the error state — never an empty briefing or the CTA', async () => {
    getBriefingConfig.mockResolvedValue(config('conv:1'));
    getChatSession.mockResolvedValue(session('conv:1'));
    listChatSessionMessagesPage.mockRejectedValue(new Error('boom'));
    renderTile();
    await screen.findByText(/could not load/i);
    expect(screen.queryByText(/no scheduled agent chats/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /create a morning briefing/i })).toBeNull();
  });

  it('a deleted conversation shows the gone state and offers the re-pick picker', async () => {
    getBriefingConfig.mockResolvedValue(config('conv:gone'));
    getChatSession.mockRejectedValue(new Error('not_found: chat_session "conv:gone" not found.')); // the client's real 404 shape
    listScheduledChats.mockResolvedValue(SCHEDULED);
    renderTile();
    await screen.findByText(/no longer exists/i);
    // `findBy`, not `getBy`: the gone-state text comes from `getChatSession`
    // REJECTING, but the picker below it renders off `listScheduledChats`
    // RESOLVING — a different promise, which need not have settled when the
    // first one has. The sync query was a latent race that only surfaced once
    // the suite grew enough to slow the second read past the first (observed
    // 2026-08-17: green solo and in a 34-file run, red twice in the full 658).
    // The assertion is unchanged in strength — `findBy` still fails if the
    // picker never appears.
    expect(await screen.findByLabelText(/show the latest update from/i)).toBeTruthy();
  });

  it('ADR 0846 grade-ux — a NON-404 conversation failure is a failed read, not "gone"', async () => {
    getBriefingConfig.mockResolvedValue(config('conv:1'));
    getChatSession.mockRejectedValue(new Error('internal: HTTP 500'));
    renderTile();
    await screen.findByText(/could not load/i);
    expect(screen.queryByText(/no longer exists/i)).toBeNull(); // no re-pick invitation over a good setting
  });

  it('ADR 0846 grade-ux — a failed scheduled-chats read never offers the create CTA', async () => {
    getBriefingConfig.mockResolvedValue(null);
    listScheduledChats.mockRejectedValue(new Error('internal: HTTP 500'));
    renderTile();
    await screen.findByText(/could not load/i);
    expect(screen.queryByText(/no scheduled agent chats/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /briefing/i })).toBeNull();
  });

  it('unconfigured with NO scheduled chats: the CTA seeds the ONE chat composer', async () => {
    getBriefingConfig.mockResolvedValue(null);
    renderTile();
    await screen.findByText(/no scheduled agent chats/i);
    const cta = screen.getByRole('link', { name: /create a morning briefing/i });
    expect(cta.getAttribute('href')).toBe('/chat');
    fireEvent.click(cta);
    expect(takeStagedComposerDraft()).toMatch(/recurring morning briefing/i);
  });

  it('unconfigured with scheduled chats: picking one + Save persists the pointer and loads it', async () => {
    getBriefingConfig.mockResolvedValue(null);
    putBriefingConfig.mockResolvedValue(config('conv:2'));
    listScheduledChats.mockResolvedValue(SCHEDULED);
    getChatSession.mockResolvedValue(session('conv:2'));
    listChatSessionMessagesPage.mockResolvedValue(page([row('m1', 'assistant', 'First briefing content.')]));
    renderTile();
    const select = await screen.findByLabelText(/show the latest update from/i);
    fireEvent.change(select, { target: { value: 'conv:2' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByText(/first briefing content/i);
    expect(putBriefingConfig).toHaveBeenCalledWith('conv:2');
  });

  it('configured but no assistant turn yet: the not-run-yet state with the open link', async () => {
    getBriefingConfig.mockResolvedValue(config('conv:1'));
    getChatSession.mockResolvedValue(session('conv:1'));
    listChatSessionMessagesPage.mockResolvedValue(page([row('m2', 'user', 'hello?')]));
    renderTile();
    await screen.findByText(/has not produced an update yet/i);
    expect(screen.getByRole('link', { name: /open conversation/i })).toBeTruthy();
  });
});
