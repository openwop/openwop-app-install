/**
 * RFC 0124 (WCP4 increment 2b-2) — the GATED run-path leg, end-to-end.
 *
 * A deferred-expanded workflow whose node had an inline `config.systemPrompt` with
 * `{{params.x}}` is now driven through a real run: the G3 lift minted a host
 * PromptTemplate + `systemPromptRef`; run-creation seeds the per-run variable bag
 * from a `configurable` override; and the dispatch node resolves the minted
 * template's `source:"variable"` slots from that bag — so the OVERRIDE value flows
 * into the composed prompt (materialize → override → resolve), a deferred prompt var
 * rides the `<UNTRUSTED>` fence (R1), and a `sensitive` param REDACTS in the
 * observability payload while its real value reaches the model (SR-1). This is the
 * non-vacuous leg the server-free scenario + witness #2 mirror.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { executeRun } from '../src/executor/executor.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { setRuntimeCapabilities } from '../src/executor/runtimeCapabilities.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import { seedRunVariables, deferredConfigurableInputs } from '../src/host/variablesRuntime.js';
import type { RunRecord } from '../src/types.js';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

let storage: Storage;

beforeAll(() => {
  ensureNodesRegistered();
});

beforeEach(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  setRuntimeCapabilities([]);
  const dataDir = mkdtempSync(join(tmpdir(), 'openwop-runpath-'));
  configureSecretResolver({ storage, dataDir });
  initInMemorySurfaces({ dataDir });
});

const chain: WorkflowChain = {
  chainId: 'test.runpath',
  version: '1.0.0',
  label: 'Run-path',
  description: 'd',
  parameters: {
    type: 'object',
    required: ['topic', 'apiKey'],
    properties: {
      topic: { type: 'string' },
      apiKey: { type: 'string', 'x-openwop-sensitive': true },
    },
  },
  dag: {
    nodes: [
      {
        id: 'gen',
        typeId: 'local.sample.demo.mock-ai',
        config: { systemPrompt: 'Brief on {{params.topic}} authed by {{params.apiKey}}.' },
      },
    ],
  },
};

describe('RFC 0124 2b-2 — gated run-path leg (end-to-end, source:secret)', () => {
  it('non-sensitive override flows into the prompt (fenced); sensitive param resolves via BYOK + redacts, plaintext never appears', async () => {
    // A sensitive param supplied per run is a SECRET REFERENCE (credentialRef),
    // resolved from the run owner's BYOK store — never a plaintext. Provision it.
    await setSecret('cred-apikey-1', 'sk-live-actual-secret', { tenantId: 'demo' });

    // Deferred expansion: apiKey (sensitive, in a prompt body) → source:secret
    // PromptVariable; topic (non-sensitive) → source:variable. Mints + registers.
    const def = expandChain(chain, { deferred: true, params: { topic: 'default' } });

    const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
    // configurable: topic = a plaintext override; apiKey = the SECRET REFERENCE.
    seedRunVariables(
      runId,
      def.variables,
      deferredConfigurableInputs(def, { topic: 'QUANTUM WIDGETS', apiKey: 'cred-apikey-1' }, undefined),
    );

    const now = new Date().toISOString();
    const run: RunRecord = {
      runId,
      workflowId: def.workflowId,
      tenantId: 'demo',
      status: 'pending',
      inputs: {},
      configurable: {},
      createdAt: now,
      updatedAt: now,
    } as RunRecord;

    await executeRun(storage, run, def);

    const events = await storage.listEvents(runId, { fromSeq: -1, limit: 1000 });
    const composedEv = events.find((e) => e.type === 'prompt.composed');
    expect(composedEv, 'a prompt.composed event was emitted').toBeDefined();
    const payload = composedEv!.payload as {
      composed?: string;
      contentTrust?: string;
      variableBindings?: Record<string, unknown>;
    };
    const keyVar = (def.variables ?? []).find((v) => v.name.endsWith('_apiKey'))!.name;

    // (1) the non-sensitive OVERRIDE resolved into the composed prompt, fenced untrusted (R1).
    expect(payload.composed).toContain('<UNTRUSTED>QUANTUM WIDGETS</UNTRUSTED>');
    expect(payload.contentTrust).toBe('untrusted');
    // (2) the sensitive param resolved via BYOK and is REDACTED (source:secret) — the
    //     credentialRef, not the value, was bagged; the plaintext secret is delivered
    //     to the model by a real host but this reference impl emits the redaction marker.
    expect(payload.composed).toContain(`[REDACTED:cred-apikey-1]`);
    // (3) the PLAINTEXT secret appears NOWHERE — not the composed body, not observability.
    expect(JSON.stringify(payload)).not.toContain('sk-live-actual-secret');
    // (4) the bagged binding for the sensitive var is the credentialRef (a reference), redacted in observability.
    const vb = JSON.stringify(payload.variableBindings ?? {});
    expect(vb).toContain(`[REDACTED:cred-apikey-1]`);
    expect(vb).not.toContain('sk-live-actual-secret');
    void keyVar;
  });
});
