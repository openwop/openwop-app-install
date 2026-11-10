/**
 * RFC 0257 §A (ADR 1027) — a run in which no node failed and EVERY terminal node
 * was skipped ends `completed`, and `run.completed` names those terminals.
 *
 * Driven through the real executor on in-memory storage. Each leg is a graph the
 * RFC's conformance scenario also uses:
 *  - a `truthy` edge that declines (`conformance-all-terminals-skipped`, ok:false),
 *    and its positive control (ok:true), which must carry NO marker (§A.3);
 *  - an `any_failed` error route whose source succeeded, with no condition at all
 *    (`conformance-error-route-only`);
 *  - two skipped terminals listed in the definition's `nodes[]` order, which is
 *    neither alphabetical nor the scheduler's topological order (§A.2);
 *  - out of scope and UNCHANGED: a node failed and every terminal was skipped,
 *    which still fails on that node's own error (RFC 0257 Open spec gap 2).
 * It also pins what this host records in `outputs` when no terminal completed
 * (RFC 0257 G11: `{}`), that no dead letter is written, and how the marker reads
 * on the major-2 wire: SEATED, because ADR 1027 P2 made the vendored v2 schema
 * declare it, and valid against the v2 `runCompleted` def. (Before P2 it was
 * carried under `vendor.openwop-app`, ADR 0725 D3; that branch is gone.)
 *
 * Red when (sabotage-witnessed, ADR 1027 §Witnesses; re-probed grade-tests w84
 * TST-FNA-2):
 *  - `inspectDisposition` returns `failed` for the all-skipped state again, or
 *    completes a run whose failed node skipped every terminal;
 *  - `finalizeRun` drops the marker, or stamps it on every completion;
 *  - `skippedTerminalsInOrder` uses the scheduler's order instead of `nodes[]`;
 *  - the vendored v2 schema stops declaring `skippedTerminals`.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { projectV2Payload } from '../src/storage/v2PayloadProjection.js';
import { VENDOR_CARRY_KEY } from '../src/storage/vendorKeyCarry.js';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { EventRecord, RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr1027-')) });
ensureNodesRegistered();
getNodeRegistry().register({
  typeId: 'test.adr1027.boom',
  version: '1.0.0',
  async execute() { return { status: 'failure', error: { code: 'boom', message: 'the source failed' } }; },
});

async function run(def: WorkflowDefinition): Promise<{ status: string; events: readonly EventRecord[] }> {
  const now = new Date().toISOString();
  const r: RunRecord = { runId: `run-adr1027-${Math.random().toString(36).slice(2)}`, workflowId: def.workflowId, tenantId: 'demo', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
  await storage.insertRun(r);
  const result = await executeRun(storage, r, def);
  return { status: result.status, events: await storage.listEvents(r.runId, { contract: 1 }) };
}
const completedPayload = (events: readonly EventRecord[]) =>
  events.find((e) => e.type === 'run.completed')?.payload as { outputs?: unknown; skippedTerminals?: unknown } | undefined;

/** `conformance-all-terminals-skipped`: check (core.identity) → act (core.noop) over `truthy payload.ok`. */
const conditionGraph = (ok: boolean): WorkflowDefinition => ({
  workflowId: `wf.adr1027.condition.${ok}`,
  nodes: [
    { nodeId: 'check', typeId: 'core.identity', inputs: { payload: { ok } } },
    { nodeId: 'act', typeId: 'core.noop' },
  ],
  edges: [{ edgeId: 'e1', sourceNodeId: 'check', targetNodeId: 'act', condition: { path: 'payload.ok', op: 'truthy' } }],
});

describe('RFC 0257 §A — every terminal skipped, no node failed', () => {
  it('a declining condition: run.completed with skippedTerminals ["act"], never run.failed, no dead letter', async () => {
    const { status, events } = await run(conditionGraph(false));
    expect(status).toBe('completed');
    expect(events.some((e) => e.type === 'node.started' && e.nodeId === 'act'), 'act was skipped').toBe(false);
    expect(completedPayload(events)?.skippedTerminals).toEqual(['act']);
    expect(events.filter((e) => e.type === 'run.failed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'run.dead_lettered'), 'a completed run is not dead-lettered').toHaveLength(0);
    // G11 — what this host records when no terminal completed: an empty object.
    expect(completedPayload(events)?.outputs).toEqual({});
    // The terminal event is still the last event (events.md §"The terminal event").
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('positive control: the same graph with ok:true runs act and carries NO marker (§A.3)', async () => {
    const { status, events } = await run(conditionGraph(true));
    expect(status).toBe('completed');
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'act')).toBe(true);
    const p = completedPayload(events);
    expect(p).toBeDefined();
    expect(p && 'skippedTerminals' in p).toBe(false);
  });

  it('an any_failed handler whose source succeeded: completed with ["on-fail"], no condition anywhere', async () => {
    const { status, events } = await run({
      workflowId: 'wf.adr1027.error-route-only',
      nodes: [{ nodeId: 'start', typeId: 'core.noop' }, { nodeId: 'on-fail', typeId: 'core.noop' }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'start', targetNodeId: 'on-fail', triggerRule: 'any_failed' }],
    });
    expect(status).toBe('completed');
    expect(completedPayload(events)?.skippedTerminals).toEqual(['on-fail']);
    expect(events.filter((e) => e.type === 'run.failed')).toHaveLength(0);
  });

  it('every terminal, once, in nodes[] order (not alphabetical, not the scheduler\'s order)', async () => {
    const { status, events } = await run({
      workflowId: 'wf.adr1027.order',
      nodes: [
        { nodeId: 'zeta', typeId: 'core.noop' },
        { nodeId: 'src', typeId: 'core.identity', inputs: { payload: { ok: false } } },
        { nodeId: 'alpha', typeId: 'core.noop' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'src', targetNodeId: 'alpha', condition: { path: 'payload.ok', op: 'truthy' } },
        { edgeId: 'e2', sourceNodeId: 'src', targetNodeId: 'zeta', condition: { path: 'payload.ok', op: 'truthy' } },
      ],
    });
    expect(status).toBe('completed');
    expect(completedPayload(events)?.skippedTerminals).toEqual(['zeta', 'alpha']);
  });

  it('out of scope, unchanged: a FAILED node with every terminal skipped still fails on that node\'s error', async () => {
    const { status, events } = await run({
      workflowId: 'wf.adr1027.failed-source',
      nodes: [{ nodeId: 'src', typeId: 'test.adr1027.boom' }, { nodeId: 'next', typeId: 'core.noop' }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'src', targetNodeId: 'next' }],
    });
    expect(status).toBe('failed');
    expect(events.some((e) => e.type === 'run.completed')).toBe(false);
    const failed = events.find((e) => e.type === 'run.failed')?.payload as { error?: { code?: string }; failedNodeId?: string };
    expect(failed.error?.code).toBe('boom');
    expect(failed.failedNodeId, 'the failure names the node that failed').toBe('src');
  });
});

describe('RFC 0257 — the marker on the major-2 wire', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const v2Dir = join(locateRepoSchemasDir(here, 'run-event.schema.json'), 'v2');
  const payloads = JSON.parse(readFileSync(join(v2Dir, 'run-event-payloads.schema.json'), 'utf8')) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };

  it('is seated on the major-2 wire (the vendored schema declares it), and validates', () => {
    // ADR 1027 P2 seated `skippedTerminals` on the vendored v2 `runCompleted` def.
    // Unconditional on purpose: a schema that lost the seat must red here, not
    // move this case onto a vendor-carry branch (grade-tests w84 TST-FNA-2).
    expect(Object.prototype.hasOwnProperty.call(payloads.$defs.runCompleted?.properties ?? {}, 'skippedTerminals'),
      'the vendored v2 runCompleted def declares skippedTerminals').toBe(true);
    const projected = projectV2Payload('run.completed', { outputs: {}, skippedTerminals: ['act'] }, { runId: 'r' }) as Record<string, unknown>;
    expect(projected.skippedTerminals).toEqual(['act']);
    const carried = projected[VENDOR_CARRY_KEY];
    expect(typeof carried === 'object' && carried !== null && 'skippedTerminals' in carried, 'a seated key is not also carried under vendor.openwop-app').toBe(false);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(payloads, 'run-event-payloads.schema.json');
    // The seated property references `ids.schema.json#/$defs/nodeId`; register the sibling under its own `$id`.
    ajv.addSchema(JSON.parse(readFileSync(join(v2Dir, 'ids.schema.json'), 'utf8')), 'ids.schema.json');
    const validate = ajv.getSchema('run-event-payloads.schema.json#/$defs/runCompleted')!;
    expect(validate(projected), JSON.stringify(validate.errors)).toBe(true);
  });
});
