/**
 * Account management routes (P3.6.5).
 *
 *   DELETE /v1/host/openwop-app/account   — hard delete the caller's data
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
import { eraseTenantOwnedUsage } from '../providers/managedProvider.js';
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { clearTenantSecretCache } from '../byok/secretResolver.js';
import { purgeTenantHostExt } from '../host/hostExtPersistence.js';
import { purgeTenantKanban } from '../host/kanbanService.js';
import { purgeTenantDurableSurfaces } from '../host/durable/durableQueue.js';
import { purgeTenantVectors } from '../host/vector/vectorTenantPurge.js';
import { purgeTenantOverrides } from '../host/featureToggles/service.js';
import { purgeTenantOwnedWorkflowDefs } from '../host/workflowOwnership.js';
import { deleteRegisteredWorkflow } from '../host/workflowsRegistry.js';
import { purgeApprovalIndexForTenant } from '../host/approvalService.js';
import { clearActiveWorkspace } from '../host/activeWorkspacePref.js';
import { callerSubject, personalTenantOf } from '../host/requestSubject.js';
import { getRetentionHold } from '../host/retentionHold.js';
import {
  sharedWorkspaceMembershipsForSubject,
  countOwners,
  deleteMember,
  getWorkspace,
} from '../host/accessControlService.js';

const log = createLogger('routes.account');

export function registerAccountRoutes(app: Express, deps: { storage: Storage }): void {
  app.delete('/v1/host/openwop-app/account', async (req, res, next) => {
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

      // CONS-4 / review F2 — the LEGAL HOLD gate. This lane had ZERO hold
      // references while ADR 0586 D2 claimed to gate "every destructive lane",
      // and it is strictly MORE destructive than the per-subject
      // `DELETE …/consent/…/subjects/:subjectKey` lane that PR did gate: this
      // one wipes the entire tenant.
      //
      // The reason it is not merely a missed lane but a SPOLIATION lane:
      // `retention-hold` is a `DurableCollection` with a `tenantOf`
      // (`host/retentionHold.ts`), so `purgeTenantHostExt` below deletes the
      // hold's own row in the same pass. Ungated, the destruction removed its
      // own evidence — self-service, no trace, and unrecoverable in exactly the
      // direction Art. 17(3)(b)/(e) exists to prevent.
      //
      // Asserted HERE, after the ≥1-owner refusal and BEFORE the first
      // mutation, so a held account is left fully intact. The gate names its
      // exit: lift the hold (superadmin ops surface), then retry.
      const hold = await getRetentionHold(tenantId);
      if (hold) {
        throw new OpenwopError(
          'legal_hold',
          `This account is under legal hold (${hold.reason}), so its data cannot be deleted. The hold must be lifted before the account can be deleted.`,
          409,
          { held: true, reason: hold.reason, since: hold.createdAt },
        );
      }

      // Wipe Postgres rows first (transactional). The KMS-wrapped DEKs
      // for this tenant become orphaned blobs; without the row in
      // byok_secrets there's no way to recover the plaintext.
      // ADR 0697 follow-up — see `eraseTenantOwnedUsage`: the introspection
      // inside `deleteAllTenantData` matches `tenant_id` EXACTLY, so this
      // tenant's participants' hashed usage buckets are invisible to it.
      await eraseTenantOwnedUsage(deps.storage, tenantId);
      const counts = await deps.storage.deleteAllTenantData(tenantId);
      // Drop in-process plaintext cache entries — the rows are already
      // gone via the cascade above; we only need to invalidate caches.
      clearTenantSecretCache(tenantId);

      // ADR 0284 — the host-extension half. `deleteAllTenantData` covers the SQL
      // engine tables; the tenant's BUSINESS data (CRM, commerce, boards, agents,
      // conversations meta, …) lives in `host_ext_kv` and previously survived
      // account deletion as ~180 collections of orphans (DATA-ASSESSMENT RI-1).
      // KT-D1 — kanban FIRST: cards have no top-level tenantId (tenant is
      // derivable only via their board), so they must cascade board→card
      // BEFORE the generic walk deletes the board rows and strands them.
      const kanban = await purgeTenantKanban(tenantId);

      // ADR 0473 (grade-data D1) — the tenant's authored workflow DEFINITIONS
      // live under `wfreg:` (no JSON tenantId), outside every generic walk;
      // without this, agent-composed draft bodies survive account deletion.
      // MUST run before the hostext purge below deletes the ownership rows
      // this reads. Defs shared with another tenant (dual-ownership edge) are
      // kept; this tenant's ownership rows are removed either way.
      const ownedDefs = await purgeTenantOwnedWorkflowDefs(tenantId, deleteRegisteredWorkflow);

      // ADR 0473 (grade-data D2) — the approvals (tenant, status) index rows
      // carry no JSON tenantId either; the tenant is their key prefix.
      const approvalIx = await purgeApprovalIndexForTenant(tenantId);

      const hostExt = await purgeTenantHostExt(tenantId);

      // GRADE-DATA 2026-07-17 (ADR 0395 batch) — the DURABLE bus/queue keyspace
      // (`hostsurf:*`) embeds the tenant but sits OUTSIDE the `hostext:` walk;
      // purge it too or queued/dead-lettered payloads survive account deletion.
      // Best-effort: a host without the durable backend bound has nothing here.
      let durableSurfaceRows = 0;
      try { durableSurfaceRows = await purgeTenantDurableSurfaces(tenantId); } catch { /* durable backend unbound */ }

      // KB-2 — the VECTOR MIRROR. `deleteAllTenantData` enumerates tables whose column
      // is literally `tenant_id`; `host_vectors` names it `tenant`, so the pgvector
      // mirror was never reached — and it may sit on a separate DSN entirely
      // (`OPENWOP_VECTOR_PG_DSN`). KB chunk rows carry the chunk's FULL TEXT in
      // `metadata`, so on a pgvector deployment a deleted tenant's document text
      // survived account deletion forever. Each backend registers its own purger
      // (`host/vector/vectorTenantPurge.ts`); a backend that FAILS is named in the
      // result and logged rather than folded into the success count.
      const vectors = await purgeTenantVectors(tenantId);
      if (vectors.failed.length > 0) {
        log.error('account-delete: vector mirror not fully reclaimed', { tenantId, backends: vectors.failed });
      }

      // GRADE-DATA 2026-07-19 (ADR 0434 P4) — the active-workspace preference is
      // keyed by SUBJECT, not tenant, so every tenant-scoped purge above walks
      // straight past it and the row would survive account deletion. Clear it
      // explicitly. Best-effort: a stale row is harmless on its own (resolution
      // fail-closes on the membership re-check), but it is still the deleted
      // user's data and must not persist.
      if (subject) await clearActiveWorkspace(subject);

      // ADR 0292 — strip this tenant's per-tenant feature-toggle overrides. Those
      // live INSIDE the shared, toggle-id-keyed config rows (not tenant-owned
      // rows), so `purgeTenantHostExt`'s tenant walk can't reach them; without
      // this they linger forever (e.g. everything `provision-demo` enabled).
      const toggleOverrides = await purgeTenantOverrides(tenantId);

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
        // KB-2 R2 — the vector mirror is part of what was (or was NOT) reclaimed, so it
        // belongs in the ADR 0284 audit payload and in the response below. Naming a
        // failing backend only in a server log made "named, never folded into the success
        // count" true inside the process and false at the API boundary: the caller was
        // told `{deleted:true}` either way.
        payload: { ...counts, hostExtRows: hostExt.deleted, hostExtGhostRows: hostExt.ghostRows, hostExtCollections: hostExt.collections, membershipsRemoved, vectorRows: vectors.purged, vectorBackends: vectors.backends, vectorBackendsFailed: vectors.failed },
      });

      log.info('account hard-delete', { tenantId, ...counts, ...hostExt, kanbanBoards: kanban.boards, kanbanCards: kanban.cards, durableSurfaceRows, vectorRows: vectors.purged, vectorBackends: vectors.backends, vectorBackendsFailed: vectors.failed, toggleOverridesPurged: toggleOverrides.length, membershipsRemoved, ownedWorkflowDefsDeleted: ownedDefs.defsDeleted, ownershipRowsDeleted: ownedDefs.ownershipRows, approvalIndexRowsPurged: approvalIx });
      res.json({
        deleted: true,
        ...counts,
        toggleOverridesPurged: toggleOverrides.length,
        membershipsRemoved,
        // KB-2 R2 — `vectorBackendsFailed` non-empty means the delete is INCOMPLETE.
        // It is reported rather than folded into a bare `deleted:true` (see the audit
        // payload above); `deleted` stays true because the tenant's own rows ARE gone.
        vectorRows: vectors.purged,
        vectorBackends: vectors.backends,
        vectorBackendsFailed: vectors.failed,
      });
    } catch (err) {
      next(err);
    }
  });
}
