/**
 * CS70WF-38 (engine finding, docs/steward/workflows-assessment/2026-10-31-engine-skipped-terminal.md)
 * — a run in which EVERY terminal node was skipped by its edge conditions, and no
 * node failed, ends FAILED with the named host code `all_terminals_skipped` and
 * the skipped terminals, instead of `internal_error: unknown node failure`.
 *
 * Driven on a REAL chain that reaches it: `career.apply` from the vendored
 * `career-search` chain pack, loaded through the real chain loader and expanded,
 * run by the real executor. Its only terminal (`session`) is reached by
 * `guard.ok equals true`; a guard that declines (`ok: false`) skips it. The guard
 * is the real pack node with a stub job-search surface returning `ok: false`; the
 * computer-use session is a stand-in that must never run.
 *
 * The run status stays `failed`: no spec text defines another for this state.
 * On the major-2 wire the emitter namespaces the code to the registered vendor org
 * (`openwop-app.all_terminals_skipped`), pinned here through `v2EventErrorCode`.
 *
 * Red when (sabotage-witnessed): the `skippedTerminals` branch in
 * `scheduler.ts` `inspectDisposition` is removed (the run reports
 * internal_error "unknown node failure" again, with the skipped node as failedNodeId).
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
import { v2EventErrorCode } from '../src/middleware/protocolVersion.js';
import type { NodeContext } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-cs70wf38-')) });
ensureNodesRegistered();

let sessionRan = 0;
const reg = getNodeRegistry();
type PackFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown> }>;
const jobSearch = (await import(new URL('../../../packs/feature.job-search.nodes/index.mjs', import.meta.url).href)) as { nodes: Record<string, PackFn> };
const guard = jobSearch.nodes['feature.job-search.nodes.guard-rewrite']!;
reg.register({
  typeId: 'feature.job-search.nodes.guard-rewrite',
  version: '1.0.0',
  async execute(ctx: NodeContext) {
    // The REAL pack node; its job-search surface declines the rewrite.
    const r = await guard({ ...(ctx as unknown as Record<string, unknown>), features: { 'job-search': { guardRewrite: async () => ({ ok: false, violations: ['invented employer'] }) } } });
    return r as never;
  },
});
reg.register({
  typeId: 'feature.computer-use.nodes.task',
  version: '1.0.0',
  async execute() { sessionRan += 1; return { status: 'success', outputs: {} }; },
});

describe('CS70WF-38 — every terminal skipped by its conditions ends FAILED with a named code', () => {
  it('career.apply with a declining guard: all_terminals_skipped, naming the skipped terminal', async () => {
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

    expect(result.status).toBe('failed');
    expect(sessionRan).toBe(0);
    const failed = (await storage.listEvents(run.runId)).find((e) => e.type === 'run.failed');
    const payload = failed?.payload as { error?: { code?: string; message?: string; details?: { skippedTerminals?: string[] } }; failedNodeId?: string } | undefined;
    expect(payload?.error?.code).toBe('all_terminals_skipped');
    expect(payload?.error?.message).toContain(session.nodeId);
    expect(payload?.error?.details?.skippedTerminals).toEqual([session.nodeId]);
    // No node failed, so none is blamed.
    expect(payload?.failedNodeId).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('unknown node failure');
    // Major 2: the registered vendor org namespaces the host code.
    expect(v2EventErrorCode('all_terminals_skipped')).toBe('openwop-app.all_terminals_skipped');
  });
});
