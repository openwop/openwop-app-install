import type { Express } from 'express';
import { createLogger } from '../observability/logger.js';
import { getManagedProviderStatuses } from '../providers/managedProvider.js';
import { sessionSecretConfigError, apiKeyConfigError } from '../middleware/auth.js';
import { APP_VERSION } from '../version.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('routes.health');

/** How long the readiness storage probe waits before declaring the DB
 *  unreachable. A pool-exhausted/hung DB would otherwise let `kvGet` block
 *  indefinitely, so /readiness would hang past Cloud Run's external timeout
 *  instead of returning a fast 503 (DATA-5). Override with
 *  OPENWOP_READINESS_PROBE_TIMEOUT_MS. Read at call time so it's configurable. */
function readinessProbeTimeoutMs(): number {
  return Number(process.env.OPENWOP_READINESS_PROBE_TIMEOUT_MS) || 5_000;
}

/** Cheap storage-connectivity probe: a kv read of a non-existent key
 *  exercises the DB round-trip without side effects. Returns an error
 *  string when the read throws (dead DB / exhausted pool) or when it does
 *  not settle within the probe timeout, else null. */
export async function storageProbeError(storage: Pick<Storage, 'kvGet'>): Promise<string | null> {
  const timeoutMs = readinessProbeTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`storage probe timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    await Promise.race([storage.kvGet('__readiness_probe__'), timeout]);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerHealthRoutes(app: Express, deps: { storage?: Storage } = {}): void {
  // /health stays a PURE liveness probe ({status:'ok'}). The deploy-verifiable
  // version lives on /readiness (ADR 0052 §D4).
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness reflects downstream-dependency health, not just process
  // liveness. Today it checks managed-provider key availability: if
  // providers.json advertises a managed ("Try it free") tier but its
  // server-held key isn't seeded (dropped/unmounted secret, missing env
  // at boot), every managed call fails with `managed_unavailable`. That
  // used to be invisible until a user ran a workflow; surfacing it here
  // — HTTP 503 + a per-provider `checks.managedProviders` block — turns
  // it into a deploy-time signal a smoke test can assert on.
  //
  // Cloud Run does not probe /readiness by default (TCP startup probe on
  // the port), so a 503 here flags degradation without evicting traffic
  // or failing the revision. Storage connectivity + other downstreams
  // can join the same checks block as they're wired.
  app.get('/readiness', async (_req, res) => {
    let managedProviders: Awaited<ReturnType<typeof getManagedProviderStatuses>>;
    try {
      managedProviders = await getManagedProviderStatuses();
    } catch (err) {
      log.error('readiness check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ status: 'degraded', error: 'readiness_check_failed' });
      return;
    }
    const unconfigured = managedProviders.filter((p) => !p.ready);
    if (unconfigured.length > 0) {
      log.warn('readiness degraded — managed provider(s) advertised but unconfigured', {
        unconfigured: unconfigured.map((p) => p.providerId),
      });
    }
    // Required prod config: a cookie-mode deploy missing OPENWOP_SESSION_SECRET
    // throws on the first session-minting POST (a silent 503) while readiness
    // would otherwise 200. Surface it here so a deploy smoke test fails fast
    // instead of the health check lying (PRD §8.3 footgun).
    const configError = sessionSecretConfigError() ?? apiKeyConfigError();
    if (configError) {
      log.warn('readiness degraded — required prod config missing', { error: configError });
    }
    // Storage connectivity: a dead DB / exhausted pool used to report 200
    // here while every real request 5xx'd (DATA-3). Probe it explicitly.
    const storageError = deps.storage ? await storageProbeError(deps.storage) : null;
    if (storageError) {
      log.error('readiness degraded — storage probe failed', { error: storageError });
    }
    const ready = unconfigured.length === 0 && !configError && !storageError;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      // ADR 0052 §D4 — version-verify a deploy: the smoke test asserts this
      // matches the version it just shipped.
      version: APP_VERSION,
      checks: {
        managedProviders,
        config: configError ? { ok: false, error: configError } : { ok: true },
        storage: deps.storage ? (storageError ? { ok: false, error: storageError } : { ok: true }) : { ok: true, skipped: true },
      },
    });
  });
}
