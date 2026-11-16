/**
 * ADR 0126 Phase 2 — channel post + read, membership-gated (DEFAULT-DENY on a
 * private channel; any tenant member on a public one).
 *
 * What breaks it: `postChannelMessage` / `listChannelMessages` dropping their
 * `canAccessChannel` call — a same-tenant non-member could then write to or read a
 * private channel. The post-side call site is guarded only here (the route tests
 * cover the read/stream 403s; `channels-service.test.ts` covers the predicate).
 * Wave 112: each refusal asserts its own guard's message (the posting-policy and
 * role gates also throw a 403), and the member post is read back by id and text,
 * so a refused post that still landed would show.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createChannel, addChannelMember, postChannelMessage, listChannelMessages } from '../src/features/channels/channelService.js';

/** ADR 0879 D1 — a caller holding `workspace:write` (not an admin): the service-level
 *  witnesses below exercise the channel rules, not the role gate (route tests do). */
const FULL_AUTHORITY = { canWrite: true, isAdmin: false };

const T = 'chan-tenant';
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('channel post/read membership gate', () => {
  it('a public channel admits any tenant member to post + read', async () => {
    const ch = await createChannel(T, 'alice', { name: 'general', visibility: 'public' }, FULL_AUTHORITY);
    await postChannelMessage(T, ch.conversationId, 'bob', 'hi all', FULL_AUTHORITY); // bob not a member, but public
    const msgs = await listChannelMessages(T, ch.conversationId, 'carol');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('hi all');
  });

  it('a private channel denies a non-member (post + read) and admits a member', async () => {
    const ch = await createChannel(T, 'alice', { name: 'secret', visibility: 'private' }, FULL_AUTHORITY);
    const notMember = { code: 'forbidden', message: 'Not a member of this channel.' };
    await expect(postChannelMessage(T, ch.conversationId, 'mallory', 'sneak', FULL_AUTHORITY)).rejects.toMatchObject(notMember);
    await expect(listChannelMessages(T, ch.conversationId, 'mallory')).rejects.toMatchObject(notMember);
    await addChannelMember(T, ch.conversationId, 'alice', FULL_AUTHORITY, 'alice'); // owner 'alice' self-joins
    const r = await postChannelMessage(T, ch.conversationId, 'alice', 'members only', FULL_AUTHORITY);
    const listed = await listChannelMessages(T, ch.conversationId, 'alice');
    expect(listed.map((m) => [m.messageId, m.content])).toEqual([[r.messageId, 'members only']]);
  });

  it('rejects empty content', async () => {
    const ch = await createChannel(T, 'alice', { name: 'g2', visibility: 'public' }, FULL_AUTHORITY);
    await expect(postChannelMessage(T, ch.conversationId, 'bob', '   ', FULL_AUTHORITY)).rejects.toMatchObject({ code: 'validation_error', message: 'Message content is required.' });
  });
});
