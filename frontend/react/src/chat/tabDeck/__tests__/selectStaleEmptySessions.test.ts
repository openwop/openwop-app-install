/**
 * selectStaleEmptySessions — the mount-time stale-empty sweep's selection.
 * Pins the guards that keep the hard-delete safe: only empty PLAIN chats, never
 * anything open as a tab or minted by this deck instance (the close-time reap
 * owns those), never a channel/group/workspace (an empty channel is deliberate),
 * and never anything younger than the age guard (it may be a fresh chat another
 * window has open). A wrong delete is data loss; a missed row is just hidden by
 * the rail filter.
 */
import { describe, it, expect } from 'vitest';
import { selectStaleEmptySessions, STALE_EMPTY_SESSION_MAX_AGE_MS } from '../TabChatDeck.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';

const NOW = Date.parse('2026-07-17T12:00:00.000Z');
const STALE_AT = new Date(NOW - STALE_EMPTY_SESSION_MAX_AGE_MS - 1).toISOString();
const FRESH_AT = new Date(NOW - 60_000).toISOString();

const header = (over: Partial<ChatSessionHeader> = {}): ChatSessionHeader => ({
  sessionId: 's1',
  tenantId: 't1',
  title: 'New chat',
  createdAt: STALE_AT,
  updatedAt: STALE_AT,
  messageCount: 0,
  ...over,
});

const select = (
  conversations: ChatSessionHeader[],
  over: Partial<Omit<Parameters<typeof selectStaleEmptySessions>[0], 'conversations'>> = {},
) => selectStaleEmptySessions({
  conversations,
  openIds: new Set<string>(),
  freshIds: new Set<string>(),
  now: NOW,
  maxAgeMs: STALE_EMPTY_SESSION_MAX_AGE_MS,
  ...over,
});

describe('selectStaleEmptySessions', () => {
  it('selects a stale, empty, closed plain chat (typed and legacy-untyped)', () => {
    const rows = [header({ sessionId: 'a', type: 'agent' }), header({ sessionId: 'b' })];
    expect(select(rows).map((c) => c.sessionId)).toEqual(['a', 'b']);
  });

  it('spares conversations with messages', () => {
    expect(select([header({ messageCount: 3 })])).toEqual([]);
  });

  it('spares open tabs and deck-minted ids (the close-time reap owns those)', () => {
    const rows = [header({ sessionId: 'open' }), header({ sessionId: 'minted' })];
    expect(select(rows, { openIds: new Set(['open']), freshIds: new Set(['minted']) })).toEqual([]);
  });

  it('never sweeps a channel, group, workspace, or person conversation', () => {
    const rows = (['channel', 'group', 'workspace', 'person'] as const).map(
      (type) => header({ sessionId: type, type }),
    );
    expect(select(rows)).toEqual([]);
  });

  it('spares anything younger than the age guard (a fresh chat in another window)', () => {
    expect(select([header({ updatedAt: FRESH_AT })])).toEqual([]);
  });

  it('sweeps exactly at the age-guard boundary', () => {
    const atBoundary = new Date(NOW - STALE_EMPTY_SESSION_MAX_AGE_MS).toISOString();
    expect(select([header({ updatedAt: atBoundary })])).toHaveLength(1);
  });
});
