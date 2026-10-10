/**
 * ADR 0829 × ADR 0831 P3 — the seam a feature uses to hear that a structured
 * handoff record was written, without core importing the feature.
 *
 * Core calls `notifyHandoffRecorded` at the three places a record is written
 * (a `core.dispatch` handoff, a confidence-floor escalation, a person's note on
 * a card assignment). Observers are FAIL-SOFT: one that throws is logged and
 * skipped, so a downstream consumer can never fail the assignment or the run
 * that produced the record. Observers must be idempotent on `origin.ref`: the
 * same record can be announced again on a retry or a replayed node.
 */
import { createLogger } from '../../observability/logger.js';
import type { HandoffRecordV1 } from './handoffRecord.js';

const log = createLogger('host.handoffObservers');

export type HandoffOrigin =
  /** Written by a run. `ref` is unique per record within the run. */
  | { kind: 'run'; runId: string; ref: string; agentId?: string }
  /** Written by a person assigning a card. `ref` is unique per note. */
  | { kind: 'card'; cardId: string; boardId: string; ref: string; by: string };

export interface HandoffRecorded {
  tenantId: string;
  record: HandoffRecordV1;
  origin: HandoffOrigin;
}

type Observer = (e: HandoffRecorded) => Promise<void>;
const observers: Observer[] = [];

export function registerHandoffObserver(fn: Observer): void {
  observers.push(fn);
}

export async function notifyHandoffRecorded(e: HandoffRecorded): Promise<void> {
  for (const fn of observers) {
    try {
      await fn(e);
    } catch (err) {
      log.warn('handoff_observer_failed', { tenantId: e.tenantId, origin: e.origin.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
