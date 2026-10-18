/**
 * ADR 0879 D7 — may a RUN write a message into this conversation?
 *
 * Two in-run lanes land posts in a conversation: the agent-runner's reply append
 * (`agentRunnerNode.ts`, the `conversationId` input every channel turn, scheduled
 * chat and KickBot coach turn ends in) and `ctx.chat.sendMessage`
 * (`chatSurface.ts`). Before this both wrote into ANY id they were handed — a
 * private channel the agent is not in, an archived channel, another tenant's
 * session — and both are reachable from a workflow an Editor can author (S7, S8).
 *
 * The question is authority over the TARGET, asked on the id that is about to be
 * written (node config outranks `configurable`, so checking the dispatch's value is
 * not enough):
 *
 *  1. The conversation exists in the run's tenant (chat rows key on `session_id`
 *     alone, so this is the tenant boundary). `sendMessage` may still create a new
 *     session when nothing by that id exists here.
 *  2. The human behind the run is `actingUserId`, else `orgScopeSubject` — the
 *     member who CAUSED a run that acts for nobody (a channel's poster, a schedule's
 *     creator). It is read here as that person's posting authority; it grants
 *     nothing else (ADR 0832 D3).
 *  3. A CHANNEL takes only an AGENT MEMBER's reply (never a `sendMessage` — its row
 *     has no author), and only when the human can POST there now: `workspace:write`
 *     in the tenant, channel access, not archived, the announcement policy. No
 *     human ⇒ refused.
 *  4. Any other conversation: with a human, the conversation must be visible to them
 *     (`isVisibleToAsync` — project chats are subject-governed). With no human, an
 *     OWNED conversation takes an agent append only from an agent that is its
 *     participant, and never a `sendMessage`; an unowned legacy session is unchanged.
 *
 * Pure host code: channel semantics are read off the meta (the same rules
 * `features/channels` applies), so core never imports a feature.
 */
import type { Storage } from '../storage/storage.js';
import { getConversationMeta, userRef, type ConversationMeta } from './conversationStore.js';
import { isVisibleToAsync } from './conversationVisibility.js';
import { hasWorkflowScope } from './workflowWriteAuthority.js';
import { assertTenantScope } from './accessControlService.js';
import { agentStorageId } from '../executor/agentIdAliases.js';

export interface RunConversationWrite {
  tenantId: string;
  conversationId: string;
  actingUserId?: string | undefined;
  orgScopeSubject?: string | undefined;
  personalTenant?: string | undefined;
  /** Set for an agent's reply; absent for `ctx.chat.sendMessage`. */
  agentId?: string | undefined;
  /** `sendMessage` creates the per-run / per-pack session when it does not exist. */
  mayCreate?: boolean;
}

export type RunConversationWriteVerdict =
  | { ok: true; create: boolean }
  | { ok: false; reason: 'not_in_tenant' | 'archived' | 'no_human' | 'not_visible' | 'cannot_post' | 'agent_not_member' | 'channel_needs_agent' };

function agentIsParticipant(meta: ConversationMeta, agentId: string): boolean {
  const want = agentStorageId(agentId);
  return meta.participants.some((p) => p.subjectRef.startsWith('agent:') && agentStorageId(p.subjectRef.slice('agent:'.length)) === want);
}

async function holdsScope(tenantId: string, human: string, personalTenant: string | undefined, scope: 'workspace:write' | 'host:members:manage'): Promise<boolean> {
  if (scope === 'workspace:write') return hasWorkflowScope({ tenantId, actingUserId: human, personalTenant }, 'workspace:write');
  try {
    await assertTenantScope(tenantId, human, scope, personalTenant !== undefined ? { personalTenant } : {});
    return true;
  } catch {
    return false;
  }
}

/** Channel POST authority for a person, read off the meta (mirrors
 *  `features/channels` `channelPostRefusal` + `requireChannelWrite`). */
async function humanMayPostToChannel(meta: ConversationMeta, tenantId: string, human: string, personalTenant: string | undefined): Promise<boolean> {
  const ch = meta.channel;
  if (!ch) return false;
  const isOwner = meta.ownerUserId !== undefined && meta.ownerUserId === human;
  const isMember = isOwner || meta.participants.some((p) => p.subjectRef === userRef(human));
  if (ch.visibility !== 'public' && !isMember) return false;
  if (!(await holdsScope(tenantId, human, personalTenant, 'workspace:write'))) return false;
  if (ch.postingPolicy === 'managers' && !isOwner && !(await holdsScope(tenantId, human, personalTenant, 'host:members:manage'))) return false;
  return true;
}

export async function authorizeRunConversationWrite(storage: Storage, w: RunConversationWrite): Promise<RunConversationWriteVerdict> {
  const [session, meta] = await Promise.all([
    storage.getChatSession(w.tenantId, w.conversationId),
    getConversationMeta(w.tenantId, w.conversationId),
  ]);
  if (!session) {
    // Nothing by this id in THIS tenant. Only a fresh session (no meta either) may
    // be created, and only by the lane that creates sessions.
    return w.mayCreate === true && !meta ? { ok: true, create: true } : { ok: false, reason: 'not_in_tenant' };
  }
  const human = w.actingUserId ?? w.orgScopeSubject;

  if (meta?.type === 'channel') {
    if (meta.channel?.archived) return { ok: false, reason: 'archived' };
    // grade-code CH2CD-3 — a `sendMessage` row has no author and a role the pack
    // picks, so in a room of peers it escapes the author-only edit rule, erasure,
    // mentions and notifications, and can pose as a host `system` notice. A workflow
    // speaks in a channel through an AGENT MEMBER (the agent-runner lane) only.
    if (w.agentId === undefined) return { ok: false, reason: 'channel_needs_agent' };
    if (w.agentId !== undefined && !agentIsParticipant(meta, w.agentId)) return { ok: false, reason: 'agent_not_member' };
    if (!human) return { ok: false, reason: 'no_human' };
    return (await humanMayPostToChannel(meta, w.tenantId, human, w.personalTenant)) ? { ok: true, create: false } : { ok: false, reason: 'cannot_post' };
  }

  if (human) {
    return (await isVisibleToAsync(meta, w.tenantId, human)) ? { ok: true, create: false } : { ok: false, reason: 'not_visible' };
  }
  const owned = !!meta && (meta.ownerUserId !== undefined || meta.ownerSubject !== undefined);
  if (!owned) return { ok: true, create: false };
  if (w.agentId !== undefined && agentIsParticipant(meta!, w.agentId)) return { ok: true, create: false };
  return { ok: false, reason: 'no_human' };
}
