/**
 * ADR 1042 Correction (2026-11-06), CHAN-KEY-1 — compound channel-ingress ids.
 * PostgreSQL TEXT rejects NUL (SQLSTATE 22021 / 0x00), while legacy SQLite and
 * memory hosts keep their NUL ids canonical, so mixed old/new hosts share ONE
 * authoritative row and an old host's revocation stays visible. Only that exact
 * refusal (code 22021 AND a `0x00` message) selects `v2:`+sha256; any other
 * error, and a failed safe-id read, stays thrown. No aliases, no memo. Deletes,
 * pending cleanup, self selection, cap eviction and erasure use the stored id.
 * Runs on real memory and sqlite stores, plus a reject-NUL wrapper that stands
 * in for the PostgreSQL parameter boundary (no database needed).
 *
 * Red when (sabotage-witnessed, w93): the narrowing throw returns absence; the
 * code check or the message check is dropped (each fixture below passes only
 * one of them); a failed safe-id read is caught as absence; the legacy id stops
 * being canonical; representability is memoized; approval stops clearing its
 * pending row; dismiss, revoke or marker erasure rebuild a raw NUL key; self
 * selection stops clearing the other self row; cap eviction sorts newest first;
 * erasure stops deleting the sender-thread index.
 * Recorded, not probed: cap eviction's `r.key !== key` skip is a tie-only second
 * guard (this fixture stamps prior rows in 2000, so the sort alone keeps the new
 * row; GX-GC-1 records its CAP+1 edge), and a repeated `recordSenderInThread`
 * landing on one row is structural (the same key overwrites).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  approveSender, getApprovedSender, revokeSender, setSenderSelf, listApprovedSenders,
  recordPendingSender, listPendingSenders, dismissPendingSender, PENDING_PER_LANE_CAP,
  recordSenderInThread, markChannelConversation, isChannelConversation, deleteChannelConversationMarker,
  channelIngressStores, putThread, threadKeyOf, conversationIdOf, purgeLane,
} from '../src/features/channel-ingress/stores.js';
import { eraseChannelIngressSubject } from '../src/features/channel-ingress/erasure.js';

const TENANT = 'controlled-compat-tenant';
let storage: Storage;
let directory = '';
afterEach(async () => { await storage?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); directory = ''; });
async function setup(mode: 'memory' | 'sqlite' | 'postgres-boundary'): Promise<{ rawWrites: string[] }> {
  if (mode === 'sqlite') directory = mkdtempSync(join(tmpdir(), 'channel-key-compat-'));
  storage = await openStorage(mode === 'sqlite' ? `sqlite://${join(directory, 'fixture.db')}` : 'memory://');
  const rawWrites: string[] = [];
  if (mode === 'postgres-boundary') {
    const get = storage.kvGet.bind(storage), set = storage.kvSet.bind(storage), del = storage.kvDelete.bind(storage);
    const reject = (value: string): void => { if (value.includes('\u0000')) throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' }); };
    storage.kvGet = async key => { reject(key); return get(key); };
    storage.kvSet = async (key, value) => { if (key.includes('\u0000') || value.includes('\u0000')) rawWrites.push(key); reject(key); reject(value); await set(key, value); };
    storage.kvDelete = async key => { reject(key); return del(key); };
  }
  initHostExtPersistence(storage);
  return { rawWrites };
}

describe.each(['memory', 'sqlite', 'postgres-boundary'] as const)('channel compound IDs on %s', mode => {
  it('approve/read/list/revoke/read has one identity and no phantom cached approval', async () => {
    const { rawWrites } = await setup(mode);
    const input = { tenantId: TENANT, laneKey: 'relay:controlled', senderId: 'alice', ownerUserId: 'owner' };
    const approved = await approveSender(input);
    expect(approved.key.includes('\u0000')).toBe(mode !== 'postgres-boundary');
    expect((await getApprovedSender(input.laneKey, input.senderId))?.key).toBe(approved.key);
    expect((await listApprovedSenders(TENANT, input.laneKey)).map(row => row.key)).toEqual([approved.key]);
    expect(await revokeSender(input.laneKey, input.senderId)).toBe(true);
    const after = await Promise.all([getApprovedSender(input.laneKey, input.senderId), getApprovedSender(input.laneKey, input.senderId)]);
    expect(after).toEqual([null, null]);
    expect(await listApprovedSenders(TENANT, input.laneKey)).toEqual([]);
    expect(rawWrites).toEqual([]);
    expect(await storage.kvList('hostextidx:channel-ingress:sender:')).toEqual([]);
  });

  it('keeps pending cleanup, self selection, dismiss and lane purge coherent with stored row keys', async () => {
    await setup(mode);
    const laneKey = 'relay:controlled';
    await recordPendingSender({ tenantId: TENANT, laneKey, senderId: 'alice', chatId: 'dm-alice' });
    await recordPendingSender({ tenantId: TENANT, laneKey, senderId: 'alice', chatId: 'dm-alice' });
    expect((await listPendingSenders(TENANT, laneKey))[0]?.count).toBe(2);
    await approveSender({ tenantId: TENANT, laneKey, senderId: 'alice', ownerUserId: 'owner' });
    expect(await listPendingSenders(TENANT, laneKey)).toEqual([]);
    await approveSender({ tenantId: TENANT, laneKey, senderId: 'bob', ownerUserId: 'owner' });
    await setSenderSelf(TENANT, laneKey, 'alice', true);
    await setSenderSelf(TENANT, laneKey, 'bob', true);
    expect((await getApprovedSender(laneKey, 'alice'))?.self).toBeUndefined();
    expect((await getApprovedSender(laneKey, 'bob'))?.self).toBe(true);
    await recordPendingSender({ tenantId: TENANT, laneKey, senderId: 'carol', chatId: 'dm-carol' });
    expect(await dismissPendingSender(TENANT, laneKey, 'carol')).toBe(true);
    expect(await listPendingSenders(TENANT, laneKey)).toEqual([]);
    await purgeLane(TENANT, laneKey);
    expect(await listApprovedSenders(TENANT, laneKey)).toEqual([]);
  });

  it('keeps the newly recorded pending row during bounded cap eviction', async () => {
    await setup(mode);
    const laneKey = 'relay:cap';
    for (let n = 0; n < PENDING_PER_LANE_CAP; n++) await recordPendingSender({ tenantId: TENANT, laneKey, senderId: `prior-${n}`, chatId: 'group' });
    for (const row of await listPendingSenders(TENANT, laneKey)) await channelIngressStores.pending.put({ ...row, firstSeenAt: '2000-01-01T00:00:00.000Z', lastSeenAt: '2000-01-01T00:00:00.000Z' });
    await recordPendingSender({ tenantId: TENANT, laneKey, senderId: 'latest', chatId: 'group' });
    const rows = await listPendingSenders(TENANT, laneKey);
    expect(rows).toHaveLength(PENDING_PER_LANE_CAP);
    expect(rows.some(row => row.senderId === 'latest')).toBe(true);
  });

  it('removes markers and sender-thread indices through actual subject erasure', async () => {
    await setup(mode);
    const laneKey = 'relay:erase', senderId = 'external-person';
    const threadKey = threadKeyOf(laneKey, 'dm', 'owner', 'narrow'), conversationId = conversationIdOf(threadKey);
    const timestamp = '2000-01-01T00:00:00.000Z';
    await putThread({ threadKey, tenantId: TENANT, lane: { kind: 'relay', relayId: 'erase', channel: 'telegram' }, chatId: 'dm', conversationId, ownerUserId: 'owner', scope: 'narrow', createdAt: timestamp, updatedAt: timestamp });
    await recordSenderInThread(TENANT, laneKey, senderId, threadKey);
    await recordSenderInThread(TENANT, laneKey, senderId, threadKey);
    expect(await channelIngressStores.senderThreads.listForTenantIndexed(TENANT)).toHaveLength(1);
    await markChannelConversation(TENANT, conversationId, threadKey);
    expect(await isChannelConversation(TENANT, conversationId)).toBe(true);
    const report = await eraseChannelIngressSubject(TENANT, senderId);
    expect(report.rowsTouched).toBe(2); // the sender-thread index row + the one-to-one thread
    expect(await isChannelConversation(TENANT, conversationId)).toBe(false);
    expect(await channelIngressStores.senderThreads.listForTenantIndexed(TENANT)).toEqual([]);
    expect(await channelIngressStores.threads.listForTenantIndexed(TENANT)).toEqual([]);
  });
});

it('legacy direct writes/revocation interleave with new reads without minting safe aliases', async () => {
  await setup('sqlite');
  const laneKey = 'relay:legacy', senderId = 'legacy-person', key = `${laneKey}\u0000${senderId}`;
  await channelIngressStores.senders.put({ key, tenantId: TENANT, laneKey, senderId, ownerUserId: 'legacy-owner', approvedAt: '2000-01-01T00:00:00.000Z' });
  expect((await getApprovedSender(laneKey, senderId))?.ownerUserId).toBe('legacy-owner');
  expect(await channelIngressStores.senders.delete(key)).toBe(true); // old-host revoke
  expect(await getApprovedSender(laneKey, senderId)).toBeNull();
  expect(await storage.kvList('hostext:channel-ingress:sender:v2:')).toEqual([]);
  const conversationId = 'legacy-conversation';
  await channelIngressStores.conversationMarkers.put({ key: `${TENANT}\u0000${conversationId}`, tenantId: TENANT, conversationId, threadKey: 'legacy-thread' });
  expect(await isChannelConversation(TENANT, conversationId)).toBe(true);
  expect(await deleteChannelConversationMarker(TENANT, conversationId)).toBe(true);
  expect(await isChannelConversation(TENANT, conversationId)).toBe(false);
});

it('propagates unexpected legacy errors and fallback-read outages instead of returning absence', async () => {
  await setup('memory');
  const get = storage.kvGet.bind(storage);
  // Only the legacy NUL key fails; the safe-id read stays healthy, so a fallback
  // chosen for the wrong error answers `false` instead of re-throwing.
  const failLegacyWith = (error: Error): void => { storage.kvGet = async key => { if (key.includes('\u0000')) throw error; return get(key); }; };
  failLegacyWith(Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' }));
  await expect(isChannelConversation(TENANT, 'ordinary')).resolves.toBe(false); // control: the exact refusal falls back
  // Each fixture passes exactly one of the two checks: the first only the message check, the second only the code check.
  for (const error of [Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '08006' }), Object.assign(new Error('different invalid encoding'), { code: '22021' })]) {
    failLegacyWith(error);
    await expect(isChannelConversation(TENANT, 'ordinary')).rejects.toBe(error);
  }
  const failure = new Error('fallback read unavailable');
  storage.kvGet = async key => { if (key.includes('\u0000')) throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' }); throw failure; };
  await expect(isChannelConversation(TENANT, 'ordinary')).rejects.toBe(failure);
  storage.kvGet = get;
});

it('does not memoize representability across a replaced Storage handle', async () => {
  await setup('postgres-boundary');
  const first = await approveSender({ tenantId: TENANT, laneKey: 'relay:replacement', senderId: 'alice', ownerUserId: 'pg-owner' });
  expect(first.key.includes('\u0000')).toBe(false);
  await storage.close();
  await setup('memory');
  const key = 'relay:replacement\u0000alice';
  await channelIngressStores.senders.put({ key, tenantId: TENANT, laneKey: 'relay:replacement', senderId: 'alice', ownerUserId: 'legacy-owner', approvedAt: '2000-01-01T00:00:00.000Z' });
  expect((await getApprovedSender('relay:replacement', 'alice'))?.ownerUserId).toBe('legacy-owner');
  await channelIngressStores.senders.delete(key);
  expect(await getApprovedSender('relay:replacement', 'alice')).toBeNull();
});
