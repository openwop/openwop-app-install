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

const getBriefingConfig = vi.fn();
const putBriefingConfig = vi.fn();
vi.mock('../dashboardClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBriefingConfig: (...a: unknown[]) => getBriefingConfig(...a),
  putBriefingConfig: (...a: unknown[]) => putBriefingConfig(...a),
}));

const getChatSession = vi.fn();
const listChatSessionMessagesPage = vi.fn();
vi.mock('../../../client/chatSessionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatSession: (...a: unknown[]) => getChatSession(...a),
  listChatSessionMessagesPage: (...a: unknown[]) => listChatSessionMessagesPage(...a),
}));

const listScheduledChats = vi.fn();
vi.mock('../../../client/scheduledChatsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listScheduledChats: (...a: unknown[]) => listScheduledChats(...a),
}));

vi.mock('../../../client/accessClient.js', () => ({
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));

import { __resetDashboardOrgMemo } from '../useDashboardOrg.js';
import { takeStagedComposerDraft } from '../../../chat/composerSeed.js';
import AiBriefingTile from '../tiles/AiBriefingTile.js';

/** A persisted plain-text row (the agent-writer shape) with attribution meta. */
const row = (id: string, role: string, content: string, meta?: Record<string, unknown>) => ({
  messageId: id, sessionId: 'conv:1', role, content,
  meta: meta ? JSON.stringify(meta) : null, createdAt: '2026-08-15T08:00:00.000Z',
});

const renderTile = () => render(<MemoryRouter><AiBriefingTile compact={false} /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  __resetDashboardOrgMemo();
  takeStagedComposerDraft(); // drain residue
  listScheduledChats.mockResolvedValue([]);
});
afterEach(cleanup);

describe('ADR 0577 — AI briefing tile', () => {
  it('renders the latest ASSISTANT turn (not the trailing user turn) with provenance + deep-link', async () => {
    getBriefingConfig.mockResolvedValue({ conversationId: 'conv:1', updatedAt: 'x' });
    getChatSession.mockResolvedValue({ sessionId: 'conv:1', title: 'Morning briefing' });
    listChatSessionMessagesPage.mockResolvedValue({
      messages: [
        row('m1', 'assistant', 'Yesterday: 3 deals moved.', { agentPersona: 'Iris' }),
        row('m2', 'user', 'thanks, look into deal 2'),
      ],
    });
    renderTile();
    await screen.findByText(/3 deals moved/);
    expect(screen.queryByText(/look into deal 2/)).toBeNull(); // the user turn is NOT the briefing
    expect(screen.getByText('Iris')).toBeTruthy();             // provenance chip names the agent
    const open = screen.getByRole('link', { name: /open conversation/i });
    expect(open.getAttribute('href')).toBe('/chat?conversation=conv%3A1');
  });

  it('a failed message read shows the error state — never an empty briefing or the CTA', async () => {
    getBriefingConfig.mockResolvedValue({ conversationId: 'conv:1', updatedAt: 'x' });
    getChatSession.mockResolvedValue({ sessionId: 'conv:1' });
    listChatSessionMessagesPage.mockRejectedValue(new Error('boom'));
    renderTile();
    await screen.findByText(/could not load/i);
    expect(screen.queryByText(/no scheduled agent chats/i)).toBeNull();
  });

  it('a deleted conversation shows the gone state and offers the re-pick picker', async () => {
    getBriefingConfig.mockResolvedValue({ conversationId: 'conv:gone', updatedAt: 'x' });
    getChatSession.mockRejectedValue(new Error('404'));
    listScheduledChats.mockResolvedValue([
      { chatId: 'c1', agentId: 'iris', prompt: 'daily summary', conversationId: 'conv:2', cronExpr: '0 8 * * *', enabled: true },
    ]);
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
    putBriefingConfig.mockResolvedValue({ conversationId: 'conv:2', updatedAt: 'x' });
    listScheduledChats.mockResolvedValue([
      { chatId: 'c1', agentId: 'iris', prompt: 'daily summary', conversationId: 'conv:2', cronExpr: '0 8 * * *', enabled: true },
    ]);
    getChatSession.mockResolvedValue({ sessionId: 'conv:2' });
    listChatSessionMessagesPage.mockResolvedValue({ messages: [row('m1', 'assistant', 'First briefing content.')] });
    renderTile();
    const select = await screen.findByLabelText(/show the latest update from/i);
    fireEvent.change(select, { target: { value: 'conv:2' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByText(/first briefing content/i);
    expect(putBriefingConfig).toHaveBeenCalledWith('conv:2');
  });

  it('configured but no assistant turn yet: the not-run-yet state with the open link', async () => {
    getBriefingConfig.mockResolvedValue({ conversationId: 'conv:1', updatedAt: 'x' });
    getChatSession.mockResolvedValue({ sessionId: 'conv:1' });
    listChatSessionMessagesPage.mockResolvedValue({ messages: [row('m2', 'user', 'hello?')] });
    renderTile();
    await screen.findByText(/has not produced an update yet/i);
    expect(screen.getByRole('link', { name: /open conversation/i })).toBeTruthy();
  });
});
