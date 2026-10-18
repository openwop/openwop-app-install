/**
 * Scheduled agent-chat routes (ADR 0125 Phase 1; ADR 0202 D3 — channel scope + D6 hardening).
 *
 * TWO scopes, ONE service + scheduler + turn-workflow (never a parallel job):
 *  - ORG   `/scheduled-chats/orgs/:orgId/chats`      — RBAC `workspace:{read,write}`.
 *  - CHANNEL `/scheduled-chats/channels/:channelId/chats` — membership-gated (owner
 *    creates/manages, members list), the ADR 0202 D3 composition of `channels`.
 *
 * D6 (security): the create path validates its target — the agent must resolve and
 * the caller must be able to SEE the bound conversation (org path) / own the channel
 * (channel path); a channel schedule's `conversationId` is FORCED to the channelId.
 *
 * ADR 0820 §8.2 — the feature has a toggle again (default ON, sold in the Agents
 * bundle), so BOTH scopes gate on toggle + plan first: the org path through
 * `authorizeOrgScope`, the channel path through `requireFeatureEnabled`, then the
 * same RBAC / channel-membership checks as before.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireFeatureEnabled, requireString } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { OpenwopError } from '../../types.js';
import { resolveAgentForTenant } from '../../host/agentVisibility.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { assertChannelManage, isChannelAgentMember, getChannel } from '../channels/channelService.js';
import { channelAuthorityOf } from '../../host/channelAuthority.js';
import { canSeeScheduledChat, createScheduledChat, deleteScheduledChat, deleteScheduledChatsForAgent, getScheduledChat, listScheduledChatsWithStatus, setScheduledChatEnabled, SCHEDULED_AGENT_CHATS_TOGGLE, type ScheduledChat } from './scheduledChatService.js';

const FEATURE = { toggleId: SCHEDULED_AGENT_CHATS_TOGGLE, label: 'Scheduled agent chats' } as const;

/** D6 — a schedulable agent must exist (else every tick silently fails). Mirrors the
 *  channel add-agent guard (channelService `addChannelAgent`).
 *  ADR 0379 P1 — tenant-gated: another tenant's `user.*` agent is treated as
 *  absent (same 404 — no existence oracle, no cross-tenant bind). */
async function assertAgentResolves(tenantId: string, agentId: string): Promise<void> {
  if (!(await resolveAgentForTenant(agentId, tenantId))) {
    throw new OpenwopError('not_found', `Agent "${agentId}" not found.`, 404, { agentId });
  }
}

/** ADR 0846 D1 — the caller as the conversation predicate keys it (see
 *  `canSeeScheduledChat`). CREATE and every ORG read/manage door use this one spelling. */
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** ADR 0846 D1 — an ORG schedule the caller may see, else the same 404 as a missing
 *  row (no existence oracle). The ONE gate for get/pause/delete. */
async function visibleOrgChat(req: Request, tenantId: string, orgId: string, chatId: string): Promise<ScheduledChat> {
  const chat = await getScheduledChat(tenantId, { orgId }, chatId);
  if (!chat || !(await canSeeScheduledChat(tenantId, chat, actingUserOf(req)))) {
    throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { chatId });
  }
  return chat;
}

export function registerScheduledChatRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const ORG = '/host/openwop-app/scheduled-chats/orgs/:orgId/chats';
  const CH = '/host/openwop-app/scheduled-chats/channels/:channelId/chats';

  // ── ORG scope (RBAC) ────────────────────────────────────────────────────────
  app.get(ORG, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      // ADR 0846 D1 — only schedules whose conversation the caller can see. The tile
      // and this page render `prompt` and link `conversationId`; both are that
      // conversation's business.
      const all = await listScheduledChatsWithStatus(tenantId, { orgId });
      const shown = await Promise.all(all.map((c) => canSeeScheduledChat(tenantId, c, actingUserOf(req))));
      res.json({ chats: all.filter((_, i) => shown[i]) });
    } catch (err) { next(err); }
  });

  app.post(ORG, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      // D6 — validate the target BEFORE binding a job: the agent must exist, and the
      // caller must be able to SEE the conversation they bind — closing the IDOR of
      // scheduling into another user's PRIVATE conversation. (A legacy/unowned/absent
      // conversation is tenant-visible by the isVisibleTo contract, so it stays
      // bindable — harmless: the reply just posts to an empty/own surface.)
      // Normalize ONCE and bind the canonical values, so the access check reads the
      // SAME id the service stores — else a padded `conversationId` (" foreign-id")
      // would miss the exact-match lookup (null → tenant-visible → check passes) yet
      // the service's trim would store the real foreign id (an IDOR bypass).
      const agentId = requireString(body.agentId, 'agentId').trim();
      const conversationId = requireString(body.conversationId, 'conversationId').trim();
      await assertAgentResolves(tenantId, agentId);
      const meta = await getConversationMeta(tenantId, conversationId);
      if (!(await isVisibleToAsync(meta, tenantId, actingUserOf(req)))) {
        throw new OpenwopError('not_found', 'Conversation not found.', 404, { conversationId });
      }
      // ADR 0879 D7 (architect C3) — a channel is posted to through the channel's own
      // owner-gated schedule lane (below), never through an org schedule, which checks
      // only that the caller can SEE the conversation (any member sees a public channel).
      if (meta?.type === 'channel') {
        throw new OpenwopError('validation_error', 'Schedule channel posts from the channel itself.', 400, { conversationId, code: 'channel_use_channel_schedule' });
      }
      res.status(201).json({ chat: await createScheduledChat(tenantId, { orgId }, user.userId, { ...body, agentId, conversationId }, actingUserOf(req) ?? user.userId, req.personalTenant) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/:chatId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ chat: await visibleOrgChat(req, tenantId, orgId, req.params.chatId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/:chatId/pause`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const enabled = (req.body as { enabled?: unknown })?.enabled !== false; // default re-enable; {enabled:false} pauses
      await visibleOrgChat(req, tenantId, orgId, req.params.chatId);
      res.json({ chat: await setScheduledChatEnabled(tenantId, { orgId }, req.params.chatId, enabled) });
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/:chatId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      await visibleOrgChat(req, tenantId, orgId, req.params.chatId);
      await deleteScheduledChat(tenantId, { orgId }, req.params.chatId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── CHANNEL scope (membership-gated — ADR 0202 D3) ──────────────────────────
  // Create/pause/delete are OWNER-gated (assertChannelManage); list is MEMBER-gated
  // (getChannel). The bound agent MUST be a channel member (M3) and the reply always
  // posts in-channel — `conversationId` is forced to the channelId, never body-supplied.
  const channelCaller = async (req: Request): Promise<{ tenantId: string; userId: string; channelId: string }> => {
    await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label); // ADR 0820 §8.2 — toggle + plan first
    const user = await resolveCallerUser(req);
    // NOT org-scoped: the CHANNEL paths are membership-gated by `getChannel` /
    // `assertChannelManage` (ADR 0202 D3), not by `requireOrgScope`, so there is no
    // gate-supplied tenant here and `user.tenantId` is the correct source. Left
    // deliberately unchanged by the ADR 0508 Phase-1 migration.
    return { tenantId: user.tenantId, userId: user.userId, channelId: req.params.channelId };
  };

  app.get(CH, async (req, res, next) => {
    try {
      const { tenantId, userId, channelId } = await channelCaller(req);
      const meta = await getChannel(tenantId, channelId, userId); // member-gated read (404-masks non-members)
      let chats = await listScheduledChatsWithStatus(tenantId, { channelId });
      // SCHED-2 — reconcile-on-read: prune schedules whose agent is no longer a channel
      // member, using the meta already loaded here. Self-heals a dropped agent-removed
      // event (the OQ-3 primary path) with no background sweep; a no-orphan list pays
      // only an in-memory filter.
      const orphanedAgents = [...new Set(chats.filter((c) => !isChannelAgentMember(meta, c.agentId)).map((c) => c.agentId))];
      if (orphanedAgents.length) {
        for (const aid of orphanedAgents) {
          try { await deleteScheduledChatsForAgent(tenantId, channelId, aid); } catch { /* best-effort reconcile */ }
        }
        chats = await listScheduledChatsWithStatus(tenantId, { channelId });
      }
      res.json({ chats });
    } catch (err) { next(err); }
  });

  app.post(CH, async (req, res, next) => {
    try {
      const { tenantId, userId, channelId } = await channelCaller(req);
      const meta = await assertChannelManage(tenantId, channelId, userId, await channelAuthorityOf(req)); // owner-or-admin + workspace:write (ADR 0879 D1/D3)
      const body = (req.body ?? {}) as Record<string, unknown>;
      const agentId = requireString(body.agentId, 'agentId').trim(); // canonical: check == store
      if (!isChannelAgentMember(meta, agentId)) {
        throw new OpenwopError('validation_error', `Agent "${agentId}" is not a member of this channel.`, 400, { agentId, channelId });
      }
      // conversationId is FORCED to the channel — a channel schedule cannot target a
      // foreign conversation (any body conversationId is ignored).
      const chat = await createScheduledChat(tenantId, { channelId }, userId, { ...body, agentId, conversationId: channelId }, req.userId ?? req.principal?.principalId ?? userId, req.personalTenant);
      res.status(201).json({ chat });
    } catch (err) { next(err); }
  });

  app.post(`${CH}/:chatId/pause`, async (req, res, next) => {
    try {
      const { tenantId, userId, channelId } = await channelCaller(req);
      await assertChannelManage(tenantId, channelId, userId, await channelAuthorityOf(req)); // owner-or-admin + workspace:write (ADR 0879 D1/D3)
      const enabled = (req.body as { enabled?: unknown })?.enabled !== false;
      res.json({ chat: await setScheduledChatEnabled(tenantId, { channelId }, req.params.chatId, enabled) });
    } catch (err) { next(err); }
  });

  app.delete(`${CH}/:chatId`, async (req, res, next) => {
    try {
      const { tenantId, userId, channelId } = await channelCaller(req);
      await assertChannelManage(tenantId, channelId, userId, await channelAuthorityOf(req)); // owner-or-admin + workspace:write (ADR 0879 D1/D3)
      await deleteScheduledChat(tenantId, { channelId }, req.params.chatId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
