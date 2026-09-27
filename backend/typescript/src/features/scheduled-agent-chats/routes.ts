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
 * The feature is always-on (graduated, no toggle), so gating is RBAC (org path) /
 * channel-membership (channel path), not a toggle check.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, requireString } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { OpenwopError } from '../../types.js';
import { resolveAgentForTenant } from '../../host/agentVisibility.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { assertChannelManage, isChannelAgentMember, getChannel } from '../channels/channelService.js';
import { createScheduledChat, deleteScheduledChat, deleteScheduledChatsForAgent, getScheduledChat, listScheduledChatsWithStatus, setScheduledChatEnabled } from './scheduledChatService.js';

/** D6 — a schedulable agent must exist (else every tick silently fails). Mirrors the
 *  channel add-agent guard (channelService `addChannelAgent`).
 *  ADR 0379 P1 — tenant-gated: another tenant's `user.*` agent is treated as
 *  absent (same 404 — no existence oracle, no cross-tenant bind). */
async function assertAgentResolves(tenantId: string, agentId: string): Promise<void> {
  if (!(await resolveAgentForTenant(agentId, tenantId))) {
    throw new OpenwopError('not_found', `Agent "${agentId}" not found.`, 404, { agentId });
  }
}

export function registerScheduledChatRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const ORG = '/v1/host/openwop-app/scheduled-chats/orgs/:orgId/chats';
  const CH = '/v1/host/openwop-app/scheduled-chats/channels/:channelId/chats';

  // ── ORG scope (RBAC) ────────────────────────────────────────────────────────
  app.get(ORG, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      res.json({ chats: await listScheduledChatsWithStatus(tenantId, { orgId }) });
    } catch (err) { next(err); }
  });

  app.post(ORG, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
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
      if (!(await isVisibleToAsync(meta, tenantId, user.userId))) {
        throw new OpenwopError('not_found', 'Conversation not found.', 404, { conversationId });
      }
      res.status(201).json({ chat: await createScheduledChat(tenantId, { orgId }, user.userId, { ...body, agentId, conversationId }) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/:chatId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      const chat = await getScheduledChat(tenantId, { orgId }, req.params.chatId);
      if (!chat) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { chatId: req.params.chatId });
      res.json({ chat });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/:chatId/pause`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      const enabled = (req.body as { enabled?: unknown })?.enabled !== false; // default re-enable; {enabled:false} pauses
      res.json({ chat: await setScheduledChatEnabled(tenantId, { orgId }, req.params.chatId, enabled) });
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/:chatId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await deleteScheduledChat(tenantId, { orgId }, req.params.chatId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── CHANNEL scope (membership-gated — ADR 0202 D3) ──────────────────────────
  // Create/pause/delete are OWNER-gated (assertChannelManage); list is MEMBER-gated
  // (getChannel). The bound agent MUST be a channel member (M3) and the reply always
  // posts in-channel — `conversationId` is forced to the channelId, never body-supplied.
  const channelCaller = async (req: Request): Promise<{ tenantId: string; userId: string; channelId: string }> => {
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
      const meta = await assertChannelManage(tenantId, channelId, userId); // owner-gated
      const body = (req.body ?? {}) as Record<string, unknown>;
      const agentId = requireString(body.agentId, 'agentId').trim(); // canonical: check == store
      if (!isChannelAgentMember(meta, agentId)) {
        throw new OpenwopError('validation_error', `Agent "${agentId}" is not a member of this channel.`, 400, { agentId, channelId });
      }
      // conversationId is FORCED to the channel — a channel schedule cannot target a
      // foreign conversation (any body conversationId is ignored).
      const chat = await createScheduledChat(tenantId, { channelId }, userId, { ...body, agentId, conversationId: channelId });
      res.status(201).json({ chat });
    } catch (err) { next(err); }
  });

  app.post(`${CH}/:chatId/pause`, async (req, res, next) => {
    try {
      const { tenantId, userId, channelId } = await channelCaller(req);
      await assertChannelManage(tenantId, channelId, userId); // owner-gated
      const enabled = (req.body as { enabled?: unknown })?.enabled !== false;
      res.json({ chat: await setScheduledChatEnabled(tenantId, { channelId }, req.params.chatId, enabled) });
    } catch (err) { next(err); }
  });

  app.delete(`${CH}/:chatId`, async (req, res, next) => {
    try {
      const { tenantId, userId, channelId } = await channelCaller(req);
      await assertChannelManage(tenantId, channelId, userId); // owner-gated
      await deleteScheduledChat(tenantId, { channelId }, req.params.chatId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
