/**
 * ADR 0992 D9 (architect H1): imported history says it is imported.
 *
 * The import writes `source:'import'` into each row's META, not its content.
 * `parsePersistedMessages` must surface it as `meta.imported`. Every imported
 * bubble then carries an "Imported" label, so an imported "assistant" reply never
 * passes for one this app's agent wrote. One note after the imported block says
 * the assistant never saw it (the next turn starts a fresh run; ADR 0992 D10).
 *
 * What turns each case red: dropping the `rowMeta.source === 'import'` line in
 * `hooks/chatSession/lib.ts` (case 1, and cases 2–3 by construction); dropping the
 * label in `MessageBubble.tsx` (case 2); dropping the note, or rendering it after
 * every imported message instead of after the last (case 3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { parsePersistedMessages } from '../hooks/chatSession/lib.js';
import { MessageFeed } from '../MessageFeed.js';
import type { ChatMessagePersisted } from '../../client/chatSessionsClient.js';

const FEED = { tenantId: 't-test', onResolveInterrupt: async () => {}, onOpenWorkflowProgress: () => {}, focusedWorkflowMessageId: null };
const IMPORT_META = JSON.stringify({ contentTrust: 'untrusted', source: 'import' });

/** Rows exactly as the importer writes them (closed envelope + import row meta). */
const imported = (id: string, role: 'user' | 'assistant', text: string): ChatMessagePersisted => ({
  messageId: id, sessionId: 's', role, meta: IMPORT_META, authorSubject: 'user:user:me', createdAt: '2026-10-27T10:00:00.000Z',
  content: JSON.stringify({ role, content: text, createdAt: '2026-10-27T10:00:00.000Z' }),
} as ChatMessagePersisted);
const typed: ChatMessagePersisted = {
  messageId: 'n1', sessionId: 's', role: 'user', meta: null, authorSubject: 'user:user:me', createdAt: '2026-10-27T11:00:00.000Z',
  content: JSON.stringify({ role: 'user', content: 'a new question' }),
} as ChatMessagePersisted;

beforeEach(() => {
  cleanup();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('ADR 0992 D9 — imported messages', () => {
  const messages = parsePersistedMessages([imported('i0', 'user', 'old question'), imported('i1', 'assistant', 'old answer'), typed]);

  it('surfaces the row-meta import provenance as meta.imported (and only there)', () => {
    expect(messages.map((m) => m.meta?.imported === true)).toEqual([true, true, false]);
  });

  it('labels every imported bubble', () => {
    render(<MessageFeed {...FEED} messages={messages} />);
    expect(screen.getAllByText('importedLabel')).toHaveLength(2);
  });

  it('notes once, after the imported block, that the assistant never saw it', () => {
    render(<MessageFeed {...FEED} messages={messages} />);
    const notes = screen.getAllByText('importedNotice');
    expect(notes).toHaveLength(1);
    const html = document.body.innerHTML;
    expect(html.indexOf('old answer')).toBeLessThan(html.indexOf('importedNotice'));
    expect(html.indexOf('importedNotice')).toBeLessThan(html.indexOf('a new question'));
  });
});
