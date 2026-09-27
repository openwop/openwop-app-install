/**
 * ADR 0237 (CHAINX-5) — `node.inputs` honored end-to-end:
 *   1. validateWorkflowDefinition PRESERVES node.inputs (was silently dropped),
 *      and rejects a non-object inputs.
 *   2. the executor interpolates `{{inputs.NAME}}` string tokens in node.inputs
 *      symmetrically with config (was config-only → an input token was
 *      delivered verbatim as a literal), against the replay-stable variable bag.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { executeRun } from '../src/executor/executor.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setRuntimeCapabilities } from '../src/executor/runtimeCapabilities.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { setRunVariable } from '../src/host/variablesRuntime.js';
import { configureSecretResolver } from '../src/byok/secretResolver.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { OpenwopError } from '../src/types.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  setRuntimeCapabilities([]);
  const dataDir = mkdtempSync(join(tmpdir(), 'openwop-test-'));
  configureSecretResolver({ storage, dataDir });
  initInMemorySurfaces({ dataDir });
});

describe('ADR 0237 — validateWorkflowDefinition preserves node.inputs', () => {
  it('keeps a node.inputs map through validation (was dropped)', () => {
    const def = validateWorkflowDefinition({
      workflowId: 'wf.inputs.preserve',
      nodes: [
        { nodeId: 'n1', typeId: 'core.noop', config: {}, inputs: { query: '{{inputs.q}}', limit: { type: 'static', value: 5 } } },
      ],
    });
    const n1 = def.nodes.find((n) => n.nodeId === 'n1')!;
    expect(n1.inputs).toEqual({ query: '{{inputs.q}}', limit: { type: 'static', value: 5 } });
  });

  it('rejects a non-object node.inputs', () => {
    expect(() =>
      validateWorkflowDefinition({
        workflowId: 'wf.inputs.bad',
        nodes: [{ nodeId: 'n1', typeId: 'core.noop', inputs: 'nope' }],
      }),
    ).toThrow(OpenwopError);
  });
});

describe('ADR 0237 — executor interpolates {{inputs.*}} in node.inputs', () => {
  it('resolves an inputs token from the run variable bag, delivered as ctx.inputs', async () => {
    let captured: unknown;
    getNodeRegistry().register({
      typeId: 'test.capture-inputs.node',
      version: '1.0.0',
      async execute(ctx) {
        captured = ctx.inputs;
        return { status: 'success', outputs: { ok: true } };
      },
    });

    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-${Math.random().toString(36).slice(2, 10)}`,
      workflowId: 'wf.inputs.interp',
      tenantId: 'demo',
      status: 'pending',
      inputs: {},
      metadata: {},
      configurable: {},
      createdAt: now,
      updatedAt: now,
    };
    await storage.insertRun(run);
    // The variable bag is what expandChain's {{params.*}}→{{inputs.*}} rename
    // resolves against at run time (same source config interpolation reads).
    setRunVariable(run.runId, 'q', 'month-end docs');
    setRunVariable(run.runId, 'orgId', 'acme-corp');

    const definition: WorkflowDefinition = {
      workflowId: 'wf.inputs.interp',
      nodes: [
        {
          nodeId: 'cap',
          typeId: 'test.capture-inputs.node',
          inputs: { query: '{{inputs.q}}', orgId: '{{inputs.orgId}}', literal: { type: 'static', value: 7 } },
        },
      ],
    };

    const result = await executeRun(storage, run, definition);
    expect(result.status).toBe('completed');
    // The token strings resolved from the bag; the static PortValue unwrapped.
    expect(captured).toMatchObject({ query: 'month-end docs', orgId: 'acme-corp', literal: 7 });
    // Critically: NOT the verbatim literal token (the pre-fix behavior).
    expect((captured as { query: string }).query).not.toContain('{{inputs');
  });
});
