/**
 * Portability routes (RFC 0098) — host-sample seam under
 * `GET /v1/host/openwop-app/export` + `POST /v1/host/openwop-app/import[?dryRun=]`, per
 * `host-sample-test-seams.md §11`.
 *
 * `export-bundle-portability` behavioral leg: importing a bundle carrying a
 * literal credential value → 422. Credential/cycle validation runs BEFORE any
 * apply or scope decision, so a leaky bundle is rejected even on `?dryRun=true`
 * (and `?dryRun=true` makes zero writes). openwop-app is the `portability.import`
 * non-vacuous graduation witness (RFC 0098 Active→Accepted).
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, isAnonTenantId, tenantOf } from '../../host/requestSubject.js';
import { requireTenantScope } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { EXPORT_PAGE_MAX, exportableFeatureIds, featureDataExporter } from '../../host/featureDataExport.js';
import { getToggleDefault } from '../../host/featureToggles/registry.js';
import { resolveSubjectScopesUnion } from '../../host/accessControlService.js';
import {
  buildExportBundle,
  planImport,
  applyImport,
  CredentialMaterialError,
  DependsOnCycleError,
  MalformedBundleError,
} from './portabilityService.js';

/** Apply (non-dry-run) import installs entities — fail-closed on `packs:publish`. */
async function assertCanImport(req: Request): Promise<void> {
  const subject = callerSubject(req);
  const tenant = tenantOf(req);
  const scopes = subject ? (await resolveSubjectScopesUnion(tenant, subject)).scopes : [];
  if (!scopes.includes('packs:publish')) {
    throw new OpenwopError('forbidden_scope', 'Applying an import bundle requires the `packs:publish` scope.', 403, {
      requiredScope: 'packs:publish',
    });
  }
}

/** ADR 0820 §7 — the lapsed-data export is admin-class (see the route). */
async function requireExportAdmin(req: Request): Promise<void> {
  if (isAnonTenantId(tenantOf(req))) {
    throw new OpenwopError('forbidden', 'Sign in to export workspace data.', 403, { reason: 'anonymous_session' });
  }
  await requireTenantScope(req, 'host:billing:manage');
}

/** ADR 0820 §7 — what the door would answer for `featureId` in this tenant:
 *  served when enabled or refused ONLY by the plan; anything else is refused. */
async function exportAccess(featureId: string, tenantId: string): Promise<{ access: 'entitled' | 'plan-lapsed' | null; blockedBy?: string }> {
  const resolved = await resolveOne(featureId, { tenantId });
  const access = resolved?.enabled === true ? 'entitled' : resolved?.blockedBy === 'plan' ? 'plan-lapsed' : null;
  return { access, ...(resolved?.blockedBy ? { blockedBy: resolved.blockedBy } : {}) };
}

/** A non-negative integer query param, else `fallback`. */
function intParam(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : fallback;
}

/** Map a validation error to a 422 (runs before scope, so leaky dry-runs 422). */
function as422(err: unknown): never {
  if (err instanceof CredentialMaterialError) throw new OpenwopError('validation_error', err.message, 422, { keyPath: err.keyPath });
  if (err instanceof DependsOnCycleError) throw new OpenwopError('validation_error', err.message, 422, { cycle: err.cycle });
  if (err instanceof MalformedBundleError) throw new OpenwopError('validation_error', err.message, 422);
  throw err;
}

export function registerPortabilityRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const wrap = (h: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(err);
      }
    };

  // Export — refs-only bundle of the tenant's REAL entities (no secret values).
  app.get(
    '/host/openwop-app/export',
    wrap(async (req, res) => {
      const kinds = typeof req.query.kinds === 'string' ? req.query.kinds.split(',').map((k) => k.trim()).filter(Boolean) : undefined;
      // ADR 0608 R2 (`CPC-13`) — pass the acting subject so the membership-scoped
      // slices (schedule) drop rows the caller cannot READ, matching the
      // `GET /scheduler/jobs` door. The broad export-authz gap on the OTHER kinds
      // (roster / prompts / connection refs / org-chart leaking on tenant
      // co-residency alone) is tracked as `CPC-16`, not closed here.
      res.json(await buildExportBundle(tenantOf(req), kinds, callerSubject(req) ?? null));
    }),
  );

  // ADR 0820 §7 — READ-ONLY export of one feature's data, served even after the
  // workspace's plan stopped including that feature ("downgrade never deletes
  // data"). This is the ONE lane that answers a plan-refused feature, so it is
  // deliberately narrow:
  //   - admin-class: `host:billing:manage` (built-in admin/owner only, never
  //     mintable onto a custom role) — the people who can resubscribe are the
  //     people who can take the workspace's data out. The anon refusal comes
  //     first (`requireTenantScope` would allow an `anon:` personal tenant).
  //   - GET only, through a registered exporter whose contract is read-only
  //     (`host/featureDataExport.ts`). No write, no feature UI, no run.
  //   - access via the ONE resolver (`resolveOne`, ADR 0819): served when the
  //     feature is enabled OR refused only by the plan (`blockedBy:'plan'`). A
  //     toggle an admin or operator switched OFF stays refused — that is a kill
  //     switch, not a lapse — and an unresolvable answer fails closed.
  app.get(
    '/host/openwop-app/export/features',
    wrap(async (req, res) => {
      await requireExportAdmin(req);
      // `features`: every registered exporter (unchanged). `exportable`: the ones
      // THIS workspace can take out right now (entitled or plan-lapsed), with a
      // label — what the Billing "Your data" list and the lock page's button read.
      const tenantId = tenantOf(req);
      const features = exportableFeatureIds();
      const exportable: Array<{ featureId: string; label: string; access: 'entitled' | 'plan-lapsed' }> = [];
      for (const featureId of features) {
        const { access } = await exportAccess(featureId, tenantId);
        if (access) exportable.push({ featureId, label: getToggleDefault(featureId)?.label ?? featureId, access });
      }
      res.json({ features, exportable });
    }),
  );
  app.get(
    '/host/openwop-app/export/features/:featureId',
    wrap(async (req, res) => {
      await requireExportAdmin(req);
      const featureId = req.params.featureId;
      const exporter = featureDataExporter(featureId);
      if (!exporter) throw new OpenwopError('not_found', 'This feature has no data export.', 404, { featureId });
      const tenantId = tenantOf(req);
      const { access, blockedBy } = await exportAccess(featureId, tenantId);
      if (!access) {
        throw new OpenwopError('forbidden', 'This feature is switched off for the workspace, so its data cannot be exported here.', 403, {
          featureId, reason: blockedBy === 'unresolved' ? 'feature_unavailable' : 'feature_disabled',
        });
      }
      // Bounded: every section is paged (`offset`, `limit` ≤ EXPORT_PAGE_MAX).
      // `page.nextOffset` is null on the last page; a client walks it to the end.
      const offset = intParam(req.query.offset, 0);
      const limit = Math.min(Math.max(intParam(req.query.limit, EXPORT_PAGE_MAX), 1), EXPORT_PAGE_MAX);
      const all = await exporter(tenantId);
      const sections: Record<string, readonly unknown[]> = {};
      const totals: Record<string, number> = {};
      let more = false;
      for (const [name, rows] of Object.entries(all)) {
        sections[name] = rows.slice(offset, offset + limit);
        totals[name] = rows.length;
        if (rows.length > offset + limit) more = true;
      }
      res.setHeader('content-disposition', `attachment; filename="${featureId}-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json({
        featureId, readOnly: true, access, exportedAt: new Date().toISOString(), sections,
        page: { offset, limit, totals, nextOffset: more ? offset + limit : null },
      });
    }),
  );

  // Import — `?dryRun=true` plans (zero writes); otherwise applies (scope-gated).
  // Credential/cycle validation runs first → 422 even on a dry-run.
  app.post(
    '/host/openwop-app/import',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { bundle?: unknown };
      const bundle = body.bundle;
      const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';

      if (dryRun) {
        try {
          res.json(planImport(bundle));
        } catch (err) {
          as422(err);
        }
        return;
      }

      // Apply: validate (422) BEFORE the scope decision, then require scope (403).
      try {
        planImport(bundle); // validates credential/cycle/shape; result discarded
      } catch (err) {
        as422(err);
      }
      await assertCanImport(req);
      const actor = callerSubject(req) ?? 'import';
      res.json(await applyImport(tenantOf(req), actor, bundle));
    }),
  );
}
