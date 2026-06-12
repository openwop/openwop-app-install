/**
 * Feature-toggle host-extension routes (sample-grade, NON-NORMATIVE).
 *
 * Backend is the authority (ADR §3.4) — resolution runs server-side from the
 * authenticated principal, and the FE consumes a read-only assignments map.
 * Surface under /v1/host/sample/feature-toggles:
 *
 *   GET /assignments              resolve EVERY toggle for the caller   [authed]
 *   GET /assignments/:id          resolve one toggle for the caller     [authed]
 *   GET /admin/configs            list every effective config       [superadmin]
 *   PUT /admin/configs/:id        upsert a toggle config            [superadmin]
 *
 * Superadmin gate (`requireSuperadmin`): a wildcard bearer principal (`*` — the
 * conformance/admin API key) OR a tenant listed in OPENWOP_SUPERADMIN_TENANTS.
 * Dev convenience is an EXPLICIT opt-in: set OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true
 * to treat any authenticated caller as superadmin (so the admin screen works
 * locally without an allowlist). The gate FAILS CLOSED by default — a deploy
 * that forgets the allowlist is never world-writable, regardless of NODE_ENV.
 *
 * NOTE: deliberately NOT mounted under /v1/host/sample/admin (which bypasses
 * cookie auth and does its own OPENWOP_ADMIN_TOKEN check) — the SPA superadmin
 * authenticates via the normal session/bearer path, which this needs.
 *
 * @see src/host/featureToggles/service.ts
 * @see docs/adr/0001-feature-first-package-architecture.md §3
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import {
  getEffectiveConfig,
  listEffectiveConfigs,
  resolveAssignments,
  resolveOne,
  saveConfig,
} from '../host/featureToggles/service.js';
import { validateToggleConfig } from '../host/featureToggles/validate.js';
import type { ToggleSubject } from '../host/featureToggles/types.js';
import { requireSuperadmin as requireSuperadminShared } from '../host/superadmin.js';

const log = createLogger('routes.featureToggles');

function subjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: req.tenantId ?? 'default' };
  const principalId = req.principal?.principalId;
  if (principalId) subject.userId = principalId;
  return subject;
}

// Superadmin gate extracted to `host/superadmin.ts` (ADR 0028 — the
// governance surface shares it; a copied gate drifts). Reused by
// routes/siteConfig.ts (ADR 0027) too.
function requireSuperadmin(req: Request): void {
  requireSuperadminShared(req, 'Feature-toggle administration');
}

export function registerFeatureToggleRoutes(app: Express): void {
  // ── Caller assignments (read-only mirror; any authenticated caller) ──
  // BY DESIGN this returns every toggle's resolved state (incl. `off`) for the
  // caller — the FE needs to know a feature exists-but-disabled to render its
  // "not enabled" state and to gate nav. Only toggle ids + the caller's own
  // resolved status/variant/bindings are exposed; cohorts, per-tenant overrides,
  // and other tenants' assignments never appear here (that's the admin surface).
  app.get('/v1/host/sample/feature-toggles/assignments', async (req, res, next) => {
    try {
      res.json({ assignments: await resolveAssignments(subjectOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/sample/feature-toggles/assignments/:id', async (req, res, next) => {
    try {
      const assignment = await resolveOne(req.params.id, subjectOf(req));
      if (!assignment) {
        throw new OpenwopError('not_found', 'No such feature toggle.', 404, { id: req.params.id });
      }
      res.json(assignment);
    } catch (err) {
      next(err);
    }
  });

  // ── Admin (superadmin only) ──
  app.get('/v1/host/sample/feature-toggles/admin/configs', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      res.json({ configs: await listEffectiveConfigs() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/sample/feature-toggles/admin/configs/:id', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const config = await getEffectiveConfig(req.params.id);
      if (!config) {
        throw new OpenwopError('not_found', 'No such feature toggle.', 404, { id: req.params.id });
      }
      res.json(config);
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/sample/feature-toggles/admin/configs/:id', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const config = validateToggleConfig(req.params.id, req.body);
      const saved = await saveConfig(config, req.tenantId ?? 'admin');
      log.info('feature_toggle_saved', { id: saved.id, status: saved.status, variants: saved.variants?.length ?? 0 });
      res.json(saved);
    } catch (err) {
      next(err);
    }
  });
}
