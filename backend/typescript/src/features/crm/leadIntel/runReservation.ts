/** ADR 0954 — the shared frozen frame for grading and routing admission. */
import { OpenwopError, type RunRecord } from '../../../types.js';
import { tombstoneId } from '../../consent/consentService.js';
import { GRADE_LEAD_WORKFLOW_ID, QUALIFY_LEAD_WORKFLOW_ID, ROUTE_LEAD_WORKFLOW_ID, LEAD_INTEL_RUN_STAMP } from './constants.js';
import type { GradeReservationPin } from './leadStore.js';

/** The generic starter checks tenant/workflow on an existing id. This owner's
 * narrower reservation additionally binds its exact inputs, stamp and cause. */
export function assertLeadDispatchMatches(run: RunRecord | null, tenantId: string, orgId: string, contactId: string, pin: GradeReservationPin): void {
  const inputs = leadDispatchInputs(orgId, contactId, pin);
  const stamp = leadDispatchStamp(orgId, contactId, pin);
  const actual = run?.inputs as Record<string, unknown> | undefined;
  const actualStamp = run?.metadata?.[LEAD_INTEL_RUN_STAMP] as Record<string, unknown> | undefined;
  const cause = run?.metadata?.orgScopeSubject;
  if (!run || run.tenantId !== tenantId || run.workflowId !== (pin.routingEpoch !== undefined ? ROUTE_LEAD_WORKFLOW_ID : pin.qualification ? QUALIFY_LEAD_WORKFLOW_ID : GRADE_LEAD_WORKFLOW_ID)
    || typeof cause !== 'string' || tombstoneId(tenantId, cause) !== pin.requesterHash
    || Object.keys(actual ?? {}).length !== Object.keys(inputs).length
    || Object.keys(actualStamp ?? {}).length !== Object.keys(stamp).length
    || Object.entries(inputs).some(([k, v]) => JSON.stringify(actual?.[k]) !== JSON.stringify(v))
    || Object.entries(stamp).some(([k, v]) => JSON.stringify(actualStamp?.[k]) !== JSON.stringify(v))) {
    throw new OpenwopError('conflict', 'The grading run could not be confirmed against its reservation. Retry.', 409, { runId: run?.runId });
  }
}

export function leadDispatchInputs(orgId: string, contactId: string, pin: GradeReservationPin) {
  return { orgId, contactId, modelId: pin.modelId, modelVersion: pin.modelVersion,
    ...(pin.routingEpoch !== undefined ? { routingEpoch: pin.routingEpoch } : {}),
  };
}
export function leadDispatchStamp(orgId: string, contactId: string, pin: GradeReservationPin) {
  return { ...leadDispatchInputs(orgId, contactId, pin), bindingId: pin.bindingId, ...(pin.qualification ? { qualification: true } : {}), modelHash: pin.modelHash, definitionHash: pin.definitionHash,
    ...(pin.parentRoutingEpoch !== undefined ? { parentRoutingEpoch: pin.parentRoutingEpoch, parentRunId: pin.parentRunId, excludeOwnerHashes: pin.excludeOwnerHashes ?? [] } : {}),
  };
}
