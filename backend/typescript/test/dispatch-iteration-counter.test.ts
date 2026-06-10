/**
 * A6 Step-1 / RFC 0061 §B — the observable `iteration` counter on the PRODUCTION
 * path (`core.dispatch`'s runOrchestrator.decided), not just the agent-loop seam.
 *
 * A `multiAgent.executionModel.version >= 5` host (PHASE_5 flag) MUST set
 * `runOrchestrator.decided.iteration` — 1-based, monotonic, +1 per orchestrator
 * turn, sourced from a PERSISTED run variable so it continues (never restarts)
 * across re-entrant supervisor→dispatch passes / `:fork`. Hosts on version < 5
 * omit the field.
 *
 * We drive core.dispatch directly with forward-compat `noop` decisions — the loop
 * emits one runOrchestrator.decided per decision then `continue`s (no child
 * dispatch), so we observe the counter without the sub-workflow machinery.
 *
 * @see spec/v1/multi-agent-execution.md §B; run-event-payloads.schema.json#runOrchestratorDecided
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend, getEventLog } from '../src/executor/eventLog.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import type { Storage } from '../src/storage/storage.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
ensureNodesRegistered();

const PHASE5 = 'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5';

function varsBag() {
  const m = new Map<string, unknown>();
  return { get: (n: string): unknown => m.get(n), set: (n: string, v: unknown): void => { m.set(n, v); } };
}

function ctx(runId: string, decisions: unknown[], variables: { get(n: string): unknown; set(n: string, v: unknown): void }): unknown {
  return {
    runId,
    nodeId: 'supervisor-node',
    inputs: { input: { agentId: 'orchestrator.test.iteration', decisions } },
    config: {},
    configurable: {},
    variables,
  };
}

async function decidedIterations(runId: string): Promise<Array<number | undefined>> {
  const events = await getEventLog().list(runId);
  return events
    .filter((e) => e.type === 'runOrchestrator.decided')
    .map((e) => (e.payload as { iteration?: number }).iteration);
}

const NOOP3 = [{ kind: 'noop' }, { kind: 'noop' }, { kind: 'noop' }];

beforeAll(() => { ensureNodesRegistered(); });
afterEach(() => { delete process.env[PHASE5]; });

describe('A6 Step-1 / RFC 0061 §B — core.dispatch iteration counter', () => {
  it('emits 1-based monotonic iteration on runOrchestrator.decided when version >= 5', async () => {
    process.env[PHASE5] = 'true';
    const node = getNodeRegistry().get('core.dispatch');
    expect(node).not.toBeNull();
    const res = await node!.execute(ctx('run-iter-basic', NOOP3, varsBag()) as never);
    expect(res.status).toBe('success');
    expect(await decidedIterations('run-iter-basic')).toEqual([1, 2, 3]);
  });

  it('continues monotonically (never restarts) across re-entrant passes via the persisted run variable', async () => {
    process.env[PHASE5] = 'true';
    const node = getNodeRegistry().get('core.dispatch')!;
    const vars = varsBag(); // one bag = one run's persisted variables
    await node.execute(ctx('run-iter-cont', NOOP3, vars) as never);
    await node.execute(ctx('run-iter-cont', NOOP3, vars) as never); // second supervisor→dispatch pass
    // The counter survives the pass boundary: 1,2,3 then 4,5,6 — not 1,2,3,1,2,3.
    expect(await decidedIterations('run-iter-cont')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('omits the field on a version < 5 host (additive forward-compat)', async () => {
    delete process.env[PHASE5];
    const node = getNodeRegistry().get('core.dispatch')!;
    await node.execute(ctx('run-iter-v4', NOOP3, varsBag()) as never);
    expect(await decidedIterations('run-iter-v4')).toEqual([undefined, undefined, undefined]);
  });
});
