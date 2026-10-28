/** ADR 0954 — one frozen admission owner for grade, manual route and
 * SLA reroute. HTTP response claims remain in the route; primary run/model/
 * definition/cause reservation and uncertain admission are shared here. */
import { createHash, randomUUID } from 'node:crypto';
import type { Storage } from '../../../storage/storage.js';
import type { HostAdapterSuite } from '../../../host/index.js';
import { OpenwopError, type RunRecord } from '../../../types.js';
import { resolveEffectiveAccess } from '../../../host/accessControlService.js';
import { startWorkflowRun } from '../../../host/runStarter.js';
import { getChainBackedWorkflow } from '../../../host/chainBackedWorkflows.js';
import { definitionHashOf } from '../../../host/definitionHash.js';
import type { IdempotentEndpoint } from '../../../host/idempotentResponse.js';
import { tombstoneId } from '../../consent/consentService.js';
import { GRADE_LEAD_WORKFLOW_ID, LEAD_INTEL_RUN_STAMP, QUALIFY_LEAD_WORKFLOW_ID, ROUTE_LEAD_WORKFLOW_ID } from './constants.js';
import { getLeadBindingId, getLeadProfile, getLeadRoutingDecision, getPendingGrade, getPendingLeadRoute, releaseLeadRoute, reserveLeadRoute, restorePendingGrade, stampPendingGrade, type GradeReservationPin } from './leadStore.js';
import { resolveActiveModel } from './modelStore.js';
import { assertLeadDispatchMatches, leadDispatchInputs, leadDispatchStamp } from './runReservation.js';

export interface LeadDispatchInput {
  mode: 'grade' | 'route' | 'qualify'; tenantId: string; orgId: string; contactId: string; userId: string;
  requestKeyHash?: string; personalTenant?: string;
  responseCommit?: { endpoint: IdempotentEndpoint; key: string; claimToken: string };
}
export interface LeadDispatchResponse { runId: string; modelId: string; modelVersion: number; routingEpoch?: number }
export async function admitLeadDispatch(deps: { storage: Storage; hostSuite: HostAdapterSuite }, input: LeadDispatchInput): Promise<LeadDispatchResponse> {
  const { storage } = deps;
  const { mode, tenantId, orgId, contactId, userId, requestKeyHash } = input;
  const workflowId = mode === 'route' ? ROUTE_LEAD_WORKFLOW_ID : mode === 'qualify' ? QUALIFY_LEAD_WORKFLOW_ID : GRADE_LEAD_WORKFLOW_ID;
  const requesterHash = tombstoneId(tenantId, userId);
  let currentGrade = await getPendingGrade(tenantId, orgId, contactId);
  let routePending = await getPendingLeadRoute(tenantId, orgId, contactId);
  if (mode !== 'route' && routePending) {
    const prior = await storage.getRun(routePending.runId);
    if (prior) assertLeadDispatchMatches(prior, tenantId, orgId, contactId, routePending.pin);
    if (prior && ['completed', 'failed', 'cancelled'].includes(prior.status)) {
      await restorePendingGrade(tenantId, orgId, contactId, routePending.runId);
      await releaseLeadRoute(tenantId, orgId, contactId, routePending.runId);
      routePending = null;
      currentGrade = await getPendingGrade(tenantId, orgId, contactId);
    } else if (routePending.pin.routingEpoch !== undefined && (await getLeadRoutingDecision(tenantId, orgId, contactId, routePending.pin.routingEpoch))?.runId === routePending.runId) {
      // A clock may wait for hours after assignment. A new grade does not
      // replace its primary routing reservation or its frozen SLA snapshot.
      await restorePendingGrade(tenantId, orgId, contactId, routePending.runId);
      currentGrade = await getPendingGrade(tenantId, orgId, contactId);
    } else if (!currentGrade || currentGrade.pin.routingEpoch !== undefined) {
      throw new OpenwopError('conflict', 'A routing request for this lead is in progress.', 409, { contactId });
    }
  }
  let pending = mode === 'route' ? routePending : currentGrade;
  let needsGradeStamp = false;
  const releasePending = async (runId: string): Promise<void> => {
    await restorePendingGrade(tenantId, orgId, contactId, runId);
    if (mode === 'route') await releaseLeadRoute(tenantId, orgId, contactId, runId);
  };
  if (mode === 'route' && pending?.pin.routingEpoch !== undefined && (!requestKeyHash || requestKeyHash !== pending.pin.requestKeyHash)
    && (await getLeadRoutingDecision(tenantId, orgId, contactId, pending.pin.routingEpoch))?.runId === pending.runId) {
    // A fresh human Route action may supersede a completed assignment whose
    // SLA clock still waits. Keyed replay was checked by HTTP before admission.
    await releasePending(pending.runId); pending = null;
    currentGrade = await getPendingGrade(tenantId, orgId, contactId);
  }
  if (pending) {
    const priorRun = await storage.getRun(pending.runId);
    if (priorRun) assertLeadDispatchMatches(priorRun, tenantId, orgId, contactId, pending.pin);
    if (priorRun && ['completed', 'failed', 'cancelled'].includes(priorRun.status)) {
      await releasePending(pending.runId);
      pending = null;
    }
  }
  if (pending && Boolean(pending.pin.qualification) !== (mode === 'qualify')) throw new OpenwopError('conflict', 'Another lead operation owns the pending run.', 409, { contactId });
  if (pending && pending.pin.requesterHash !== requesterHash) {
    throw new OpenwopError('conflict', 'A grading start by another operator is still pending.', 409, { contactId });
  }
  if (pending && pending.pin.requestKeyHash !== requestKeyHash) {
    throw new OpenwopError('conflict', 'A different grading request is still in progress. Retry when it completes.', 409, { contactId });
  }
  if (!pending) {
    if (mode === 'route' && currentGrade) {
      const prior = await storage.getRun(currentGrade.runId);
      if (prior) assertLeadDispatchMatches(prior, tenantId, orgId, contactId, currentGrade.pin);
      if (!prior || !['completed', 'failed', 'cancelled'].includes(prior.status)) throw new OpenwopError('conflict', 'A grading request owns this lead. Retry when it completes.', 409, { contactId });
      await restorePendingGrade(tenantId, orgId, contactId, currentGrade.runId);
    }
    const definition = getChainBackedWorkflow(workflowId);
    if (!definition) throw new OpenwopError('workflow_not_found', 'The trusted grading chain is unavailable.', 422, { workflowId });
    const model = await resolveActiveModel(tenantId, orgId);
    if (mode === 'qualify' && model.content.criteria.length === 0) throw new OpenwopError('validation_error', 'The scoring model has no qualification criteria.', 422, { reason: 'no_criteria' });
    const bindingId = await getLeadBindingId(tenantId, orgId, contactId);
    pending = { runId: randomUUID(), pin: { bindingId, ...(mode === 'qualify' ? { qualification: true as const } : {}), modelId: model.modelId, modelVersion: model.version, modelHash: model.contentHash, definitionHash: definitionHashOf(definition), requesterHash, ...(requestKeyHash ? { requestKeyHash } : {}) } };
    if (mode === 'route') pending = await reserveLeadRoute(tenantId, orgId, contactId, pending.runId, pending.pin);
    else needsGradeStamp = true;
  }
  return startReservedLeadDispatch(deps, input, pending, needsGradeStamp);
}

async function startReservedLeadDispatch(deps: { storage: Storage; hostSuite: HostAdapterSuite }, input: LeadDispatchInput,
  pending: { runId: string; pin: GradeReservationPin }, needsGradeStamp = false): Promise<LeadDispatchResponse> {
  const { storage, hostSuite } = deps; const { mode, tenantId, orgId, contactId, userId } = input;
  const workflowId = mode === 'route' ? ROUTE_LEAD_WORKFLOW_ID : mode === 'qualify' ? QUALIFY_LEAD_WORKFLOW_ID : GRADE_LEAD_WORKFLOW_ID;
  const releasePending = async (runId: string): Promise<void> => {
    await restorePendingGrade(tenantId, orgId, contactId, runId);
    if (mode === 'route') await releaseLeadRoute(tenantId, orgId, contactId, runId);
  };
  if (mode === 'route') {
    const routingEpoch = pending.pin.routingEpoch;
    if (typeof routingEpoch !== 'number' || !Number.isSafeInteger(routingEpoch) || routingEpoch < 1) {
      throw new OpenwopError('conflict', 'The routing reservation has no valid round.', 409, { reason: 'invalid_routing_epoch' });
    }
    const gradePending = await getPendingGrade(tenantId, orgId, contactId);
    if (gradePending && gradePending.runId !== pending.runId) throw new OpenwopError('conflict', 'Another grading request owns this lead.', 409, { contactId });
    if (!gradePending && !(await getLeadRoutingDecision(tenantId, orgId, contactId, routingEpoch))) {
      await stampPendingGrade(tenantId, orgId, contactId, pending.runId, pending.pin);
    }
  } else if (needsGradeStamp) {
    await stampPendingGrade(tenantId, orgId, contactId, pending.runId, pending.pin);
  }
  const { runId, pin } = pending;
  const response = { runId, modelId: pin.modelId, modelVersion: pin.modelVersion, ...(pin.routingEpoch !== undefined ? { routingEpoch: pin.routingEpoch } : {}) };
  const responseBody = JSON.stringify(response);
  const inputs = leadDispatchInputs(orgId, contactId, pin);
  const stamp = leadDispatchStamp(orgId, contactId, pin);
  const verifyLanded = async (): Promise<void> => assertLeadDispatchMatches(await storage.getRun(runId), tenantId, orgId, contactId, pin);
  const existing = await storage.getRun(runId);
  if (existing) {
    await verifyLanded();
  } else {
    // A thrown insert/acknowledgement is ambiguous: retain this reservation
    // so a retry reconciles the SAME run and frozen model, never an old stamp.
    const started = await startWorkflowRun({ storage, hostSuite }, {
      tenantId,
      workflowId,
      expectedDefinitionHash: pin.definitionHash,
      runId,
      ...(input.responseCommit ? { idempotencyCommit: { tenantId, endpoint: input.responseCommit.endpoint, key: input.responseCommit.key, claimToken: input.responseCommit.claimToken, responseStatus: 202, responseBody, updatedAt: new Date().toISOString() } } : {}),
      inputs,
      metadata: { [LEAD_INTEL_RUN_STAMP]: stamp },
      orgScopeSubject: userId,
      ...(input.personalTenant ? { personalTenant: input.personalTenant } : {}),
    });
    if (!started) {
      await releasePending(runId);
      throw new OpenwopError('workflow_not_found', `Grading workflow not found or changed: ${workflowId}`, 422, { workflowId });
    }
    await verifyLanded();
  }
  return response;
}

/** A deterministic source child reconciles admission after an uncertain start
 * even if its primary epoch subsequently advanced. Only this real source
 * decision/run can authorize it; the caller's causedBy/exclusion is not used. */
export async function admitLeadReroute(deps: { storage: Storage; hostSuite: HostAdapterSuite }, input: {
  tenantId: string; orgId: string; contactId: string; sourceRunId: string; sourceEpoch: number;
}): Promise<LeadDispatchResponse | null> {
  const { tenantId, orgId, contactId, sourceRunId, sourceEpoch } = input;
  const profile = await getLeadProfile(tenantId, orgId, contactId);
  const source = await getLeadRoutingDecision(tenantId, orgId, contactId, sourceEpoch);
  if (!profile || profile.status === 'closed' || !source?.chosen) return null;
  if (source.runId !== sourceRunId) throw new OpenwopError('forbidden_scope', 'Only the recorded routing run may start its child.', 403, { reason: 'reroute_source_mismatch' });
  const parent = await deps.storage.getRun(sourceRunId);
  const userId = parent?.metadata?.orgScopeSubject;
  const frame = parent?.metadata?.[LEAD_INTEL_RUN_STAMP] as Record<string, unknown> | undefined;
  const bindingId = await getLeadBindingId(tenantId, orgId, contactId);
  if (!parent || parent.tenantId !== tenantId || parent.workflowId !== ROUTE_LEAD_WORKFLOW_ID || typeof userId !== 'string'
    || !frame || frame.orgId !== orgId || frame.contactId !== contactId || frame.routingEpoch !== sourceEpoch || frame.bindingId !== bindingId) {
    throw new OpenwopError('forbidden_scope', 'The reroute source has no matching frozen client frame.', 403, { reason: 'reroute_source_mismatch' });
  }
  if (!(await resolveEffectiveAccess(tenantId, { subject: userId, orgId })).scopes.includes('workspace:write')) return null;
  const digest = createHash('sha256').update(JSON.stringify([tenantId, orgId, contactId, sourceEpoch, sourceRunId, 'sla-reroute'])).digest('hex');
  const runId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const expected = { bindingId, requesterHash: tombstoneId(tenantId, userId), parentRoutingEpoch: sourceEpoch, parentRunId: sourceRunId,
    routingEpoch: sourceEpoch + 1, excludeOwnerHashes: [tombstoneId(tenantId, source.chosen)] };
  const existing = await deps.storage.getRun(runId);
  if (existing) {
    // Reading this host-reserved stamp confirms an already admitted fact; it
    // does not regain a write reservation or alter a completed/failed child.
    const pin = existingReroutePin(existing, expected);
    assertLeadDispatchMatches(existing, tenantId, orgId, contactId, pin);
    return { runId, modelId: pin.modelId, modelVersion: pin.modelVersion, routingEpoch: pin.routingEpoch };
  }
  let pending = await getPendingLeadRoute(tenantId, orgId, contactId);
  if (pending?.runId === runId) {
    if (pending.pin.bindingId !== bindingId || pending.pin.requesterHash !== expected.requesterHash || pending.pin.parentRunId !== sourceRunId || pending.pin.parentRoutingEpoch !== sourceEpoch
      || JSON.stringify(pending.pin.excludeOwnerHashes) !== JSON.stringify(expected.excludeOwnerHashes)) throw new OpenwopError('conflict', 'The routing child reservation changed.', 409, { reason: 'reroute_source_mismatch' });
  } else {
    if (profile.routingEpoch !== sourceEpoch) return null;
    if (pending) {
      if (pending.runId !== sourceRunId) throw new OpenwopError('conflict', 'Another routing start owns this lead.', 409, { reason: 'routing_start_pending' });
      assertLeadDispatchMatches(parent, tenantId, orgId, contactId, pending.pin);
    }
    const grade = await getPendingGrade(tenantId, orgId, contactId);
    if (grade && grade.runId !== sourceRunId) throw new OpenwopError('conflict', 'Another grade owns this lead.', 409, { reason: 'routing_start_pending' });
    await restorePendingGrade(tenantId, orgId, contactId, sourceRunId);
    const definition = getChainBackedWorkflow(ROUTE_LEAD_WORKFLOW_ID);
    if (!definition) throw new OpenwopError('workflow_not_found', 'The routing chain is unavailable.', 422, {});
    const model = await resolveActiveModel(tenantId, orgId);
    try {
      pending = await reserveLeadRoute(tenantId, orgId, contactId, runId,
        { ...expected, modelId: model.modelId, modelVersion: model.version, modelHash: model.contentHash, definitionHash: definitionHashOf(definition) },
        { routingEpoch: sourceEpoch, runId: sourceRunId });
    } catch (err) {
      if (err instanceof OpenwopError && err.details?.reason === 'routing_superseded') return null;
      throw err;
    }
  }
  return startReservedLeadDispatch(deps, { mode: 'route', tenantId, orgId, contactId, userId }, pending);
}

function existingReroutePin(run: RunRecord, expected: Pick<GradeReservationPin, 'bindingId' | 'requesterHash' | 'parentRoutingEpoch' | 'parentRunId' | 'routingEpoch' | 'excludeOwnerHashes'>): GradeReservationPin {
  const stamp = run.metadata?.[LEAD_INTEL_RUN_STAMP] as Record<string, unknown> | undefined;
  if (!stamp || typeof stamp.modelId !== 'string' || !stamp.modelId || typeof stamp.modelVersion !== 'number' || !Number.isSafeInteger(stamp.modelVersion) || stamp.modelVersion < 0
    || typeof stamp.modelHash !== 'string' || !/^[a-f0-9]{64}$/.test(stamp.modelHash) || typeof stamp.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(stamp.definitionHash)) {
    throw new OpenwopError('conflict', 'The child has no matching frozen model.', 409, { reason: 'reroute_source_mismatch' });
  }
  return { ...expected, modelId: stamp.modelId, modelVersion: stamp.modelVersion, modelHash: stamp.modelHash, definitionHash: stamp.definitionHash };
}
