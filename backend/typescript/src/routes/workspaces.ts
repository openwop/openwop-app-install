/**
 * Workspace routes (ADR 0015 — workspace-as-tenant, B2B tenancy). Host-extension,
 * non-normative (`/v1/host/sample/*`). A Workspace IS the tenant; these endpoints
 * let a user list the workspaces they can act in, create a shared one, and SWITCH
 * the active workspace (re-binding the session — the RFC 0048 §D "one active
 * workspace per session" model, membership-verified).
 *
 * Authority + storage are the single source of truth in `accessControlService`
 * (a Workspace = the Organization whose `orgId === tenantId`). This module only
 * adds the user-facing workspace lifecycle on top.
 *
 *   GET  /v1/host/sample/me/workspaces            list the caller's workspaces
 *   POST /v1/host/sample/workspaces               create a shared workspace (owner = caller)
 *   POST /v1/host/sample/workspaces/:id/switch    re-bind the active workspace (member-gated)
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
import { issueSubjectSession, issueUserSession } from '../middleware/auth.js';
import {
  createWorkspace,
  ensurePersonalWorkspace,
  listWorkspacesForSubject,
  isWorkspaceMember,
  getWorkspace,
} from '../host/accessControlService.js';
import { ensurePersonalBoard } from '../host/kanbanService.js';
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
  app.get('/v1/host/sample/me/workspaces', async (req, res, next) => {
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
          const ws = await ensurePersonalWorkspace({ tenantId: personal, ownerSubject: subject });
          // ADR 0025 — give every durable user their own kanban board at the same
          // idempotent choke point, so a human is a board-owning orchestration
          // principal exactly like a seeded roster agent. Best-effort: a board
          // hiccup must never block listing the workspace.
          await ensurePersonalBoard(personal, subject).catch((err) =>
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
  app.post('/v1/host/sample/workspaces', async (req, res, next) => {
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
  app.post('/v1/host/sample/workspaces/:id/switch', async (req, res, next) => {
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
      const userId = (req as { userId?: string }).userId;
      if (userId) {
        issueUserSession(res, { userId, tenantId: target, personalTenant: personal });
      } else {
        issueSubjectSession(res, { subject, tenantId: target, personalTenant: personal });
      }
      res.json({ ok: true, active: target });
    } catch (err) {
      next(err);
    }
  });
}
