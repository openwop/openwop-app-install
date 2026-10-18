/**
 * ADR 0879 D2 — a moderator's delete is NAMED on the tombstone; the author's own
 * delete stays a plain "Message deleted". (Owners and admins may delete others'
 * posts but never edit them; a delete that vanished without a name would hide
 * who silenced whom.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.name ? `${k}:${String(o.name)}` : k) }) }));

import { MessageFeed } from '../MessageFeed.js';

/** The four props every MessageFeed requires; these cases do not exercise them. */
const FEED = { tenantId: 't-test', onResolveInterrupt: async () => {}, onOpenWorkflowProgress: () => {}, focusedWorkflowMessageId: null };
import type { ChatMessage } from '../types.js';

const tomb = (id: string, author: string, deletedBy: string): ChatMessage =>
  ({ id, role: 'user', content: '{"deleted":true}', createdAt: '2026-10-12T00:00:00.000Z', authorSubject: author, meta: { deletedAt: '2026-10-12T00:01:00.000Z', deletedBy } });

beforeEach(() => {
  cleanup();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('ADR 0879 D2 — "Removed by <name>" tombstones', () => {
  const directory = new Map([
    ['user:alice', { displayName: 'Alice', kind: 'user' as const }],
    ['user:olga', { displayName: 'Olga', kind: 'user' as const }],
  ]);

  it('names the moderator from the roster, falls back to "a moderator", and keeps the author\'s own delete plain', () => {
    render(
      <MessageFeed {...FEED}
        messages={[tomb('m1', 'user:alice', 'user:olga'), tomb('m2', 'user:alice', 'user:admin-not-in-room'), tomb('m3', 'user:alice', 'user:alice')]}
        authorDirectory={directory}
        viewerSubjectRef="user:bob"
      />,
    );
    expect(screen.getByText('messageRemovedBy:Olga')).toBeTruthy();
    expect(screen.getByText('messageRemovedBy:messageRemovedByModerator')).toBeTruthy();
    expect(screen.getByText('messageDeleted')).toBeTruthy();
  });
});
