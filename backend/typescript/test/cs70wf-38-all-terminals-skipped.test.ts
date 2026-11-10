/**
 * CS70WF-38 (engine finding, docs/steward/workflows-assessment/2026-10-31-engine-skipped-terminal.md)
 * under RFC 0257 §A (ADR 1027) — a run in which EVERY terminal node was skipped
 * by its edge conditions, and no node failed, ends COMPLETED and says it reached
 * no terminal (`run.completed.skippedTerminals`). #5443 failed it with the host
 * code `all_terminals_skipped`; before that it was `internal_error: unknown node
 * failure`. Neither had a failed node to name.
 *
 * Driven on a REAL chain that reaches it: `career.apply` from the vendored
 * `career-search` chain pack, loaded through the real chain loader and expanded,
 * run by the real executor. Its only terminal (`session`) is reached by
 * `guard.ok equals true`; a guard that declines (`ok: false`) skips it. The guard
 * is the real pack node with a stub job-search surface returning `ok: false`; the
 * computer-use session is a stand-in that must never run.
 *
 * Red when (sabotage-witnessed, grade-tests w84 TST-FNA-1): `inspectDisposition`
 * fails the all-skipped state again (the run is `failed`, dead-lettered), or
 * `finalizeRun` drops the marker.
 *
 * Overlap (kept, a human ask): `career-apply-chain-gate.test.ts` drives the same
 * declining guard; this file alone pins the exact list, the persisted status and
 * the absence of `all_terminals_skipped`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, getChain, expandChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import type { NodeContext, NodeOutcome } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-cs70wf38-')) });
ensureNodesRegistered();

let sessionRan = 0;
const reg = getNodeRegistry();
// The pack module is untyped .mjs: this names the shape the executor calls it with.
type PackFn = (ctx: NodeContext) => Promise<NodeOutcome>;
const jobSearch = (await import(new URL('../../../packs/feature.job-search.nodes/index.mjs', import.meta.url).href)) as { nodes: Record<string, PackFn> };
const guard = jobSearch.nodes['feature.job-search.nodes.guard-rewrite']!;
reg.register({
  typeId: 'feature.job-search.nodes.guard-rewrite',
  version: '1.0.0',
  async execute(ctx: NodeContext) {
    // The REAL pack node; its job-search surface declines the rewrite.
    return guard({ ...ctx, features: { 'job-search': { guardRewrite: async () => ({ ok: false, violations: ['invented employer'] }) } } });
  },
});
reg.register({
  typeId: 'feature.computer-use.nodes.task',
  version: '1.0.0',
  async execute() { sessionRan += 1; return { status: 'success', outputs: {} }; },
});

describe('CS70WF-38 / RFC 0257 — every terminal skipped by its conditions COMPLETES with the marker', () => {
  it('career.apply with a declining guard: run.completed naming the skipped terminal, no run.failed, no dead letter', async () => {
    _resetChainRegistryForTest();
    expect(loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() }).errors).toEqual([]);
    const chain = getChain('career.apply');
    expect(chain, 'career.apply must load from the vendored chain packs').toBeTruthy();
    const def = expandChain(chain!.chain, { params: { original: 'I led a team.', reworded: 'I led a team at Acme.', allowedEmployers: [], orgId: 'org-1' } });
    const session = def.nodes.find((n) => n.nodeId.endsWith('_session'))!;
    expect(session, 'the chain\'s only terminal').toBeTruthy();

    const now = new Date().toISOString();
    const run: RunRecord = { runId: `run-cs70wf38-${Math.random().toString(36).slice(2)}`, workflowId: def.workflowId, tenantId: 'demo', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
    await storage.insertRun(run);
    const result = await executeRun(storage, run, def);

    expect(result.status).toBe('completed');
    expect((await storage.getRun(run.runId))?.status).toBe('completed');
    expect(sessionRan).toBe(0);
    const events = await storage.listEvents(run.runId, { contract: 1 });
    const completed = events.find((e) => e.type === 'run.completed')?.payload as { skippedTerminals?: string[] } | undefined;
    expect(completed?.skippedTerminals).toEqual([session.nodeId]);
    expect(events.some((e) => e.type === 'run.failed'), 'no failure: no node failed').toBe(false);
    expect(events.some((e) => e.type === 'run.dead_lettered'), 'a completed run is not dead-lettered').toBe(false);
    expect(JSON.stringify(events)).not.toContain('all_terminals_skipped');
  });
});
