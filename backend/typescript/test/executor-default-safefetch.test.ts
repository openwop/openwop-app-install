/**
 * Regression test for MEDIA-1 (grade-code 2026-06-22): the executor MUST expose
 * `ctx.http.safeFetch` to EVERY run, not only runs that opted into Connections.
 *
 * The notebooks YouTube-ingest node (`feature.notebooks.nodes.fetch-youtube-source`)
 * requires `ctx.http.safeFetch` for SSRF-guarded egress to a PUBLIC host (it needs
 * no user credential). Before the fix the executor injected `http.safeFetch` only
 * when `run.configurable.connections` was non-empty, so the ingest workflow — which
 * declares no connections — threw `host_capability_missing` in production while
 * passing every mock-`ctx` unit test. This drives a real `executeRun()` (no mock
 * ctx) and asserts a no-connections run still sees a callable `ctx.http.safeFetch`.
 *
 * Tracker: TST-DBC-2. Red when: the executor provides `ctx.http` only for runs
 * whose `connections` is non-empty (probe w70g2-sf-always → case 1), or only for
 * runs with none (w70g2-sf-optin → case 2).
 *
 * Case 2 is NOT covered by `connection-injection.test.ts`: that file builds the
 * safeFetch with `makeConnectionSafeFetch` directly and never goes through the
 * executor's `ctx`, so an executor that dropped `ctx.http` for opted-in runs
 * leaves it green (cross-file probe w70g2-sf-optin-ci-r2).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-safefetch-')) });

interface Observation { hasHttp: boolean; safeFetchType: string }
const observations: Observation[] = [];

beforeAll(() => {
  getNodeRegistry().register({
    typeId: 'test.observe-safefetch',
    version: '1.0.0',
    async execute(ctx) {
      observations.push({ hasHttp: !!ctx.http, safeFetchType: typeof ctx.http?.safeFetch });
      return { status: 'success', outputs: { output: null } };
    },
  });
});

let runSeq = 0;
async function newRun(configurable: Record<string, unknown>): Promise<RunRecord> {
  const now = new Date().toISOString();
  runSeq += 1;
  const run: RunRecord = {
    runId: `run-safefetch-${runSeq}`,
    workflowId: 'wf.safefetch',
    tenantId: 'demo',
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable,
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

const def: WorkflowDefinition = {
  workflowId: 'wf.safefetch',
  nodes: [{ nodeId: 'a', typeId: 'test.observe-safefetch' }],
  edges: [],
};

describe('executor — ctx.http.safeFetch is always provided (MEDIA-1)', () => {
  it('exposes a callable safeFetch to a run with NO Connections opted in', async () => {
    observations.length = 0;
    const run = await newRun({}); // no `connections` ⇒ the old code provided no http seam
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    expect(observations).toHaveLength(1);
    expect(observations[0]?.hasHttp).toBe(true);
    expect(observations[0]?.safeFetchType).toBe('function');
  });

  it('still exposes safeFetch when Connections ARE opted in', async () => {
    observations.length = 0;
    const run = await newRun({ connections: ['github'] });
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    expect(observations).toHaveLength(1);
    expect(observations[0]?.hasHttp).toBe(true);
    expect(observations[0]?.safeFetchType).toBe('function');
  });
});
