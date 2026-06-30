/**
 * Scheduled agent-chat routes (ADR 0125 Phase 1) — host-extension, org-scoped + RBAC.
 * `/v1/host/openwop-app/scheduled-chats/orgs/:orgId/chats` CRUD + pause.
 * `authorizeOrgScope` (read list/get · write create/pause/delete), IDOR-404.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import { OpenwopError } from '../../types.js';
import { createScheduledChat, deleteScheduledChat, getScheduledChat, listScheduledChatsWithStatus, setScheduledChatEnabled } from './scheduledChatService.js';


export function registerScheduledChatRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/scheduled-chats/orgs/:orgId/chats';

  app.get(BASE, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      res.json({ chats: await listScheduledChatsWithStatus(user.tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      res.status(201).json({ chat: await createScheduledChat(user.tenantId, orgId, user.userId, (req.body ?? {}) as Record<string, unknown>) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:chatId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      const chat = await getScheduledChat(user.tenantId, orgId, req.params.chatId);
      if (!chat) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { chatId: req.params.chatId });
      res.json({ chat });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:chatId/pause`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      const enabled = (req.body as { enabled?: unknown })?.enabled !== false; // default re-enable; {enabled:false} pauses
      res.json({ chat: await setScheduledChatEnabled(user.tenantId, orgId, req.params.chatId, enabled) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:chatId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      await deleteScheduledChat(user.tenantId, orgId, req.params.chatId);
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
