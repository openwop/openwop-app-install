/**
 * Users feature routes (host-extension, sample-grade — ADR 0002, Phase 1).
 *
 * Surface under /v1/host/sample/users:
 *   GET    /me                 find-or-create + return the caller's durable record
 *   GET    /users              list the tenant's users
 *   POST   /users              create a user (admin path)
 *   GET    /users/:id          one user
 *   PATCH  /users/:id          update profile (email / displayName / groups)
 *   POST   /users/:id/disable  lifecycle: disable (fail-closed)
 *   POST   /users/:id/enable   lifecycle: re-enable
 *   DELETE /users/:id          remove
 *
 * TOGGLE-GATED (backend authority — ADR 0001 §3.4): every route resolves the
 * caller's `users` assignment server-side; off (or beta + not in cohort) => the
 * surface 404s. The client cannot bypass this.
 *
 * `GET /me` is the reconciliation seam (ADR 0002 Phase 1): it turns the
 * transient `req.principal` minted by the existing auth paths (oidcVerifier,
 * cookie/session) into a durable `User`, capturing raw IdP `groups[]` for the
 * RBAC handoff (ADR 0006) WITHOUT making any authorization decision here. It is
 * FAIL-CLOSED (finding H5): a disabled user gets 403, not a silent pass.
 *
 * Keeping reconciliation inside the feature package (rather than editing core
 * `middleware/auth.ts`) honors ADR 0001's "no edits to core route code" rule;
 * deeper auth-path integration is a documented follow-on within Phase 1.
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { tenantOf } from '../featureRoute.js';
import { requireSignedIn, resolveCallerUser } from './usersGuards.js';
import {
  USER_SOURCES,
  createUser,
  deleteUser,
  getUser,
  listUsers,
  setUserStatus,
  updateUser,
  type UserSource,
} from './usersService.js';

const log = createLogger('features.users');

/** The Users toggle id — matches the feature id + the future `feature.users.*` packs. */

/** Resolve the caller's Users assignment; 404 when not enabled for them
 *  (backend authority — a disabled feature has no surface). */
// Graduated off the feature toggle (2026-06-11, feature.ts § Correction) —
// every route serves unconditionally; identity is platform plumbing.

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

function patchString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a string, null, or omitted.`, 400, { field });
  }
  return value;
}

/** Validate an optional string[] of group names. */
function parseGroups(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((g) => typeof g === 'string')) {
    throw new OpenwopError('validation_error', 'Field `groups` MUST be an array of strings.', 400, { field: 'groups' });
  }
  return value as string[];
}

function parseSource(value: unknown): UserSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (USER_SOURCES as readonly string[]).includes(value)) return value as UserSource;
  throw new OpenwopError('validation_error', `Field \`source\` MUST be one of ${USER_SOURCES.join(', ')}.`, 400, {
    field: 'source',
    allowed: USER_SOURCES,
  });
}

export function registerUsersRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // The reconciliation seam: durable record for the authenticated caller.
  // Fail-closed — a disabled user is denied (finding H5).
  app.get('/v1/host/sample/users/me', async (req, res, next) => {
    try {
      // ADR 0003: resolve the ONE canonical durable user. A bound session
      // (`req.userId`, after login) resolves by id; an anon session is refused
      // (no durable identity — review finding #8); an OIDC bearer falls back to
      // principal-keyed reconciliation.
      const user = await resolveCallerUser(req);
      if (user.status !== 'active') {
        throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: user.userId });
      }
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  // Self-serve: update the CALLER's own mutable identity (display name). Distinct
  // from the admin PATCH /users/:id — this resolves the caller and edits only
  // their own record, so a user can set their name from their profile page.
  app.patch('/v1/host/sample/users/me', async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      if (user.status !== 'active') {
        throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: user.userId });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated = await updateUser(user.userId, {
        displayName: patchString(body.displayName, 'displayName'),
      });
      res.json(updated ?? user);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/sample/users/users', async (req, res, next) => {
    try {
      res.json({ users: await listUsers(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/users', async (req, res, next) => {
    try {
      requireSignedIn(req); // anon sessions can't create durable users / grant groups (finding #4)
      const body = (req.body ?? {}) as Record<string, unknown>;
      const user = await createUser({
        tenantId: tenantOf(req),
        principalId: requireString(body.principalId, 'principalId'),
        groups: parseGroups(body.groups) ?? [],
        source: parseSource(body.source) ?? 'manual',
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      });
      res.status(201).json(user);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/sample/users/users/:id', async (req, res, next) => {
    try {
      const user = await getUser(req.params.id);
      if (!user || user.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      }
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/sample/users/users/:id', async (req, res, next) => {
    try {
      requireSignedIn(req);
      const existing = await getUser(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated = await updateUser(req.params.id, {
        email: patchString(body.email, 'email'),
        displayName: patchString(body.displayName, 'displayName'),
        groups: parseGroups(body.groups),
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // Lifecycle — disable (fail-closed control) / enable.
  for (const [verb, status] of [['disable', 'disabled'], ['enable', 'active']] as const) {
    app.post(`/v1/host/sample/users/users/:id/${verb}`, async (req, res, next) => {
      try {
          requireSignedIn(req);
        const existing = await getUser(req.params.id);
        if (!existing || existing.tenantId !== tenantOf(req)) {
          throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
        }
        const updated = await setUserStatus(req.params.id, status);
        log.info('user_lifecycle', { userId: req.params.id, status });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    });
  }

  app.delete('/v1/host/sample/users/users/:id', async (req, res, next) => {
    try {
      requireSignedIn(req);
      const existing = await getUser(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      }
      await deleteUser(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
