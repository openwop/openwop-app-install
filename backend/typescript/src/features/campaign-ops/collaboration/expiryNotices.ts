/**
 * ADR 0958 D7 / P5 — the expiry-notice tick: a feature-owned, unref'd interval
 * started from the collaboration routes (the cms `publishSweep` and commerce
 * reservation-sweep shape; no new scheduler primitive). Each tick runs
 * `notifyExpiringGrants`, which claims every grant by CAS before it announces
 * it, so running on several instances, or more often than daily, sends each
 * notice once.
 */
import { createLogger } from '../../../observability/logger.js';
import { runUnderWorkerContract } from '../../../storage/eventEraAdapter.js';
import { notifyExpiringGrants } from '../../../host/externalCollaborators.js';

const log = createLogger('campaign-ops.collab.expiryNotices');
const POLL_MS = (() => {
  const raw = Number(process.env.OPENWOP_COLLAB_EXPIRY_NOTICE_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 60 * 60_000;
})();

let started = false;

/** `collaborationOn` is the routes' `collabEnabledFor` (passed in, so this
 *  module does not import the routes that start it). */
export function startCollaboratorExpiryNotices(collaborationOn: (tenantId: string) => Promise<boolean>): { stop: () => void } | null {
  if (started) return null;
  started = true;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await notifyExpiringGrants(new Date(), collaborationOn);
      if (r.notified > 0 || r.failed > 0) log.info('collab_expiry_notices', r);
    } catch (err) {
      log.warn('collab_expiry_notice_tick_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => { clearInterval(timer); started = false; } };
}
