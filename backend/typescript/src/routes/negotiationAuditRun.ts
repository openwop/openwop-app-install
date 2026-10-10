/**
 * ADR 0858 P4 — the run the §22/§23 invoke seams record `negotiation.decided` on.
 *
 * In production a version negotiation happens inside a run (a node calling
 * `ctx.a2a.*` / `ctx.mcp.*`), and the executor hands the client a recorder that
 * appends to that run's log. The invoke seams drive the SAME client with no run
 * behind them, so the corpus (`v2-negotiation-decided-emitted`,
 * `v2-minimum-version-refused`, `v2-negotiation-authenticated`) asks the seam to
 * name "the run whose log recorded the decision" — and reads it on the normative
 * `GET /runs/{runId}/events/poll`.
 *
 * This plants that run and supplies the recorder. The seam does not write the
 * event itself: the CLIENT's negotiation code calls the recorder at each
 * outcome, exactly as it calls the executor's in production, so the event the
 * suite reads is the production emitter's output (non-vacuity, §22/§23).
 *
 * Test-seam only (callers are env-gated on `OPENWOP_TEST_SEAM_ENABLED`). The run
 * is marked `seededBy: 'conformance-seam'` like every other seam-planted run, is
 * owned by the caller's tenant, and is `completed`: it stands for a run, it never
 * executes.
 */
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { toWireRunId } from '../host/v2Ids.js';
import { NEGOTIATION_DECIDED_EVENT, type NegotiationRecorder } from '../host/negotiationDecided.js';

export const NEGOTIATION_AUDIT_WORKFLOW_ID = 'sample.negotiation-audit';

export async function plantNegotiationAuditRun(
  storage: Storage,
  tenantId: string,
): Promise<{ wireRunId: string; record: NegotiationRecorder }> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId,
    workflowId: NEGOTIATION_AUDIT_WORKFLOW_ID,
    tenantId,
    status: 'completed',
    inputs: {},
    metadata: { seededBy: 'conformance-seam', purpose: 'negotiation-audit' },
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  const record: NegotiationRecorder = async (payload) => {
    await storage.appendEvent({
      eventId: randomUUID(),
      runId,
      type: NEGOTIATION_DECIDED_EVENT,
      payload: { ...payload },
      timestamp: payload.at,
    });
  };
  return { wireRunId: toWireRunId(runId, tenantId), record };
}
