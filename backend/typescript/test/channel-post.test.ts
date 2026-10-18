/**
 * ADR 0126 Phase 2 — channel post + read, membership-gated (DEFAULT-DENY on a
 * private channel; any tenant member on a public one).
 *
 * What breaks it: `postChannelMessage` / `listChannelMessages` dropping their
 * `canAccessChannel` call — a same-tenant non-member could then write to or read a
 * private channel. The post-side call site is guarded only here (the route tests
 * cover the read/stream 403s; `channels-service.test.ts` covers the predicate).
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
    await expect(postChannelMessage(T, ch.conversationId, 'mallory', 'sneak', FULL_AUTHORITY)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listChannelMessages(T, ch.conversationId, 'mallory')).rejects.toMatchObject({ code: 'forbidden' });
    await addChannelMember(T, ch.conversationId, 'alice', FULL_AUTHORITY, 'alice'); // owner 'alice' self-joins
    const r = await postChannelMessage(T, ch.conversationId, 'alice', 'members only', FULL_AUTHORITY);
    expect(r.messageId).toBeTruthy();
    expect(await listChannelMessages(T, ch.conversationId, 'alice')).toHaveLength(1);
  });

  it('rejects empty content', async () => {
    const ch = await createChannel(T, 'alice', { name: 'g2', visibility: 'public' }, FULL_AUTHORITY);
    await expect(postChannelMessage(T, ch.conversationId, 'bob', '   ', FULL_AUTHORITY)).rejects.toMatchObject({ code: 'validation_error' });
  });
});
