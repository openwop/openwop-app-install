/**
 * ADR 1110 (round fix) — the catalog and order indexes' own sweep: the reservation-sweep
 * shape (feature-owned, bounded, unref'd interval, idempotent start), kept separate so a
 * long background build never holds up the release of expired reservations.
 */
import { createLogger } from '../../observability/logger.js';
import { repairCatalogIndex } from './commerceService.js';

const log = createLogger('commerce.catalogIndexSweep');
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_COMMERCE_INDEX_SWEEP_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

let started = false;
export function startCatalogIndexSweep(): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await repairCatalogIndex();
      if (r.repaired > 0 || r.built > 0 || r.drifted > 0) log.info('catalog index upkeep', r);
    } catch (err) {
      log.warn('catalog index sweep tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => { clearInterval(timer); started = false; } };
}
