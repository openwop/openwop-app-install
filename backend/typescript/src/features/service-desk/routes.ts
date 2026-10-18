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
import { orgScopeGranted } from './orgScope.js';
import { ticketLabel } from './sla.js';
import { OpenwopError } from '../../types.js';
import { createTicket, getTicket, listTickets, appendMessageResult, setStatus, assignTicket, setPriority, userAuthorRef } from './tickets.js';
import { getIntakeConfig, setIntakeConfig, parseSlaHours } from './intake.js';
import { mintPublicIntakeKey, publicIntakeKeys } from './widgetRoutes.js';
import { deliverOutbound, listDeliveries } from './delivery.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import { callerSubjectSpellings, tenantOf } from '../featureRoute.js';
import { getOrg, listMembers, listOrgs } from '../../host/accessControlService.js';
import { isOwnPersonalWorkspace } from '../../host/requestSubject.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { randomUUID } from 'node:crypto';

const FEATURE = { toggleId: 'service-desk', label: 'Service desk' };
const MANAGE: Scope = 'host:members:manage';
const ORG = '/host/openwop-app/service-desk/orgs/:orgId';
type Scope = 'workspace:read' | 'workspace:write' | 'host:members:manage';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export { orgScopeGranted } from './orgScope.js';

/**
 * ADR 0878 D2 (SD2-S2) — "may route the whole tenant's inbound support". The
 * intake config is TENANT-wide (it decides which org receives every WhatsApp and
 * widget ticket), so an admin of ONE org must not hold it: that was the hole — an
 * org-B admin re-pointed the tenant's intake into org B and rotated the published
 * widget key. Workspace authority resolves the way the host resolves it elsewhere:
 *  - the wildcard operator, or the owner of their OWN personal workspace;
 *  - a tenant with a workspace-root org (`orgId === tenantId`, every `ws:`):
 *    `host:members:manage` on the ROOT membership (ADR 0815 D1b);
 *  - a multi-principal tenant with no root org: `host:members:manage` in EVERY
 *    org. Two admins who each own one org lock each other out; the operator is the
 *    exit (recorded in the ADR, not hidden).
 * Every spelling of the caller is tried (`callerSubjectSpellings`).
 */
async function requireWorkspaceAdmin(req: Request, tenantId: string): Promise<void> {
  if (req.principal?.tenants?.includes('*')) return;
  if (isOwnPersonalWorkspace(req) && tenantId === tenantOf(req)) return;
  const spellings = await callerSubjectSpellings(req);
  const holds = async (orgId: string): Promise<boolean> => {
    for (const subject of spellings) {
      if (await orgScopeGranted(tenantId, subject, orgId, MANAGE)) return true;
    }
    return false;
  };
  const deny = (): never => {
    throw new OpenwopError('forbidden_scope', 'Changing where support intake is filed needs admin rights for the whole workspace, not one organization.', 403, { requiredScope: MANAGE, level: 'workspace' });
  };
  const root = await getOrg(tenantId);
  if (root && root.tenantId === tenantId) {
    if (!(await holds(tenantId))) deny();
    return;
  }
  const orgs = await listOrgs(tenantId);
  if (orgs.length === 0) deny();
  for (const o of orgs) if (!(await holds(o.orgId))) deny();
}

/** ADR 0878 D5 — the caller's own member row in `orgId` (any spelling), so
 *  "Assign to me" stores the spelling the member store and notifications key on. */
async function selfMemberSubject(req: Request, tenantId: string, orgId: string, fallback: string): Promise<string> {
  const spellings = new Set(await callerSubjectSpellings(req));
  const row = (await listMembers(tenantId, orgId)).find((m) => m.subject && spellings.has(m.subject));
  return row?.subject ?? fallback;
}

const VIEWS = ['all', 'mine', 'unassigned', 'overdue'] as const;

export function registerServiceDeskRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);
  const loadInOrg = async (tenantId: string, orgId: string, ticketId: string) => {
    const t = await getTicket(tenantId, ticketId);
    return t && t.orgId === orgId ? t : null;
  };

  // The intake config (the org new WhatsApp/widget tickets file under). ADR 0878
  // D2: a member of ANOTHER org learns only that intake is configured elsewhere —
  // not which org, not the public key, not the SLA table.
  app.get(`${ORG}/intake-config`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const config = await getIntakeConfig(tenantId);
      if (!config) { res.json({ configured: false, here: false, config: null }); return; }
      if (config.defaultOrgId !== orgId) { res.json({ configured: true, here: false, config: null }); return; }
      const keys = await publicIntakeKeys.listForTenantIndexed(tenantId);
      res.json({ configured: true, here: true, config: { ...config, ...(keys[0] ? { publicIntakeKey: keys[0].key } : {}) } });
    } catch (err) { next(err); }
  });
  app.put(`${ORG}/intake-config`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, MANAGE);
      await requireWorkspaceAdmin(req, tenantId);
      const sla = parseSlaHours((req.body ?? {} as Record<string, unknown>).slaHoursByPriority);
      const config = await setIntakeConfig(tenantId, orgId, user.userId, sla);
      // Re-routing a tenant's inbound support is an admin act with a trail (SD2CD-18).
      void deps.storage.appendAudit({ timestamp: new Date().toISOString(), principalId: user.userId, action: 'servicedesk.intake.configured', resource: `servicedesk-intake:${tenantId}`, outcome: 'success', payload: { tenantId, orgId } })
        .catch(() => undefined);
      // The FIRST save mints the widget key; later saves keep it (they used to
      // re-mint on every save, silently breaking every published embed).
      const existing = await publicIntakeKeys.listForTenantIndexed(tenantId);
      const publicIntakeKey = existing[0]?.key ?? (await mintPublicIntakeKey(tenantId));
      res.json({ configured: true, here: true, config: { ...config, publicIntakeKey } });
    } catch (err) { next(err); }
  });
  app.post(`${ORG}/intake-config/rotate-key`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, MANAGE);
      await requireWorkspaceAdmin(req, tenantId);
      const config = await getIntakeConfig(tenantId);
      if (!config || config.defaultOrgId !== orgId) { sendError(res, 409, 'conflict', 'Intake is not configured for this organization.'); return; }
      const publicIntakeKey = await mintPublicIntakeKey(tenantId);
      void deps.storage.appendAudit({ timestamp: new Date().toISOString(), principalId: req.userId ?? 'unknown', action: 'servicedesk.intake.key-rotated', resource: `servicedesk-intake:${tenantId}`, outcome: 'success', payload: { tenantId, orgId } })
        .catch(() => undefined);
      res.json({ publicIntakeKey });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/tickets`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const viewRaw = typeof req.query.view === 'string' ? req.query.view : 'all';
      const view = (VIEWS as readonly string[]).includes(viewRaw) ? viewRaw : 'all';
      let tickets = await listTickets(tenantId, orgId, status ? { status } : undefined);
      if (view === 'mine') {
        const me = new Set(await callerSubjectSpellings(req));
        tickets = tickets.filter((t) => !!t.assigneeMemberId && me.has(t.assigneeMemberId));
      } else if (view === 'unassigned') {
        tickets = tickets.filter((t) => !t.assigneeMemberId && t.status !== 'solved' && t.status !== 'closed');
      } else if (view === 'overdue') {
        const now = new Date().toISOString();
        tickets = tickets.filter((t) => !!t.slaDueAt && t.slaDueAt <= now && t.status !== 'solved' && t.status !== 'closed');
      }
      res.json({ tickets });
    } catch (err) { next(err); }
  });

  // ADR 0878 D5 — who a ticket can be assigned to: members of THIS org who can
  // work it (`workspace:write`), by the member-row subject.
  app.get(`${ORG}/assignees`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const out: Array<{ subject: string; displayName: string }> = [];
      for (const m of await listMembers(tenantId, orgId)) {
        if (!m.subject) continue;
        if (await orgScopeGranted(tenantId, m.subject, orgId, 'workspace:write')) out.push({ subject: m.subject, displayName: m.displayName || m.subject });
      }
      res.json({ assignees: out, me: await callerSubjectSpellings(req) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/tickets/:ticketId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const ticket = await loadInOrg(tenantId, orgId, req.params.ticketId);
      if (!ticket) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      res.json({ ticket, deliveries: await listDeliveries(tenantId, ticket.ticketId) });
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
          ? { firstMessage: { messageId: `m-${randomUUID()}`, body: str((body.firstMessage as Record<string, unknown>).body), author: userAuthorRef(user.userId), direction: 'internal' } }
          : {}),
        createdBy: user.userId,
      });
      res.status(created ? 201 : 200).json({ ticket });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/tickets/:ticketId/messages`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await loadInOrg(tenantId, orgId, req.params.ticketId);
      if (!existing) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const direction = str(body.direction) === 'outbound' ? 'outbound' : 'internal'; // members write internal notes or outbound replies — never 'inbound'
      // ADR 0878 D3 (pre-code Blocker 2) — the server mints the id. A client key is
      // only an idempotency key, namespaced to the caller, so it can never NAME a
      // message someone else wrote (and so never cause that message's delivery).
      const clientKey = str(body.idempotencyKey) || str(body.messageId);
      const messageId = clientKey ? `client:${user.userId}:${clientKey.slice(0, 80)}` : `out:${randomUUID()}`;
      const { ticket, appended } = await appendMessageResult(tenantId, existing.ticketId, {
        messageId,
        body: str(body.body),
        author: userAuthorRef(user.userId),
        direction,
      });
      // Deliver only what THIS call wrote, and only a reply to the customer.
      const delivery = appended && direction === 'outbound'
        ? await deliverOutbound({ tenantId, ticketId: ticket.ticketId, messageId, actor: user.userId })
        : undefined;
      res.json({ ticket, deliveries: await listDeliveries(tenantId, ticket.ticketId), ...(delivery ? { delivery } : {}) });
    } catch (err) { next(err); }
  });

  // ADR 0878 D3 — the exit from a failed (or crash-orphaned) delivery.
  app.post(`${ORG}/tickets/:ticketId/messages/:messageId/retry`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await loadInOrg(tenantId, orgId, req.params.ticketId);
      if (!existing) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const delivery = await deliverOutbound({ tenantId, ticketId: existing.ticketId, messageId: req.params.messageId, actor: user.userId, retry: true });
      res.json({ delivery, deliveries: await listDeliveries(tenantId, existing.ticketId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/tickets/:ticketId/status`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await loadInOrg(tenantId, orgId, req.params.ticketId);
      if (!existing) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const ticket = await setStatus(tenantId, existing.ticketId, str((req.body ?? {} as Record<string, unknown>).status), `user:${user.userId}`);
      res.json({ ticket });
    } catch (err) { next(err); }
  });

  // ADR 0878 D7 — priority re-derives the SLA due time from the stored table.
  app.post(`${ORG}/tickets/:ticketId/priority`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await loadInOrg(tenantId, orgId, req.params.ticketId);
      if (!existing) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const cfg = await getIntakeConfig(tenantId);
      const ticket = await setPriority(tenantId, existing.ticketId, str((req.body ?? {} as Record<string, unknown>).priority), `user:${user.userId}`, cfg?.slaHoursByPriority);
      res.json({ ticket });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/tickets/:ticketId/assign`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const existing = await loadInOrg(tenantId, orgId, req.params.ticketId);
      if (!existing) { sendError(res, 404, 'not_found', 'Ticket not found.'); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      // ADR 0878 D5 (SD2-S5) — an assignee is a member who can WORK the ticket.
      // Any string used to be accepted. "Assign to me" uses the caller's own
      // member row (the gate above already proved they hold write here).
      let assignee: string | undefined;
      if (body.assignToSelf === true) {
        assignee = await selfMemberSubject(req, tenantId, orgId, user.userId);
      } else {
        assignee = str(body.assigneeMemberId) || undefined;
        if (assignee && !(await orgScopeGranted(tenantId, assignee, orgId, 'workspace:write'))) {
          sendError(res, 422, 'validation_error', 'That person cannot be assigned: they are not a member of this organization who can work tickets.', { field: 'assigneeMemberId', reason: 'invalid_assignee' });
          return;
        }
      }
      const ticket = await assignTicket(tenantId, existing.ticketId, assignee, `user:${user.userId}`);
      const self = new Set(await callerSubjectSpellings(req));
      if (assignee && !self.has(assignee) && assignee !== existing.assigneeMemberId) {
        void getNotificationEmitter().emit({
          tenantId,
          recipientUserId: assignee,
          type: 'servicedesk.ticket-assigned',
          priority: ticket.priority === 'urgent' || ticket.priority === 'high' ? 'high' : 'normal',
          title: 'A support ticket was assigned to you',
          message: ticketLabel(ticket),
          actionUrl: `/support?org=${encodeURIComponent(orgId)}&ticket=${encodeURIComponent(ticket.ticketId)}`,
          metadata: { ticketId: ticket.ticketId, orgId },
        }).catch(() => undefined);
      }
      res.json({ ticket });
    } catch (err) { next(err); }
  });
}
