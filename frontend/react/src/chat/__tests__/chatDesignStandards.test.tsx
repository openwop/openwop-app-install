/**
 * The chat brought onto DESIGN.md §4.5 rules 15–18 (2026-10-07). Each block pins
 * one behaviour that changed, so a revert reads as a red test rather than a
 * silent regression:
 *
 *  - a lost conversation (`interrupt_not_found` & co.) says so in plain words
 *    and offers "Send again", with the wire code behind Technical details;
 *  - the ConversationView banner does not echo an error the feed already shows;
 *  - the composer stays editable while a reply streams, but cannot send;
 *  - a `seed` FILLS the composer and does not send;
 *  - conversations blocked on the caller lead the rail in "Needs you", once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../hooks/useAudioRecorder.js', () => ({
  useAudioRecorder: () => ({ isSupported: false, isRecording: false, error: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
  blobToBase64: vi.fn(),
}));
// The composer warms the `/` workflow cache on mount; these tests are about the
// field, not the picker, so the cache read is stubbed (no live fetch).
// …and the `@` agent list it loads for mention detection.
vi.mock('../../client/agentsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../client/agentsClient.js')>()),
  listAgents: vi.fn(() => Promise.resolve([])),
}));
// …and the `@@` board list.
vi.mock('../../features/advisory-board/advisoryBoardClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/advisory-board/advisoryBoardClient.js')>()),
  listBoards: vi.fn(() => Promise.resolve([])),
}));
// The real button waits on the live auth + demo-mode handshake; the notice only
// has to place it.
vi.mock('../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Sign in</button>,
}));
vi.mock('../lib/workflowMentions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(() => Promise.resolve()),
}));

import { classifyChatError } from '../lib/errorClassify.js';
import { ErrorCard } from '../ErrorCard.js';
import { errorShownInFeed } from '../ConversationView.js';
import { ChatInput } from '../ChatInput.js';
import { ConversationsRail } from '../conversations/ConversationsRail.js';
import { SignInRequiredContext, SignInRequiredNotice } from '../SignInRequiredNotice.js';
import type { ChatMessage } from '../types.js';
import type { ChatSessionHeader } from '../../client/chatSessionsClient.js';

afterEach(cleanup);

describe('a lost conversation reads in plain words', () => {
  for (const code of ['interrupt_not_found', 'interrupt_gone', 'interrupt_already_resolved', 'run_not_found']) {
    it(`${code} → "The reply didn't arrive" with a Send again action`, () => {
      const k = classifyChatError({ code, message: 'no open interrupt for this node' });
      expect(k.title).toBe('The reply didn’t arrive');
      expect(k.detail).not.toContain(code);
      expect(k.action).toEqual({ kind: 'retry', label: 'Send again' });
    });
  }

  it('a provider status wrapped by the conversation lane still classifies (no raw JSON)', () => {
    const k = classifyChatError({ code: 'internal_error', message: 'Conversation reply failed: openai_401: { "error": { "message": "Incorrect API key" } }' });
    expect(k.action?.kind).toBe('reconfigure-byok');
    expect(k.detail).not.toContain('{');
  });

  it('the free tier refusing an anonymous caller asks them to sign in', () => {
    for (const e of [
      { code: 'sign_in_required', message: 'Sign in to use the free tier.' },
      { code: 'internal_error', message: 'Conversation reply failed: Sign in to use the free tier.' },
    ]) {
      const k = classifyChatError(e);
      expect(k.title).toBe('Sign in to chat');
      expect(k.action?.kind).toBe('sign-in');
    }
  });

  it('the card puts the wire code behind Technical details, not in the message', () => {
    const onRetry = vi.fn();
    render(<ErrorCard error={{ code: 'interrupt_not_found', message: 'no open interrupt for this node' }} onRetry={onRetry} />);
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('The reply didn’t arrive');
    const details = card.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('Technical details');
    expect(details?.querySelector('code')?.textContent).toBe('interrupt_not_found');
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('the error banner does not repeat the feed', () => {
  const user: ChatMessage = { id: 'u', role: 'user', content: 'hi', createdAt: '' } as ChatMessage;
  const failed: ChatMessage = { id: 'a', role: 'assistant', content: '', createdAt: '', meta: { error: { code: 'x', message: 'boom' } } } as ChatMessage;

  it('is suppressed when the newest failed turn carries the same text', () => {
    expect(errorShownInFeed([user, failed], 'boom')).toBe(true);
  });
  it('still shows a different error (a load or resolve failure has no turn)', () => {
    expect(errorShownInFeed([user, failed], 'Could not resolve interrupt: nope')).toBe(false);
  });
  it('still shows when the newest message is the user’s own (no failed reply yet)', () => {
    expect(errorShownInFeed([failed, user], 'boom')).toBe(false);
  });
});

describe('the composer while a reply streams', () => {
  it('stays editable but does not send', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} onCancel={vi.fn()} disabled agentEntries={[]} />);
    const box = screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'next question' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe('next question');
  });

  it('a seed fills the box and sends nothing', async () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput onSend={onSend} agentEntries={[]} />);
    rerender(<ChatInput onSend={onSend} agentEntries={[]} seed={{ text: '@iris ', nonce: 1 }} />);
    const box = screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('@iris '));
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('Needs you leads the conversations rail', () => {
  const CONVERSATIONS = [
    { sessionId: 'ag-1', title: 'Quarterly review', type: 'agent', messageCount: 2 },
    { sessionId: 'ag-2', title: 'Launch FAQ', type: 'agent', messageCount: 3 },
  ] as ChatSessionHeader[];

  it('moves a blocked conversation into Needs you, and only there', () => {
    render(
      <ConversationsRail
        conversations={CONVERSATIONS}
        isLoading={false}
        error={null}
        activeSessionId={null}
        onRefresh={vi.fn(() => Promise.resolve())}
        onSelect={vi.fn()}
        onRename={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn(() => Promise.resolve())}
        onNewChat={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onClose={vi.fn()}
        liveStatusFor={(sid) => (sid === 'ag-2' ? 'blocked' : null)}
      />,
    );
    const needs = screen.getByRole('region', { name: 'Needs you' });
    const agents = screen.getByRole('region', { name: 'Agents' });
    expect(needs.textContent).toContain('Launch FAQ');
    expect(agents.textContent).not.toContain('Launch FAQ');
    expect(agents.textContent).toContain('Quarterly review');
    expect(screen.getAllByRole('button', { name: /Launch FAQ/ })).toHaveLength(1);
  });

  it('renders no Needs you section when nothing is blocked', () => {
    render(
      <ConversationsRail
        conversations={CONVERSATIONS}
        isLoading={false}
        error={null}
        activeSessionId={null}
        onRefresh={vi.fn(() => Promise.resolve())}
        onSelect={vi.fn()}
        onRename={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn(() => Promise.resolve())}
        onNewChat={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  });
});

describe('a signed-out visitor learns the free model needs an account before sending', () => {
  it('says so above the composer, with sign-in and the own-key way through', () => {
    const onUseOwnKey = vi.fn();
    render(
      <SignInRequiredContext.Provider value>
        <SignInRequiredNotice onUseOwnKey={onUseOwnKey} />
      </SignInRequiredContext.Provider>,
    );
    const notice = screen.getByRole('region', { name: 'Sign in to chat' });
    expect(notice.textContent).toMatch(/own API key/);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use your own key' }));
    expect(onUseOwnKey).toHaveBeenCalledTimes(1);
  });

  it('renders nothing where the host has not said sign-in is required (incl. embedded chats)', () => {
    const { container } = render(<SignInRequiredNotice onUseOwnKey={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('labels the visible notice with its own heading when another chat tab stays mounted', () => {
    const { container } = render(
      <SignInRequiredContext.Provider value>
        <div style={{ display: 'none' }}><SignInRequiredNotice onUseOwnKey={() => {}} /></div>
        <div><SignInRequiredNotice onUseOwnKey={() => {}} /></div>
      </SignInRequiredContext.Provider>,
    );
    const notices = [...container.querySelectorAll('section.signin-notice')];
    const headingIds = notices.map((notice) => notice.getAttribute('aria-labelledby'));
    expect(new Set(headingIds).size).toBe(2);
    for (const [index, notice] of notices.entries()) {
      expect(document.getElementById(headingIds[index]!)).toBe(notice.querySelector('strong'));
    }
    expect(screen.getByRole('region', { name: 'Sign in to chat' })).toBe(notices[1]);
  });
});
