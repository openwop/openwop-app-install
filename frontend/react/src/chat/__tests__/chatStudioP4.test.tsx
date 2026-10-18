/**
 * ADR 0768 P4 — promote an ephemeral embedded conversation to the full chat,
 * on click only, strictly (no partial handoff), idempotently (a retry finishes).
 * Breaks if the row is not bound to the EXISTING run, a streaming bubble or a
 * mis-encoded message is copied, a 409 is treated as failure (or a 500 as done),
 * or a failed handoff navigates / stays silent. Store encodings are pinned as
 * literals — never recomputed with encodeMessageForStore (the subject).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
type Client = typeof import('../../client/chatSessionsClient.js');
const client = vi.hoisted(() => ({
  createChatSession: vi.fn<Client['createChatSession']>(),
  setConversationRun: vi.fn<Client['setConversationRun']>(),
  appendChatMessage: vi.fn<Client['appendChatMessage']>(),
  updateChatMessage: vi.fn<Client['updateChatMessage']>(),
}));
vi.mock('../../client/chatSessionsClient.js', () => client);
const announced = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../ui/announce.js', () => ({ announce: (m: string) => { announced.calls.push(m); } }));

import type { ChatMessage } from '../types.js';
import { promoteConversation } from '../lib/promoteConversation.js';
import { ContinueInFullChat } from '../ContinueInFullChat.js';

const AT = '2026-09-28T10:00:00.000Z';
const m = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content: id, createdAt: AT, ...over });
// The store encoding of u1 / a1, written out by hand (id + meta lifted out of `content`).
const U1_CONTENT = `{"role":"user","content":"u1","createdAt":"${AT}"}`;
const A1_STORED = { messageId: 'a1', role: 'assistant', content: `{"role":"assistant","content":"a1","createdAt":"${AT}"}`, meta: '{"model":"x"}' };
const session = {
  id: 's1',
  title: 'Lead intake',
  conversationRunId: 'run-1',
  messages: [m('u1', { role: 'user' }), m('a1', { meta: { model: 'x' } }), m('a2', { isStreaming: true })],
};

beforeEach(() => {
  client.createChatSession.mockReset().mockResolvedValue({ sessionId: 's1', tenantId: 't', title: 'Lead intake', createdAt: AT, updatedAt: AT, messageCount: 0 });
  client.setConversationRun.mockReset().mockResolvedValue(undefined);
  client.appendChatMessage.mockReset().mockImplementation(async (sessionId, msg) => ({
    messageId: msg.messageId, sessionId, role: 'assistant', content: msg.content, meta: msg.meta ?? null, createdAt: AT,
  }));
  client.updateChatMessage.mockReset().mockResolvedValue(undefined);
  announced.calls = [];
});

describe('promoteConversation', () => {
  it('creates the row with the scoped agent, binds the EXISTING run, copies settled messages', async () => {
    await expect(promoteConversation(session, 'workflow-architect')).resolves.toBe('s1');
    expect(client.createChatSession).toHaveBeenCalledWith({ sessionId: 's1', title: 'Lead intake', participants: ['agent:workflow-architect'] });
    expect(client.setConversationRun).toHaveBeenCalledWith('s1', 'run-1');
    expect(client.appendChatMessage.mock.calls.map((c) => c[1].messageId)).toEqual(['u1', 'a1']);
    expect(client.appendChatMessage.mock.calls[0]?.[1]).toEqual({ messageId: 'u1', role: 'user', content: U1_CONTENT });
    expect(client.appendChatMessage.mock.calls[1]?.[1]).toEqual(A1_STORED);
  });

  it('treats 409s as already-done, so a retry finishes a half-done promotion', async () => {
    client.createChatSession.mockRejectedValueOnce(new Error('idempotency_key_conflict'));
    client.appendChatMessage.mockRejectedValueOnce(new Error('HTTP 409'));
    await expect(promoteConversation(session)).resolves.toBe('s1');
    expect(client.updateChatMessage).toHaveBeenCalledWith('s1', 'u1', { content: U1_CONTENT });
    // …and the copy carried on past the conflict to the next settled message.
    expect(client.appendChatMessage.mock.calls.map((c) => c[1].messageId)).toEqual(['u1', 'a1']);
    expect(client.setConversationRun).toHaveBeenCalledWith('s1', 'run-1');
  });

  it('throws on a real failure instead of handing off a partial transcript', async () => {
    client.appendChatMessage.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(promoteConversation(session)).rejects.toThrow('500');
  });
});

function Where(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}
const renderAt = (s = session) => render(
  <MemoryRouter initialEntries={['/builder']}>
    <Routes>
      <Route path="/builder" element={<ContinueInFullChat session={s} agentId="w" />} />
      <Route path="/" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

describe('ContinueInFullChat', () => {
  it('is absent on an empty conversation', () => {
    const { container } = renderAt({ ...session, messages: [] });
    expect(container.innerHTML).toBe('');
  });

  it('deep-links the promoted conversation on success', async () => {
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /handoffLabel/ }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/?conversation=s1'));
  });

  it('stays put and says so (announced) on failure', async () => {
    client.setConversationRun.mockRejectedValueOnce(new Error('HTTP 503'));
    renderAt();
    fireEvent.click(screen.getByRole('button', { name: /handoffLabel/ }));
    await waitFor(() => expect(screen.getByText('handoffFailed')).toBeTruthy());
    expect(screen.queryByTestId('where')).toBeNull();
    expect(announced.calls).toEqual(['handoffFailed']);
  });
});
