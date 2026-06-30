import { describe, it, expect } from 'vitest';
import { groupConversations, isUnread, sectionOf, SECTION_ORDER } from '../conversationGroups.js';
import type { ChatSessionHeader, ConversationParticipant } from '../../../client/chatSessionsClient.js';

function owner(lastReadAt?: string): ConversationParticipant {
  return { subjectRef: 'user:u1', role: 'owner', addedAt: '2026-01-01T00:00:00Z', ...(lastReadAt ? { lastReadAt } : {}) };
}

function conv(over: Partial<ChatSessionHeader> = {}): ChatSessionHeader {
  return {
    sessionId: over.sessionId ?? 'c1',
    tenantId: 't1',
    title: over.title ?? 'Untitled',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    messageCount: 0,
    ...over,
  };
}

describe('sectionOf', () => {
  it('maps each conversation type to its sidebar section (ADR 0043 Phase 6 IA)', () => {
    expect(sectionOf('agent')).toBe('Agents');
    expect(sectionOf('channel')).toBe('Channels');
    expect(sectionOf('group')).toBe('Groups');
    expect(sectionOf('workspace')).toBe('Workspace');
    // `person` is a reserved discriminator (no DM ships) → falls under Agents.
    expect(sectionOf('person')).toBe('Agents');
  });

  it('defaults a legacy untyped conversation to Agents (matches the BE projection)', () => {
    expect(sectionOf(undefined)).toBe('Agents');
  });
});

describe('groupConversations', () => {
  it('partitions into Agents / Channels / Groups / Workspace preserving input order', () => {
    const list = [
      conv({ sessionId: 'a1', type: 'agent', title: 'Ada' }),
      conv({ sessionId: 'ch1', type: 'channel', title: 'product' }),
      conv({ sessionId: 'g1', type: 'group', title: 'Council' }),
      conv({ sessionId: 'a2', type: 'agent', title: 'Felix' }),
      conv({ sessionId: 'w1', type: 'workspace', title: 'Workspace' }),
      conv({ sessionId: 'legacy', title: 'Old chat' }), // no type → Agents
    ];
    const grouped = groupConversations(list);
    expect(grouped.Agents.map((c) => c.sessionId)).toEqual(['a1', 'a2', 'legacy']);
    expect(grouped.Channels.map((c) => c.sessionId)).toEqual(['ch1']);
    expect(grouped.Groups.map((c) => c.sessionId)).toEqual(['g1']);
    expect(grouped.Workspace.map((c) => c.sessionId)).toEqual(['w1']);
  });

  it('filters by title case-insensitively across all sections', () => {
    const list = [
      conv({ sessionId: 'a1', type: 'agent', title: 'Ada Lovelace' }),
      conv({ sessionId: 'g1', type: 'group', title: 'Advisory Council' }),
      conv({ sessionId: 'w1', type: 'workspace', title: 'Adaptive Workspace' }),
    ];
    const grouped = groupConversations(list, 'ad');
    expect(grouped.Agents.map((c) => c.sessionId)).toEqual(['a1']);
    expect(grouped.Groups.map((c) => c.sessionId)).toEqual(['g1']);
    expect(grouped.Workspace.map((c) => c.sessionId)).toEqual(['w1']);
  });

  it('exposes a stable section render order', () => {
    expect(SECTION_ORDER).toEqual(['Agents', 'Channels', 'Groups', 'Workspace']);
  });
});

describe('isUnread', () => {
  it('is false for an empty conversation (you just created it)', () => {
    expect(isUnread(conv({ messageCount: 0, participants: [owner()] }))).toBe(false);
  });

  it('is true when the owner has never read a conversation that has messages', () => {
    expect(isUnread(conv({ messageCount: 3, updatedAt: '2026-02-01T00:00:00Z', participants: [owner()] }))).toBe(true);
  });

  it('is true when activity is newer than the owner read marker', () => {
    expect(isUnread(conv({
      messageCount: 3,
      updatedAt: '2026-02-02T00:00:00Z',
      participants: [owner('2026-02-01T00:00:00Z')],
    }))).toBe(true);
  });

  it('is false when the owner has read at or after the latest activity', () => {
    expect(isUnread(conv({
      messageCount: 3,
      updatedAt: '2026-02-01T00:00:00Z',
      participants: [owner('2026-02-01T00:00:00Z')],
    }))).toBe(false);
  });

  it('is false for a legacy conversation with no owner participant', () => {
    expect(isUnread(conv({ messageCount: 3, participants: [] }))).toBe(false);
  });
});
