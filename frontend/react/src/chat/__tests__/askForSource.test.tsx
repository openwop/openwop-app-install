/**
 * ADR 0768 follow-up D3 — "Ask for a source" on an agent member's channel
 * message. It only DRAFTS the question into the composer (the user reviews and
 * sends), addressed by the handle the channel roster gives that agent — the same
 * entries the composer's @-mentions route on. No button on a human's message or
 * on an agent that is not a member of this channel.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, string>) => (o ? `${k}|${o.handle}|${o.quote}` : k) }) }));
const seeded: string[] = [];
vi.mock('../composerSeed.js', async (orig) => ({
  ...(await orig<typeof import('../composerSeed.js')>()),
  seedLiveComposer: (text: string) => { seeded.push(text); },
}));

import { MessageFeed } from '../MessageFeed.js';
import type { ChatMessage } from '../types.js';
import type { AgentMentionEntry } from '../lib/agentMentions.js';

const msg = (id: string, role: ChatMessage['role'], content: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content, createdAt: '2026-09-30T00:00:00.000Z', ...over } as ChatMessage);
const actions = { onToggleReaction: () => {}, onEdit: () => {}, onDelete: () => {} };
const directory = new Map([
  ['user:alice', { displayName: 'Alice', kind: 'user' as const }],
  ['agent:a.kai', { displayName: 'Kai', kind: 'agent' as const }],
  ['agent:a.ghost', { displayName: 'Ghost', kind: 'agent' as const }],
]);
const entries: readonly AgentMentionEntry[] = [{ agentId: 'a.kai', slug: 'kai', displayName: 'Kai', persona: 'Kai', description: '', packName: '', packVersion: '', modelClass: '' }];

beforeEach(() => { cleanup(); seeded.length = 0; window.HTMLElement.prototype.scrollIntoView = vi.fn(); });

// The feed's required props, inert here.
const base = { tenantId: 't', onResolveInterrupt: vi.fn(), onOpenWorkflowProgress: vi.fn(), focusedWorkflowMessageId: null };
const feed = (messages: ChatMessage[], withEntries = true) => render(withEntries
  ? <MessageFeed {...base} messages={messages} authorDirectory={directory} viewerSubjectRef="user:bob" messageActions={actions} mentionEntries={entries} />
  : <MessageFeed {...base} messages={messages} authorDirectory={directory} viewerSubjectRef="user:bob" messageActions={actions} />);

describe('Ask for a source (ADR 0768 D3)', () => {
  it('drafts an @-addressed question quoting the claim, and sends nothing', () => {
    feed([msg('m1', 'assistant', 'Partner posts drove   40% of signups.', { authorSubject: 'agent:a.kai' })]);
    fireEvent.click(screen.getByText('askForSource'));
    expect(seeded).toEqual(['askSourceDraft|kai|Partner posts drove 40% of signups.']);
  });

  it('no button on a human message, or an agent that is not a channel member', () => {
    feed([
      msg('m1', 'user', 'I think so', { authorSubject: 'user:alice' }),
      msg('m2', 'assistant', 'hi', { authorSubject: 'agent:a.ghost' }),
    ]);
    expect(screen.queryByText('askForSource')).toBeNull();
  });

  it('no button without the roster (not a channel surface)', () => {
    feed([msg('m1', 'assistant', 'x', { authorSubject: 'agent:a.kai' })], false);
    expect(screen.queryByText('askForSource')).toBeNull();
  });
});
