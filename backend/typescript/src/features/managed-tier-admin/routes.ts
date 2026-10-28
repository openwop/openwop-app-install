/**
 * ADR 0990 — free-tier provider setting routes (superadmin only, host-extension).
 *
 *   GET    /host/openwop-app/managed-tier/settings        → saved row, what serves, key readiness
 *   PUT    /host/openwop-app/managed-tier/settings        → save (409 when the provider has no key)
 *   DELETE /host/openwop-app/managed-tier/settings        → back to the env default
 *   POST   /host/openwop-app/managed-tier/settings/test   → one bounded call to a candidate
 *
 * Non-normative host-extension namespace, so no RFC. No route accepts or returns
 * a key: keys go in the Secrets Vault (D3).
 */
import { createLogger } from '../../observability/logger.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { OpenwopError } from '../../types.js';
import { testManagedTierCandidate } from '../../providers/managedProvider.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { clearConfig, getView, saveConfig, validateConfig } from './service.js';

const log = createLogger('features.managedTierAdmin');
const BASE = '/host/openwop-app/managed-tier/settings';

/** A test message is a real paid call: at most one per tenant per this window. */
const TEST_COOLDOWN_MS = 3_000;
const lastTestAt = new Map<string, number>();

export function registerManagedTierAdminRoutes(deps: RouteDeps): void {
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
      const saved = await saveConfig(validateConfig(req.body), req.tenantId ?? 'admin');
      log.info('managed_tier_saved', { provider: saved.provider, model: saved.model, dailyTokenCap: saved.dailyTokenCap });
      res.json(await getView());
    } catch (err) {
      next(err);
    }
  });

  app.delete(BASE, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      await clearConfig();
      log.info('managed_tier_cleared', {});
      res.json(await getView());
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/test`, async (req, res, next) => {
    try {
      requireSuperadmin(req);
      const tenantId = req.tenantId ?? 'admin';
      const now = Date.now();
      const last = lastTestAt.get(tenantId) ?? 0;
      if (now - last < TEST_COOLDOWN_MS) {
        res.setHeader('Retry-After', String(Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000)));
        throw new OpenwopError('rate_limited', 'Wait a few seconds before sending another test message.', 429);
      }
      const candidate = validateConfig(req.body);
      lastTestAt.set(tenantId, now);
      const result = await testManagedTierCandidate({ provider: candidate.provider, model: candidate.model, tenantId });
      log.info('managed_tier_tested', { provider: result.provider, model: result.model, ok: result.ok, ...(result.ok ? {} : { code: result.code }) });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });
}
