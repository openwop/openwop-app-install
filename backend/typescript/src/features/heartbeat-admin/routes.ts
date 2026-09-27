/**
 * ADR 0318 — heartbeat admin settings routes (superadmin only, host-extension).
 *
 *   GET  /v1/host/openwop-app/heartbeat/settings   → saved config + live effective state
 *   PUT  /v1/host/openwop-app/heartbeat/settings   → upsert (validated)
 *
 * Non-normative host-extension namespace — never touches the OpenWOP wire, so no
 * RFC. Gated by `requireSuperadmin` exactly like feature-toggles / navigation-settings.
 */
import { createLogger } from '../../observability/logger.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { getView, saveConfig, validateConfig } from './service.js';

const log = createLogger('features.heartbeatAdmin');
const BASE = '/v1/host/openwop-app/heartbeat/settings';

export function registerHeartbeatAdminRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      res.json(await getView());
    } catch (err) {
      next(err);
    }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const config = validateConfig(req.body);
      const saved = await saveConfig(config, req.tenantId ?? 'admin');
      log.info('heartbeat_admin_saved', {
        status: saved.status,
        hostDefaultIntervalMs: saved.hostDefaultIntervalMs,
        enabledUntil: saved.enabledUntil,
        runBudgetPerHour: saved.runBudgetPerHour,
      });
      res.json(await getView());
    } catch (err) {
      next(err);
    }
  });
}
