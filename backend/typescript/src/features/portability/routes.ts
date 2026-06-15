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
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
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

  // Export — refs-only bundle (no secret values).
  app.get(
    '/v1/host/openwop-app/export',
    wrap(async (req, res) => {
      const kinds = typeof req.query.kinds === 'string' ? req.query.kinds.split(',').map((k) => k.trim()).filter(Boolean) : undefined;
      res.json(buildExportBundle(tenantOf(req), kinds));
    }),
  );

  // Import — `?dryRun=true` plans (zero writes); otherwise applies (scope-gated).
  // Credential/cycle validation runs first → 422 even on a dry-run.
  app.post(
    '/v1/host/openwop-app/import',
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
      res.json(applyImport(bundle));
    }),
  );
}
