/**
 * Team channels (ADR 0126 Phase 1) — v1 LOCAL-HOST, presence-free.
 *
 * A channel is a NEW conversation `type:'channel'` (NOT a parallel message store):
 * it reuses `conversationStore` (meta + participants) + the chat-session title/
 * message store. Presence/typing/receipts + cross-host are RFC-gated and NOT here.
 *
 * @see docs/adr/0126-team-channels-realtime-messaging.md
 */
import { randomUUID } from 'node:crypto';
import type { ChatMessageRecord } from '../../types.js';
import { OpenwopError } from '../../types.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import {
  ensureConversationMeta,
  getConversationMeta,
  listConversationMetas,
  setConversationChannel,
  addParticipant,
  removeParticipant,
  userRef,
  agentRef,
  type ConversationMeta,
} from '../../host/conversationStore.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { appendChatMessageLive } from '../../host/chatMessageBus.js';

export interface ChannelInput { name?: unknown; description?: unknown; visibility?: unknown }

function cleanName(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new OpenwopError('validation_error', '`name` is required.', 400, { field: 'name' });
  return v.trim().slice(0, 120);
}

export async function createChannel(tenantId: string, ownerUserId: string | undefined, input: ChannelInput): Promise<ConversationMeta> {
  const name = cleanName(input.name);
  const visibility: 'public' | 'private' = input.visibility === 'private' ? 'private' : 'public';
  const channelId = randomUUID();
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({ sessionId: channelId, tenantId, title: name, createdAt: now, updatedAt: now, messageCount: 0 });
  return ensureConversationMeta(tenantId, channelId, {
    type: 'channel',
    ...(ownerUserId ? { ownerUserId } : {}),
    channel: { name, ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim().slice(0, 1000) } : {}), visibility },
  });
}

export async function listChannels(tenantId: string): Promise<ConversationMeta[]> {
  return (await listConversationMetas(tenantId))
    .filter((m) => m.type === 'channel' && m.channel && !m.channel.archived)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** A discovery row — the MINIMAL public shape (ADR 0154 FU-4). Deliberately omits
 *  participants/ownerUserId/run ids: a non-member (or anon) caller must not learn a
 *  channel's roster or owner identity, only that a joinable channel exists. */
export interface ChannelDiscoveryRow { conversationId: string; channel: ConversationMeta['channel']; joined: boolean }

/** Channels the viewer may discover + join (ADR 0154 FU-4): every PUBLIC channel
 *  plus the viewer's OWN private memberships — never leaks other private channels.
 *  `joined` = the viewer is already a member or the owner. Unjoined-first so the
 *  discover affordance leads with what the caller can actually join. */
export async function listChannelsForViewer(tenantId: string, callerUserId: string | undefined): Promise<ChannelDiscoveryRow[]> {
  const ref = callerUserId ? userRef(callerUserId) : null;
  const isMember = (m: ConversationMeta): boolean =>
    (ref !== null && (m.participants ?? []).some((p) => p.subjectRef === ref)) || (!!callerUserId && m.ownerUserId === callerUserId);
  return (await listConversationMetas(tenantId))
    .filter((m) => m.type === 'channel' && m.channel && !m.channel.archived)
    .filter((m) => m.channel!.visibility === 'public' || isMember(m))
    .map((m) => ({ conversationId: m.conversationId, channel: m.channel, joined: isMember(m) }))
    .sort((a, b) => (a.joined === b.joined ? 0 : a.joined ? 1 : -1));
}

/** Self-join a PUBLIC channel (any tenant member adds THEMSELVES — not owner-gated).
 *  A private (or archived) channel is 404-masked unless the caller is already a
 *  member (idempotent join, no private existence leak). ADR 0154 FU-4. */
export async function joinChannel(tenantId: string, channelId: string, callerUserId: string | undefined): Promise<ConversationMeta> {
  if (callerUserId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  const m = await mustGetChannel(tenantId, channelId);
  const ref = userRef(callerUserId);
  const alreadyMember = m.ownerUserId === callerUserId || (m.participants ?? []).some((p) => p.subjectRef === ref);
  if (alreadyMember) return m; // idempotent — never duplicate the owner/member
  // 404-mask anything the caller can't join: private channels and archived ones.
  if (m.channel?.visibility !== 'public' || m.channel.archived) {
    throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  }
  const next = await addParticipant(tenantId, channelId, ref, m);
  return next ?? m;
}

async function mustGetChannel(tenantId: string, channelId: string): Promise<ConversationMeta> {
  const m = await getConversationMeta(tenantId, channelId);
  if (!m || m.type !== 'channel') throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  return m;
}

/** The owner is authorized for read+management even though they are not stored as a
 *  `participants` entry (createChannel stamps `ownerUserId` only). Exported so the
 *  GET route can return a server-computed `viewerIsOwner` flag — the FE must NOT
 *  reconstruct the backend identity (`ownerUserId` is `oidc:<sub>`/`user:<hash>`,
 *  never the raw client uid). ADR 0154 Phase 2. */
export function isChannelOwner(m: ConversationMeta, callerUserId: string | undefined): boolean {
  return callerUserId !== undefined && !!m.ownerUserId && m.ownerUserId === callerUserId;
}

/** Read a channel's metadata. Membership-gated (CHN-2): the owner or a member may read;
 *  a private channel is 404-masked from everyone else; an undefined caller is denied
 *  (CHN-3, no anon read). */
export async function getChannel(tenantId: string, channelId: string, callerUserId: string | undefined): Promise<ConversationMeta> {
  const m = await mustGetChannel(tenantId, channelId);
  if (!isChannelOwner(m, callerUserId) && (callerUserId === undefined || !canAccessChannel(m, callerUserId))) {
    // 404-mask: a non-member must not learn a private channel exists.
    throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  }
  return m;
}

/** Authorize a channel MANAGEMENT op (rename/archive/add-member/remove-member).
 *  Fail-closed owner-only policy (CHN-1): the owner passes (even though not a
 *  participant); a member who is not the owner is 403; a private-channel non-member
 *  and an ownerless legacy channel (no `ownerUserId`, e.g. created by an API-key
 *  principal before owners were stamped) are 404-masked. We never fall back to
 *  membership for the WRITE, which would reintroduce the IDOR. */
async function assertChannelManage(tenantId: string, channelId: string, callerUserId: string | undefined): Promise<ConversationMeta> {
  const m = await mustGetChannel(tenantId, channelId);
  if (isChannelOwner(m, callerUserId)) return m;
  // Not the owner: distinguish "you may see it but can't manage it" (403) from
  // "you may not even know it exists" (404). A public channel / a participant knows
  // it exists → 403; everyone else (incl. undefined caller, ownerless channel) → 404.
  if (callerUserId === undefined || !canAccessChannel(m, callerUserId)) {
    throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  }
  throw new OpenwopError('forbidden', 'Only the channel owner can manage this channel.', 403, { channelId });
}

export async function renameChannel(tenantId: string, channelId: string, callerUserId: string | undefined, name: string): Promise<ConversationMeta> {
  await assertChannelManage(tenantId, channelId, callerUserId);
  const next = await setConversationChannel(tenantId, channelId, { name: cleanName(name) });
  if (!next) throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  return next;
}

export async function archiveChannel(tenantId: string, channelId: string, callerUserId: string | undefined): Promise<void> {
  await assertChannelManage(tenantId, channelId, callerUserId);
  await setConversationChannel(tenantId, channelId, { archived: true });
}

export async function addChannelMember(tenantId: string, channelId: string, callerUserId: string | undefined, userId: string): Promise<ConversationMeta> {
  const m = await assertChannelManage(tenantId, channelId, callerUserId);
  const next = await addParticipant(tenantId, channelId, userRef(userId), m);
  return next ?? m;
}

/** Add an AGENT as a channel member (ADR 0154 Phase 4). Owner-gated. An agent
 *  member can be addressed in a post to dispatch a turn (channelAgentDispatch).
 *  The agent must resolve in the registry so an owner can't add a dead agentId
 *  whose every turn would silently fail. */
export async function addChannelAgent(tenantId: string, channelId: string, callerUserId: string | undefined, agentId: string): Promise<ConversationMeta> {
  const m = await assertChannelManage(tenantId, channelId, callerUserId);
  const resolved = await getAgentRegistry().resolve(agentId);
  if (!resolved) throw new OpenwopError('not_found', `Agent "${agentId}" not found.`, 404, { agentId });
  const next = await addParticipant(tenantId, channelId, agentRef(agentId), m);
  return next ?? m;
}

/** Remove an AGENT member (ADR 0154 Phase 4). Owner-gated. */
export async function removeChannelAgent(tenantId: string, channelId: string, callerUserId: string | undefined, agentId: string): Promise<ConversationMeta> {
  const m = await assertChannelManage(tenantId, channelId, callerUserId);
  const next = await removeParticipant(tenantId, channelId, agentRef(agentId), m);
  return next ?? m;
}

export async function removeChannelMember(tenantId: string, channelId: string, callerUserId: string | undefined, userId: string): Promise<ConversationMeta> {
  const m = await assertChannelManage(tenantId, channelId, callerUserId);
  // Invariant: the owner can't be removed (would orphan the channel into an
  // unmanageable state) — archive the channel instead.
  if (m.ownerUserId && m.ownerUserId === userId) {
    throw new OpenwopError('validation_error', 'Cannot remove the channel owner; archive the channel instead.', 400, { channelId });
  }
  const next = await removeParticipant(tenantId, channelId, userRef(userId), m);
  return next ?? m;
}


// ── ADR 0126 Phase 2 — membership-gated post + read ───────────────────────────

/** A public channel admits any tenant member; a private channel admits only its
 *  participants. DEFAULT-DENY: an undefined viewer on a private channel is denied. */
function canAccessChannel(m: ConversationMeta, userId: string | undefined): boolean {
  if (m.channel?.visibility === 'public') return true;
  if (userId === undefined) return false;
  const ref = userRef(userId);
  return (m.participants ?? []).some((p) => p.subjectRef === ref);
}

/** ADR 0126 Phase 4 — gate channel-presence access + resolve the caller's subject ref.
 *  Throws 404 (not a channel) / 403 (not a member) — the SAME DEFAULT-DENY as post/read.
 *  Returns the RFC 0041 `user:<id>` ref to track presence under. */
export async function assertChannelAccess(tenantId: string, channelId: string, userId: string | undefined): Promise<{ ref: string }> {
  const m = await mustGetChannel(tenantId, channelId);
  if (!canAccessChannel(m, userId)) throw new OpenwopError('forbidden', 'Not a member of this channel.', 403, { channelId });
  if (userId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  return { ref: userRef(userId) };
}

export async function postChannelMessage(tenantId: string, channelId: string, authorUserId: string | undefined, content: unknown): Promise<{ messageId: string }> {
  const m = await mustGetChannel(tenantId, channelId);
  if (m.channel?.archived) throw new OpenwopError('validation_error', 'Channel is archived.', 400, { channelId });
  // CHN-3: no anonymous channel access — even a public channel requires a resolved
  // principal to post (mirrors assertChannelAccess's default-deny on an undefined caller).
  if (authorUserId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  if (!canAccessChannel(m, authorUserId)) throw new OpenwopError('forbidden', 'Not a member of this channel.', 403, { channelId });
  const text = String(content ?? '').trim();
  if (!text) throw new OpenwopError('validation_error', 'Message content is required.', 400, {});
  const messageId = randomUUID();
  // ADR 0154 FU-6 — append + publish a live-delivery event so members streaming
  // the channel see the post without a manual refresh.
  await appendChatMessageLive({
    messageId, sessionId: channelId, role: 'user', content: text.slice(0, 100_000),
    meta: null, authorSubject: authorUserId ? userRef(authorUserId) : null, createdAt: new Date().toISOString(),
  });
  return { messageId };
}

export async function listChannelMessages(tenantId: string, channelId: string, viewerUserId: string | undefined): Promise<readonly ChatMessageRecord[]> {
  const m = await mustGetChannel(tenantId, channelId);
  // CHN-3: no anonymous channel reads, even on a public channel.
  if (viewerUserId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  if (!canAccessChannel(m, viewerUserId)) throw new OpenwopError('forbidden', 'Not a member of this channel.', 403, { channelId });
  return hostExtStorage().listChatSessionMessages(channelId);
}
