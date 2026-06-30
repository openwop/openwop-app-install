/**
 * ADR 0003 Phase 4d — one-shot subject re-key (maintenance route).
 *
 *   POST /v1/host/openwop-app/maintenance/rekey-member-subjects
 *
 * Rewrites every legacy-form `OrgMember.subject` in a tenant to its canonical
 * `user:<userId>`. Re-keys ONLY the RBAC subject — never run ownership (runs are
 * tenant-owned, no subject stamp), so it is replay/fork-safe (RFC 0048 §D). The
 * service fn (`rekeyLegacyMemberSubjects`) is idempotent + safe to re-run.
 *
 * Gating: superadmin ONLY — the SAME posture as the governance / feature-toggle
 * administration surfaces (`host/superadmin.ts`, ADR 0028). No new auth path.
 *
 * Target tenant: superadmin may pass `{ tenantId }` in the body to scope the
 * migration to a specific tenant; absent, it runs for the caller's own tenant.
 */

import type { Express, Request } from 'express';
import type { Storage } from '../storage/storage.js';
import { OpenwopError } from '../types.js';
import { requireSuperadmin } from '../host/superadmin.js';
import { rekeyLegacyMemberSubjects } from '../host/subjectRekeyMigration.js';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';

export function registerSubjectRekeyRoute(app: Express, deps: { storage: Storage }): void {
  app.post('/v1/host/openwop-app/maintenance/rekey-member-subjects', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Subject re-key maintenance');

      const body = (req.body ?? {}) as { tenantId?: unknown };
      let targetTenant = tenantOf(req);
      if (body.tenantId !== undefined) {
        if (typeof body.tenantId !== 'string' || body.tenantId.length === 0) {
          throw new OpenwopError('validation_error', '`tenantId` MUST be a non-empty string when provided.', 400, {});
        }
        targetTenant = body.tenantId;
      }

      const result = await rekeyLegacyMemberSubjects(targetTenant);

      await deps.storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: req.principal?.principalId,
        action: 'access.rekey-member-subjects',
        resource: targetTenant,
        outcome: 'success',
        payload: { tenantId: targetTenant, ...result },
      });

      res.json({ tenantId: targetTenant, ...result });
    } catch (err) {
      next(err);
    }
  });
}
