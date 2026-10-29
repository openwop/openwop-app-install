/** ADR 0957 P1b: reuse the autonomy effect boundary and its covering grants.
 * The report surface proves the report belongs to this run. This check binds
 * its publication to the client's verified frozen policy and exact snapshot.
 * No mutable workflow-catalog lookup or node output can stand in for approval.
 */
import { isDeepStrictEqual } from 'node:util';
import { OpenwopError, type EventRecord, type RunRecord } from '../../../types.js';
import { hostExtStorage } from '../../../host/hostExtPersistence.js';
import {
  autonomyToggleOn, enforceCampaignAction, findCoveringGrant, runAutonomyOf,
  type EnforceVerdict,
} from '../../../host/autonomyPolicy/index.js';
import { autonomyOrgOf } from '../../../host/autonomyPolicy/frozen.js';
import { resolveRunDefinition } from '../../../host/resolveRunDefinition.js';
import { runClientStamp } from '../../../host/runClientOrg.js';
import type { ClientReport } from './types.js';

export const AUTONOMY_GATE_TYPE_ID = 'feature.campaign-orchestration.nodes.autonomy-gate';

const refused = (reason: string): OpenwopError => new OpenwopError(
  'conflict', 'This report needs a valid approval for its frozen figures and client policy.', 409, { reason },
);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A branch can reuse a computation only when its copied checkpoint proves
 * that exact output came from the computing run. Parentage alone is not proof,
 * and this never substitutes for the branch's own publication approval below.
 */
export async function assertReportSnapshotBelongsToRun(report: ClientReport, runId: string): Promise<void> {
  const deny = (): never => { throw new OpenwopError('conflict', 'This run has no verified computation of the report.', 409,
    { reason: 'report_not_from_this_run', reportId: report.reportId }); };
  if (!runId || !report.runId) return deny();
  if (report.runId === runId) return;
  const storage = hostExtStorage();
  const bound = (run: RunRecord | null): run is RunRecord => {
    if (!run || run.tenantId !== report.tenantId) return false;
    const stamp = runClientStamp(run.metadata);
    return !!stamp && 'orgId' in stamp && stamp.orgId === report.orgId;
  };
  const computes = async (run: RunRecord): Promise<Set<string>> => {
    const definition = await resolveRunDefinition(run, { getWorkflow: async () => null });
    return new Set(definition?.definition.nodes.filter(node =>
      node.typeId.replace(/@.*$/, '') === 'feature.campaign-ops.nodes.compute-snapshot',
    ).map(node => node.nodeId) ?? []);
  };
  const matches = (event: EventRecord, nodes: Set<string>): boolean => {
    if (event.type !== 'node.completed' || !event.nodeId || !nodes.has(event.nodeId) || !object(event.payload)) return false;
    const outputs = event.payload.outputs;
    return object(outputs) && outputs.reportId === report.reportId && outputs.snapshotHash === report.snapshotHash;
  };
  let child = await storage.getRun(runId);
  const seen = new Set<string>();
  for (let depth = 0; depth < 32; depth++) {
    if (!bound(child) || seen.has(child.runId) || child.forkMode !== 'branch' || !child.parentRunId
      || !Number.isSafeInteger(child.parentSeq) || child.parentSeq! <= 0 || child.parentSeq! > 10_000) return deny();
    seen.add(child.runId);
    const parent = await storage.getRun(child.parentRunId);
    if (!bound(parent) || parent.workflowId !== child.workflowId) return deny();
    const parentSeq = child.parentSeq!;
    const [childNodes, parentNodes, childEvents, parentEvents] = await Promise.all([
      computes(child), computes(parent),
      storage.listEvents(child.runId, { fromSeq: -1, limit: parentSeq }),
      storage.listEvents(parent.runId, { fromSeq: -1, limit: parentSeq }),
    ]);
    const inherited = childEvents.some(event => event.sequence < parentSeq
      && matches(event, childNodes) && parentEvents.some(source => source.sequence === event.sequence
        && source.sequence < parentSeq && event.causationId === source.eventId
        && source.nodeId === event.nodeId && matches(source, parentNodes) && isDeepStrictEqual(event.payload, source.payload)));
    if (!inherited) return deny();
    if (parent.runId === report.runId) return;
    child = parent;
  }
  deny();
}

export async function assertReportPublishGatePassed(
  tenantId: string, orgId: string, runId: string, snapshotHash: string,
): Promise<{ via: 'policy-auto' | 'approved'; enforcement: EnforceVerdict }> {
  const storage = hostExtStorage();
  const run = await storage.getRun(runId);
  if (!run || run.tenantId !== tenantId || !/^[a-f0-9]{64}$/.test(snapshotHash)) throw refused('report_publish_ungated');
  const frozen = runAutonomyOf(run);
  if (!frozen.stamp || autonomyOrgOf(run.metadata, frozen.stamp) !== orgId || !(await autonomyToggleOn(tenantId))) {
    throw refused('report_publish_ungated');
  }
  // Includes live client status/mode and attended-fork floors, unlike deciding
  // from the frozen policy alone. A preview or archived client cannot publish.
  const enforcement = await enforceCampaignAction({ storage, tenantId, runId }, {
    actionClass: 'report.publish', facts: {}, contentHash: snapshotHash,
  });
  if (enforcement.kind === 'proceed') return { via: 'policy-auto', enforcement };
  if (enforcement.kind !== 'approve') throw refused('report_publish_ungated');
  // Publication needs the as-run node identity. Deliberately provide no head
  // fallback: a pruned/missing revision cannot authorize from today's catalog.
  const definition = await resolveRunDefinition(run, { getWorkflow: async () => null });
  if (!definition) throw refused('report_publish_unapproved');
  const gateNodes = new Set(definition.definition.nodes.filter((node) =>
    node.typeId.replace(/@.*$/, '') === AUTONOMY_GATE_TYPE_ID && node.config?.actionClass === 'report.publish',
  ).map((node) => node.nodeId));
  const grant = await findCoveringGrant(storage, runId, {
    actionClass: 'report.publish', facts: {}, contentHash: snapshotHash,
  }, (interrupt) => {
    const value = interrupt.resolvedValue;
    const data = interrupt.data;
    // Require explicit approval of this frozen policy at its as-run gate.
    // Continue past null/skip/cancelled/unrelated resolutions to a later valid
    // approval; no earlier response can authorize or poison the publication.
    // The interrupt protocol advertises `accept`; the UI's `approve` is its
    // admitted alias (routes/interrupts.ts). Both record explicit approval.
    return gateNodes.has(interrupt.nodeId) && object(value) && (value.action === 'approve' || value.action === 'accept')
      && value.cancelled !== true && value.cascadedFromParent !== true
      && object(data) && data.key === 'autonomy-gate' && object(data.autonomy)
      && data.autonomy.policyHash === enforcement.policyHash;
  });
  if (!grant) throw refused('report_publish_unapproved');
  return { via: 'approved', enforcement };
}
