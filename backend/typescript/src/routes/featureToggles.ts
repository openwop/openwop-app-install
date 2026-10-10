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
 *   GET /admin/configs/:id/history  the toggle's change audit       [superadmin]
 *   PUT /admin/configs/:id        upsert a toggle config            [superadmin]
 *                                 (409 conflict when a disable would orphan a dependent)
 *   DELETE /admin/configs/:id     revert to the code default        [superadmin]
 *
 * ADR 0819 §5 — optimistic concurrency. The admin projection carries
 * `revision`; a PUT whose body carries it (or a DELETE with `?revision=`) is
 * refused `409 { reason: 'revision_conflict' }` when the stored row moved
 * since it was read. A write that omits it is last-writer-wins, kept for
 * scripts; the admin panel always sends it. ADR 0819 §4 — every write appends
 * one `feature-toggle.*` row to the audit log, naming the acting PERSON.
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
  listAdminConfigs,
  resolveAssignments,
  resolveToggle,
  saveConfig,
  deleteConfig,
  getAdminConfig,
  getStoredConfig,
} from '../host/featureToggles/service.js';
import { listToggleChanges, recordToggleChange } from '../host/featureToggles/audit.js';
import { validateToggleConfig } from '../host/featureToggles/validate.js';
import { getToggleDefault } from '../host/featureToggles/registry.js';
import type { ToggleSubject } from '../host/featureToggles/types.js';
import { requireSuperadmin as requireSuperadminShared } from '../host/superadmin.js';
import { contextEconomy } from '../host/contextEconomy.js';

const log = createLogger('routes.featureToggles');

/** One literal for the whole surface (the ADR 0652 canonical `/host/openwop-app`
 *  root rewrites onto it), so a new route adds no `/v1/` call site. */
const BASE = '/host/openwop-app/feature-toggles';

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

/** ADR 0819 §4 — the acting PERSON for `updatedBy` and the audit row. It used
 *  to be `req.tenantId`, which names a workspace, not who flipped the switch. */
function actorOf(req: Request): string {
  return req.principal?.principalId ?? req.tenantId ?? 'admin';
}

/** The optional revision precondition: a string, or JSON `null` meaning "I saw
 *  no stored row". `undefined` = the caller sent none (last-writer-wins). */
function expectedRevisionOf(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === 'null') return null;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  throw new OpenwopError('validation_error', 'Field `revision` MUST be a string or null.', 400, { field: 'revision' });
}

export function registerFeatureToggleRoutes(app: Express): void {
  // ── Caller assignments (read-only mirror; any authenticated caller) ──
  // BY DESIGN this returns every toggle's resolved state (incl. `off`) for the
  // caller — the FE needs to know a feature exists-but-disabled to render its
  // "not enabled" state and to gate nav. Only toggle ids + the caller's own
  // resolved status/variant/bindings are exposed; cohorts, per-tenant overrides,
  // and other tenants' assignments never appear here (that's the admin surface).
  app.get(`${BASE}/assignments`, async (req, res, next) => {
    try {
      res.json({ assignments: await resolveAssignments(subjectOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/assignments/:id`, async (req, res, next) => {
    try {
      // ADR 0819 §1 — the TOGGLE, like the bulk map above: the FE renders a
      // plan-locked feature as its upgrade state, which it cannot do if the
      // feature reads as absent.
      const assignment = await resolveToggle(req.params.id, subjectOf(req));
      if (!assignment) {
        throw new OpenwopError('not_found', 'No such feature toggle.', 404, { id: req.params.id });
      }
      res.json(assignment);
    } catch (err) {
      next(err);
    }
  });

  // ── Admin (superadmin only) ──
  app.get(`${BASE}/admin/configs`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      res.json({ configs: await listAdminConfigs() });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/admin/configs/:id`, async (req, res, next) => {
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

  app.get(`${BASE}/admin/configs/:id/history`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      if (!getToggleDefault(req.params.id)) {
        throw new OpenwopError('not_found', 'No such feature toggle.', 404, { id: req.params.id });
      }
      res.json({ changes: await listToggleChanges(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  // The Plugins-console projection (ADR 0194 Phase 2): per feature — dependency
  // graph + live disable-lock + declared packs with on-disk presence. A projection
  // over the boot registries + effective toggle state + the pack dir (no stored
  // model); powers the admin console's Off-lock, "required by …", and pack badges.
  // (Renamed from Phase 1's /admin/dependencies — same-repo lockstep consumer only.)
  app.get(`${BASE}/admin/features`, async (req, res, next) => {
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
  app.get(`${BASE}/admin/env-governed`, (req, res, next) => {
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

  app.put(`${BASE}/admin/configs/:id`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      // A toggle with no declared default is not a toggle: saving one wrote an
      // orphan row that boot pruning later deleted (ADR 0819 hygiene).
      if (!getToggleDefault(req.params.id)) {
        throw new OpenwopError('not_found', 'No such feature toggle.', 404, { id: req.params.id });
      }
      const config = validateToggleConfig(req.params.id, req.body);
      const expectedRevision = expectedRevisionOf((req.body as Record<string, unknown> | undefined)?.revision);
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
      const before = await getStoredConfig(config.id);
      const saved = await saveConfig(config, actorOf(req), { ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
      log.info('feature_toggle_saved', { id: saved.id, status: saved.status, killed: saved.killed === true, variants: saved.variants?.length ?? 0 });
      const after = await getStoredConfig(config.id);
      await recordToggleChange({ action: 'feature-toggle.saved', id: config.id, principalId: actorOf(req), actingTenantId: req.tenantId ?? 'default', before, after });
      // Echo the new revision so the panel can keep editing without a re-read.
      res.json((await getAdminConfig(config.id)) ?? saved);
    } catch (err) {
      next(err);
    }
  });

  // Revert to the code default (architect 2026-07-13, finding 2): deletes the
  // stored override so the compiled `toggleDefault` governs again — the GA
  // cleanup step as one audited call instead of psql row surgery. The same
  // disable-lock gate as PUT applies when the revert would turn the feature OFF.
  app.delete(`${BASE}/admin/configs/:id`, async (req, res, next) => {
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
      const before = await getStoredConfig(req.params.id);
      const expectedRevision = expectedRevisionOf(req.query.revision);
      const reverted = await deleteConfig(req.params.id, actorOf(req), { ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
      if (!reverted) {
        throw new OpenwopError('not_found', 'No stored override to delete — the toggle already follows its code default.', 404, { id: req.params.id });
      }
      await recordToggleChange({ action: 'feature-toggle.reverted', id: req.params.id, principalId: actorOf(req), actingTenantId: req.tenantId ?? 'default', before, after: null });
      res.json({ ...reverted, overridden: false, defaultDrift: false, revision: null });
    } catch (err) {
      next(err);
    }
  });
}
