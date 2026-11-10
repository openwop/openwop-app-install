/**
 * ADR 1042 D8 — subject erasure (ADR 0464) and tenant teardown for the channel
 * core's stores, through the REAL `eraseSubject` fan-out on a booted app.
 *
 * (a) Erasing an app user who owns channel threads deletes their approved
 *     senders, their threads AND the main-chat conversation each thread made
 *     (session, messages, meta), their owed replies and their relay-owner rows.
 *     The generic chat-post eraser cannot reach that transcript: its rows carry
 *     no `authorSubject` (the host wrote them), which the first case pins.
 * (b) Erasing an external person by an exact identifier deletes the pending and
 *     approved sender rows and threads whose `senderId`/`chatId` equals it, and
 *     nothing that merely shares a prefix.
 * (c) Tenant teardown purges every new collection for that tenant only.
 *
 * Red when: either eraser is unregistered; an owner match misses a store; the
 * thread's conversation survives; the external match goes fuzzy (prefix) or
 * misses `chatId`; a collection is unreachable by teardown.
 * Sabotage-witnessed 2026-11-03: unregistering `eraseChannelIngressSubject`,
 * removing the `deleteChatSession` call, changing the external match to
 * `startsWith`, and removing the relay-owner `tenantOf` (its eraser lists by the
 * tenant index) each turned their case red. Teardown (c) stays green without
 * that `tenantOf`: the row's top-level `tenantId` also reaches it. After the
 * security review: matching a DM on the chat id only (d, Slack-style DM),
 * skipping the group redaction (d, group), and disabling the pending cap (e)
 * each turned their case red. Delta review (M5): ignoring the uncapped
 * sender-thread index turned both (d) cases red, the early group writer included.
 * Wave 87: case (e) stamps rows 1 s apart and re-sees the first row, so only
 * least-recently-seen eviction passes; reversing the eviction sort, or sorting
 * on `firstSeenAt`, turns it red deterministically (it no longer rests on
 * same-millisecond ties).
 * CHAN-F5 (f): a thread erasure deletes takes every writer's sender-thread index
 * rows with it (owner erasure, and the other rows of an erased writer's DM),
 * while the same writer's row in a surviving thread stays. Sabotage-witnessed
 * 2026-11-09: removing the per-thread index delete turned both (f) cases red.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootChannelHarness, type ChannelHarness } from './support/channelCoreHarness.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { ensureConversationMeta, getConversationMeta } from '../src/host/conversationStore.js';
import { claimRelayInbound } from '../src/messaging/inboundClaims.js';
import { getRelayOwner, recordRelayOwner } from '../src/messaging/relayOwner.js';
import {
  approveSender, channelIngressStores, conversationIdOf, recordSenderInThread, getApprovedSender, getPendingReply, getThread, listPendingSenders, putChannelSettings,
  getChannelSettings, putPendingReply, putThread, recordPendingSender, threadKeyOf,
} from '../src/features/channel-ingress/stores.js';

let h: ChannelHarness;
beforeAll(async () => { h = await bootChannelHarness('c1042er'); }, 120_000);
afterAll(async () => { await h?.close(); });

const lane = { kind: 'connection' as const, connectionId: 'conn:er', provider: 'telegram' };
const LK = 'conn:conn:er';

/** One owner's thread with a real main-chat conversation behind it. */
async function seedThread(tenantId: string, ownerUserId: string, chatId: string): Promise<string> {
  const threadKey = threadKeyOf(LK, chatId, ownerUserId, 'narrow');
  const conversationId = conversationIdOf(threadKey);
  const now = new Date().toISOString();
  await h.storage.createChatSession({ sessionId: conversationId, tenantId, title: `Telegram · ${chatId}`, createdAt: now, updatedAt: now, messageCount: 0, titleSource: 'given' });
  await h.storage.appendChatMessage({ messageId: `${conversationId}-u`, sessionId: conversationId, role: 'user', content: JSON.stringify({ role: 'user', content: 'my address is 1 Main St' }), meta: null, authorSubject: null, createdAt: now });
  await ensureConversationMeta(tenantId, conversationId, { type: 'agent', ownerUserId });
  await putThread({ threadKey, tenantId, lane, chatId, conversationId, ownerUserId, createdAt: now, updatedAt: now });
  await putPendingReply({ exchangeKey: `chan-${threadKey.slice(0, 40)}`, tenantId, lane, chatId, inboundMessageId: 'm1', conversationId, ownerUserId, createdAt: now });
  return threadKey;
}

describe('(a) erasing the owner', () => {
  it('removes their senders, threads with their conversations, owed replies and relay devices', async () => {
    const T = h.ws;
    const owner = 'user:er-owner';
    const other = 'user:er-other';
    await approveSender({ tenantId: T, laneKey: LK, senderId: '111', ownerUserId: owner });
    await approveSender({ tenantId: T, laneKey: LK, senderId: '222', ownerUserId: other });
    const mine = await seedThread(T, owner, '111');
    const theirs = await seedThread(T, other, '222');
    await recordRelayOwner('relay_er_mine', T, owner);
    await recordRelayOwner('relay_er_theirs', T, other);
    const conv = conversationIdOf(mine);

    const res = await eraseSubject(T, owner);
    expect(res.failed).toBe(0);

    expect(await getApprovedSender(LK, '111')).toBeNull();
    expect(await getThread(mine)).toBeNull();
    expect(await getPendingReply(`chan-${mine.slice(0, 40)}`)).toBeNull();
    expect(await h.storage.getChatSession(T, conv)).toBeNull();
    expect(await h.storage.listChatSessionMessages(conv)).toEqual([]);
    expect(await getConversationMeta(T, conv)).toBeNull();
    expect(await getRelayOwner('relay_er_mine', T)).toBeNull();
    // Someone else's rows are untouched.
    expect(await getApprovedSender(LK, '222')).not.toBeNull();
    expect(await getThread(theirs)).not.toBeNull();
    expect(await h.storage.getChatSession(T, conversationIdOf(theirs))).not.toBeNull();
    expect(await getRelayOwner('relay_er_theirs', T)).toBe(other);
  });
});

describe('(b) erasing an external person by exact identifier', () => {
  it('removes rows whose senderId or chatId equals the key, and nothing that shares a prefix', async () => {
    const T = h.ws;
    const phone = '+15550009999';
    await approveSender({ tenantId: T, laneKey: LK, senderId: phone, ownerUserId: 'user:er-o2' });
    await approveSender({ tenantId: T, laneKey: LK, senderId: `${phone}1`, ownerUserId: 'user:er-o2' });
    await recordPendingSender({ tenantId: T, laneKey: 'conn:other', senderId: 'someone', chatId: phone });
    await recordPendingSender({ tenantId: T, laneKey: 'conn:other', senderId: `${phone}1`, chatId: 'x' });
    const thread = await seedThread(T, 'user:er-o2', phone);
    const near = await seedThread(T, 'user:er-o2', `${phone}1`);

    expect((await eraseSubject(T, phone)).failed).toBe(0);

    expect(await getApprovedSender(LK, phone)).toBeNull();
    expect(await getThread(thread)).toBeNull();
    expect(await h.storage.getChatSession(T, conversationIdOf(thread))).toBeNull();
    expect((await listPendingSenders(T, 'conn:other')).map((p) => p.senderId)).toEqual([`${phone}1`]);
    expect(await getApprovedSender(LK, `${phone}1`)).not.toBeNull();
    expect(await getThread(near)).not.toBeNull();
  });
});

describe('(c) tenant teardown', () => {
  it('purges every channel-core collection for the tenant, and only that tenant', async () => {
    const now = new Date().toISOString();
    for (const T of ['t-er-gone', 't-er-kept']) {
      await approveSender({ tenantId: T, laneKey: `conn:${T}`, senderId: 's', ownerUserId: 'user:x' });
      await recordPendingSender({ tenantId: T, laneKey: `conn:${T}`, senderId: 'p', chatId: 'c' });
      await putChannelSettings({ laneKey: `conn:${T}`, tenantId: T, updatedAt: now });
      await putThread({ threadKey: `tk-${T}`, tenantId: T, lane, chatId: 'c', conversationId: `cv-${T}`, ownerUserId: 'user:x', createdAt: now, updatedAt: now });
      await putPendingReply({ exchangeKey: `ek-${T}`, tenantId: T, lane, chatId: 'c', inboundMessageId: 'm', conversationId: `cv-${T}`, ownerUserId: 'user:x', createdAt: now });
      await recordRelayOwner(`relay-${T}`, T, 'user:x');
      expect(await claimRelayInbound({ relayId: `relay-${T}`, tenantId: T }, 'c', 'pm')).toBe(true);
    }
    await purgeTenantHostExt('t-er-gone');
    const state = async (T: string) => ({
      sender: await getApprovedSender(`conn:${T}`, 's'),
      pending: await listPendingSenders(T, `conn:${T}`),
      settings: await getChannelSettings(`conn:${T}`),
      thread: await getThread(`tk-${T}`),
      reply: await getPendingReply(`ek-${T}`),
      relayOwner: await getRelayOwner(`relay-${T}`, T),
      // A purged claim can be claimed again.
      claimFree: await claimRelayInbound({ relayId: `relay-${T}`, tenantId: T }, 'c', 'pm'),
    });
    expect(await state('t-er-gone')).toEqual({ sender: null, pending: [], settings: null, thread: null, reply: null, relayOwner: null, claimFree: true });
    const kept = await state('t-er-kept');
    expect(kept.sender && kept.settings && kept.thread && kept.reply).toBeTruthy();
    expect(kept.pending).toHaveLength(1);
    expect(kept.relayOwner).toBe('user:x');
    expect(kept.claimFree).toBe(false);
  });
});

describe('(d) security review M5 — erasure finds a person by the messages they sent', () => {
  it('a Slack-style DM (chat id is not the person id) is deleted on the sender id', async () => {
    const T = h.ws;
    const owner = 'user:er-o3';
    const threadKey = threadKeyOf(LK, 'D0SLACKDM', owner, 'narrow');
    const conversationId = conversationIdOf(threadKey);
    const now = new Date().toISOString();
    await h.storage.createChatSession({ sessionId: conversationId, tenantId: T, title: 'Slack · D0SLACKDM', createdAt: now, updatedAt: now, messageCount: 0, titleSource: 'given' });
    await ensureConversationMeta(T, conversationId, { type: 'agent', ownerUserId: owner });
    await putThread({ threadKey, tenantId: T, lane, chatId: 'D0SLACKDM', conversationId, ownerUserId: owner, isGroup: false, createdAt: now, updatedAt: now });
    await recordSenderInThread(T, LK, 'U0PERSON', threadKey);
    await putPendingReply({ exchangeKey: 'chan-dm-reply', tenantId: T, lane, chatId: 'D0SLACKDM', inboundMessageId: 'm', senderId: 'U0PERSON', conversationId, ownerUserId: owner, createdAt: now });

    expect((await eraseSubject(T, 'U0PERSON')).failed).toBe(0);
    expect(await getThread(threadKey)).toBeNull();
    expect(await h.storage.getChatSession(T, conversationId)).toBeNull();
    expect(await getPendingReply('chan-dm-reply')).toBeNull();
  });

  it('in a group only that sender\'s messages are redacted, an early writer included; the group conversation stays', async () => {
    const T = h.ws;
    const owner = 'user:er-o4';
    const threadKey = threadKeyOf(LK, 'C0GROUP', owner, 'narrow');
    const conversationId = conversationIdOf(threadKey);
    const now = new Date().toISOString();
    await h.storage.createChatSession({ sessionId: conversationId, tenantId: T, title: 'Slack · C0GROUP', createdAt: now, updatedAt: now, messageCount: 0, titleSource: 'given' });
    await ensureConversationMeta(T, conversationId, { type: 'agent', ownerUserId: owner });
    const say = (id: string, sender: string, text: string) => h.storage.appendChatMessage({
      messageId: id, sessionId: conversationId, role: 'user', content: JSON.stringify({ role: 'user', content: text }),
      meta: JSON.stringify({ channelSender: { provider: 'slack', senderId: sender } }), authorSubject: null, createdAt: new Date().toISOString(),
    });
    // U0ERASE wrote FIRST, then 60 others did: an early writer is still found (the
    // index is uncapped; a capped most-recent list would have dropped them).
    await say('g-1', 'U0ERASE', 'my phone is 555');
    await recordSenderInThread(T, LK, 'U0ERASE', threadKey);
    for (let i = 0; i < 60; i++) await recordSenderInThread(T, LK, `U0LATER${i}`, threadKey);
    await say('g-2', 'U0STAY', 'hello all');
    await recordSenderInThread(T, LK, 'U0STAY', threadKey);
    await putThread({ threadKey, tenantId: T, lane, chatId: 'C0GROUP', conversationId, ownerUserId: owner, isGroup: true, createdAt: now, updatedAt: now });

    expect((await eraseSubject(T, 'U0ERASE')).failed).toBe(0);
    const msgs = await h.storage.listChatSessionMessages(conversationId);
    const byId = new Map(msgs.map((m) => [m.messageId, (JSON.parse(m.content) as { content: string }).content]));
    expect(byId.get('g-1')).not.toContain('555');
    expect(byId.get('g-2')).toBe('hello all');
    expect(await h.storage.getChatSession(T, conversationId)).not.toBeNull();
    expect(await getThread(threadKey)).not.toBeNull();
    // The index forgets the erased sender only.
    const rows = (await channelIngressStores.senderThreads.listForTenantIndexed(T)).filter((r) => r.threadKey === threadKey);
    expect(rows.some((r) => r.senderId === 'U0ERASE')).toBe(false);
    expect(rows.some((r) => r.senderId === 'U0STAY')).toBe(true);
  });
});

describe('(f) CHAN-F5 — a deleted thread takes its sender-thread index rows with it', () => {
  it('erasing the owner removes every writer\'s index rows for their deleted threads, and no one else\'s', async () => {
    const T = h.ws;
    const owner = 'user:er-o5';
    const other = 'user:er-o6';
    const gone = await seedThread(T, owner, 'C0F5GONE');
    const kept = await seedThread(T, other, 'C0F5KEPT');
    for (const sender of ['U0F5A', 'U0F5B']) await recordSenderInThread(T, LK, sender, gone);
    await recordSenderInThread(T, LK, 'U0F5A', kept);
    const indexOf = async (threadKey: string) =>
      (await channelIngressStores.senderThreads.listForTenantIndexed(T)).filter((r) => r.threadKey === threadKey).map((r) => r.senderId).sort();
    expect(await indexOf(gone)).toEqual(['U0F5A', 'U0F5B']);

    expect((await eraseSubject(T, owner)).failed).toBe(0);

    expect(await getThread(gone)).toBeNull();
    expect(await indexOf(gone)).toEqual([]);
    // The same writer's row in a thread that stays is kept: erasure still finds them there.
    expect(await getThread(kept)).not.toBeNull();
    expect(await indexOf(kept)).toEqual(['U0F5A']);
  });

  it('erasing a DM\'s writer removes the deleted DM\'s other index rows too', async () => {
    const T = h.ws;
    const owner = 'user:er-o7';
    const dm = threadKeyOf(LK, 'D0F5DM', owner, 'narrow');
    const now = new Date().toISOString();
    await putThread({ threadKey: dm, tenantId: T, lane, chatId: 'D0F5DM', conversationId: conversationIdOf(dm), ownerUserId: owner, isGroup: false, createdAt: now, updatedAt: now });
    await recordSenderInThread(T, LK, 'U0F5DM', dm);
    await recordSenderInThread(T, LK, 'U0F5ALT', dm); // e.g. a second platform id seen in the same DM

    expect((await eraseSubject(T, 'U0F5DM')).failed).toBe(0);
    expect(await getThread(dm)).toBeNull();
    expect((await channelIngressStores.senderThreads.listForTenantIndexed(T)).filter((r) => r.threadKey === dm)).toEqual([]);
  });
});

describe('(e) security review M6 — the pending list is capped per lane', () => {
  it('keeps at most PENDING_PER_LANE_CAP rows, evicting the least recently seen', async () => {
    const { PENDING_PER_LANE_CAP } = await import('../src/features/channel-ingress/stores.js');
    const lk = 'conn:cap-lane';
    // Distinct timestamps (1 s apart): rows written in one millisecond tie on
    // `lastSeenAt`, and the eviction order would then be the store's key order.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let t = Date.parse('2026-11-01T00:00:00Z');
      const record = async (i: number) => {
        vi.setSystemTime((t += 1000));
        await recordPendingSender({ tenantId: 't-cap', laneKey: lk, senderId: `s${i}`, chatId: `c${i}` });
      };
      for (let i = 0; i < PENDING_PER_LANE_CAP; i++) await record(i);
      // s0 writes again: it is now the most recently seen, though first seen.
      await record(0);
      for (let i = PENDING_PER_LANE_CAP; i < PENDING_PER_LANE_CAP + 5; i++) await record(i);
      const ids = new Set((await listPendingSenders('t-cap', lk)).map((r) => r.senderId));
      expect(ids.size).toBe(PENDING_PER_LANE_CAP);
      // Least recently seen goes: s1..s5. First-seen order would evict s0; key
      // order would evict s0, s1, s10, s100, s101.
      expect(['s1', 's2', 's3', 's4', 's5'].filter((id) => ids.has(id))).toEqual([]);
      expect(['s0', 's6', 's10', `s${PENDING_PER_LANE_CAP}`, `s${PENDING_PER_LANE_CAP + 4}`].every((id) => ids.has(id))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
