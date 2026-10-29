/**
 * Starts the `campaign-ops.change-request` chain for one request version
 * through the ONE run starter (budget cap, plan run limit, durable dispatch).
 *
 * The run acts for nobody: the route has already authorized the operator on the
 * client org, and that operator is stamped as the run's CAUSE
 * (`orgScopeSubject`, ADR 0832 D3), which narrows what the run may reach. The
 * campaign-ops stamp binds the run to one client (ADR 0921 D3).
 */
import { randomUUID } from 'node:crypto';
import type { Storage } from '../../storage/storage.js';
import type { HostAdapterSuite } from '../../host/index.js';
import { startWorkflowRun } from '../../host/runStarter.js';
import { OpenwopError } from '../../types.js';
import { CAMPAIGN_OPS_RUN_STAMP } from './surface.js';
import { attachRun } from './requestService.js';

export const CHANGE_REQUEST_CHAIN_ID = 'campaign-ops.change-request';

export async function startChangeRequestRun(
  deps: { storage: Storage; hostSuite: HostAdapterSuite },
  input: { tenantId: string; orgId: string; requestId: string; version: number; causedBy: string; personalTenant?: string; metadata?: Record<string, unknown> },
): Promise<string> {
  const runId = randomUUID();
  const started = await startWorkflowRun(deps, {
    tenantId: input.tenantId,
    workflowId: CHANGE_REQUEST_CHAIN_ID,
    runId,
    inputs: { orgId: input.orgId, requestId: input.requestId, version: input.version },
    // ADR 0962 P2 — extra provenance (an outside agent's request) never overrides the stamp.
    metadata: { ...(input.metadata ?? {}), [CAMPAIGN_OPS_RUN_STAMP]: { orgId: input.orgId, requestId: input.requestId, requestVersion: input.version } },
    orgScopeSubject: input.causedBy,
    ...(input.personalTenant ? { personalTenant: input.personalTenant } : {}),
  });
  if (!started) {
    throw new OpenwopError('workflow_not_found', 'The change-request workflow is not available.', 422, { workflowId: CHANGE_REQUEST_CHAIN_ID });
  }
  await attachRun(input.tenantId, input.orgId, input.requestId, input.version, started);
  return started;
}

export const EXECUTE_CHAIN_ID = 'campaign-ops.execute';

/** ADR 0924 D6 — start the execution run for an approved change set, with the
 *  approved hash pinned in the run stamp. The approver is the cause. */
export async function startExecutionRun(
  deps: { storage: Storage; hostSuite: HostAdapterSuite },
  input: { tenantId: string; orgId: string; approvalId: string; changeSetId: string; changeSetHash: string; approvedBy: string },
): Promise<string> {
  const started = await startWorkflowRun(deps, {
    tenantId: input.tenantId,
    workflowId: EXECUTE_CHAIN_ID,
    runId: randomUUID(),
    inputs: { orgId: input.orgId, approvalId: input.approvalId },
    metadata: { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: input.orgId, approvalId: input.approvalId, changeSetId: input.changeSetId, changeSetHash: input.changeSetHash } },
    orgScopeSubject: input.approvedBy,
  });
  if (!started) throw new OpenwopError('workflow_not_found', 'The execution workflow is not available.', 422, { workflowId: EXECUTE_CHAIN_ID });
  return started;
}


/** ADR 0957 D2 — start the client-report chain on demand (the "run now" path;
 *  the schedule starts the same chain). The campaign-ops stamp binds the run to
 *  the client and freezes the client's autonomy policy for its review gate
 *  (ADR 0942 P2b); the operator who asked is the run's cause. */
export async function startClientReportRun(
  deps: { storage: Storage; hostSuite: HostAdapterSuite },
  input: { tenantId: string; orgId: string; definitionId: string; definitionVersion: number; causedBy: string; periodStart?: string; periodEnd?: string; personalTenant?: string },
): Promise<string> {
  const { CLIENT_REPORT_CHAIN_ID } = await import('./reports/types.js');
  const started = await startWorkflowRun(deps, {
    tenantId: input.tenantId,
    workflowId: CLIENT_REPORT_CHAIN_ID,
    runId: randomUUID(),
    inputs: {
      orgId: input.orgId, definitionId: input.definitionId, definitionVersion: input.definitionVersion,
      ...(input.periodStart ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
    },
    metadata: { [CAMPAIGN_OPS_RUN_STAMP]: {
      orgId: input.orgId, definitionId: input.definitionId, definitionVersion: input.definitionVersion,
      ...(input.periodStart ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
    } },
    orgScopeSubject: input.causedBy,
    ...(input.personalTenant ? { personalTenant: input.personalTenant } : {}),
  });
  if (!started) throw new OpenwopError('workflow_not_found', 'The client-report workflow is not available.', 422, { workflowId: CLIENT_REPORT_CHAIN_ID });
  return started;
}
