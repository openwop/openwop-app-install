/**
 * #5928 — the media indexes' own sweep: the catalog-index sweep's shape (feature-owned,
 * bounded, unref'd interval, idempotent start). It repairs unfinished index intents,
 * runs queued background builds, and runs the hourly counter drift check
 * (`repairMediaIndex`). Media is always-on (ADR 0027), so this runs on every deployment,
 * commerce or not.
 */
import { createLogger } from '../../observability/logger.js';
import { repairMediaIndex } from './mediaService.js';

const log = createLogger('features.media.indexSweep');
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_MEDIA_INDEX_SWEEP_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

let started = false;
export function startMediaIndexSweep(): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await repairMediaIndex();
      if (r.repaired > 0 || r.built > 0 || r.drifted > 0) log.info('media index upkeep', r);
    } catch (err) {
      log.warn('media index sweep tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => { clearInterval(timer); started = false; } };
}
