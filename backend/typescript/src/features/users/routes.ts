/**
 * Users feature routes (host-extension, best-effort — ADR 0002, Phase 1).
 *
 * Surface under /v1/host/openwop-app/users:
 *   GET    /me                 find-or-create + return the caller's durable record
 *   GET    /users              list the tenant's users
 *   POST   /users              create a user (admin path)
 *   GET    /users/:id          one user
 *   PATCH  /users/:id          update profile (email / displayName / groups)
 *   POST   /users/:id/disable  lifecycle: disable (fail-closed; ends live sessions — ADR 0621)
 *   POST   /users/:id/enable   lifecycle: re-enable (does NOT resurrect old sessions)
 *   POST   /users/:id/sessions/revoke  admin "sign out everywhere" (ADR 0621 P3)
 *   POST   /me/sessions/revoke         self "sign out everywhere" (ADR 0621 P3; signs the caller out too)
 *   DELETE /users/:id          remove (erase; ends live sessions FIRST — ADR 0621)
 *
 * ALWAYS-ON (graduated OFF the feature toggle 2026-06-11 — feature.ts
 * § Correction; this docblock used to say "TOGGLE-GATED"): identity is platform
 * plumbing, every route serves unconditionally. Authority is per-route —
 * `requireSignedIn` + the tenant-level `requireTenantScope('host:members:manage')`
 * gate on every admin mutation — never the toggle.
 *
 * ADR 0621 D7 — disable, erase and admin revoke REFUSE the caller's OWN row
 * (`409 self_lockout`): an admin who must leave uses a peer admin, the same
 * rule membership removal applies to the last owner.
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

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { isOwnPersonalWorkspace } from '../../host/requestSubject.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { tenantOf, requireTenantScope } from '../featureRoute.js';
import { requireSignedIn, resolveCallerUser } from './usersGuards.js';
import { userErased } from './emit.js';
import { clearSessionCookie } from '../../middleware/auth.js';
import {
  USER_SOURCES,
  bumpSessionEpoch,
  createUser,
  deleteUser,
  getUser,
  listUsers,
  setUserStatus,
  tombstoneCanonicalPointer,
  updateUser,
  type User,
  type UserSource,
} from './usersService.js';

/**
 * ADR 0621 D7 — refuse a lockout action aimed at the caller's own account.
 * Review NIT-1: keyed on the CALLER'S RESOLVED durable user, not `req.userId`
 * alone — `req.userId` is undefined on the unbound (bearer-only `oidc:<sub>`)
 * lane, where the implicit owner of a personal tenant could otherwise disable /
 * erase / revoke its own row past the 409. `resolveCallerUser` is the same
 * resolution `/me` uses; a caller with no durable identity (an api-key
 * principal) cannot be the target row, so its `sign_in_required` is "not self".
 */
async function refuseSelfLockout(req: Request, target: User, action: string): Promise<void> {
  let callerId = req.userId;
  if (callerId === undefined) {
    try {
      callerId = (await resolveCallerUser(req)).userId;
    } catch (err: unknown) {
      if (!(err instanceof OpenwopError && err.code === 'sign_in_required')) throw err;
    }
  }
  if (callerId !== undefined && callerId === target.userId) {
    throw new OpenwopError(
      'self_lockout',
      `You cannot ${action} your own account. Ask another administrator.`,
      409,
      { action, userId: target.userId },
    );
  }
}

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
  app.get('/v1/host/openwop-app/users/me', async (req, res, next) => {
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
  app.patch('/v1/host/openwop-app/users/me', async (req, res, next) => {
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

  app.get('/v1/host/openwop-app/users/users', async (req, res, next) => {
    try {
      // USERS-8 — symmetry with the mutating routes: durable identity records
      // (emails, display names, IdP groups) are not anonymous-readable. Every
      // legit caller is signed in (the SPA gates the page on a session).
      requireSignedIn(req);
      res.json({ users: await listUsers(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/users/users', async (req, res, next) => {
    try {
      requireSignedIn(req); // anon sessions can't create durable users / grant groups (finding #4)
      // (2026-07 vuln-scan M6) Provisioning durable identities + granting groups is a
      // tenant-management op — in a shared SSO/SCIM tenant any member could otherwise
      // mint identities with arbitrary groups. Personal-tenant owner short-circuits.
      await requireTenantScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const user = await createUser({
        tenantId: tenantOf(req),
        principalId: requireString(body.principalId, 'principalId'),
        groups: parseGroups(body.groups) ?? [],
        source: parseSource(body.source) ?? 'manual',
        // ADR 0622 D7 review S1 — provenance is THIS lane's, never the body's
        // `source` (a personal-tenant owner could POST `source:'saml'` with a
        // victim's email and mint an "IdP-asserted" row). A shared-workspace
        // manager vouches (`'admin'`); under the personal-owner short-circuit
        // the "admin" IS the person (`'self'`, refused by the invitation gates).
        ...(typeof body.email === 'string'
          ? { email: body.email, emailProvenance: isOwnPersonalWorkspace(req) ? 'self' as const : 'admin' as const }
          : {}),
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      });
      // USERS-16 — provisioning a durable identity (+ its RBAC-handoff groups)
      // is a tenant-management act; ids only (never principalId — a SCIM/SAML
      // principal embeds an email), actor the opaque bound id, best-effort.
      const { appendAudit } = await import('../../host/auditChainService.js');
      await appendAudit(tenantOf(req), 'users.lifecycle.create', {
        tenantId: tenantOf(req),
        userId: user.userId,
        source: user.source,
        groupCount: user.groups.length,
        actor: req.userId ?? 'unknown',
      }).catch(() => { /* audit is best-effort */ });
      res.status(201).json(user);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/users/users/:id', async (req, res, next) => {
    try {
      requireSignedIn(req); // USERS-8 — same boundary as the list read
      const user = await getUser(req.params.id);
      if (!user || user.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      }
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/openwop-app/users/users/:id', async (req, res, next) => {
    try {
      requireSignedIn(req);
      // (2026-07 vuln-scan M6) The admin PATCH edits ANOTHER user's record incl. the
      // RBAC-handoff `groups` — a tenant-management op. Self-service (own display name)
      // is the separate PATCH /me. Personal-tenant owner short-circuits.
      await requireTenantScope(req, 'host:members:manage');
      const existing = await getUser(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch = {
        email: patchString(body.email, 'email'),
        displayName: patchString(body.displayName, 'displayName'),
        groups: parseGroups(body.groups),
      };
      // ADR 0622 D7 (`ORGINV-9`) — WHO is asserting this email. The actor
      // editing their OWN row, or acting under the implicit personal-owner
      // short-circuit (a `user:` tenant is single-human, so "admin" there IS
      // the person), is `'self'` — unverified, and refused by the invitation
      // accept/decline gates. A shared-workspace manager editing ANOTHER
      // member's row vouches for it: `'admin'`.
      const selfAsserted = req.userId === req.params.id || isOwnPersonalWorkspace(req);
      const updated = await updateUser(req.params.id, {
        ...patch,
        ...(patch.email ? { emailProvenance: selfAsserted ? 'self' as const : 'admin' as const } : {}),
      });
      // USERS-16 — an admin editing ANOTHER identity (incl. `groups`, the RBAC
      // handoff) is audited with the changed FIELD NAMES only — never values.
      const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => patch[k] !== undefined);
      const { appendAudit } = await import('../../host/auditChainService.js');
      await appendAudit(tenantOf(req), 'users.lifecycle.patch', {
        tenantId: tenantOf(req),
        userId: req.params.id,
        changed,
        actor: req.userId ?? 'unknown',
      }).catch(() => { /* audit is best-effort */ });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // Lifecycle — disable (fail-closed control) / enable.
  for (const [verb, status] of [['disable', 'disabled'], ['enable', 'active']] as const) {
    app.post(`/v1/host/openwop-app/users/users/:id/${verb}`, async (req, res, next) => {
      try {
        requireSignedIn(req);
        // (2026-07 vuln-scan M6) Disabling a user is a fail-closed lockout — a
        // tenant-management op, not a co-member action. Personal owner short-circuits.
        await requireTenantScope(req, 'host:members:manage');
        const existing = await getUser(req.params.id);
        if (!existing || existing.tenantId !== tenantOf(req)) {
          throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
        }
        // ADR 0621 D7 — disabling yourself ends YOUR session on the next request.
        if (status === 'disabled') await refuseSelfLockout(req, existing, 'disable');
        // ADR 0621 D2 — `setUserStatus(…, 'disabled')` bumps the session epoch in
        // the same atomic write, so the disabled account's LIVE sessions end now.
        // ADR 0617 D1 — `reason: 'admin'` is explicit, never inferred from the
        // row's `source` (an admin can disable a SCIM-sourced row).
        const updated = await setUserStatus(req.params.id, status, { reason: 'admin' });
        log.info('user_lifecycle', { userId: req.params.id, status });
        // USERS-5 — tamper-evident record on the ADR 0301 chain (exportable per
        // ADR 0416), like the factor-event: an admin flipping another identity's
        // lifecycle is a security-relevant act. Ids only; best-effort (the audit
        // trail never blocks the lifecycle action itself).
        const { appendAudit } = await import('../../host/auditChainService.js');
        // Actor is the opaque bound `user:<id>` ONLY — a principalId fallback
        // could embed a SAML email NameID (PII) into the exportable chain.
        await appendAudit(tenantOf(req), `users.lifecycle.${verb}`, {
          tenantId: tenantOf(req),
          userId: req.params.id,
          status,
          actor: req.userId ?? 'unknown',
        }).catch(() => { /* audit is best-effort */ });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    });
  }

  app.delete('/v1/host/openwop-app/users/users/:id', async (req, res, next) => {
    try {
      requireSignedIn(req);
      // (2026-07 vuln-scan M6) Deleting a durable identity is a tenant-management op.
      // Personal-tenant owner short-circuits.
      await requireTenantScope(req, 'host:members:manage');
      const existing = await getUser(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      }
      // ADR 0621 D7 — erasing yourself is a self-lockout; use a peer admin.
      await refuseSelfLockout(req, existing, 'delete');
      // PROF-2 — cascade the subject's PII with the identity. Deleting only the
      // user left the profile row (bio/location) readable by-id with `owner`
      // null, and its Team Portfolio KB doc searchable. Review F5: this is the
      // REGISTRY fan-out (`eraseSubject`), not a hand-kept function list — a
      // future `registerSubjectEraser` registration is picked up automatically.
      // Review F3: the KB removal runs STRICT first, and an incomplete fan-out
      // REFUSES — both ordered BEFORE `deleteUser` so any failure surfaces while
      // the delete is still retryable (the reverse order strands the PII
      // forever: the retry 404s on the already-deleted user).
      // CONS-4 / WF-CONS-1 — the SECOND door onto the same irreversible fan-out.
      // `eraseSubject` now refuses under a legal hold, but this route destroys
      // the profile FIRST, so relying on the seam's own throw would leave the
      // subject's profile deleted under a hold that was supposed to stop
      // everything. Asserted here, before anything mutates.
      const { getRetentionHold } = await import('../../host/retentionHold.js');
      const hold = await getRetentionHold(tenantOf(req));
      if (hold) {
        throw new OpenwopError(
          'legal_hold',
          `This workspace is under legal hold (${hold.reason}), so user data cannot be erased. Lift the hold, then retry.`,
          409,
          { held: true, reason: hold.reason, since: hold.createdAt },
        );
      }
      // ADR 0621 D2 — end the account's LIVE sessions BEFORE the erasure fan-out:
      // a cookie minted before this point fails on epoch even in the window
      // where the row still exists (and as `account_erased` once it is gone).
      // Ordered first so a partial fan-out (which refuses below and stays
      // retryable) never leaves a signed-in session on a half-erased subject.
      await bumpSessionEpoch(req.params.id);
      const { removeProfileStrict } = await import('../profiles/profilesKnowledgeService.js');
      await removeProfileStrict(tenantOf(req), req.params.id);
      const { eraseSubject } = await import('../../host/subjectErasure.js');
      const erasure = await eraseSubject(tenantOf(req), req.params.id);
      if (erasure.failed > 0) {
        throw new OpenwopError(
          'internal_error',
          `Subject-data cleanup failed for: ${erasure.failedFeatures.join(', ')} — the user was NOT deleted; retry.`,
          500,
          { failedFeatures: erasure.failedFeatures },
        );
      }
      // ADR 0621 rev. 2 (review BLOCKER-1, erase family) — leave a TOMBSTONE:
      // pin the personal tenant's canonical pointer to this row BEFORE deleting
      // it, so the dangling pointer makes the unbound-lane session read AND the
      // canonical fold refuse `account_erased` instead of re-creating an active
      // row for the same IdP identity on its next bearer request. No-op for a
      // shared/org tenant (principal-keyed identity; the bind refuses by row).
      await tombstoneCanonicalPointer(existing);
      await deleteUser(req.params.id);
      // ADR 0617 D1 — `host.users.user.erased` fires HERE, after `deleteUser`
      // succeeded — never on the `failed > 0` throw above (a "failed" `erased`
      // event would be a false claim) and not merely after `eraseSubject`.
      userErased({ userId: req.params.id, tenantId: tenantOf(req), outcome: 'deleted' });
      // USERS-5 — same audit-chain record as disable/enable: removing a durable
      // identity is the strongest lifecycle act of the three.
      const { appendAudit } = await import('../../host/auditChainService.js');
      // Ids only (see the disable/enable note): never a principalId fallback,
      // which could embed a SAML email NameID into the exportable chain.
      await appendAudit(tenantOf(req), 'users.lifecycle.delete', {
        tenantId: tenantOf(req),
        userId: req.params.id,
        actor: req.userId ?? 'unknown',
      }).catch(() => { /* audit is best-effort */ });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ADR 0621 P3 — admin "Sign out everywhere". Bumps the target's session epoch,
  // so every cookie minted before this call is `401 session_revoked` on its next
  // request (D2). Gated by the SAME predicate as disable/enable; D7 refuses the
  // caller's own row (use `/me/sessions/revoke` for that). Audit row ids-only,
  // like the lifecycle routes.
  app.post('/v1/host/openwop-app/users/users/:id/sessions/revoke', async (req, res, next) => {
    try {
      requireSignedIn(req);
      await requireTenantScope(req, 'host:members:manage');
      const existing = await getUser(req.params.id);
      if (!existing || existing.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      }
      await refuseSelfLockout(req, existing, 'revoke the sessions of');
      const updated = await bumpSessionEpoch(req.params.id);
      if (!updated) throw new OpenwopError('not_found', 'User not found.', 404, { userId: req.params.id });
      log.info('user_sessions_revoked', { userId: req.params.id });
      const { appendAudit } = await import('../../host/auditChainService.js');
      await appendAudit(tenantOf(req), 'users.lifecycle.sessions-revoke', {
        tenantId: tenantOf(req),
        userId: req.params.id,
        actor: req.userId ?? 'unknown',
      }).catch(() => { /* audit is best-effort */ });
      res.json({ userId: updated.userId, sessionEpoch: updated.sessionEpoch ?? 0, revoked: true });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0621 P3 — self-service "Sign out everywhere". Bumps the CALLER's own
  // epoch. The current response ALSO clears the caller's cookie: the session
  // that made this request is minted under the old epoch and would be refused
  // on its very next request anyway, so it is signed out honestly here rather
  // than one request later with a surprising 401. (The SPA re-authenticates
  // from its IdP token; the bind re-stamps the new epoch.)
  app.post('/v1/host/openwop-app/users/me/sessions/revoke', async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const updated = await bumpSessionEpoch(user.userId);
      if (!updated) throw new OpenwopError('sign_in_required', 'Session identity not found.', 401, {});
      const { appendAudit } = await import('../../host/auditChainService.js');
      await appendAudit(user.tenantId, 'users.lifecycle.sessions-revoke', {
        tenantId: user.tenantId,
        userId: user.userId,
        actor: user.userId,
        self: true,
      }).catch(() => { /* audit is best-effort */ });
      clearSessionCookie(res);
      res.json({ userId: updated.userId, sessionEpoch: updated.sessionEpoch ?? 0, revoked: true, signedOut: true });
    } catch (err) {
      next(err);
    }
  });
}
