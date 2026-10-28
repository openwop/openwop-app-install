/**
 * selectStaleEmptySessions — the mount-time stale-empty sweep's selection
 * (ADR 0140 deck, TabChatDeck's once-per-mount sweep). Breaks if the empty check,
 * the plain-chat type filter, the open-tab / deck-minted exclusions or the age
 * guard (inclusive at the boundary) is dropped or weakened.
 * Pins the guards that keep the hard-delete safe: only empty chats the caller
 * owns alone (ADR 0978 D3), never
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

// The shape a never-used deck "New chat" has: the caller is its sole owner
// participant (ADR 0978 D3 — the only shape any automatic delete may take).
const header = (over: Partial<ChatSessionHeader> = {}): ChatSessionHeader => ({
  sessionId: 's1',
  tenantId: 't1',
  title: 'New chat',
  createdAt: STALE_AT,
  updatedAt: STALE_AT,
  messageCount: 0,
  type: 'agent',
  ownerUserId: 'u1',
  participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: STALE_AT }],
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
  it('selects a stale, empty, closed chat the caller owns alone', () => {
    const rows = [header({ sessionId: 'a' }), header({ sessionId: 'b' })];
    expect(select(rows).map((c) => c.sessionId)).toEqual(['a', 'b']);
  });

  it('never sweeps a meta-less legacy row — every member sees it (MT2WF-2)', () => {
    const legacy = header({ sessionId: 'legacy', type: 'agent', participants: [] });
    delete (legacy as Partial<ChatSessionHeader>).ownerUserId;
    const untyped = header({ sessionId: 'untyped', participants: [] });
    delete (untyped as Partial<ChatSessionHeader>).type;
    delete (untyped as Partial<ChatSessionHeader>).ownerUserId;
    expect(select([legacy, untyped])).toEqual([]);
  });

  it('never sweeps a DM or a container-bound chat', () => {
    const rows = [
      header({ sessionId: 'dm', participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: STALE_AT }, { subjectRef: 'agent:iris', role: 'member', addedAt: STALE_AT }] }),
      header({ sessionId: 'project', ownerSubject: { kind: 'project', id: 'p1' } }),
      header({ sessionId: 'board', boardId: 'b1' }),
      header({ sessionId: 'client', client: { orgId: 'o1', name: 'Acme' } }),
    ];
    expect(select(rows)).toEqual([]);
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
