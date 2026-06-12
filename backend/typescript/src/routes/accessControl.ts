/**
 * Organizations / teams / members + roles — host-extension routes
 * (sample-grade, NON-NORMATIVE). Surface under /v1/host/sample/*:
 *
 *   GET    /roles                         built-in role catalog (role → scopes)
 *   GET    /access/effective[?memberId|?subject]  resolve effective access
 *   GET    /orgs                          list the caller's orgs (tenant-scoped)
 *   POST   /orgs                          create an org              [host:org:manage]
 *   GET    /orgs/:orgId                   one org
 *   PATCH  /orgs/:orgId                   rename / edit              [host:org:manage]
 *   DELETE /orgs/:orgId                   delete (cascades teams+members) [host:org:manage]
 *   GET    /orgs/:orgId/teams             list teams
 *   POST   /orgs/:orgId/teams             create a team              [host:teams:manage]
 *   PATCH  /orgs/:orgId/teams/:teamId     edit                       [host:teams:manage]
 *   DELETE /orgs/:orgId/teams/:teamId     delete                     [host:teams:manage]
 *   GET    /orgs/:orgId/members           list members
 *   POST   /orgs/:orgId/members           add a member               [host:members:manage]
 *   PATCH  /orgs/:orgId/members/:memberId edit roles/teams/identity  [host:members:manage]
 *   DELETE /orgs/:orgId/members/:memberId remove (≥1-owner guarded)  [host:members:manage]
 *   POST   /orgs/:orgId/members/:memberId/transfer-ownership  grant owner (+stepDown) [host:org:manage]
 *   GET    /orgs/:orgId/groups            list groups
 *   POST   /orgs/:orgId/groups            create a group (roles+members) [host:groups:manage]
 *   PATCH  /orgs/:orgId/groups/:groupId   edit roles/members          [host:groups:manage]
 *   DELETE /orgs/:orgId/groups/:groupId   delete                      [host:groups:manage]
 *
 * Tenant-scoped per entity: every by-id read/write verifies the stored row's
 * tenantId matches the caller's tenant (404 otherwise) — the IDOR guard
 * (architect finding 2). Nested team/member routes additionally verify the
 * row's orgId matches the path :orgId so a valid-but-foreign id can't be
 * addressed through another org.
 *
 * Enforcement: `requireScope` gates the management mutations here (always on).
 * The PROTOCOL runs/artifacts paths + the RFC 0049 §C decision seam below are
 * gated on `OPENWOP_AUTHORIZATION_ENFORCEMENT` (ADR 0006 Phase 3): the host
 * advertises capabilities.authorization ONLY when that enforcement is real, so
 * the advertisement is never a false authorization-oracle (architect finding 1).
 * When enforcement is off, the decision seam 404s and the conformance probe
 * (`authorization-fail-closed.test.ts`) soft-skips.
 *
 * @see src/host/protocolAuthorization.ts (the Phase 3 gate + decision)
 * @see src/host/accessControlService.ts
 * @see RFCS/0049 (RBAC scopes), RFCS/0087 §B (org position confers no authority)
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_IDS,
  resolveEffectiveAccess,
  createOrg,
  listOrgs,
  getOrg,
  updateOrg,
  deleteOrg,
  createTeam,
  listTeams,
  getTeam,
  updateTeam,
  deleteTeam,
  createMember,
  listMembers,
  getMember,
  updateMember,
  deleteMember,
  createGroup,
  listGroups,
  getGroup,
  updateGroup,
  deleteGroup,
  createCustomRole,
  listCustomRoles,
  getCustomRole,
  updateCustomRole,
  deleteCustomRole,
  isProtocolScope,
  PROTOCOL_SCOPES,
  type Scope,
} from '../host/accessControlService.js';
import {
  isAuthorizationEnforced,
  decideProtocolAuthorization,
} from '../host/protocolAuthorization.js';
import { callerSubject, tenantOf, isOwnPersonalWorkspace } from '../host/requestSubject.js';

/**
 * Reference-host DEMO SEAM: `x-openwop-act-as: <memberId>` lets the tenant
 * owner exercise the role-derived scopes of one of its members, so role-based
 * enforcement is demonstrable (a `viewer` is actually denied a management
 * mutation) without a production multi-principal auth stack.
 *
 * This is NOT an authentication mechanism — a production host derives the
 * acting principal from real auth (OIDC/mTLS), never a client header. It is
 * tenant-scoped: `resolveEffectiveAccess` only matches members in the caller's
 * own tenant, so acting-as a foreign member resolves to zero scopes
 * (fail-closed). Absent ⇒ authority is resolved from the CALLER'S OWN explicit
 * membership in the org being acted on (ADR 0006 Phase 2 — no implicit
 * tenant-owner for an authenticated non-member).
 */
const ACT_AS_HEADER = 'x-openwop-act-as';

function actingMemberId(req: Request): string | undefined {
  const v = req.header(ACT_AS_HEADER);
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Org creation (and other tenant-level bootstrap) requires only an authenticated
 *  caller — they become the org's explicit owner (ADR 0006 Phase 1). Membership
 *  can't gate the FIRST org (chicken-and-egg), so authority on existing orgs is
 *  membership-derived while creation is open to any signed-in principal. */
function requireAuthenticated(req: Request): void {
  if (!callerSubject(req)) {
    throw new OpenwopError('unauthenticated', 'Authentication is required.', 401, {});
  }
}

/**
 * Gate a management mutation on a scope (ADR 0006 Phase 2 — membership-derived).
 * Resolves the caller's effective access from their EXPLICIT membership in the
 * org being acted on (`req.params.orgId`), or the acted-as member when
 * `x-openwop-act-as` is present. A non-member of a SHARED workspace resolves to
 * ZERO scopes (the multi-principal hazard stays closed). FAIL-CLOSED.
 *
 * ADR 0015: the caller is the implicit OWNER of their OWN personal workspace (a
 * single-principal scope by construction), so a solo user manages their own
 * workspace without first seeding a member. This short-circuit is suppressed
 * under `x-openwop-act-as`, so "view as <viewer>" still narrows correctly, and
 * it NEVER applies to a shared `ws:` workspace (those are membership-derived).
 */
async function requireScope(req: Request, scope: Scope): Promise<void> {
  const memberId = actingMemberId(req);
  if (!memberId && isOwnPersonalWorkspace(req)) return; // implicit personal owner
  const orgId = typeof req.params.orgId === 'string' ? req.params.orgId : undefined;
  const access = await resolveEffectiveAccess(
    tenantOf(req),
    memberId ? { memberId, orgId } : { subject: callerSubject(req), orgId },
  );
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, {
      requiredScope: scope,
      ...(memberId ? { actingAs: memberId } : {}),
    });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a string.`, 400, { field });
  }
  return value;
}

/** `string` → set, `null`/'' → clear, `undefined` → leave. */
function patchString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a string, null, or omitted.`, 400, { field });
  }
  return value;
}

/** The role ids assignable in an org: the built-in catalog ∪ the org's custom
 *  roles. Used to validate role assignments fail-closed at the boundary. */
async function validRoleIds(tenantId: string, orgId: string): Promise<ReadonlySet<string>> {
  const custom = await listCustomRoles(tenantId, orgId);
  return new Set<string>([...BUILT_IN_ROLE_IDS, ...custom.map((r) => r.roleId)]);
}

/** Validate a `roles` array against the set of valid role ids (fail-closed:
 *  unknown ids are rejected so a member/group only ever carries valid roles). */
function parseRoleIds(value: unknown, validIds: ReadonlySet<string>): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new OpenwopError('validation_error', 'Field `roles` MUST be an array of role ids.', 400, { field: 'roles' });
  }
  const out: string[] = [];
  for (const r of value) {
    if (typeof r !== 'string' || !validIds.has(r)) {
      throw new OpenwopError('validation_error', `Unknown role id \`${String(r)}\`.`, 400, { field: 'roles', valid: [...validIds] });
    }
    out.push(r);
  }
  return out;
}

/** Validate a custom role's `scopes` array fail-closed. A custom role may carry
 *  ONLY RFC 0049 protocol scopes — `host:` management scopes are reserved to
 *  the built-in admin/owner roles (so a custom role can't administer the
 *  access-control surface or mint roles). */
function parseScopes(value: unknown): Scope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new OpenwopError('validation_error', 'Field `scopes` MUST be an array of scope strings.', 400, { field: 'scopes' });
  }
  const out: Scope[] = [];
  for (const s of value) {
    if (!isProtocolScope(s)) {
      throw new OpenwopError(
        'validation_error',
        `Scope \`${String(s)}\` is not assignable to a custom role. Custom roles may carry only RFC 0049 protocol scopes; \`host:\` management scopes are reserved to the built-in admin/owner roles.`,
        400,
        { field: 'scopes', valid: PROTOCOL_SCOPES },
      );
    }
    out.push(s);
  }
  return out;
}

function parseTeamIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((t) => typeof t === 'string')) {
    throw new OpenwopError('validation_error', 'Field `teamIds` MUST be an array of team ids.', 400, { field: 'teamIds' });
  }
  return value as string[];
}

function parseMemberIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((m) => typeof m === 'string')) {
    throw new OpenwopError('validation_error', 'Field `memberIds` MUST be an array of member ids.', 400, { field: 'memberIds' });
  }
  return value as string[];
}

/** Load an org owned by the caller's tenant, or throw 404 (IDOR guard). */
async function loadOrgOwned(req: Request, orgId: string) {
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantOf(req)) {
    throw new OpenwopError('not_found', 'Organization not found.', 404, { orgId });
  }
  return org;
}

export function registerAccessControlRoutes(app: Express): void {
  // ── Role catalog (read-only) ──
  app.get('/v1/host/sample/roles', (_req, res) => {
    res.json({ roles: BUILT_IN_ROLE_IDS.map((id) => BUILT_IN_ROLES[id]) });
  });

  // ── Effective access ──
  app.get('/v1/host/sample/access/effective', async (req, res, next) => {
    try {
      // Explicit ?memberId / act-as wins (the UI's per-member preview); else an
      // explicit ?subject; else default to the CALLER's own subject (ADR 0006
      // Phase 2 — membership-derived, not the implicit tenant owner). ?orgId
      // scopes the resolution to one org.
      const memberId =
        typeof req.query.memberId === 'string' ? req.query.memberId : actingMemberId(req);
      const explicitSubject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
      const subject = explicitSubject ?? (memberId ? undefined : callerSubject(req));
      const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
      const access = await resolveEffectiveAccess(tenantOf(req), { memberId, subject, orgId });
      res.json(access);
    } catch (err) {
      next(err);
    }
  });

  // ── RFC 0049 §C — fail-closed authorization-decision seam (ADR 0006 Phase 3) ──
  // `POST /v1/host/sample/authorization/decide` per spec/v1/host-sample-test-seams.md.
  // Gated on capabilities.authorization.supported: when enforcement is OFF the
  // capability is unadvertised and the seam 404s (the conformance probe
  // soft-skips). When ON, resolves the principal's membership-derived scopes and
  // returns `{ allowed }` — fail-closed: an absent/unseeded principal (basis
  // 'none', zero scopes) MUST resolve `allowed: false` (SECURITY invariant
  // `authorization-fail-closed`); the host MUST NOT default-allow.
  app.post('/v1/host/sample/authorization/decide', async (req, res, next) => {
    try {
      if (!isAuthorizationEnforced()) {
        res.status(404).json({
          error: 'not_found',
          message: 'authorization decision seam not enabled (capabilities.authorization.supported is false)',
        });
        return;
      }
      const body = (req.body ?? {}) as { principal?: unknown; action?: unknown; resource?: unknown };
      const principal = typeof body.principal === 'string' ? body.principal : undefined;
      const action = typeof body.action === 'string' ? body.action : '';
      const decision = await decideProtocolAuthorization(tenantOf(req), principal, action);
      // Return ONLY `{ allowed }` — the seam's documented contract
      // (host-sample-test-seams.md). The resolved scope list / membership basis
      // are deliberately NOT echoed: this is a decision oracle, and leaking a
      // principal's full scope set + membership status to the caller is an
      // enumeration surface (code-review follow-up).
      res.json({ allowed: decision.allowed });
    } catch (err) {
      next(err);
    }
  });

  // ── Organizations ──
  app.get('/v1/host/sample/orgs', async (req, res, next) => {
    try {
      res.json({ orgs: await listOrgs(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/orgs', async (req, res, next) => {
    try {
      requireAuthenticated(req); // bootstrap: any signed-in caller may create an org (becomes owner)
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      const name = requireString(body.name, 'name');
      // ADR 0006: bind ownership to the stable User.userId (ADR 0003) when the
      // session is bound, falling back to the principal, then the tenant
      // (back-compat for the single-principal demo). Seed an EXPLICIT owner
      // member so authority is membership-derived, not tenant==principal.
      const ownerSubject = req.userId ?? req.principal?.principalId;
      const org = await createOrg({
        tenantId: tenantOf(req),
        createdBy: ownerSubject ?? tenantOf(req),
        name,
        description: optionalString(body.description, 'description'),
        ...(ownerSubject ? { ownerSubject } : {}),
      });
      res.status(201).json(org);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/sample/orgs/:orgId', async (req, res, next) => {
    try {
      res.json(await loadOrgOwned(req, req.params.orgId));
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/sample/orgs/:orgId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:org:manage');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      const updated = await updateOrg(req.params.orgId, {
        name: optionalString(body.name, 'name'),
        description: patchString(body.description, 'description'),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/sample/orgs/:orgId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:org:manage');
      const counts = await deleteOrg(req.params.orgId);
      res.status(200).json({ deleted: counts });
    } catch (err) {
      next(err);
    }
  });

  // ── Teams (nested under an org) ──
  app.get('/v1/host/sample/orgs/:orgId/teams', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      res.json({ teams: await listTeams(tenantOf(req), req.params.orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/orgs/:orgId/teams', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:teams:manage');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; color?: unknown };
      const team = await createTeam({
        orgId: req.params.orgId,
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        description: optionalString(body.description, 'description'),
        color: optionalString(body.color, 'color'),
      });
      res.status(201).json(team);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/sample/orgs/:orgId/teams/:teamId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:teams:manage');
      const team = await getTeam(req.params.teamId);
      if (!team || team.tenantId !== tenantOf(req) || team.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Team not found.', 404, { teamId: req.params.teamId });
      }
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; color?: unknown };
      const updated = await updateTeam(req.params.teamId, {
        name: optionalString(body.name, 'name'),
        description: patchString(body.description, 'description'),
        color: patchString(body.color, 'color'),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/sample/orgs/:orgId/teams/:teamId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:teams:manage');
      const team = await getTeam(req.params.teamId);
      if (!team || team.tenantId !== tenantOf(req) || team.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Team not found.', 404, { teamId: req.params.teamId });
      }
      await deleteTeam(req.params.teamId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Members (nested under an org) ──
  app.get('/v1/host/sample/orgs/:orgId/members', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      res.json({ members: await listMembers(tenantOf(req), req.params.orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/orgs/:orgId/members', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as {
        displayName?: unknown;
        subject?: unknown;
        email?: unknown;
        roles?: unknown;
        teamIds?: unknown;
      };
      const member = await createMember({
        orgId: req.params.orgId,
        tenantId: tenantOf(req),
        displayName: requireString(body.displayName, 'displayName'),
        subject: optionalString(body.subject, 'subject'),
        email: optionalString(body.email, 'email'),
        roles: parseRoleIds(body.roles, await validRoleIds(tenantOf(req), req.params.orgId)),
        teamIds: parseTeamIds(body.teamIds),
      });
      res.status(201).json(member);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/sample/orgs/:orgId/members/:memberId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:members:manage');
      const member = await getMember(req.params.memberId);
      if (!member || member.tenantId !== tenantOf(req) || member.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Member not found.', 404, { memberId: req.params.memberId });
      }
      const body = (req.body ?? {}) as {
        displayName?: unknown;
        email?: unknown;
        subject?: unknown;
        roles?: unknown;
        teamIds?: unknown;
      };
      // ≥1-owner invariant is enforced inside `updateMember` (the single mutator
      // chokepoint): a role change that strips `owner` from the last owner is
      // rejected atomically with `conflict` (409). ADR 0015.
      const updated = await updateMember(req.params.memberId, {
        displayName: optionalString(body.displayName, 'displayName'),
        email: patchString(body.email, 'email'),
        subject: patchString(body.subject, 'subject'),
        roles: parseRoleIds(body.roles, await validRoleIds(tenantOf(req), req.params.orgId)),
        teamIds: parseTeamIds(body.teamIds),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/sample/orgs/:orgId/members/:memberId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:members:manage');
      const member = await getMember(req.params.memberId);
      if (!member || member.tenantId !== tenantOf(req) || member.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Member not found.', 404, { memberId: req.params.memberId });
      }
      // ≥1-owner invariant is enforced inside `deleteMember` (atomic post-write
      // re-check): removing a workspace's last owner is rejected with `conflict`
      // (409) — it would orphan the workspace. ADR 0015.
      await deleteMember(req.params.memberId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Transfer / grant ownership — the escape hatch for the last-owner guard
  // (ADR 0015). Grants the built-in `owner` role to another member of the
  // workspace (idempotent); with `{ stepDown: true }` the caller ALSO relinquishes
  // their own `owner` role in the same operation — now safe, because the target is
  // already an owner, so the ≥1-owner invariant still holds. Owner-level
  // (`host:org:manage`). This is the in-app path to demote/remove a sole owner:
  // hand ownership over first, then the guard no longer blocks stepping down.
  app.post('/v1/host/sample/orgs/:orgId/members/:memberId/transfer-ownership', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:org:manage');
      const target = await getMember(req.params.memberId);
      if (!target || target.tenantId !== tenantOf(req) || target.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Member not found.', 404, { memberId: req.params.memberId });
      }
      const body = (req.body ?? {}) as { stepDown?: unknown };
      const stepDown = body.stepDown === true;

      // Grant owner to the target (idempotent — a no-op if already an owner).
      if (!target.roles.includes('owner')) {
        await updateMember(target.memberId, { roles: [...target.roles, 'owner'] });
      }

      // Optionally step the caller down from owner in this workspace. Find the
      // caller's OWN member record (by subject) — never the target — and strip
      // `owner`. The target is now an owner, so the invariant is preserved.
      let steppedDown: string | undefined;
      if (stepDown) {
        const subject = callerSubject(req);
        const self = (await listMembers(tenantOf(req), req.params.orgId)).find(
          (m) => m.subject === subject && m.memberId !== target.memberId && m.roles.includes('owner'),
        );
        if (self) {
          await updateMember(self.memberId, { roles: self.roles.filter((r) => r !== 'owner') });
          steppedDown = self.memberId;
        }
      }
      res.json({ transferredTo: target.memberId, ...(steppedDown ? { steppedDown } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // ── Groups (cross-cutting RBAC units carrying roles) ──
  app.get('/v1/host/sample/orgs/:orgId/groups', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      res.json({ groups: await listGroups(tenantOf(req), req.params.orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/orgs/:orgId/groups', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:groups:manage');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; roles?: unknown; memberIds?: unknown };
      const group = await createGroup({
        orgId: req.params.orgId,
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        description: optionalString(body.description, 'description'),
        roles: parseRoleIds(body.roles, await validRoleIds(tenantOf(req), req.params.orgId)),
        memberIds: parseMemberIds(body.memberIds),
      });
      res.status(201).json(group);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/sample/orgs/:orgId/groups/:groupId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:groups:manage');
      const group = await getGroup(req.params.groupId);
      if (!group || group.tenantId !== tenantOf(req) || group.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Group not found.', 404, { groupId: req.params.groupId });
      }
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; roles?: unknown; memberIds?: unknown };
      const updated = await updateGroup(req.params.groupId, {
        name: optionalString(body.name, 'name'),
        description: patchString(body.description, 'description'),
        roles: parseRoleIds(body.roles, await validRoleIds(tenantOf(req), req.params.orgId)),
        memberIds: parseMemberIds(body.memberIds),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/sample/orgs/:orgId/groups/:groupId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:groups:manage');
      const group = await getGroup(req.params.groupId);
      if (!group || group.tenantId !== tenantOf(req) || group.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Group not found.', 404, { groupId: req.params.groupId });
      }
      await deleteGroup(req.params.groupId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Custom roles (org-defined, beyond the built-in catalog) ──
  app.get('/v1/host/sample/orgs/:orgId/roles', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      res.json({
        roles: BUILT_IN_ROLE_IDS.map((id) => BUILT_IN_ROLES[id]),
        customRoles: await listCustomRoles(tenantOf(req), req.params.orgId),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/orgs/:orgId/roles', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:roles:manage');
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; scopes?: unknown };
      const role = await createCustomRole({
        orgId: req.params.orgId,
        tenantId: tenantOf(req),
        name: requireString(body.name, 'name'),
        description: optionalString(body.description, 'description'),
        scopes: parseScopes(body.scopes) ?? [],
      });
      res.status(201).json(role);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/sample/orgs/:orgId/roles/:roleId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:roles:manage');
      const role = await getCustomRole(req.params.roleId);
      if (!role || role.tenantId !== tenantOf(req) || role.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Custom role not found.', 404, { roleId: req.params.roleId });
      }
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown; scopes?: unknown };
      const updated = await updateCustomRole(req.params.roleId, {
        name: optionalString(body.name, 'name'),
        description: patchString(body.description, 'description'),
        scopes: parseScopes(body.scopes),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/sample/orgs/:orgId/roles/:roleId', async (req, res, next) => {
    try {
      await loadOrgOwned(req, req.params.orgId);
      await requireScope(req, 'host:roles:manage');
      const role = await getCustomRole(req.params.roleId);
      if (!role || role.tenantId !== tenantOf(req) || role.orgId !== req.params.orgId) {
        throw new OpenwopError('not_found', 'Custom role not found.', 404, { roleId: req.params.roleId });
      }
      await deleteCustomRole(req.params.roleId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
