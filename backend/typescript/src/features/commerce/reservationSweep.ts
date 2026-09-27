/**
 * Commerce reservation-expiry sweep (gap plan §5C C5) — the cms `publishSweep`
 * clone: a feature-owned, bounded, unref'd interval started from the feature's
 * own registerRoutes (idempotent guard). Auto-cancels pending orders whose
 * stock reservation deadline passed, releasing inventory through the normal
 * service path (cancelOrder → CAS restore + movement + audit + host event).
 * No new scheduler primitive; `scheduleDaemon` stays cron-cadence workflow
 * starts only (the publishSweep ruling).
 */
import { createLogger } from '../../observability/logger.js';
import { purgeStaleGuestShipping, sweepExpiredReservations } from './commerceService.js';

const log = createLogger('commerce.reservationSweep');
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_COMMERCE_RESERVATION_SWEEP_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

let started = false;
export interface CommerceReservationSweep { stop: () => void }

export function startCommerceReservationSweep(): CommerceReservationSweep | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const released = await sweepExpiredReservations();
      if (released > 0) log.info('expired reservations released', { released });
      // R3 I1 — guest shipping snapshots age out on the same tick (bounded;
      // retention is the backstop for PII no DSAR key can reach).
      const purged = await purgeStaleGuestShipping();
      if (purged > 0) log.info('stale guest shipping anonymized', { purged });
    } catch (err) {
      log.warn('reservation sweep tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('commerce reservation sweep started', { pollMs: POLL_MS });
  return { stop: () => { clearInterval(timer); started = false; } };
}
