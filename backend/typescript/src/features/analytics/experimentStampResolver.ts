/**
 * ANLWF-3 / ADR 0651 D3 — the ingest-side experiment-stamp seam.
 *
 * The beacon is unauthenticated, so its `experiment.variant` is a CLAIM: an
 * anonymous caller could place conversions on a variant no visitor was ever
 * assigned. Analytics therefore reads only the client's `id` and asks the OWNER
 * of experiments (the cms feature, which registers a resolver at boot) for the
 * deterministic assignment of THIS session. Analytics never imports cms (the
 * feature-dependency direction is cms → analytics, ADR 0446), hence a seam.
 *
 * ANL-21 (grade-code 2026-09-10) — a drop is a TYPED OUTCOME, never a bare `null`:
 * the reason rides the event row (`experimentDropped`) so the results projection
 * can say how many stamps it did NOT count, and every drop is logged. The
 * `id` on a dropped outcome is set ONLY when the experiment is known to this
 * tenant+org — a client-fabricated id never reaches durable state.
 */
import { createLogger } from '../../observability/logger.js';

const log = createLogger('analytics.experimentStamp');

export type ExperimentStampDropReason =
  | 'unknown'        // no experiment with this id in this tenant+org
  | 'not_running'    // known, but draft/promoted — never assigned this session
  | 'no_session'     // the beacon carried no sessionKey, so nothing to assign
  | 'no_resolver'    // cms not booted / stripped from this bundle
  | 'resolver_error'; // the owner threw — an unreadable experiment is not a stamp

export type ExperimentStampOutcome =
  | { ok: true; id: string; variant: string }
  | { ok: false; reason: ExperimentStampDropReason; id?: string };

export type ExperimentStampResolver = (
  tenantId: string, orgId: string, experimentId: string, sessionKey: string,
) => Promise<ExperimentStampOutcome>;

let resolver: ExperimentStampResolver | null = null;

/** Called once from the cms feature's boot path. Last registration wins. */
export function registerExperimentStampResolver(fn: ExperimentStampResolver): void {
  resolver = fn;
}

/** Re-derive the stamp for THIS session. Never throws; never trusts the client. */
export async function resolveExperimentStamp(
  tenantId: string, orgId: string, experimentId: string, sessionKey: string,
): Promise<ExperimentStampOutcome> {
  if (!sessionKey) return { ok: false, reason: 'no_session' };
  if (!experimentId) return { ok: false, reason: 'unknown' };
  if (!resolver) {
    log.warn('analytics_experiment_stamp_dropped', { tenantId, orgId, reason: 'no_resolver' });
    return { ok: false, reason: 'no_resolver' };
  }
  try {
    const out = await resolver(tenantId, orgId, experimentId, sessionKey);
    if (!out.ok) log.info('analytics_experiment_stamp_dropped', { tenantId, orgId, reason: out.reason, ...(out.id ? { experimentId: out.id } : {}) });
    return out;
  } catch (e) {
    log.error('analytics_experiment_stamp_dropped', { tenantId, orgId, reason: 'resolver_error', error: e instanceof Error ? e.message : String(e) });
    return { ok: false, reason: 'resolver_error' };
  }
}
