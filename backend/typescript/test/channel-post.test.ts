/**
 * ADR 0126 Phase 2 — channel post + read, membership-gated.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createChannel, addChannelMember, postChannelMessage, listChannelMessages } from '../src/features/channels/channelService.js';

const T = 'chan-tenant';
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('channel post/read membership gate', () => {
  it('a public channel admits any tenant member to post + read', async () => {
    const ch = await createChannel(T, 'alice', { name: 'general', visibility: 'public' });
    await postChannelMessage(T, ch.conversationId, 'bob', 'hi all'); // bob not a member, but public
    const msgs = await listChannelMessages(T, ch.conversationId, 'carol');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('hi all');
  });

  it('a private channel denies a non-member (post + read) and admits a member', async () => {
    const ch = await createChannel(T, 'alice', { name: 'secret', visibility: 'private' });
    await expect(postChannelMessage(T, ch.conversationId, 'mallory', 'sneak')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listChannelMessages(T, ch.conversationId, 'mallory')).rejects.toMatchObject({ code: 'forbidden' });
    await addChannelMember(T, ch.conversationId, 'alice', 'alice'); // owner 'alice' self-joins
    const r = await postChannelMessage(T, ch.conversationId, 'alice', 'members only');
    expect(r.messageId).toBeTruthy();
    expect(await listChannelMessages(T, ch.conversationId, 'alice')).toHaveLength(1);
  });

  it('rejects empty content', async () => {
    const ch = await createChannel(T, 'alice', { name: 'g2', visibility: 'public' });
    await expect(postChannelMessage(T, ch.conversationId, 'bob', '   ')).rejects.toMatchObject({ code: 'validation_error' });
  });
});
