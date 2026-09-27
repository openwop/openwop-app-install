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
  setParticipantResponsePolicy,
  userRef,
  agentRef,
  type ConversationMeta,
} from '../../host/conversationStore.js';
import { getReadMarker, readMarkersByConversation } from '../../host/conversationReadState.js';
import { resolveAgentForTenant } from '../../host/agentVisibility.js';
import { appendChatMessageLive, extractMessageText } from '../../host/chatMessageBus.js';
import { publishChannelAgentRemoved } from '../../host/channelMembershipEvents.js';
import { slugify, uniqueSlug } from '../../host/slug.js';
import { resolveSubjectDisplays, type SubjectDisplay } from '../../host/subjectDisplay.js';

export interface ChannelInput {
  name?: unknown;
  description?: unknown;
  visibility?: unknown;
  /** ADR 0192 D4 — one-flow create: initial human + agent members, added through
   *  the SAME membership paths as post-create adds (slug stamping included). */
  memberUserIds?: unknown;
  agentIds?: unknown;
}

/** ADR 0192 D4 — channel names are lowercase slugs (`[a-z0-9][a-z0-9._-]*`, ≤80):
 *  the `#name` vocabulary every incumbent trains. Dots/underscores survive
 *  (conventional in channel names — `team.eng`, `ops_oncall`), so this is a
 *  channel-name policy, deliberately NOT `host/slug.ts` `slugify` (which strips
 *  them; that one is for MENTION slugs, D1). Legacy names are grandfathered for
 *  display and normalize on their next rename. */
function cleanName(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new OpenwopError('validation_error', '`name` is required.', 400, { field: 'name' });
  const normalized = v.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
  if (!normalized) throw new OpenwopError('validation_error', '`name` must contain letters or digits.', 400, { field: 'name' });
  return normalized;
}

const MAX_INITIAL_MEMBERS = 50;

function readIdList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 128)) {
    throw new OpenwopError('validation_error', `${field} MUST be an array of non-empty strings of 128 chars or fewer.`, 400, { field });
  }
  if (v.length > MAX_INITIAL_MEMBERS) {
    throw new OpenwopError('validation_error', `${field} MUST have ${MAX_INITIAL_MEMBERS} entries or fewer.`, 400, { field });
  }
  return [...new Set((v as string[]).map((x) => x.trim()))];
}

export async function createChannel(tenantId: string, ownerUserId: string | undefined, input: ChannelInput): Promise<ConversationMeta> {
  const name = cleanName(input.name);
  const visibility: 'public' | 'private' = input.visibility === 'private' ? 'private' : 'public';
  const memberUserIds = readIdList(input.memberUserIds, 'memberUserIds');
  const agentIds = readIdList(input.agentIds, 'agentIds');
  // Fail-closed BEFORE creating anything: every initial agent must resolve
  // (the addChannelAgent invariant, applied to the batch). ADR 0379 P1 —
  // tenant-gated: another tenant's user agent is absent (no cross-tenant bind).
  const resolvedAgents = await Promise.all(agentIds.map(async (agentId) => {
    const resolved = await resolveAgentForTenant(agentId, tenantId);
    if (!resolved) throw new OpenwopError('not_found', `Agent "${agentId}" not found.`, 404, { agentId });
    return { agentId, resolved };
  }));
  const channelId = randomUUID();
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({ sessionId: channelId, tenantId, title: name, createdAt: now, updatedAt: now, messageCount: 0 });
  let meta = await ensureConversationMeta(tenantId, channelId, {
    type: 'channel',
    ...(ownerUserId ? { ownerUserId } : {}),
    channel: { name, ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim().slice(0, 1000) } : {}), visibility },
  });
  // ADR 0192 D4 — initial members ride the same paths as post-create adds.
  for (const userId of memberUserIds) {
    if (ownerUserId && userId === ownerUserId) continue; // ensureConversationMeta already records the owner participant
    meta = (await addParticipant(tenantId, channelId, userRef(userId), meta)) ?? meta;
  }
  for (const { agentId, resolved } of resolvedAgents) {
    meta = await stampAgentMember(tenantId, channelId, meta, agentId, resolved.label ?? resolved.persona);
  }
  return meta;
}

/** ADR 0192 D1 — add an agent participant WITH its frozen mention identity:
 *  `mentionSlug` via the shared `host/slug.ts` policy, unique within the
 *  conversation; `displayLabel` = the human name at add-time. Stamped ONLY at
 *  membership-mutation time (never from a read path — the LWW hazard). */
async function stampAgentMember(tenantId: string, channelId: string, meta: ConversationMeta, agentId: string, label: string): Promise<ConversationMeta> {
  const taken = new Set(
    (meta.participants ?? []).map((p) => p.mentionSlug).filter((s): s is string => !!s),
  );
  const mentionSlug = uniqueSlug(slugify(label, 'agent'), taken, 'agent');
  // ADR 0202 D1 — the FIRST agent added to a channel is stamped 'all' (the
  // visible successor to the invisible sole-agent auto-reply); later agents
  // default to 'mention'. Add-time stamp only — never a read path.
  const hasAgentAlready = (meta.participants ?? []).some((p) => p.subjectRef.startsWith('agent:'));
  const responsePolicy: 'all' | 'mention' = hasAgentAlready ? 'mention' : 'all';
  const next = await addParticipant(tenantId, channelId, agentRef(agentId), meta, { mentionSlug, displayLabel: label, responsePolicy });
  return next ?? meta;
}

/** ADR 0202 D1 — set an agent member's reply policy (owner-gated). A real
 *  membership mutation (rewrites the participant record), so LWW-safe. */
export async function setChannelAgentPolicy(tenantId: string, channelId: string, callerUserId: string | undefined, agentId: string, policy: 'all' | 'mention'): Promise<ConversationMeta> {
  const m = await assertChannelManage(tenantId, channelId, callerUserId);
  const ref = agentRef(agentId);
  if (!(m.participants ?? []).some((p) => p.subjectRef === ref)) {
    throw new OpenwopError('not_found', `Agent "${agentId}" is not a member of this channel.`, 404, { agentId });
  }
  const next = await setParticipantResponsePolicy(tenantId, channelId, ref, policy, m);
  return next ?? m;
}

export async function listChannels(tenantId: string): Promise<ConversationMeta[]> {
  return (await listConversationMetas(tenantId))
    .filter((m) => m.type === 'channel' && m.channel && !m.channel.archived)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** A discovery row — the MINIMAL public shape (ADR 0154 FU-4). Deliberately omits
 *  participants/ownerUserId/run ids: a non-member (or anon) caller must not learn a
 *  channel's roster or owner identity, only that a joinable channel exists.
 *  ADR 0192 D8 adds aggregate COUNTS + last activity (reasons to join) — counts
 *  reveal room size, not identities, so the privacy posture holds. */
export interface ChannelDiscoveryRow {
  conversationId: string;
  channel: ConversationMeta['channel'];
  joined: boolean;
  memberCount: number;
  agentCount: number;
  lastActivityAt: string;
}

/** Channels the viewer may discover + join (ADR 0154 FU-4): every PUBLIC channel
 *  plus the viewer's OWN private memberships — never leaks other private channels.
 *  `joined` = the viewer is already a member or the owner. Unjoined-first so the
 *  discover affordance leads with what the caller can actually join. */
export async function listChannelsForViewer(tenantId: string, callerUserId: string | undefined): Promise<ChannelDiscoveryRow[]> {
  const ref = callerUserId ? userRef(callerUserId) : null;
  const isMember = (m: ConversationMeta): boolean =>
    (ref !== null && (m.participants ?? []).some((p) => p.subjectRef === ref)) || (!!callerUserId && m.ownerUserId === callerUserId);
  // Message activity lives on the SESSION header (`updatedAt` bumps on every
  // append); the meta's updatedAt only moves on membership/descriptor writes —
  // browsing "last active" must reflect messages, not renames. One batched read.
  const sessions = await hostExtStorage().listChatSessions(tenantId);
  const sessionUpdatedAt = new Map(sessions.map((s) => [s.sessionId, s.updatedAt]));
  // Mentions-inbox rollup (2026-07-17) — join the CALLER's read markers onto the
  // list so unread/mention counts ride the existing response (no second endpoint,
  // no N+1: session headers above are already batch-read and carry messageCount;
  // markers come from ONE tenant-batched read). Counts only for the signed-in
  // caller's JOINED channels; mention bumps come from chatMessageBus (ADR 0192 D6).
  const sessionMessageCount = new Map(sessions.map((s) => [s.sessionId, s.messageCount ?? 0]));
  const markers = ref !== null ? await readMarkersByConversation(tenantId) : new Map<string, Map<string, { readMessageCount?: number; mentionCount?: number }>>();
  return (await listConversationMetas(tenantId))
    .filter((m) => m.type === 'channel' && m.channel && !m.channel.archived)
    .filter((m) => m.channel!.visibility === 'public' || isMember(m))
    .map((m) => {
      const participants = m.participants ?? [];
      const agentCount = participants.filter((p) => p.subjectRef.startsWith('agent:')).length;
      // Humans = user participants, + the owner ONLY when they lack a
      // participant row. NOTE (review CR2): ensureConversationMeta records the
      // owner as an owner-role participant for ALL createChannel paths, so
      // owners DO carry isSelf/readMessageCount/mentionCount in the list
      // projection; this +1 synthesis exists only for legacy metas created
      // before owner stamping.
      const ownerHasRow = !!m.ownerUserId && participants.some((p) => p.subjectRef === userRef(m.ownerUserId!));
      const memberCount = participants.length - agentCount + (m.ownerUserId && !ownerHasRow ? 1 : 0);
      const joined = isMember(m);
      let counts: { unreadCount?: number; mentionCount?: number } = {};
      if (joined && ref !== null) {
        const marker = markers.get(m.conversationId)?.get(ref);
        const total = sessionMessageCount.get(m.conversationId) ?? 0;
        counts = {
          unreadCount: Math.max(0, total - (marker?.readMessageCount ?? 0)),
          mentionCount: marker?.mentionCount ?? 0,
        };
      }
      return {
        conversationId: m.conversationId,
        channel: m.channel,
        joined,
        memberCount,
        agentCount,
        lastActivityAt: sessionUpdatedAt.get(m.conversationId) ?? m.updatedAt,
        ...counts,
      };
    })
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
export async function assertChannelManage(tenantId: string, channelId: string, callerUserId: string | undefined): Promise<ConversationMeta> {
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
  const normalized = cleanName(name);
  const next = await setConversationChannel(tenantId, channelId, { name: normalized });
  if (!next) throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  // ADR 0192 D4 — the name lives in TWO stores (the descriptor + the session
  // header's `title` the rail lists by). Pre-0192 rename updated only the
  // descriptor, so the rail drifted from the channel's real name.
  await hostExtStorage().updateChatSession(tenantId, channelId, { title: normalized });
  return next;
}

/** ADR 0192 D4 — set/clear the channel description (owner-gated; ≤1000 chars). */
export async function setChannelDescription(tenantId: string, channelId: string, callerUserId: string | undefined, description: string): Promise<ConversationMeta> {
  await assertChannelManage(tenantId, channelId, callerUserId);
  const next = await setConversationChannel(tenantId, channelId, { description: description.trim().slice(0, 1000) });
  if (!next) throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  return next;
}

/** ADR 0192 D2/D8 — a roster row with the display identity resolved server-side
 *  (raw subjectRefs never render as UI). */
export interface ChannelRosterRow {
  subjectRef: string;
  role: 'owner' | 'member';
  addedAt?: string;
  kind: SubjectDisplay['kind'];
  displayName: string;
  mentionSlug?: string;
  /** ADR 0202 D1 — an agent member's EFFECTIVE reply policy (derived when
   *  unstamped: sole agent ⇒ 'all', else 'mention'). */
  responsePolicy?: 'all' | 'mention';
}

/** ADR 0192 D2 — the channel detail's resolved roster. Synthesizes the OWNER row
 *  (the owner is stamped on the meta, not stored as a participant) and resolves
 *  every display name through the subjectDisplay seam; agent members resolve
 *  from their add-time `displayLabel` with zero extra reads. */
export async function channelRoster(tenantId: string, meta: ConversationMeta): Promise<ChannelRosterRow[]> {
  const participants = meta.participants ?? [];
  const knownAgentLabels = new Map(
    participants
      .filter((p) => p.subjectRef.startsWith('agent:') && p.displayLabel)
      .map((p) => [p.subjectRef.slice('agent:'.length), p.displayLabel as string]),
  );
  const ownerRef = meta.ownerUserId ? userRef(meta.ownerUserId) : null;
  const refs = [...participants.map((p) => p.subjectRef), ...(ownerRef && !participants.some((p) => p.subjectRef === ownerRef) ? [ownerRef] : [])];
  const displays = await resolveSubjectDisplays(tenantId, refs, knownAgentLabels);
  const fallback = (ref: string): SubjectDisplay => ({ kind: ref.startsWith('agent:') ? 'agent' : 'user', displayName: ref.slice(ref.indexOf(':') + 1) });
  const agentCount = participants.filter((p) => p.subjectRef.startsWith('agent:')).length;
  const rows: ChannelRosterRow[] = participants.map((p) => {
    const d = displays.get(p.subjectRef) ?? fallback(p.subjectRef);
    const isAgent = p.subjectRef.startsWith('agent:');
    return {
      subjectRef: p.subjectRef,
      role: ownerRef !== null && p.subjectRef === ownerRef ? 'owner' : p.role,
      addedAt: p.addedAt,
      kind: d.kind,
      displayName: d.displayName,
      ...(p.mentionSlug ? { mentionSlug: p.mentionSlug } : {}),
      // ADR 0202 D1 — surface the EFFECTIVE policy (derived when unstamped) so
      // the persona card + owner control reflect actual behavior.
      ...(isAgent ? { responsePolicy: p.responsePolicy ?? (agentCount === 1 ? 'all' as const : 'mention' as const) } : {}),
    };
  });
  if (ownerRef && !participants.some((p) => p.subjectRef === ownerRef)) {
    const d = displays.get(ownerRef) ?? fallback(ownerRef);
    rows.unshift({ subjectRef: ownerRef, role: 'owner', kind: d.kind, displayName: d.displayName });
  }
  return rows;
}

/** ADR 0192 D3 — self-serve leave: any non-owner member removes THEMSELVES.
 *  The owner gets 409 (archive or transfer first — the owner-removal invariant
 *  with a self-serve door). A non-member is 404-masked like every other read. */
export async function leaveChannel(tenantId: string, channelId: string, callerUserId: string | undefined): Promise<void> {
  if (callerUserId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  const m = await mustGetChannel(tenantId, channelId);
  if (isChannelOwner(m, callerUserId)) {
    throw new OpenwopError('conflict', 'The channel owner cannot leave; archive the channel instead.', 409, { channelId });
  }
  const ref = userRef(callerUserId);
  if (!(m.participants ?? []).some((p) => p.subjectRef === ref)) {
    throw new OpenwopError('not_found', 'Channel not found.', 404, { channelId });
  }
  await removeParticipant(tenantId, channelId, ref, m);
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
  // ADR 0379 P1 — tenant-gated resolve (same 404 for absent and cross-tenant).
  const resolved = await resolveAgentForTenant(agentId, tenantId);
  if (!resolved) throw new OpenwopError('not_found', `Agent "${agentId}" not found.`, 404, { agentId });
  // ADR 0192 D1 — persist the mention identity at membership time (the slug
  // source ADR 0154 said didn't exist).
  return stampAgentMember(tenantId, channelId, m, agentId, resolved.label ?? resolved.persona);
}

/** Is `agentId` an agent MEMBER of this channel? (ADR 0202 D3 — a scheduled channel
 *  post must bind an agent that's actually a member, parity with live dispatch M3.) */
export function isChannelAgentMember(m: ConversationMeta, agentId: string): boolean {
  return (m.participants ?? []).some((p) => p.subjectRef === agentRef(agentId));
}

/** Remove an AGENT member (ADR 0154 Phase 4). Owner-gated. */
export async function removeChannelAgent(tenantId: string, channelId: string, callerUserId: string | undefined, agentId: string): Promise<ConversationMeta> {
  const m = await assertChannelManage(tenantId, channelId, callerUserId);
  const wasMember = isChannelAgentMember(m, agentId);
  const next = await removeParticipant(tenantId, channelId, agentRef(agentId), m);
  // ADR 0202 OQ-3 — signal the removal so a listener (scheduled-agent-chats) can clean
  // up this agent's scheduled channel posts. Published on the host-ext bus, NOT a direct
  // import, so the scheduled feature stays the only side of the edge (no cycle). Only on
  // an ACTUAL removal — a no-op remove (not a member) emits nothing.
  if (wasMember) publishChannelAgentRemoved({ tenantId, channelId, agentId });
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

const MAX_POST_BYTES = 256 * 1024; // envelope posts may carry inline attachments

export async function postChannelMessage(tenantId: string, channelId: string, authorUserId: string | undefined, content: unknown): Promise<{ messageId: string; text: string }> {
  const m = await mustGetChannel(tenantId, channelId);
  if (m.channel?.archived) throw new OpenwopError('validation_error', 'Channel is archived.', 400, { channelId });
  // CHN-3: no anonymous channel access — even a public channel requires a resolved
  // principal to post (mirrors assertChannelAccess's default-deny on an undefined caller).
  if (authorUserId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  if (!canAccessChannel(m, authorUserId)) throw new OpenwopError('forbidden', 'Not a member of this channel.', 403, { channelId });
  // ADR 0192 D5 — accept plain text (back-compat) OR the serialized ChatMessage
  // envelope (attachments; `useChatSession` already dual-parses both shapes).
  const raw = String(content ?? '').trim();
  const text = extractMessageText(raw).trim();
  if (!text && !raw) throw new OpenwopError('validation_error', 'Message content is required.', 400, {});
  if (Buffer.byteLength(raw, 'utf8') > MAX_POST_BYTES) {
    throw new OpenwopError('validation_error', `Message content MUST be ${MAX_POST_BYTES} bytes or fewer.`, 400, {});
  }
  const messageId = randomUUID();
  // ADR 0154 FU-6 — append + publish a live-delivery event so members streaming
  // the channel see the post without a manual refresh (tenantId enables the
  // ADR 0192 D6 mention stamping in the bus post-processing).
  await appendChatMessageLive({
    messageId, sessionId: channelId, role: 'user', content: raw,
    meta: null, authorSubject: authorUserId ? userRef(authorUserId) : null, createdAt: new Date().toISOString(),
  }, tenantId);
  return { messageId, text };
}

/** ADR 0202 D2 — resolve the caller's UNREAD span for a catch-up summary. The
 *  messages since their `readMessageCount` (ADR 0192 D6), capped, flattened to a
 *  prompt-ready transcript. Member-gated; requires a channel agent member (no
 *  phantom host summarizer). Returns the agentId to run + the task text, or
 *  throws a typed error the route maps. */
const CATCHUP_MAX_MESSAGES = 50;

export async function resolveChannelCatchup(
  tenantId: string,
  channelId: string,
  callerUserId: string | undefined,
): Promise<{ agentId: string; task: string; unreadCount: number }> {
  if (callerUserId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  // getChannel 404-masks a private channel from non-members (no existence leak)
  // and admits any member of a public channel — the correct catch-up gate.
  const m = await getChannel(tenantId, channelId, callerUserId);
  const agentMember = (m.participants ?? []).find((p) => p.subjectRef.startsWith('agent:'));
  if (!agentMember) {
    throw new OpenwopError('validation_error', 'This channel has no agent member to summarize with.', 400, { channelId });
  }
  // CS-CH-3 — bounded read: the total comes from an exact COUNT (the
  // `message_count` column is caller-maintained and the channel/voice append
  // paths don't bump it — the post-merge architect review caught catch-up
  // trusting that stale counter) and only the capped tail is fetched; the
  // unread span is that tail narrowed to the unread suffix. Behavior-identical
  // to the old full read for every thread ≤ the cap, honest (capped) beyond it.
  const total = await hostExtStorage().countChatSessionMessages(channelId);
  const marker = await getReadMarker(tenantId, channelId, userRef(callerUserId));
  const readCount = marker?.readMessageCount ?? 0;
  const unreadCount = total - readCount;
  const tail = await hostExtStorage().listChatSessionMessages(channelId, { limit: CATCHUP_MAX_MESSAGES });
  const unread = tail.slice(Math.max(0, tail.length - Math.min(Math.max(unreadCount, 0), CATCHUP_MAX_MESSAGES)));
  const transcript = unread.map((r) => extractMessageText(r.content)).filter((t) => t.trim()).join('\n');
  const task = `Summarize the recent messages I missed in this channel, as a short bulleted recap:\n\n${transcript || '(no new messages)'}`;
  return { agentId: agentMember.subjectRef.slice('agent:'.length), task, unreadCount: Math.max(0, unreadCount) };
}

export async function listChannelMessages(
  tenantId: string,
  channelId: string,
  viewerUserId: string | undefined,
  // CS-CH-3 — reverse pagination (the chat-sessions idiom; absent ⇒ the
  // legacy full-thread read for back-compat).
  opts?: { limit?: number; before?: { createdAt: string; messageId: string } },
): Promise<readonly ChatMessageRecord[]> {
  const m = await mustGetChannel(tenantId, channelId);
  // CHN-3: no anonymous channel reads, even on a public channel.
  if (viewerUserId === undefined) throw new OpenwopError('forbidden', 'Authentication required.', 403, { channelId });
  if (!canAccessChannel(m, viewerUserId)) throw new OpenwopError('forbidden', 'Not a member of this channel.', 403, { channelId });
  return hostExtStorage().listChatSessionMessages(channelId, opts);
}
