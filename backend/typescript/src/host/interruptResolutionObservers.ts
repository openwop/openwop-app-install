/**
 * ADR 0853 D5 — the seam a feature uses to hear that a PERSON resolved a run
 * interrupt (an approval gate or a clarification), without core importing the
 * feature. Called from `resolveAndResume` (routes/interrupts.ts) after the
 * winning claim and its `interrupt.resolved` row — never for a lost claim, a
 * timeout, a cancel cascade or a timer.
 *
 * Fail-soft: an observer that throws is logged and skipped; the resolution and
 * the run's resume never depend on it. Observers must be idempotent on
 * `interruptId` (a retried resolve can announce twice).
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.interruptResolutionObservers');

export interface InterruptResolved {
  runId: string;
  interruptId: string;
  kind: string;
  outcome: 'accepted' | 'rejected';
  /** The interrupt's own data (an approval's `prompt`, a clarification's `question`). */
  data: unknown;
  /** What the person sent (a clarification's answer, an approval's action). */
  resumeValue: unknown;
  /** The resolving person's subject ref, when known. */
  decidedBy?: string;
}

type Observer = (e: InterruptResolved) => Promise<void>;
const observers: Observer[] = [];

export function registerInterruptResolutionObserver(fn: Observer): void {
  observers.push(fn);
}

export async function notifyInterruptResolved(e: InterruptResolved): Promise<void> {
  for (const fn of observers) {
    try {
      await fn(e);
    } catch (err) {
      log.warn('interrupt_resolution_observer_failed', { kind: e.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
