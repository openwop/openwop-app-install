/**
 * ADR 1042 — the channel core's small host-ext stores. Every row carries its
 * tenant (a `tenantOf` resolver), so tenant teardown reaches all of them.
 *
 * A LANE is where messages come from: `conn:<connectionId>` (hosted) or
 * `relay:<relayId>` (device). A THREAD is one external chat on a lane, and maps
 * to ONE main-chat conversation.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { ChannelLane } from '../connections/messagingOutbound.js';

export const laneKeyOf = (lane: ChannelLane): string => (lane.kind === 'relay' ? `relay:${lane.relayId}` : `conn:${lane.connectionId}`);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** ADR1042 correction: legacy NUL IDs remain canonical wherever supported.
 * PostgreSQL TEXT cannot represent them. Resolve by READ before any index/row
 * write, and fall back only for that exact encoding refusal, never an outage.
 * No aliases or absence cache: old hosts' revocations remain authoritative. */
async function readCompound<T>(collection: DurableCollection<T>, parts: readonly string[]): Promise<{ key: string; row: T | null }> {
  const legacy = parts.join('\u0000');
  try {
    return { key: legacy, row: await collection.get(legacy) };
  } catch (error) {
    if (!legacy.includes('\u0000') || !(error instanceof Error) || !('code' in error)
      || error.code !== '22021' || !/\b0x00\b/.test(error.message)) throw error;
    const key = `v2:${sha(JSON.stringify(parts))}`;
    return { key, row: await collection.get(key) };
  }
}

/** Per-lane channel settings (D7): the answering agent and the bot's handle for group mentions. */
export interface ChannelSettings {
  laneKey: string;
  tenantId: string;
  /** The agent that answers; absent = the main chat's default assistant. */
  agentId?: string;
  /** The bot's handle, without `@`. Group messages must mention it. */
  botHandle?: string;
  /** Model routing for the conversation run (absent = the tenant default). */
  provider?: string;
  model?: string;
  updatedAt: string;
}
const settings = new DurableCollection<ChannelSettings>('channel-ingress:settings', (s) => s.laneKey, undefined, (s) => s.tenantId);
export const getChannelSettings = (laneKey: string): Promise<ChannelSettings | null> => settings.get(laneKey);
export const putChannelSettings = (s: ChannelSettings): Promise<void> => settings.put(s);

/** An approved sender (D3): `senderId` is the platform user id, or `group:<chatId>`. */
export interface ApprovedSender {
  key: string;
  tenantId: string;
  laneKey: string;
  senderId: string;
  /** The paired owner: the person who approved, as whom this sender's turns run. */
  ownerUserId: string;
  /** The owner's own personal workspace, recorded at approval (M4): in that
   *  workspace the owner is present without a member row. */
  ownerPersonalTenant?: string;
  /** ADR 1042 D9 — this sender is the OWNER's own linked account: their turns get
   *  the owner's full tools. Set only by the owner, never on a group, at most one
   *  per owner per lane. */
  self?: boolean;
  label?: string;
  approvedAt: string;
}
const senders = new DurableCollection<ApprovedSender>('channel-ingress:sender', (s) => s.key, undefined, (s) => s.tenantId);
export const getApprovedSender = async (laneKey: string, senderId: string): Promise<ApprovedSender | null> =>
  (await readCompound(senders, [laneKey, senderId])).row;
export async function approveSender(input: Omit<ApprovedSender, 'key' | 'approvedAt'>): Promise<ApprovedSender> {
  const parts = [input.laneKey, input.senderId];
  const { key } = await readCompound(senders, parts);
  const pendingIdentity = await readCompound(pending, parts);
  const row: ApprovedSender = { ...input, key, approvedAt: new Date().toISOString() };
  await senders.put(row);
  await pending.delete(pendingIdentity.key);
  return row;
}
export const revokeSender = async (laneKey: string, senderId: string): Promise<boolean> =>
  senders.delete((await readCompound(senders, [laneKey, senderId])).key);
/** ADR 1042 D9 — mark (or unmark) an approval as the owner's own account. The caller
 *  has checked the requester IS the row's owner. Marking clears any other self row of
 *  the same owner on the lane (at most one). Returns the updated row, or null. */
export async function setSenderSelf(tenantId: string, laneKey: string, senderId: string, self: boolean): Promise<ApprovedSender | null> {
  const { row } = await readCompound(senders, [laneKey, senderId]);
  if (!row || row.tenantId !== tenantId) return null;
  if (self) {
    for (const other of await senders.listForTenantIndexed(tenantId)) {
      if (other.laneKey === laneKey && other.ownerUserId === row.ownerUserId && other.key !== row.key && other.self) {
        const cleared = { ...other };
        delete cleared.self;
        await senders.put(cleared);
      }
    }
  }
  const next: ApprovedSender = { ...row };
  if (self) next.self = true; else delete next.self;
  await senders.put(next);
  return next;
}
export async function listApprovedSenders(tenantId: string, laneKey: string): Promise<ApprovedSender[]> {
  return (await senders.listForTenantIndexed(tenantId)).filter((s) => s.laneKey === laneKey);
}

/** A sender nobody approved yet (D3): recorded, never answered. */
export interface PendingSender { key: string; tenantId: string; laneKey: string; senderId: string; chatId: string; firstSeenAt: string; lastSeenAt: string; count: number }
const pending = new DurableCollection<PendingSender>('channel-ingress:pending', (s) => s.key, undefined, (s) => s.tenantId);
/** Security review M6 — at most this many pending rows per lane; the oldest is evicted. */
export const PENDING_PER_LANE_CAP = 100;
export async function recordPendingSender(input: { tenantId: string; laneKey: string; senderId: string; chatId: string }): Promise<void> {
  const { key, row: prior } = await readCompound(pending, [input.laneKey, input.senderId]);
  const now = new Date().toISOString();
  await pending.put({ key, ...input, firstSeenAt: prior?.firstSeenAt ?? now, lastSeenAt: now, count: (prior?.count ?? 0) + 1 });
  if (prior) return;
  // A new row: keep the lane under its cap, evicting the least recently seen.
  const lane = (await pending.listForTenantIndexed(input.tenantId)).filter((r) => r.laneKey === input.laneKey);
  if (lane.length <= PENDING_PER_LANE_CAP) return;
  lane.sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt) || a.firstSeenAt.localeCompare(b.firstSeenAt));
  for (const r of lane.slice(0, lane.length - PENDING_PER_LANE_CAP)) if (r.key !== key) await pending.delete(r.key);
}
/** CHAN-P0-8 — deny a pending request: the row goes, the sender stays blocked (default
 *  deny). If they write again, a new request is recorded. Tenant-checked. */
export async function dismissPendingSender(tenantId: string, laneKey: string, senderId: string): Promise<boolean> {
  const { key, row } = await readCompound(pending, [laneKey, senderId]);
  if (!row || row.tenantId !== tenantId) return false;
  return pending.delete(key);
}
export async function listPendingSenders(tenantId: string, laneKey: string): Promise<PendingSender[]> {
  return (await pending.listForTenantIndexed(tenantId)).filter((s) => s.laneKey === laneKey);
}

/** One external chat ↔ one main-chat conversation (D7). */
export interface ChannelThread {
  threadKey: string;
  tenantId: string;
  lane: ChannelLane;
  chatId: string;
  conversationId: string;
  ownerUserId: string;
  /** A group chat (several people write in it). */
  isGroup?: boolean;
  /** Review N1 — `self`: the owner's own account; `narrow`: everyone else. The two
   *  never share a conversation (the scope is part of the thread key). */
  scope?: 'self' | 'narrow';
  /** The live `openwop-app.conversation` run, when one is open. */
  runId?: string;
  /** Review round 3 (M5) — every conversation run this thread ever opened, so
   *  erasure deletes them all (and with them their event logs). */
  runIds?: string[];
  createdAt: string;
  updatedAt: string;
}
const threads = new DurableCollection<ChannelThread>('channel-ingress:thread', (t) => t.threadKey, undefined, (t) => t.tenantId);
/** Security review M4 — the owner is part of the thread's identity: when the
 *  approval moves to another person, their messages start a NEW thread and
 *  conversation; another owner's conversation is never reused. Review N1 — so is
 *  the scope: the owner's own (self) turns and outsiders' (narrow) turns never
 *  share a conversation, so no full-tools turn can read an outsider's text. */
export const threadKeyOf = (laneKey: string, chatId: string, ownerUserId: string, scope: 'self' | 'narrow'): string =>
  sha(`${laneKey}\u0000${chatId}\u0000${ownerUserId}\u0000${scope}`);

/** Review round 3 — which chat sessions are channel threads (core refuses to re-bind
 *  or branch them, and keeps them out of conversation search). Keyed by session. */
interface ConversationMarker { key: string; tenantId: string; conversationId: string; threadKey: string }
const conversationMarkers = new DurableCollection<ConversationMarker>('channel-ingress:conversation', (m) => m.key, undefined, (m) => m.tenantId);
export async function markChannelConversation(tenantId: string, conversationId: string, threadKey: string): Promise<void> {
  const { key } = await readCompound(conversationMarkers, [tenantId, conversationId]);
  await conversationMarkers.put({ key, tenantId, conversationId, threadKey });
}
export async function isChannelConversation(tenantId: string, conversationId: string): Promise<boolean> {
  return (await readCompound(conversationMarkers, [tenantId, conversationId])).row !== null;
}
export const deleteChannelConversationMarker = async (tenantId: string, conversationId: string): Promise<boolean> =>
  conversationMarkers.delete((await readCompound(conversationMarkers, [tenantId, conversationId])).key);

/** Review M5 — the UNCAPPED index of who wrote in which thread (lane + sender →
 *  thread), so erasing a person finds every thread they ever wrote in, however
 *  early. One row per (lane, sender, thread). */
export interface SenderThreadRow { key: string; tenantId: string; laneKey: string; senderId: string; threadKey: string }
const senderThreads = new DurableCollection<SenderThreadRow>('channel-ingress:sender-thread', (r) => r.key, undefined, (r) => r.tenantId);
export async function recordSenderInThread(tenantId: string, laneKey: string, senderId: string, threadKey: string): Promise<void> {
  const { key, row } = await readCompound(senderThreads, [laneKey, senderId, threadKey]);
  if (row) return;
  await senderThreads.put({ key, tenantId, laneKey, senderId, threadKey });
}
/** Matches the chat-session id grammar `/^[A-Za-z0-9_-]{1,64}$/`. */
export const conversationIdOf = (threadKey: string): string => `ch-${threadKey.slice(0, 40)}`;
export const getThread = (threadKey: string): Promise<ChannelThread | null> => threads.get(threadKey);
export const putThread = (t: ChannelThread): Promise<void> => threads.put(t);

/** ADR 1042 CHAN-F3 — create a thread only if no row holds its key yet, and return the
 *  row that does. Two instances taking a first message at once both build a fresh
 *  thread; a plain `put` let the later one overwrite the earlier one's recorded runs. */
export async function createThreadOnce(t: ChannelThread): Promise<ChannelThread> {
  if (await threads.putIfAbsent(t)) return t;
  return (await threads.get(t.threadKey)) ?? t;
}

/**
 * ADR 1042 CHAN-F3 (the runIds read-modify-write race) — record a conversation run on
 * its thread with a compare-and-swap, so two instances opening runs for one thread at
 * once cannot lose an id (erasure deletes runs through `runIds`; a lost id was a run
 * erasure never found). Never re-creates a thread that is gone: erasure deleted it,
 * and a write here would bring it back. Returns whether the run was recorded.
 */
export async function recordThreadRun(threadKey: string, runId: string): Promise<boolean> {
  // One writer wins each round, so N concurrent writers need at most N rounds; real
  // contention is a few instances, and 32 leaves room for a burst.
  for (let attempt = 0; attempt < 32; attempt++) {
    const cur = await threads.get(threadKey);
    if (!cur) return false;
    const next: ChannelThread = { ...cur, runId, runIds: [...new Set([...(cur.runIds ?? []), runId])], updatedAt: new Date().toISOString() };
    if (await threads.compareAndSwap(cur, next)) return true;
  }
  return false;
}

/** A reply owed for one inbound message, keyed by the exchange key (D4/D7). */
export interface PendingReply {
  exchangeKey: string;
  tenantId: string;
  lane: ChannelLane;
  chatId: string;
  threadId?: string;
  inboundMessageId: string;
  /** The platform id of the person the reply answers (erasure, M5). */
  senderId?: string;
  conversationId: string;
  ownerUserId: string;
  ownerPersonalTenant?: string;
  createdAt: string;
}
const replies = new DurableCollection<PendingReply>('channel-ingress:reply', (r) => r.exchangeKey, undefined, (r) => r.tenantId);
/** `chan-` + 40 hex: inside the chat message id grammar with room for a suffix. */
/** Security review H1 — the chat and thread are part of the key: a platform message
 *  id can be unique only within one chat (Telegram `message_id`, relay ids). */
export const exchangeKeyOf = (laneKey: string, chatId: string, threadId: string | undefined, messageId: string): string =>
  `chan-${sha(`${laneKey}\u0000${chatId}\u0000${threadId ?? ''}\u0000${messageId}`).slice(0, 40)}`;
export const putPendingReply = (r: PendingReply): Promise<void> => replies.put(r);
export const getPendingReply = (exchangeKey: string): Promise<PendingReply | null> => replies.get(exchangeKey);
export const deletePendingReply = (exchangeKey: string): Promise<boolean> => replies.delete(exchangeKey);

/** Connection revoked: its senders, pending requests and settings go (threads stay —
 *  they point at the owner's conversation, which is theirs to keep). */
export async function purgeLane(tenantId: string, laneKey: string): Promise<void> {
  for (const s of await senders.listForTenantIndexed(tenantId)) if (s.laneKey === laneKey) await senders.delete(s.key);
  for (const p of await pending.listForTenantIndexed(tenantId)) if (p.laneKey === laneKey) await pending.delete(p.key);
  await settings.delete(laneKey);
}

/** ADR 1042 D8 — the erasure module's handle on the rows (deletes stay in one place per store). */
export const channelIngressStores = { senders, pending, threads, replies, senderThreads, conversationMarkers } as const;
