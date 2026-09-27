/**
 * Feature-toggle host-extension routes (NON-NORMATIVE).
 *
 * Backend is the authority (ADR §3.4) — resolution runs server-side from the
 * authenticated principal, and the FE consumes a read-only assignments map.
 * Surface under /v1/host/openwop-app/feature-toggles:
 *
 *   GET /assignments              resolve EVERY toggle for the caller   [authed]
 *   GET /assignments/:id          resolve one toggle for the caller     [authed]
 *   GET /admin/configs            list every effective config       [superadmin]
 *   GET /admin/features           Plugins console: deps + lock + packs [superadmin]
 *   GET /admin/env-governed       read-only env-governed capabilities  [superadmin]
 *   PUT /admin/configs/:id        upsert a toggle config            [superadmin]
 *                                 (409 conflict when a disable would orphan a dependent)
 *
 * Superadmin gate (`requireSuperadmin`): a wildcard bearer principal (`*` — the
 * conformance/admin API key) OR a tenant listed in OPENWOP_SUPERADMIN_TENANTS.
 * Dev convenience is an EXPLICIT opt-in: set OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true
 * to treat any authenticated caller as superadmin (so the admin screen works
 * locally without an allowlist). The gate FAILS CLOSED by default — a deploy
 * that forgets the allowlist is never world-writable, regardless of NODE_ENV.
 *
 * NOTE: deliberately NOT mounted under /v1/host/openwop-app/admin (which bypasses
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
  buildFeatureConsole,
  computeDisableBlockers,
  listEffectiveConfigs,
  resolveAssignments,
  resolveOne,
  saveConfig,
  deleteConfig,
  getAdminConfig,
} from '../host/featureToggles/service.js';
import { validateToggleConfig } from '../host/featureToggles/validate.js';
import { getToggleDefault } from '../host/featureToggles/registry.js';
import type { ToggleSubject } from '../host/featureToggles/types.js';
import { requireSuperadmin as requireSuperadminShared } from '../host/superadmin.js';
import { contextEconomy } from '../host/contextEconomy.js';

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
  app.get('/v1/host/openwop-app/feature-toggles/assignments', async (req, res, next) => {
    try {
      res.json({ assignments: await resolveAssignments(subjectOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/feature-toggles/assignments/:id', async (req, res, next) => {
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
  app.get('/v1/host/openwop-app/feature-toggles/admin/configs', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      res.json({ configs: await listEffectiveConfigs() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/feature-toggles/admin/configs/:id', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      // Admin projection (architect 2026-07-13, finding 3): effective config +
      // provenance — `overridden` (a stored row pins it) and `defaultDrift`
      // (the compiled default changed under the pin).
      const config = await getAdminConfig(req.params.id);
      if (!config) {
        throw new OpenwopError('not_found', 'No such feature toggle.', 404, { id: req.params.id });
      }
      res.json(config);
    } catch (err) {
      next(err);
    }
  });

  // The Plugins-console projection (ADR 0194 Phase 2): per feature — dependency
  // graph + live disable-lock + declared packs with on-disk presence. A projection
  // over the boot registries + effective toggle state + the pack dir (no stored
  // model); powers the admin console's Off-lock, "required by …", and pack badges.
  // (Renamed from Phase 1's /admin/dependencies — same-repo lockstep consumer only.)
  app.get('/v1/host/openwop-app/feature-toggles/admin/features', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      res.json({ features: await buildFeatureConsole() });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0434 — ENV-GOVERNED host capabilities: read-only, never flippable.
  // `context-economy` used to register a toggle purely "for visibility", but the
  // dispatch layer is tenant-agnostic and reads `OPENWOP_CONTEXT_ECONOMY*`
  // directly, so the switch gated nothing — an admin could flip it and observe
  // no effect. A lying switch is worse than no switch, and worse than an honest
  // read-only row: the operator lever is the deploy env, so the console reports
  // the resolved env state instead of pretending to own it. Additive by design —
  // future env-only capabilities append here rather than minting inert toggles.
  app.get('/v1/host/openwop-app/feature-toggles/admin/env-governed', (req, res, next) => {
    try {
      requireSuperadmin(req);
      const ce = contextEconomy();
      res.json({
        capabilities: [
          {
            id: 'context-economy',
            label: 'Context economy',
            description:
              'Token-efficiency for host-internal context assembly — provider prompt caching, tool-surface diet, transcript + memory budgets, transport economy (ADR 0148, Tier A).',
            envVar: 'OPENWOP_CONTEXT_ECONOMY',
            enabled: ce.enabled,
            levers: [
              { id: 'providerCache', envVar: 'OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE', enabled: ce.providerCache },
              { id: 'toolDiet', envVar: 'OPENWOP_CONTEXT_ECONOMY_TOOL_DIET', enabled: ce.toolDiet },
              { id: 'transcriptBudget', envVar: 'OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT', enabled: ce.transcriptBudget },
              { id: 'memoryBudget', envVar: 'OPENWOP_CONTEXT_ECONOMY_MEMORY', enabled: ce.memoryBudget },
              { id: 'transport', envVar: 'OPENWOP_CONTEXT_ECONOMY_TRANSPORT', enabled: ce.transport },
            ],
          },
        ],
      });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/feature-toggles/admin/configs/:id', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const config = validateToggleConfig(req.params.id, req.body);
      // ADR 0194 disable-lock: refuse to turn a feature OFF while an enabled feature
      // hard-depends on it (would orphan the dependent). Backend is the authority —
      // the FE pre-gates the Off control, but this is the enforced boundary.
      const blockers = await computeDisableBlockers(config);
      if (blockers.length > 0) {
        // Unique dependent ids (back-compat) + per-scope detail (ADR 0194 Phase 5).
        const dependents = [...new Set(blockers.map((b) => b.dependentId))].sort();
        const scopes = blockers
          .map((b) => (b.tenantId ? `${b.dependentId} (workspace ${b.tenantId})` : b.dependentId))
          .sort();
        throw new OpenwopError(
          'conflict',
          `Cannot disable "${config.id}" — it is required by enabled feature(s): ${scopes.join(', ')}. Disable them first.`,
          409,
          { id: config.id, dependents, blockers },
        );
      }
      const saved = await saveConfig(config, req.tenantId ?? 'admin');
      log.info('feature_toggle_saved', { id: saved.id, status: saved.status, variants: saved.variants?.length ?? 0 });
      res.json(saved);
    } catch (err) {
      next(err);
    }
  });

  // Revert to the code default (architect 2026-07-13, finding 2): deletes the
  // stored override so the compiled `toggleDefault` governs again — the GA
  // cleanup step as one audited call instead of psql row surgery. The same
  // disable-lock gate as PUT applies when the revert would turn the feature OFF.
  app.delete('/v1/host/openwop-app/feature-toggles/admin/configs/:id', async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const def = getToggleDefault(req.params.id);
      if (!def) {
        throw new OpenwopError('not_found', 'No such feature toggle.', 404, { id: req.params.id });
      }
      if (def.status === 'off') {
        const blockers = await computeDisableBlockers(def);
        if (blockers.length > 0) {
          const dependents = [...new Set(blockers.map((b) => b.dependentId))].sort();
          throw new OpenwopError(
            'conflict',
            `Cannot revert "${def.id}" to its (off) code default — it is required by enabled feature(s): ${dependents.join(', ')}. Disable them first.`,
            409,
            { id: def.id, dependents },
          );
        }
      }
      const reverted = await deleteConfig(req.params.id, req.tenantId ?? 'admin');
      if (!reverted) {
        throw new OpenwopError('not_found', 'No stored override to delete — the toggle already follows its code default.', 404, { id: req.params.id });
      }
      res.json({ ...reverted, overridden: false, defaultDrift: false });
    } catch (err) {
      next(err);
    }
  });
}
