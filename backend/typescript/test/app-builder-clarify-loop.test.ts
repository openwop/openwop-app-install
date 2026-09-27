/**
 * AI-08 clarify loop (ADR 0346 correction / DECIDE-3 follow-through) — the
 * design chain's intake→clarify shape composes the EXISTING `clarification`
 * interrupt (no RFC): a CLARIFY verdict routes through `core.clarificationGate`
 * (suspend, question carried, answers returned as the gate's `output`); a clear
 * verdict routes straight to the next stage via the conditional edge +
 * `any_success` fan-in, with the gate never firing.
 *
 * Tested at the executor level with the SAME topology/conditions the chain
 * pack declares (test emitters stand in for the AI stages), plus a
 * chain-expansion assertion pinning the real pack's wiring.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let storage: Storage;

beforeAll(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  ensureNodesRegistered();
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-clarify-')) });
  const registry = getNodeRegistry();
  registry.register({
    typeId: 'test.emit-config-content',
    version: '1.0.0',
    async execute(ctx) {
      return { status: 'success', outputs: { content: (ctx.config as { content?: string })?.content ?? '' } };
    },
  });
  registry.register({
    typeId: 'test.collect-inputs',
    version: '1.0.0',
    async execute(ctx) {
      return { status: 'success', outputs: { got: ctx.inputs ?? {} } };
    },
  });
});

async function newRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-clarify-${Math.random().toString(36).slice(2)}`,
    workflowId, tenantId: 'demo', status: 'pending',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

/** The chain's intake→clarify→prd shape with a configurable intake verdict. */
function defWithVerdict(workflowId: string, verdict: string): WorkflowDefinition {
  return {
    workflowId,
    nodes: [
      { nodeId: 'intake', typeId: 'test.emit-config-content', config: { content: verdict } },
      { nodeId: 'clarify', typeId: 'core.clarificationGate', config: { question: 'Please answer.', schema: { type: 'string' } } },
      { nodeId: 'prd', typeId: 'test.collect-inputs' },
    ],
    edges: [
      { edgeId: 'e1', sourceNodeId: 'intake', targetNodeId: 'clarify', sourceOutput: 'content', targetInput: 'question', triggerRule: 'all_success', condition: { path: 'content', op: 'contains', value: 'VERDICT_CLARIFY' } },
      { edgeId: 'e2', sourceNodeId: 'intake', targetNodeId: 'prd', sourceOutput: 'content', targetInput: 'intakeVerdict', triggerRule: 'any_success', condition: { path: 'content', op: 'contains', value: 'VERDICT_OK' } },
      { edgeId: 'e3', sourceNodeId: 'clarify', targetNodeId: 'prd', sourceOutput: 'output', targetInput: 'clarifications', triggerRule: 'any_success' },
    ],
  };
}

describe('AI-08 clarify loop — executor semantics', () => {
  it('CLARIFY verdict: gate suspends with kind clarification; the resume answer reaches the next stage', async () => {
    const run = await newRun('wf.clarify-branch');
    const def = defWithVerdict('wf.clarify-branch', 'VERDICT_CLARIFY: who is the audience?');
    const first = await executeRun(storage, run, def);
    expect(first.status).toBe('waiting-input'); // kind clarification maps to waiting-input
    const events = await storage.listEvents(run.runId);
    const interruptEvt = events.find((e) => e.type === 'node.suspended');
    expect(interruptEvt, 'an interrupt event must be recorded').toBeTruthy();
    expect(JSON.stringify(interruptEvt!.payload)).toContain('clarification');

    // Resume with the human's answer — the interrupts route's exact shape:
    // the suspended snapshot rides the run record.
    const fresh = await storage.getRun(run.runId);
    const snapshot = JSON.parse((fresh as { schedulerSnapshot?: string }).schedulerSnapshot ?? 'null');
    expect(snapshot, 'suspension must persist a scheduler snapshot').toBeTruthy();
    const resumed = await executeRun(storage, fresh ?? run, def, {
      resumeSnapshot: snapshot,
      resumeNodeId: 'clarify',
      resumeValue: 'Small landscaping businesses.',
    });
    expect(resumed.status).toBe('completed');
    const done = await storage.listEvents(run.runId);
    const prdCompleted = done.find((e) => e.type === 'node.completed' && e.nodeId === 'prd');
    expect(prdCompleted).toBeTruthy();
    expect(JSON.stringify(prdCompleted!.payload)).toContain('Small landscaping businesses.');
  });

  it('OK verdict: the gate never fires; the next stage runs via the conditional edge', async () => {
    const run = await newRun('wf.clear-branch');
    const def = defWithVerdict('wf.clear-branch', 'VERDICT_OK');
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'prd')).toBe(true);
    // The gate never suspended anything.
    expect(events.some((e) => e.type === 'node.suspended')).toBe(false);
  });
});

describe('AI-08 — the SHIPPED chain wires the same shape', () => {
  it('expands with intake+clarify, conditional edges, and the clarifications port on prd', async () => {
    const { buildDesignWorkflowDefinition } = await import('../src/features/app-builder/designWorkflow.js');
    const def = buildDesignWorkflowDefinition();
    const byId = (suffix: string) => def.nodes.find((n) => n.nodeId.endsWith(suffix));
    expect(byId('intake')?.typeId).toBe('core.ai.chatCompletion');
    expect(byId('clarify')?.typeId).toBe('core.clarificationGate');
    const edges = def.edges ?? [];
    const toClarify = edges.find((e) => e.targetNodeId.endsWith('clarify'));
    expect(toClarify?.condition).toMatchObject({ op: 'contains', value: 'VERDICT_CLARIFY' });
    const clear = edges.find((e) => e.targetNodeId.endsWith('prd') && e.sourceNodeId.endsWith('intake'));
    expect(clear?.condition).toMatchObject({ op: 'contains', value: 'VERDICT_OK' });
    expect(clear?.triggerRule).toBe('any_success');
    const answers = edges.find((e) => e.targetNodeId.endsWith('prd') && e.sourceNodeId.endsWith('clarify'));
    expect(answers?.targetInput).toBe('clarifications');
  });
});
