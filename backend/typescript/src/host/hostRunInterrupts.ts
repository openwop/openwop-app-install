/**
 * ADR 1005 D14 — a hand-off for interrupts on HOST-OWNED runs.
 *
 * A host-owned run is one the host inserts itself and never executes (the RFC
 * 0254 deployment-management run). When such a run suspends on an RFC 0051
 * interrupt, the ordinary resolve route still owns every check and the CAS
 * claim, but it cannot resume the run through the executor: there is no
 * definition to resume. So the route consults this registry, keyed by the run's
 * `workflowId`:
 *
 *   - `authorize` runs BEFORE the claim and may throw; a refusal leaves the
 *     interrupt open for someone else.
 *   - `onResolved` runs AFTER the claim is won and `interrupt.resolved` is
 *     recorded, INSTEAD of the executor resume. Every outcome reaches it: an
 *     accept, a reject and the timeout sweep's rejection.
 *   - `onCancelled` runs after a cancel closed the run's gates without a
 *     decision (`host/runCancel.ts`), so the handler can release what it held.
 *
 * The route stays feature-blind (ADR 0001): a feature registers its handler
 * from `registerRoutes`. A `workflowId` with no handler behaves as before.
 */

import type { InterruptRecord, RunRecord } from '../types.js';

export interface HostRunInterruptHandler {
  /** Throw to refuse this decision before anything is claimed. `decidedBy` is
   *  the resolving user, absent on a lane with no identity (a bare token). */
  authorize(input: { run: RunRecord; interrupt: InterruptRecord; resumeValue: unknown; decidedBy?: string }): Promise<void>;
  /** The claim is won. `rejection` is set for a reject or a timeout. */
  onResolved(input: { run: RunRecord; interrupt: InterruptRecord; resumeValue: unknown; rejection?: { code: string; message: string } }): Promise<void>;
  /** The run was cancelled (its gates closed without a decision): release what it held. */
  onCancelled(input: { run: RunRecord }): Promise<void>;
}

const handlers = new Map<string, HostRunInterruptHandler>();

export function registerHostRunInterruptHandler(workflowId: string, handler: HostRunInterruptHandler): void {
  handlers.set(workflowId, handler);
}

export function hostRunInterruptHandler(workflowId: string | undefined): HostRunInterruptHandler | undefined {
  return workflowId === undefined ? undefined : handlers.get(workflowId);
}

/** Never forkable, resumable or pausable: the run stands for an operation, not a graph. */
export function isHostManagedRun(run: Pick<RunRecord, 'workflowId'>): boolean {
  return handlers.has(run.workflowId);
}
