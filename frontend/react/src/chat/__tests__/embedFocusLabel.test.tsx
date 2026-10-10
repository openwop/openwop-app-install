/**
 * ADR 0777 — the embed's "can see" strip says "this model" ONLY after the server
 * accepted the focus binding (it checked the caller may read the canvas). Until
 * then, and on a refusal, the honest workspace-wide label stays: a label the
 * server never confirmed would tell the user the agent sees something it may not.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const setConversationFocus = vi.fn(async (_s: string, _f: unknown) => true);
vi.mock('../../client/chatSessionsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/chatSessionsClient.js')>()),
  setConversationFocus: (s: string, f: unknown) => setConversationFocus(s, f),
}));
const runCoreSubmit = vi.fn(async () => undefined);
vi.mock('../lib/chatSubmit.js', () => ({ runCoreSubmit: (...a: unknown[]) => runCoreSubmit(...(a as [])) }));

let messages: unknown[] = [];
vi.mock('../hooks/useChatSession.js', () => ({
  useChatSession: () => ({
    session: { id: 'sess-1', messages },
    isSending: false, error: null, send: vi.fn(), cancel: vi.fn(), reset: vi.fn(), resolveInterrupt: vi.fn(),
    runWorkflowMention: vi.fn(), regenerate: vi.fn(), setFeedback: vi.fn(), hasOlderMessages: false,
    isLoadingEarlier: false, loadEarlierMessages: vi.fn(), activeAgents: [],
  }),
}));
vi.mock('../lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: [] }) }));
vi.mock('../activeAgents/useScopeToAgent.js', () => ({ useScopeToAgent: () => undefined }));
vi.mock('../reviews/ConversationReviewsStrip.js', () => ({ ConversationReviewsStrip: () => null }));
vi.mock('../ContinueInFullChat.js', () => ({ ContinueInFullChat: () => null }));
vi.mock('../ConversationView.js', () => ({
  ConversationView: ({ onSend, footerSlot }: { onSend: (t: string) => Promise<void>; footerSlot?: ReactNode }) => (
    <div>
      <button type="button" onClick={() => { void onSend('hello'); }}>send</button>
      {footerSlot}
    </div>
  ),
}));

import { EmbeddedConversation } from '../EmbeddedConversation.js';

const config = { provider: 'anthropic', model: 'claude-opus-5-5' } as never;
const base = { agentId: 'a', config, onReconfigureBYOK: vi.fn(), contextLabel: 'any model you can open' };
const focus = { kind: 'canvas' as const, id: 'cv-1', label: 'this model' };
const strip = () => document.querySelector('.embed-context-strip')?.textContent ?? '';

beforeEach(() => { setConversationFocus.mockReset(); messages = []; });
afterEach(cleanup);

describe('ADR 0777 — focus label follows the server', () => {
  it('switches to the focus label once the server accepts, binding this session + canvas', async () => {
    let accept!: (ok: boolean) => void;
    setConversationFocus.mockImplementation(() => new Promise<boolean>((r) => { accept = r; }));
    render(<EmbeddedConversation {...base} focus={focus} />);
    expect(setConversationFocus).toHaveBeenCalledWith('sess-1', { kind: 'canvas', id: 'cv-1' });
    expect(strip()).toContain('any model you can open'); // not before the answer
    await act(async () => { accept(true); });
    expect(strip()).toContain('this model');
  });

  it('keeps the workspace label when the server refuses', async () => {
    setConversationFocus.mockResolvedValue(false);
    render(<EmbeddedConversation {...base} focus={focus} />);
    await act(async () => { await Promise.resolve(); });
    expect(strip()).toContain('any model you can open');
    expect(screen.queryByText('this model')).toBeNull();
  });

  it('asks for no binding without a focus', () => {
    render(<EmbeddedConversation {...base} />);
    expect(setConversationFocus).not.toHaveBeenCalled();
  });
});
