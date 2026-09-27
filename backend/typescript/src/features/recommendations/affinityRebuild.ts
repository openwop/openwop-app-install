/**
 * Recommendations affinity-rebuild sweep (ADR 0273 / MERCH-A) — the
 * `reservationSweep` clone: a feature-owned, bounded, unref'd interval started
 * from the feature's `registerRoutes` (idempotent guard). Rebuilds the derived
 * co-occurrence + trending cache from `Order` lines for every org with an active
 * placement. No new scheduler primitive.
 */
import { createLogger } from '../../observability/logger.js';
import { rebuildAllAffinity } from './recommendationsService.js';

const log = createLogger('recommendations.affinity');
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_RECO_AFFINITY_REBUILD_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 6 * 60 * 60 * 1000; // default 6h
})();

let started = false;
export interface AffinitySweep { stop: () => void }

export function startRecoAffinitySweep(): AffinitySweep | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const rows = await rebuildAllAffinity();
      if (rows > 0) log.info('reco affinity rebuilt', { rows });
    } catch (err) {
      log.warn('reco affinity rebuild failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  // R3 M4 — an immediate first tick: a 6h setInterval has no tick at start,
  // and under Cloud Run cpu-throttling the first interval may never fire —
  // so a fresh instance served STALE affinity for its whole life.
  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('reco affinity sweep started', { pollMs: POLL_MS });
  return { stop: () => { clearInterval(timer); started = false; } };
}
