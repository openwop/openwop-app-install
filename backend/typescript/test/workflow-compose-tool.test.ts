/**
 * ADR 0369 §6 / Phase 5 — the compose-and-run agent tool: schema-validate →
 * register transient → ordinary run. Pins: invalid stores NOTHING; the
 * capability refusal matches POST /v1/runs; no id takeover; the per-tenant
 * transient cap; the composed draft is catalog-hidden but owner-listed; the
 * run completes as an ordinary run.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import type { Storage } from '../src/storage/storage.js';
import { registerWorkflowComposeTool, COMPOSE_AND_RUN_TOOL_ID } from '../src/host/workflowComposeTool.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { getRegisteredWorkflow, deleteRegisteredWorkflow, listRegisteredWorkflows } from '../src/host/workflowsRegistry.js';
import { listOwned } from '../src/host/workflowOwnership.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from '../src/bootstrap/suspend.js';
import { ensureEventLogInstalled } from '../src/bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from '../src/bootstrap/invocationLog.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeOwnership } from '../src/host/workflowOwnership.js';

const TENANT = 'org:compose-test';
let storage: Storage;
let runTool: (input: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
const registered: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-compose-')) });
  ensureNodesRegistered();
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  ensureInvocationLogInstalled(storage);
  const hostSuite = createHostAdapterSuite({ storage });
  registerWorkflowComposeTool({ storage, hostSuite });
  const provider = createAgentToolProvider({ tenantId: TENANT, agentProfileId: 'agent-under-test' });
  runTool = async (input) => provider.executeTool({ name: COMPOSE_AND_RUN_TOOL_ID, input });
});
afterEach(async () => {
  for (const id of registered.splice(0)) {
    deleteRegisteredWorkflow(id);
    await removeOwnership(TENANT, id); // the cap counts ownership rows
  }
});

const NODES = [{ nodeId: 'a', typeId: 'core.noop' }];
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe('workflows.compose-and-run (ADR 0369 §6)', () => {
  it('an INVALID definition stores nothing', async () => {
    const before = listRegisteredWorkflows({ includeTransient: true, includeArchived: true }).length;
    const r = await runTool({ definition: { workflowId: 'agent-bad-1', nodes: 'not-an-array' } });
    expect(r.isError).toBe(true);
    expect(listRegisteredWorkflows({ includeTransient: true, includeArchived: true }).length).toBe(before);
    expect(getRegisteredWorkflow('agent-bad-1')).toBeUndefined();
  });

  it('dryRun validates without registering or running', async () => {
    const r = await runTool({ definition: { nodes: NODES }, dryRun: true });
    expect(r.isError).toBeUndefined();
    const body = parse(r);
    expect(body.valid).toBe(true);
    expect(getRegisteredWorkflow(body.workflowId as string)).toBeUndefined();
  });

  it('refuses an id takeover of an existing definition', async () => {
    const seed = await runTool({ definition: { nodes: NODES } });
    const seedId = parse(seed).workflowId as string;
    registered.push(seedId);
    const r = await runTool({ definition: { workflowId: seedId, nodes: NODES } });
    expect(r.isError).toBe(true);
    expect(parse(r).message).toContain('already exists');
  });

  it('composes → registers TRANSIENT (catalog-hidden, owner-listed, generatedBy stamped) → the run COMPLETES', async () => {
    const r = await runTool({ definition: { nodes: NODES, metadata: { name: 'Agent one-shot' } }, inputs: {} });
    expect(r.isError, r.content).toBeUndefined();
    const body = parse(r);
    const id = body.workflowId as string;
    registered.push(id);
    expect(body.runId).toBeTruthy();
    expect(body.lifecycle).toBe('transient');

    // Catalog-hidden (the P1 filter) but resolvable + owner-listed.
    expect(listRegisteredWorkflows().some((d) => d.workflowId === id)).toBe(false);
    const def = getRegisteredWorkflow(id);
    expect(def).toBeTruthy();
    expect((def?.metadata as { lifecycle?: { generatedBy?: string } })?.lifecycle?.generatedBy).toBe('agent:agent-under-test');
    const owned = await listOwned(TENANT);
    expect(owned.find((o) => o.workflowId === id)?.transient).toBe(true);

    // The run is an ORDINARY run — it lands in the run store and completes.
    for (let i = 0; i < 60; i++) {
      const run = await storage.getRun(body.runId as string);
      if (run?.status === 'completed') return;
      if (run?.status === 'failed') throw new Error(`run failed: ${JSON.stringify(run.error)}`);
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('composed run never completed');
  });

  it('enforces the per-tenant transient cap', async () => {
    process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX = '2';
    try {
      for (let i = 0; i < 2; i++) {
        const r = await runTool({ definition: { nodes: NODES } });
        expect(r.isError, r.content).toBeUndefined();
        registered.push(parse(r).workflowId as string);
      }
      const over = await runTool({ definition: { nodes: NODES } });
      expect(over.isError).toBe(true);
      // ADR 0595 §Correction 7 — the refusal text is now the ONE shared
      // `transientCapMessage()`. Assert what the message must DO (name the
      // budget and the remedy that always works) rather than a phrase, which
      // is what let the old copy name the wrong population for so long.
      expect(parse(over).message).toMatch(/unsaved AI-generated drafts/i);
      expect(parse(over).message).toMatch(/archive/i);
    } finally {
      delete process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX;
    }
  });
});
