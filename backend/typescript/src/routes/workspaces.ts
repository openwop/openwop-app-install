/**
 * Workspace routes (ADR 0015 — workspace-as-tenant, B2B tenancy). Host-extension,
 * non-normative (`/v1/host/openwop-app/*`). A Workspace IS the tenant; these endpoints
 * let a user list the workspaces they can act in, create a shared one, and SWITCH
 * the active workspace (re-binding the session — the RFC 0048 §D "one active
 * workspace per session" model, membership-verified).
 *
 * Authority + storage are the single source of truth in `accessControlService`
 * (a Workspace = the Organization whose `orgId === tenantId`). This module only
 * adds the user-facing workspace lifecycle on top.
 *
 *   GET  /v1/host/openwop-app/me/workspaces            list the caller's workspaces
 *   POST /v1/host/openwop-app/workspaces               create a shared workspace (owner = caller)
 *   POST /v1/host/openwop-app/workspaces/:id/switch    re-bind the active workspace (member-gated)
 *
 * GATING (deliberate): unlike the `orgs` invitation FEATURE (toggle-gated per
 * ADR 0001), these routes are ALWAYS-ON — they are core tenancy that builds
 * directly on the always-on `accessControl` surface, not an optional add-on. A
 * caller with no shared workspaces simply sees their personal one; nothing here
 * is gated behind a flag. (The sidebar switcher likewise shows for everyone,
 * falling back to a static link before workspaces load.)
 *
 * @see docs/adr/0015-workspace-as-tenant-b2b.md
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { callerSubject, tenantOf, personalTenantOf, isDurableCaller } from '../host/requestSubject.js';
import { clearSessionCookie, issueSubjectSession, issueUserSession } from '../middleware/auth.js';
import { setActiveWorkspace } from '../host/activeWorkspacePref.js';
import {
  createWorkspace,
  ensurePersonalWorkspace,
  listWorkspacesForSubject,
  isWorkspaceMember,
  getWorkspace,
} from '../host/accessControlService.js';
import { ensurePersonalBoard } from '../host/kanbanService.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';
import { getUser, sessionEpochOf } from '../features/users/usersService.js';
import { createLogger } from '../observability/logger.js';

const wsLog = createLogger('routes.workspaces');

/** The caller's stable subject, or throw 401. */
function requireSubject(req: Request): string {
  const subject = callerSubject(req);
  if (!subject) {
    throw new OpenwopError('unauthenticated', 'Authentication is required.', 401, {});
  }
  return subject;
}

interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  slug: string;
  roles: string[];
  kind: 'personal' | 'shared';
  active: boolean;
}

export function registerWorkspaceTenancyRoutes(app: Express): void {
  // ── List the caller's workspaces ──
  app.get('/v1/host/openwop-app/me/workspaces', async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const personal = personalTenantOf(req);
      const active = tenantOf(req);
      const out: WorkspaceSummary[] = [];

      // Personal workspace first. For a durable caller, ensure a record exists
      // (idempotent) so it can be named/listed; for an anon sandbox, synthesize
      // an ephemeral entry without persisting.
      if (personal) {
        if (isDurableCaller(req)) {
          // ADR 0003 — provision the personal workspace + board under the caller's
          // ONE canonical durable user (the same identity `/me` resolves), NOT the
          // raw `callerSubject`. The subject falls back to the volatile channel
          // principal (`oidc:<sub>` bearer / `session:<sid>`) when the session
          // isn't bound, and `ensurePersonalWorkspace`/`ensurePersonalBoard` key
          // the owner member + board id on it — so keying on the subject mints a
          // SEPARATE owner + "My Board" per channel (the duplicate-board / split-
          // principal fragmentation ADR 0003 eliminates). The canonical userId is
          // stable across channels, so provisioning is genuinely idempotent.
          const ownerId = (await resolveCallerUser(req)).userId;
          const ws = await ensurePersonalWorkspace({ tenantId: personal, ownerSubject: ownerId });
          await ensurePersonalBoard(personal, ownerId).catch((err) =>
            wsLog.warn('personal_board_provision_failed', { tenantId: personal, error: err instanceof Error ? err.message : String(err) }),
          );
          out.push({
            workspaceId: ws.orgId, name: ws.name, slug: ws.slug,
            roles: ['owner'], kind: 'personal', active: active === personal,
          });
        } else {
          out.push({
            workspaceId: personal, name: 'Personal sandbox', slug: 'personal',
            roles: ['owner'], kind: 'personal', active: active === personal,
          });
        }
      }

      // Shared workspaces the caller is a member of.
      for (const ws of await listWorkspacesForSubject(subject)) {
        if (ws.orgId === personal) continue; // already listed as personal
        out.push({
          workspaceId: ws.orgId, name: ws.name, slug: ws.slug,
          roles: ws.roles, kind: 'shared', active: active === ws.orgId,
        });
      }

      res.json({ workspaces: out, active, personal });
    } catch (err) {
      next(err);
    }
  });

  // ── Create a shared workspace (caller becomes its owner) ──
  app.post('/v1/host/openwop-app/workspaces', async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      if (!isDurableCaller(req)) {
        throw new OpenwopError(
          'forbidden', 'Sign in to create a shared workspace (anonymous sessions are ephemeral).', 403, {},
        );
      }
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
      }
      const ws = await createWorkspace({
        name: body.name,
        ownerSubject: subject,
        description: typeof body.description === 'string' ? body.description : undefined,
      });
      res.status(201).json({ workspaceId: ws.orgId, name: ws.name, slug: ws.slug, roles: ['owner'], kind: 'shared' });
    } catch (err) {
      next(err);
    }
  });

  // ── Switch the active workspace (re-bind the session, member-gated) ──
  app.post('/v1/host/openwop-app/workspaces/:id/switch', async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const personal = personalTenantOf(req);
      const target = req.params.id;

      // The caller's own personal workspace is always switchable; a shared
      // workspace requires explicit membership (FAIL-CLOSED).
      if (target !== personal) {
        if (!(await isWorkspaceMember(subject, target))) {
          throw new OpenwopError('forbidden', 'You are not a member of that workspace.', 403, { workspaceId: target });
        }
        if (!(await getWorkspace(target))) {
          throw new OpenwopError('not_found', 'Workspace not found.', 404, { workspaceId: target });
        }
      }

      // Re-issue the session bound to the target as the ACTIVE workspace, with
      // the caller's INTRINSIC personal tenant preserved (so the implicit
      // personal-owner check keeps pointing at the right tenant after the switch).
      // ADR 0434 Phase 4 — persist the choice server-side so it follows the
      // subject to their other devices. Before this the switch wrote ONLY a
      // cookie, so the active workspace was device-local and machine B silently
      // showed the personal tenant. Best-effort and awaited: a storage failure
      // must not fail the switch, which has already been authorized above.
      await setActiveWorkspace(subject, target);

      const userId = req.userId;
      // ADR 0621 D2 (review SHOULD-2): the re-mint carries the epoch the
      // middleware VALIDATED on this request (`req.sessionEpoch`), never a fresh
      // row read — a bump landing between validation and this route would be
      // stamped onto the new cookie and survive the revoke. The row is still
      // read for the disable check (the USERS-1 mint-site class), and if its
      // epoch has moved past the validated one the switch is refused as the
      // revoke it is, cookie cleared. A bound user with no validated epoch is a
      // wiring bug, not a `0` (that fallback was the fail-open shape).
      const validatedEpoch = req.sessionEpoch;
      if (userId) {
        if (validatedEpoch === undefined) {
          throw new OpenwopError('internal_error', 'Bound session reached the workspace switch without a validated session epoch.', 500, { userId });
        }
        const durable = await getUser(userId);
        if (!durable) {
          clearSessionCookie(res);
          throw new OpenwopError('account_erased', 'This account no longer exists. Sign in again.', 401, { userId });
        }
        if (durable.status !== 'active') {
          clearSessionCookie(res);
          throw new OpenwopError('account_disabled', 'This account is disabled.', 401, { userId });
        }
        if (sessionEpochOf(durable) !== validatedEpoch) {
          clearSessionCookie(res);
          throw new OpenwopError('session_revoked', 'This session was signed out. Sign in again.', 401, { userId });
        }
        // ADR 0389 P1: carry the second-factor mark across the switch — a
        // re-issue that dropped it would silently demote an MFA session.
        issueUserSession(res, { userId, tenantId: target, personalTenant: personal, mfa: req.mfaVerified, epoch: validatedEpoch });
      } else {
        // The unbound lane carries the canonical row's epoch the middleware
        // validated (absent when no row was ever bound — nothing to revoke).
        issueSubjectSession(res, { subject, tenantId: target, personalTenant: personal, mfa: req.mfaVerified, ...(validatedEpoch !== undefined ? { epoch: validatedEpoch } : {}) });
      }
      res.json({ ok: true, active: target });
    } catch (err) {
      next(err);
    }
  });
}
