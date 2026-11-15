/**
 * ADR 1123 — add a person who already has an account to an org, with no email
 * round trip, and link an unbound roster row to an account.
 *
 *   GET  /host/openwop-app/orgs/:orgId/member-candidates        (D1, org admin;
 *                                                               `?for=link` keeps the org's own members)
 *   POST /host/openwop-app/orgs/:orgId/member-lookup            (D2, superadmin)
 *   POST /host/openwop-app/orgs/:orgId/members/add-existing     (D3)
 *   POST /host/openwop-app/orgs/:orgId/members/:memberId/link   (D4)
 *
 * The client never sends a subject. It sends a `candidateId` from the pool,
 * which is recomputed and re-checked at bind time, or a superadmin's
 * `lookupToken` (`host/orgPersonLookup.ts`). The guards are the ones
 * `routes/accessControl.ts` uses for `POST …/members`, passed in, so the role
 * and owner rules have one copy.
 */
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import {
  createMember,
  deleteMember,
  getMember,
  isMembershipRootedWorkspace,
  isWorkspaceRootMembership,
  listMembers,
  updateMember,
  type EffectiveAccess,
  type Organization,
  type OrgMember,
  type Scope,
} from '../host/accessControlService.js';
import { callerSubject, tenantOf } from '../host/requestSubject.js';
import { isSuperadmin } from '../host/superadmin.js';
import { memberAdded } from '../host/memberLifecycleEvents.js';
import { appendAudit } from '../host/auditChainService.js';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { burnLookupToken, mintLookupToken, verifyLookupToken } from '../host/orgPersonLookup.js';
import { findAddableUserByEmail, getUser, listUsers } from '../features/users/usersService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.orgAddExisting');

export interface AddExistingGuards {
  loadOrgOwned: (req: Request, orgId: string) => Promise<Organization>;
  requireScope: (req: Request, scope: Scope) => Promise<EffectiveAccess>;
  requireOwner: (req: Request, access: EffectiveAccess, what: string) => void;
  namesOwner: (roles: readonly string[] | undefined) => boolean;
  validRoleIds: (tenantId: string, orgId: string) => Promise<ReadonlySet<string>>;
  parseRoleIds: (value: unknown, validIds: ReadonlySet<string>) => string[] | undefined;
  listCallerOrgs: (req: Request) => Promise<Organization[]>;
}

interface Candidate { candidateId: string; subject: string; displayName: string; email?: string }

const NOT_FOUND = (): OpenwopError => new OpenwopError('not_found', 'That person cannot be added here. Send an invitation instead.', 404, { reason: 'candidate_unavailable' });

/**
 * D1 — the people this caller may add to `orgId`: the bound subjects holding a
 * member row in an org the caller can act in (`listCallerOrgs`, #5930), plus,
 * where membership does not root the tenant (the shared SSO `default` tenant),
 * the tenant's own active `/users` rows. Minus the target org's members.
 * First row wins, so a candidate's id is stable.
 */
async function candidatePool(req: Request, g: AddExistingGuards, orgId: string, purpose: 'add' | 'link'): Promise<Candidate[]> {
  const tenantId = tenantOf(req);
  // For a link, the target org's own members stay in: linking a placeholder to
  // someone already there merges the two (D4) rather than refusing.
  const taken = purpose === 'link' ? new Set<string>() : new Set((await listMembers(tenantId, orgId)).map((m) => m.subject).filter((s): s is string => !!s));
  const out = new Map<string, Candidate>();
  for (const org of await g.listCallerOrgs(req)) {
    if (purpose === 'add' && org.orgId === orgId) continue;
    for (const m of await listMembers(tenantId, org.orgId)) {
      if (!m.subject || taken.has(m.subject) || out.has(m.subject)) continue;
      out.set(m.subject, { candidateId: `m:${m.memberId}`, subject: m.subject, displayName: m.displayName, ...(m.email ? { email: m.email } : {}) });
    }
  }
  if (!isMembershipRootedWorkspace(tenantId)) {
    for (const u of await listUsers(tenantId)) {
      if (u.status !== 'active' || taken.has(u.userId) || out.has(u.userId)) continue;
      out.set(u.userId, { candidateId: `u:${u.userId}`, subject: u.userId, displayName: u.displayName ?? u.email ?? u.userId, ...(u.email ? { email: u.email } : {}) });
    }
  }
  return [...out.values()];
}

/** Who the body names, re-resolved now. `lane` is for the audit entry. */
async function resolveAddee(req: Request, g: AddExistingGuards, orgId: string, body: Record<string, unknown>, purpose: 'add' | 'link'): Promise<{ subject: string; displayName: string; email?: string; lane: 'workspace' | 'host-lookup' }> {
  const tenantId = tenantOf(req);
  if (typeof body.lookupToken === 'string') {
    if (!isSuperadmin(req)) throw NOT_FOUND();
    const claims = verifyLookupToken(body.lookupToken, { orgId, actor: callerSubject(req) });
    if (!claims || !(await burnLookupToken(claims, tenantId))) throw NOT_FOUND();
    const u = await getUser(claims.u);
    if (!u || u.status !== 'active') throw NOT_FOUND();
    return { subject: u.userId, displayName: u.displayName ?? u.email ?? u.userId, ...(u.email ? { email: u.email } : {}), lane: 'host-lookup' };
  }
  if (typeof body.candidateId === 'string') {
    const c = (await candidatePool(req, g, orgId, purpose)).find((x) => x.candidateId === body.candidateId);
    if (!c) throw NOT_FOUND();
    return { subject: c.subject, displayName: c.displayName, ...(c.email ? { email: c.email } : {}), lane: 'workspace' };
  }
  throw new OpenwopError('validation_error', 'Send a `candidateId` or a `lookupToken`.', 400, { field: 'candidateId' });
}

/** Audit failures never undo a membership, but they are logged loudly. */
async function audit(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await appendAudit(tenantId, kind, payload);
  } catch (err) {
    log.warn('org_add_existing_audit_failed', { tenantId, kind, orgId: payload.orgId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** D5 — tell the added person, and only them: the org's name and who added them. */
async function noticeAdded(member: OrgMember, org: Organization, req: Request): Promise<void> {
  if (!member.subject) return;
  try {
    const actor = callerSubject(req);
    const actorRow = actor ? (await listMembers(member.tenantId, org.orgId)).find((m) => m.subject === actor) ?? (await listMembers(member.tenantId, member.tenantId)).find((m) => m.subject === actor) : undefined;
    const by = actorRow?.displayName;
    await getNotificationEmitter().emit({
      tenantId: member.tenantId,
      recipientUserId: member.subject,
      type: 'org.member.added',
      priority: 'normal',
      title: `You were added to ${org.name}`,
      message: by ? `${by} added you to ${org.name}.` : `You were added to ${org.name}.`,
      actionUrl: '/orgs',
      metadata: { kind: 'org.member.added', orgId: org.orgId, memberId: member.memberId },
    });
  } catch (err) {
    log.debug('org_add_existing_notice_failed', { orgId: org.orgId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * ADR 1123 interim (#5945) — the OLD free-text lane (`POST`/`PATCH …/members`
 * with a `subject`) stays open until the fixture sweep lands, but a PERSON it
 * binds (a `user:` subject) is now as visible as the new lanes: the same audit
 * entry with `lane: 'legacy-subject'`, and the same notice to that person only.
 * No behaviour change. Service and IdP subjects are not people we can notify.
 */
export async function recordLegacySubjectBind(req: Request, org: Organization, member: OrgMember, opts: { placeholderMemberId?: string } = {}): Promise<void> {
  if (!member.subject?.startsWith('user:')) return;
  const actor = callerSubject(req);
  const kind = opts.placeholderMemberId ? 'security.org.member-linked' : 'security.org.member-added-direct';
  await audit(member.tenantId, kind, {
    orgId: org.orgId, memberId: member.memberId, subject: member.subject,
    ...(opts.placeholderMemberId ? { placeholderMemberId: opts.placeholderMemberId } : { roles: member.roles }),
    lane: 'legacy-subject', ...(actor ? { actor } : {}),
  });
  await noticeAdded(member, org, req);
}

export function registerOrgAddExistingRoutes(app: Express, g: AddExistingGuards): void {
  app.get('/host/openwop-app/orgs/:orgId/member-candidates', async (req, res, next) => {
    try {
      await g.loadOrgOwned(req, req.params.orgId);
      await g.requireScope(req, 'host:members:manage');
      const pool = await candidatePool(req, g, req.params.orgId, req.query.for === 'link' ? 'link' : 'add');
      res.json({ candidates: pool.map(({ candidateId, displayName, email }) => ({ candidateId, displayName, ...(email ? { email } : {}) })) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/host/openwop-app/orgs/:orgId/member-lookup', async (req, res, next) => {
    try {
      await g.loadOrgOwned(req, req.params.orgId);
      await g.requireScope(req, 'host:members:manage');
      // D2 — superadmins only. Anyone else is refused before the address is read.
      if (!isSuperadmin(req)) throw new OpenwopError('forbidden', 'Only a host superadmin can look an account up by email.', 403, { reason: 'superadmin_required' });
      const email = (req.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== 'string' || email.trim().length === 0) throw new OpenwopError('validation_error', 'Field `email` is required.', 400, { field: 'email' });
      const u = await findAddableUserByEmail(email);
      const actor = callerSubject(req);
      if (!u || !actor) { res.json({ candidate: null }); return; }
      res.json({ candidate: { lookupToken: mintLookupToken({ userId: u.userId, orgId: req.params.orgId, actor }), displayName: u.displayName ?? u.email ?? '', ...(u.email ? { email: u.email } : {}) } });
    } catch (err) {
      next(err);
    }
  });

  app.post('/host/openwop-app/orgs/:orgId/members/add-existing', async (req, res, next) => {
    try {
      const org = await g.loadOrgOwned(req, req.params.orgId);
      const access = await g.requireScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tenantId = tenantOf(req);
      const roles = g.parseRoleIds(body.roles, await g.validRoleIds(tenantId, req.params.orgId));
      if (g.namesOwner(roles)) g.requireOwner(req, access, 'add an owner');
      const who = await resolveAddee(req, g, req.params.orgId, body, 'add');
      if ((await listMembers(tenantId, req.params.orgId)).some((m) => m.subject === who.subject)) {
        throw new OpenwopError('conflict', 'That person is already a member of this organization.', 409, { field: 'candidateId', reason: 'identity_taken' });
      }
      const startedAt = new Date().toISOString();
      const member = await createMember({ orgId: req.params.orgId, tenantId, displayName: who.displayName, subject: who.subject, ...(who.email ? { email: who.email } : {}), roles });
      if (member.createdAt >= startedAt) memberAdded(member, callerSubject(req));
      await audit(tenantId, 'security.org.member-added-direct', { orgId: req.params.orgId, memberId: member.memberId, subject: who.subject, roles: member.roles, lane: who.lane, ...(callerSubject(req) ? { actor: callerSubject(req) } : {}) });
      await noticeAdded(member, org, req);
      res.status(201).json(member);
    } catch (err) {
      next(err);
    }
  });

  app.post('/host/openwop-app/orgs/:orgId/members/:memberId/link', async (req, res, next) => {
    try {
      const org = await g.loadOrgOwned(req, req.params.orgId);
      const access = await g.requireScope(req, 'host:members:manage');
      const tenantId = tenantOf(req);
      const placeholder = await getMember(req.params.memberId);
      if (!placeholder || placeholder.tenantId !== tenantId || placeholder.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Member not found.', 404, { memberId: req.params.memberId });
      }
      if (placeholder.subject) {
        throw new OpenwopError('conflict', 'This member is already linked to an account.', 409, { memberId: placeholder.memberId, reason: 'identity_locked' });
      }
      // Linking hands the row's roles to a person, so an owner row needs an owner.
      if (g.namesOwner(placeholder.roles)) g.requireOwner(req, access, 'link an owner row');
      const who = await resolveAddee(req, g, req.params.orgId, (req.body ?? {}) as Record<string, unknown>, 'link');
      const actor = callerSubject(req);
      const existing = (await listMembers(tenantId, req.params.orgId)).find((m) => m.subject === who.subject);
      let linked: OrgMember;
      if (existing) {
        // D4 — the person is already here: keep their row as it is, drop the placeholder.
        await deleteMember(placeholder.memberId, actor ? { actor } : {});
        linked = existing;
      } else if (isWorkspaceRootMembership(placeholder)) {
        // A root row's id derives from its subject, so it cannot be re-keyed:
        // create the bound row with the placeholder's roles, then drop it.
        linked = await createMember({ orgId: req.params.orgId, tenantId, displayName: placeholder.displayName, subject: who.subject, ...(placeholder.email ?? who.email ? { email: placeholder.email ?? who.email } : {}), roles: [...placeholder.roles] });
        await deleteMember(placeholder.memberId, actor ? { actor } : {});
        memberAdded(linked, actor);
      } else {
        const updated = await updateMember(placeholder.memberId, { subject: who.subject });
        if (!updated) throw new OpenwopError('not_found', 'Member not found.', 404, { memberId: req.params.memberId });
        linked = updated;
      }
      await audit(tenantId, 'security.org.member-linked', { orgId: req.params.orgId, memberId: linked.memberId, placeholderMemberId: placeholder.memberId, subject: who.subject, lane: who.lane, ...(actor ? { actor } : {}) });
      if (!existing) await noticeAdded(linked, org, req);
      res.json(linked);
    } catch (err) {
      next(err);
    }
  });
}
