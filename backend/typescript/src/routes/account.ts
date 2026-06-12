/**
 * Account management routes (P3.6.5).
 *
 *   DELETE /v1/host/sample/account   — hard delete the caller's data
 *
 * Hard delete wipes:
 *   - every row owned by the caller's user:* tenant (runs, events,
 *     interrupts, workflows, byok_tenant_secrets)
 *   - cached tenant secrets in the in-process resolver
 *   - the caller's membership in every SHARED workspace they belong to
 *     (ADR 0015 cascade) — BUT it refuses (409) if the caller is the sole
 *     owner of any shared workspace, so a delete never orphans a team
 *     workspace; the user transfers ownership first.
 *
 * Firebase user revocation is the caller's responsibility — the SPA
 * follows the backend DELETE with `user.delete()` on the Firebase JS
 * SDK. We don't pull in firebase-admin server-side because:
 *   (a) it's a heavyweight dep with native modules,
 *   (b) the JS SDK already does the right thing with the user's own
 *       fresh ID token, no service-account credentials needed,
 *   (c) defense-in-depth: server-side data deletion is independent of
 *       Firebase availability.
 *
 * Audit: every deletion writes one row to `audit_log` with the row
 * counts. The audit log itself is NOT cleared — security-relevant
 * events outlive the account by design.
 */

import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { clearTenantSecretCache } from '../byok/secretResolver.js';
import { callerSubject, personalTenantOf } from '../host/requestSubject.js';
import {
  sharedWorkspaceMembershipsForSubject,
  countOwners,
  deleteMember,
  getWorkspace,
} from '../host/accessControlService.js';

const log = createLogger('routes.account');

export function registerAccountRoutes(app: Express, deps: { storage: Storage }): void {
  app.delete('/v1/host/sample/account', async (req, res, next) => {
    try {
      // ADR 0015: "delete my account" wipes the caller's PERSONAL tenant — NOT
      // `req.tenantId`, which is the ACTIVE workspace and may be a shared `ws:`
      // whose data belongs to the whole team. Targeting the active workspace
      // would let account-deletion wipe a shared workspace; use the intrinsic
      // personal tenant the auth middleware resolved. Shared-workspace
      // memberships are cascaded separately below (ADR 0015 follow-up).
      const tenantId = personalTenantOf(req);
      if (!tenantId || !tenantId.startsWith('user:')) {
        throw new OpenwopError(
          'unauthenticated',
          'Account deletion requires a signed-in user (OIDC Bearer).',
          401,
        );
      }

      // The caller's shared-workspace memberships (everything but their own
      // personal tenant, wiped directly below). ADR 0015 cascade.
      const subject = callerSubject(req);
      const memberships = subject
        ? await sharedWorkspaceMembershipsForSubject(subject, tenantId)
        : [];

      // ≥1-owner invariant: refuse to delete the account while the caller is the
      // SOLE owner of a shared workspace — removing them would orphan it. They
      // must transfer ownership (or delete the workspace) first. Checked BEFORE
      // any data is wiped, so a blocked delete leaves the account fully intact.
      // The 409 carries workspace NAMES (not just `ws:` ids) so the SPA can
      // render an actionable prompt.
      const soleOwned: Array<{ workspaceId: string; name: string }> = [];
      for (const m of memberships) {
        if (m.roles.includes('owner') && (await countOwners(m.tenantId, m.orgId)) <= 1) {
          const ws = await getWorkspace(m.tenantId);
          soleOwned.push({ workspaceId: m.tenantId, name: ws?.name ?? m.tenantId });
        }
      }
      if (soleOwned.length > 0) {
        throw new OpenwopError(
          'conflict',
          'You are the last owner of one or more shared workspaces. Transfer ownership or delete those workspaces before deleting your account.',
          409,
          { workspaces: soleOwned },
        );
      }

      // Wipe Postgres rows first (transactional). The KMS-wrapped DEKs
      // for this tenant become orphaned blobs; without the row in
      // byok_secrets there's no way to recover the plaintext.
      const counts = await deps.storage.deleteAllTenantData(tenantId);
      // Drop in-process plaintext cache entries — the rows are already
      // gone via the cascade above; we only need to invalidate caches.
      clearTenantSecretCache(tenantId);

      // Cascade-remove the caller from every shared workspace they belong to.
      // `deleteMember` enforces the ≥1-owner invariant atomically; the pre-check
      // above cleared the common case, but a CONCURRENT removal of a co-owner
      // could make the caller a workspace's last owner in the window between.
      // If that happens we skip that one membership (leaving the caller as that
      // workspace's owner — the safe, never-orphan direction) rather than failing
      // the whole delete after data is already wiped.
      let membershipsRemoved = 0;
      for (const m of memberships) {
        try {
          if (await deleteMember(m.memberId)) membershipsRemoved += 1;
        } catch (e) {
          if (e instanceof OpenwopError && e.code === 'conflict') {
            log.warn('account-delete: kept a membership that became sole-owned by a concurrent change', {
              workspace: m.tenantId,
            });
            continue;
          }
          throw e;
        }
      }

      await deps.storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: req.principal?.principalId,
        action: 'account.delete',
        resource: tenantId,
        outcome: 'success',
        payload: { ...counts, membershipsRemoved },
      });

      log.info('account hard-delete', { tenantId, ...counts, membershipsRemoved });
      res.json({ deleted: true, ...counts, membershipsRemoved });
    } catch (err) {
      next(err);
    }
  });
}
