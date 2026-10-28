/**
 * ADR 0978 D3 — `isAbandonedEmptyChat`, the one predicate every AUTOMATIC
 * conversation delete passes (deck sweep, deck adoption, ChatSidebar purge). Each
 * row below is a shape a real conversation has; a wrong `true` is a delete of
 * something the caller did not create or still needs.
 */
import { describe, it, expect } from 'vitest';
import { isAbandonedEmptyChat, selectPurgeableEmptyChats } from '../abandonedChat.js';
import type { ChatSessionHeader } from '../../../client/chatSessionsClient.js';

const AT = '2026-10-25T00:00:00.000Z';
type Over = { [K in keyof ChatSessionHeader]?: ChatSessionHeader[K] | undefined };
/** A never-used chat owned by u1; an override of `undefined` REMOVES the field. */
const own = (over: Over = {}): ChatSessionHeader => {
  const out: Record<string, unknown> = {
    sessionId: 's', tenantId: 't', title: 'New chat', createdAt: AT, updatedAt: AT, messageCount: 0,
    type: 'agent', ownerUserId: 'u1', participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: AT }],
  };
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete out[k]; else out[k] = v; }
  return out as unknown as ChatSessionHeader;
};

describe('isAbandonedEmptyChat', () => {
  it('matches a never-used chat whose only participant is its owner', () => {
    expect(isAbandonedEmptyChat(own())).toBe(true);
  });

  it('matches an anonymous session owner (owner `session:x`, participant `user:session:x`)', () => {
    // The server records `userRef(actingUserOf(req))`; `isSelf` is never stamped for
    // this caller (MT2WF-R2), which is why the predicate does not use it.
    expect(isAbandonedEmptyChat(own({ ownerUserId: 'session:x', participants: [{ subjectRef: 'user:session:x', role: 'owner', addedAt: AT }] }))).toBe(true);
  });

  it.each<[string, Over]>([
    ['has messages', { messageCount: 1 }],
    ['legacy meta-less (no owner, no participants)', { ownerUserId: undefined, participants: [] }],
    ['no recorded owner', { ownerUserId: undefined }],
    // The owner check is layered under the ref match; this row is the one only it catches.
    ['no recorded owner, sole participant spelled `user:undefined`', { ownerUserId: undefined, participants: [{ subjectRef: 'user:undefined', role: 'owner', addedAt: AT }] }],
    ['untyped (local fallback index row)', { type: undefined }],
    ['a group', { type: 'group' }],
    ['a channel', { type: 'channel' }],
    ['a workspace chat', { type: 'workspace' }],
    ['a person DM', { type: 'person' }],
    ['an agent DM (second participant)', { participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: AT }, { subjectRef: 'agent:iris', role: 'member', addedAt: AT }] }],
    ['owner participant is someone else', { participants: [{ subjectRef: 'user:u2', role: 'owner', addedAt: AT }] }],
    ['sole participant is a member, not the owner', { participants: [{ subjectRef: 'user:u1', role: 'member', addedAt: AT }] }],
    ['bound to a board', { boardId: 'b1' }],
    ['bound to a project/notebook subject', { ownerSubject: { kind: 'project', id: 'p1' } }],
    ['bound to a client', { client: { orgId: 'o1', name: 'Acme' } }],
  ])('spares a conversation that %s', (_label, over) => {
    expect(isAbandonedEmptyChat(own(over))).toBe(false);
  });
});

describe('selectPurgeableEmptyChats (the ChatSidebar one-shot purge)', () => {
  it('purges only owner-only empty chats, never the active one, never a project/notebook group chat or a DM', () => {
    const rows = [
      own({ sessionId: 'mine' }),
      own({ sessionId: 'active' }),
      own({ sessionId: 'project', type: 'group', ownerSubject: { kind: 'project', id: 'p1' } }),
      own({ sessionId: 'notebook', type: 'group', ownerSubject: { kind: 'notebook', id: 'n1' } }),
      own({ sessionId: 'dm', participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: AT }, { subjectRef: 'agent:iris', role: 'member', addedAt: AT }] }),
      own({ sessionId: 'legacy', ownerUserId: undefined, participants: [] }),
    ];
    expect(selectPurgeableEmptyChats(rows, 'active').map((r) => r.sessionId)).toEqual(['mine']);
  });
});
