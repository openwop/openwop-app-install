/**
 * ADR 0462 Phase 3 — the STALE WEARABLE STREAM exception source (the fifth ADR 0460
 * exception source, deferred there for want of an honest staleness signal — now
 * unblocked by the P3 liveness clock).
 *
 * A stream is an exception ONLY when it WAS reporting and went quiet AND it is still
 * expected to report — the honest join that avoids the false positives ADR 0460 named:
 *   - a durable `lastReadingAt` older than STALE_WEARABLE_MS (it reported, then quiet;
 *     a never-reporting device has no row and never fires), AND
 *   - a LIVE `wearable-evidence` consent (a revoked consent legitimately stops readings
 *     — expected, not an exception), AND
 *   - an ACTIVE enrollment (a completed/withdrawn enrollment stops readings — expected).
 */
import { registerExceptionSource, type ExceptionRow } from '../../host/exceptionProjection.js';
import { listStaleWearableStreams } from './wearableLivenessService.js';
import { liveConsent } from './integrationService.js';
import { listEnrollmentsFor } from '../kicktodo-core/enrollmentService.js';

const SOURCE_KEY = 'kicktodo:wearable-stale';
/** Default 48h — operator-tunable via env; a stream quiet longer than this, while
 *  still consented + enrolled, needs attention. */
function staleMs(): number {
  const h = Number(process.env.OPENWOP_WEARABLE_STALE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 48) * 3_600_000;
}

async function staleWearableExceptionSource(tenantId: string): Promise<ExceptionRow[]> {
  if (!tenantId) return [];
  const rows: ExceptionRow[] = [];
  for (const s of await listStaleWearableStreams(tenantId, staleMs())) {
    // Honest join — skip the two expected-quiet cases (revoked consent / no active enrollment).
    if (!(await liveConsent(tenantId, s.ownerSubject, 'wearable-evidence'))) continue;
    const active = (await listEnrollmentsFor(tenantId, s.ownerSubject)).some((e) => e.state === 'active');
    if (!active) continue;
    rows.push({
      id: `wearable-stale:${s.ownerSubject}`,
      source: SOURCE_KEY,
      severity: 'attention',
      label: `A consented wearable stream has gone quiet (last reading ${s.lastReadingAt}).`,
      owner: { kind: 'user', ref: s.ownerSubject, label: 'participant' },
      action: { labelKey: 'exceptionActionOpen', href: '/admin/kicktodo/connections' },
      audit: { detectedAt: s.lastReadingAt, tenantId },
    });
  }
  return rows;
}

export function registerKicktodoWearableStaleExceptionSource(): void {
  registerExceptionSource(SOURCE_KEY, staleWearableExceptionSource);
}
