/**
 * `approval.overridden` — ONE stored payload, valid on BOTH majors.
 *
 * v1 (`interrupt-profiles.md:95`) MUSTs the event on the override path, with a
 * closed def `required: [gateId, principal, reason]`. The host used to write
 * `{interruptId, principal, reason, bypassedQuorum}`: invalid on v1 (no gateId;
 * two keys the closed def forbids) and on v2 (the alias of the closed
 * `interruptResolved` forbids `principal`). Now the v1 shape is stored, and the
 * major-2 read rebuilds it (`approvalOverriddenProjection.ts`).
 *
 * The REAL path: a live override through `resolveAndResume`, read back through
 * `listEvents` at contract 1 and contract 2, each validated against that major's
 * package `$defs`. Plus: a row stored in the PRE-change shape still projects to
 * a valid v2 payload (history is never rewritten).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { __awaitRunResumeChainForTests, __resolveAndResumeForTests } from '../src/routes/interrupts.js';
import { projectV2Payload } from '../src/storage/v2PayloadProjection.js';
import { projectV2RunIds } from '../src/host/v2Ids.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { defsFor } from './support/runEventDefs.js';

const storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-override-majors-')) });
const hostSuite = createHostAdapterSuite({ storage });
const V1 = defsFor(1)('approval.overridden');
const V2 = defsFor(2)('approval.overridden');
const TENANT = 'default';
ensureNodesRegistered();
registerHostWorkflow({
  workflowId: 'wf.ovr', name: 'override', version: '1.0.0',
  nodes: [{ nodeId: 'gate', typeId: 'core.noop', config: {} }, { nodeId: 'after', typeId: 'core.noop', config: {} }],
  edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'after' }],
} as unknown as WorkflowDefinition);

describe('approval.overridden — one stored payload, legal on both majors', () => {
  it('a live override writes the closed v1 shape and reads back valid at contract 1 AND contract 2', async () => {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-ovr-${Math.random().toString(36).slice(2)}`, workflowId: 'wf.ovr', tenantId: TENANT,
      status: 'waiting-approval', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    const gate: InterruptRecord = {
      interruptId: `int-ovr-${Math.random().toString(36).slice(2)}`, runId: run.runId, nodeId: 'gate', kind: 'approval',
      token: `tok-ovr-${Math.random().toString(36).slice(2)}`,
      data: { requiredApprovals: 3, override: { requiredRole: 'owner', audited: true }, overrideBypassesQuorum: true },
      createdAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    await storage.insertInterrupt(gate);
    await __resolveAndResumeForTests(storage, hostSuite, gate.interruptId, { action: 'override', voter: 'principal-owner', reason: 'emergency change window' });
    await __awaitRunResumeChainForTests(run.runId);

    const v1 = (await storage.listEvents(run.runId, { fromSeq: -1, limit: 1000, contract: 1 })).filter((e) => e.type === 'approval.overridden');
    expect(v1, 'the v1 MUST: the override path emits approval.overridden').toHaveLength(1);
    expect(v1[0]!.payload).toEqual({ gateId: gate.interruptId, principal: 'principal-owner', reason: 'emergency change window' });
    expect(V1(v1[0]!.payload), `v1: ${JSON.stringify(V1.errors)}`).toBe(true);

    const v2 = (await storage.listEvents(run.runId, { fromSeq: -1, limit: 1000, contract: 2 })).filter((e) => e.type === 'approval.overridden');
    expect(v2).toHaveLength(1);
    const wire = projectV2RunIds(v2[0]!.payload, TENANT) as Record<string, unknown>;
    expect(V2(wire), `v2: ${JSON.stringify(V2.errors)} ← ${JSON.stringify(wire)}`).toBe(true);
    expect(wire).toMatchObject({ nodeId: 'gate', kind: 'approval', decision: 'overridden', action: 'accept', resolvedBy: { subjectId: 'principal-owner' } });
    expect(JSON.stringify(wire), 'the human justification is carried, not dropped').toContain('emergency change window');
  });

  it('a row stored in the PRE-change shape still reads back valid on v2 (history is not rewritten)', () => {
    const legacy = { interruptId: 'int-legacy-0000000000000000000000', principal: 'boss', reason: 'expedite', bypassedQuorum: false };
    const wire = projectV2RunIds(projectV2Payload('approval.overridden', legacy, { runId: 'r1', nodeId: 'gate' }, TENANT), TENANT);
    expect(V2(wire), `v2: ${JSON.stringify(V2.errors)} ← ${JSON.stringify(wire)}`).toBe(true);
    expect(projectV2Payload('approval.overridden', projectV2Payload('approval.overridden', legacy, { runId: 'r1', nodeId: 'gate' }, TENANT), { runId: 'r1', nodeId: 'gate' }, TENANT),
      'idempotent: the fan-out projects twice').toEqual(projectV2Payload('approval.overridden', legacy, { runId: 'r1', nodeId: 'gate' }, TENANT));
  });
});
