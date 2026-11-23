/**
 * ADR 1155 P3a — the ONE upkeep sweep for every declared index (ADR 1110): unfinished
 * write intents every tick (bounded; fresh ones are left to their writers), queued
 * background builds, and once per UTC hour, fleet-wide, a drift check of every built
 * tenant of every registered type (a count mismatch queues a rebuild; every org counter
 * is recounted). Commerce and media each ran their own copy of this over the same global
 * intent and build queues; a third indexed store would have added a third. Entities is
 * core, so this runs on every deployment.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { builtTenants, checkSystemIndex, drainSystemIndexBuilds, registeredIndexTypes, repairSystemIndex } from './systemIndex.js';

const log = createLogger('features.entities.systemIndexSweep');
// `OPENWOP_MEDIA_INDEX_SWEEP_MS` set the media copy of this sweep before ADR 1155 P3a,
// so an operator's existing value is still honoured.
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_SYSTEM_INDEX_SWEEP_MS ?? process.env.OPENWOP_MEDIA_INDEX_SWEEP_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();
// Two sweeps used to drain the build queue one tenant per tick each; one sweep drains two.
const BUILDS_PER_TICK = 2;

const upkeepHour = new DurableCollection<{ k: string; hour: number }>('entity:sysidx-hour', (r) => r.k);

export async function runSystemIndexUpkeep(now = Date.now()): Promise<{ repaired: number; built: number; drifted: number }> {
  const { repaired } = await repairSystemIndex({ limit: 100, now });
  const built = await drainSystemIndexBuilds({ limit: BUILDS_PER_TICK });
  const hour = Math.floor(now / 3_600_000);
  const cur = await upkeepHour.get('hour');
  if (cur && cur.hour >= hour) return { repaired, built, drifted: 0 };
  if (!(await upkeepHour.compareAndSwap(cur, { k: 'hour', hour }))) return { repaired, built, drifted: 0 };
  let drifted = 0;
  for (const type of registeredIndexTypes()) {
    for await (const tenantId of builtTenants(type)) if (!(await checkSystemIndex(tenantId, type))) drifted += 1;
  }
  if (drifted > 0) log.warn('system_index_drift_queued', { tenants: drifted });
  return { repaired, built, drifted };
}

let started = false;
export function startSystemIndexSweep(): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await runSystemIndexUpkeep();
      if (r.repaired > 0 || r.built > 0 || r.drifted > 0) log.info('system index upkeep', r);
    } catch (err) {
      log.warn('system index sweep tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => { clearInterval(timer); started = false; } };
}
