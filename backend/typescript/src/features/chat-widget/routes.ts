/**
 * Chat-widget admin routes (ADR 0127 Phase 1) — authed config CRUD, org-scoped.
 * `/v1/host/openwop-app/chat-widget/orgs/:orgId/widgets` (authorizeOrgScope write/
 * read, IDOR-404). The PUBLIC runtime gateway (`/widget/*`) is Phase 2.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';

/** ADR 0820 §8.2 — the operator routes gate on toggle + plan (`authorizeOrgScope`). */
const FEATURE = { toggleId: 'chat-widget', label: 'Website chat widget' } as const;
import { OpenwopError } from '../../types.js';
import { buildToolCatalog } from '../../routes/agentAllowlists.js';
import { deleteWidget, getWidget, listWidgets, patchWidget, provisionWidget, rotateWidgetToken, type WidgetConfig } from './widgetService.js';
import { deleteThread, getThread, listThreadSummaries } from './visitorThreads.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { assertWidgetCredential } from './widgetCredential.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.chat-widget.routes');


/** grade-ux `CW68U-2` — a widget bound to an agent the gateway cannot run reported
 *  "Active" while every visitor turn 404'd. Refuse it at save time, with the same
 *  rule the gateway applies (`publicGateway.ts`: resolvable, and not another tenant's
 *  user-authored agent). */
async function assertAgentServable(tenantId: string, agentId: unknown): Promise<void> {
  if (typeof agentId !== 'string' || !agentId.trim()) return; // the service's own 400 names the field
  const agent = await getAgentRegistry().resolve(agentId.trim(), tenantId);
  if (!agent || (agent.ownerTenant && agent.ownerTenant !== tenantId)) {
    throw new OpenwopError('validation_error', `No agent "${agentId.trim().slice(0, 120)}" is available to this workspace.`, 400, { field: 'agentId' });
  }
}

export function registerChatWidgetRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/chat-widget/orgs/:orgId/widgets';

  // ADR 0469 Phase B — the WORKSPACE-SCOPED tool catalog that populates the anon
  // grant editor. Reuses the ONE catalog SSoT (`buildToolCatalog`) — NOT the
  // superadmin `/agents/:agentId` route (finding 3: the operator editor must not be
  // coupled to a superadmin surface). Read-only (`workspace:read`); the grant SAVE
  // stays `workspace:write` via the widget PATCH below.
  app.get('/host/openwop-app/chat-widget/orgs/:orgId/tool-catalog', async (req, res, next) => {
    try { await authorizeOrgScope(req, FEATURE, 'workspace:read'); res.json({ tools: buildToolCatalog() }); } catch (err) { next(err); }
  });

  app.get(BASE, async (req, res, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read'); res.json({ widgets: await listWidgets(tenantId, orgId) }); } catch (err) { next(err); }
  });
  app.post(BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      await assertAgentServable(tenantId, body.agentId);
      await assertWidgetCredential(tenantId); // ADR 1018 D8 — own key, or a listed superadmin
      res.status(201).json({ widget: await provisionWidget(tenantId, orgId, user.userId, body) });
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read'); const w = await getWidget(tenantId, orgId, req.params.widgetId); if (!w) throw new OpenwopError('not_found', 'Widget not found.', 404, {}); res.json({ widget: w }); } catch (err) { next(err); }
  });
  app.patch(`${BASE}/:widgetId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const body = (req.body ?? {}) as { agentId?: unknown; enabled?: unknown };
      const current = await getWidget(tenantId, orgId, req.params.widgetId);
      if (body.agentId !== undefined) await assertAgentServable(tenantId, body.agentId);
      // grade-ux CW68U-16 — turning a widget ON re-checks the agent it will serve. A widget
      // auto-disabled because its agent was deleted used to come back "Active" and answer
      // every visitor with an error.
      else if (body.enabled === true && current) await assertAgentServable(tenantId, current.agentId);
      // ADR 1018 D8 — any PATCH that leaves the widget serving re-asks the credential
      // rule. Turning a widget OFF is never refused: it spends nothing.
      if (current && (body.enabled === true || (body.enabled === undefined && current.enabled))) await assertWidgetCredential(tenantId);
      res.json({ widget: await patchWidget(tenantId, orgId, req.params.widgetId, (req.body ?? {}) as Record<string, unknown>) });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/:widgetId/rotate-token`, async (req, res, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write'); res.json({ widget: await rotateWidgetToken(tenantId, orgId, req.params.widgetId) }); } catch (err) { next(err); }
  });
  // ADR 1018 D3 — the operator's read of what visitors asked. `workspace:write`, not
  // `:read`: visitor text can carry personal data, and the sibling anon-write review
  // projection sits at the same tier. The widget must exist in THIS org first, so a
  // widget id from another org (or a guessed thread id) is a uniform 404.
  const CONV = `${BASE}/:widgetId/conversations`;
  const widgetInScope = async (req: Request): Promise<WidgetConfig> => {
    const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
    const w = await getWidget(tenantId, orgId, String(req.params.widgetId));
    if (!w) throw new OpenwopError('not_found', 'Widget not found.', 404, {});
    return w;
  };
  app.get(CONV, async (req, res, next) => {
    try { res.json({ conversations: await listThreadSummaries(await widgetInScope(req)) }); } catch (err) { next(err); }
  });
  app.get(`${CONV}/:threadId`, async (req, res, next) => {
    try {
      const w = await widgetInScope(req);
      const t = await getThread(w, String(req.params.threadId));
      if (!t) throw new OpenwopError('not_found', 'Conversation not found.', 404, {});
      // grade-code `CW68C-4` — who read a visitor's transcript (ids only, never text).
      log.info('widget_conversation_read', { widgetId: w.widgetId, threadId: t.threadId, actor: (req as { principal?: { principalId?: string } }).principal?.principalId ?? null });
      res.json({ conversation: { threadId: t.threadId, startedAt: t.startedAt, updatedAt: t.updatedAt, messages: t.messages } });
    } catch (err) { next(err); }
  });
  app.delete(`${CONV}/:threadId`, async (req, res, next) => {
    try {
      if (!(await deleteThread(await widgetInScope(req), String(req.params.threadId)))) throw new OpenwopError('not_found', 'Conversation not found.', 404, {});
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write'); await deleteWidget(tenantId, orgId, req.params.widgetId); res.status(204).end(); } catch (err) { next(err); }
  });
}
