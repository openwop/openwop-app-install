/**
 * ADR 0422 P1 — service-desk routes (host-extension, non-normative).
 * Reads `workspace:read`; agent-side writes (status/assign/reply) are member
 * work (`workspace:write`); nothing here is public — the customer-facing
 * lanes arrive with intake (P2) and widget ticketing (P5) behind their own
 * gates. Every path toggle-gated + org-scoped via the shared predicate.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { createTicket, getTicket, listTickets, appendMessage, setStatus, assignTicket } from './tickets.js';
import { getIntakeConfig, setIntakeConfig } from './intake.js';
import { mintPublicIntakeKey, publicIntakeKeys } from './widgetRoutes.js';
import { sendError } from '../../middleware/errorEnvelope.js';

const FEATURE = { toggleId: 'service-desk', label: 'Service desk' };
const ORG = '/v1/host/openwop-app/service-desk/orgs/:orgId';
type Scope = 'workspace:read' | 'workspace:write' | 'host:members:manage';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The org-scope predicate shared by the service-desk ROUTES (via
 * `authorizeOrgScope` → `requireOrgScope` → `resolveEffectiveAccess`) and the
 * Support Agent's chat TOOLS (`agentTools.ts`), so a route and a tool can NEVER
 * drift on who may read or act on a ticket — the CFP-1 "one helper, route + tool
 * both call it" pattern (campaign-brief / crm precedent).
 *
 * CHAT-FIRST-PORT-AUDIT D8: the tools formerly checked only `actingUserId`
 * truthiness + the toggle, then read/acted on a CALLER-SUPPLIED `orgId` (list) or
 * a ticket fetched by id with no org check (get/draft/set-status) — so any
 * authenticated co-tenant could read or act on ANOTHER org's tickets within a
 * shared tenant. This predicate closes that: it resolves the acting subject's
 * effective access IN the ticket's org and requires the same scope the matching
 * route requires. `subject` undefined ⇒ never granted (fail-closed — an
 * undefined subject would otherwise resolve to the tenant-owner branch).
 */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  if (!subject || !orgId) return false;
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

export function registerServiceDeskRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // P2 — the intake config (the org new tickets file under; admin, explicit).
  app.get(`${ORG}/intake-config`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:read');
      const config = await getIntakeConfig(tenantId);
      const keys = await publicIntakeKeys.listForTenantIndexed(tenantId);
      res.json({ config: config ? { ...config, ...(keys[0] ? { publicIntakeKey: keys[0].key } : {}) } : null });
    } catch (err) { next(err); }
  });
  app.put(`${ORG}/intake-config`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'host:members:manage');
      const config = await setIntakeConfig(tenantId, orgId, user.userId);
      const publicIntakeKey = await mintPublicIntakeKey(tenantId);
      res.json({ config: { ...config, publicIntakeKey } });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/tickets`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      res.json({ tickets: await listTickets(tenantId, orgId, status ? { status } : undefined) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/tickets/:ticketId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const ticket = await getTicket(tenantId, req.params.ticketId);
      if (!ticket || ticket.orgId !== orgId) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      res.json({ ticket });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/tickets`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { ticket, created } = await createTicket({
        tenantId, orgId,
        subject: str(body.subject),
        channel: str(body.channel) || 'manual',
        ...(str(body.priority) ? { priority: str(body.priority) } : {}),
        ...(str(body.contactId) ? { contactId: str(body.contactId) } : {}),
        ...(body.firstMessage && typeof body.firstMessage === 'object'
          ? { firstMessage: { messageId: str((body.firstMessage as Record<string, unknown>).messageId) || `m-${Date.now()}`, body: str((body.firstMessage as Record<string, unknown>).body), author: `user:${user.userId}`, direction: 'internal' } }
          : {}),
        createdBy: user.userId,
      });
      res.status(created ? 201 : 200).json({ ticket });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/tickets/:ticketId/messages`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await getTicket(tenantId, req.params.ticketId);
      if (!existing || existing.orgId !== orgId) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const direction = str(body.direction) === 'outbound' ? 'outbound' : 'internal'; // members write internal notes or outbound replies — never 'inbound'
      const ticket = await appendMessage(tenantId, req.params.ticketId, {
        messageId: str(body.messageId) || `m-${user.userId}-${Date.now()}`,
        body: str(body.body),
        author: `user:${user.userId}`,
        direction,
      });
      res.json({ ticket });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/tickets/:ticketId/status`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await getTicket(tenantId, req.params.ticketId);
      if (!existing || existing.orgId !== orgId) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const ticket = await setStatus(tenantId, req.params.ticketId, str((req.body ?? {} as Record<string, unknown>).status), `user:${user.userId}`);
      res.json({ ticket });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/tickets/:ticketId/assign`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await getTicket(tenantId, req.params.ticketId);
      if (!existing || existing.orgId !== orgId) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const assignee = str((req.body ?? {} as Record<string, unknown>).assigneeMemberId) || undefined;
      const ticket = await assignTicket(tenantId, req.params.ticketId, assignee, `user:${user.userId}`);
      res.json({ ticket });
    } catch (err) { next(err); }
  });
}
