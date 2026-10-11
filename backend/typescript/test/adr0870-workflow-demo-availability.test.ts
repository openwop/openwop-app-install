/**
 * ADR 0870 §Stopgap — `GET /host/openwop-app/workflows/availability`.
 *
 * The Work-Twin portfolio cards read this to label a mock-AI workflow a DEMO
 * and to refuse "Run now" where the mock node is not registered.
 *
 * Two witnesses:
 *   1. POSTURE: the REAL node bootstrap (`ensureNodesRegistered`, which holds
 *      the LEAK-3 `enterprisePosture()` guard) under each deploy posture, in a
 *      fresh module graph per posture (registration is a once-per-process boot
 *      snapshot). The same composed mock-AI definition must flip from runnable
 *      to `demo-node-unavailable` with no other change. The definition is
 *      inline, not read from the template catalog: ADR 0775 P2 moved the
 *      `tmpl.*` templates into a chain pack that only a full boot registers,
 *      and a full `createApp` under `auth` is refused by its own server guards
 *      (KMS, durable surfaces), none of which this signal depends on. That the
 *      REAL template reads as demo is witness 2's job.
 *   2. ROUTE: the HTTP surface on a real app boot (default posture), including
 *      the tenant-filtered catalog read and the no-oracle answer for unknowns.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { assessWorkflowAvailability, MOCK_AI_TYPE_ID } from '../src/host/workflowDemoAvailability.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

/** A composed template: its own steps AND its `core.subWorkflow` child are mock-AI. */
const DEMO_ID = 'tmpl.meeting-ops.post-meeting-follow-up';
const PLAIN_ID = 'openwop-app.uppercase';
const MISSING_ID = 'wf.copy.nope.0000000000000000';

/** Witness 1's definitions: the template shape (a mock-AI step plus a
 *  `core.subWorkflow` child that is mock-AI too), without the catalog. */
const POSTURE_DEFS: Record<string, WorkflowDefinition> = {
  'posture.parent': {
    workflowId: 'posture.parent',
    nodes: [
      { nodeId: 'draft', typeId: MOCK_AI_TYPE_ID },
      { nodeId: 'call', typeId: 'core.subWorkflow', config: { workflowId: 'posture.child' } },
    ],
  } as WorkflowDefinition,
  'posture.child': { workflowId: 'posture.child', nodes: [{ nodeId: 'ai', typeId: MOCK_AI_TYPE_ID }] } as WorkflowDefinition,
};

interface Row { workflowId: string; known: boolean; demo: boolean; runnable: boolean; reason?: string }

const saved = process.env.OPENWOP_DEPLOY_POSTURE;
afterAll(() => {
  if (saved === undefined) delete process.env.OPENWOP_DEPLOY_POSTURE;
  else process.env.OPENWOP_DEPLOY_POSTURE = saved;
  vi.resetModules();
});

describe.each([
  { posture: 'cookie-per-visitor', expected: { workflowId: 'posture.parent', known: true, demo: true, runnable: true } },
  { posture: 'auth', expected: { workflowId: 'posture.parent', known: true, demo: true, runnable: false, reason: 'demo-node-unavailable' } },
])('availability signal under posture=$posture (real LEAK-3 registration)', ({ posture, expected }) => {
  it('labels a composed mock-AI workflow a demo with the posture-correct runnability', async () => {
    vi.resetModules();
    process.env.OPENWOP_DEPLOY_POSTURE = posture;
    const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const mod = await import('../src/host/workflowDemoAvailability.js');
    ensureNodesRegistered();
    const registry = getNodeRegistry();
    // The control: the posture really did change registration.
    expect(registry.isResolvable(MOCK_AI_TYPE_ID)).toBe(posture !== 'auth');
    const rows = await mod.assessWorkflowAvailability(['posture.parent'], {
      readDefinition: async (id) => POSTURE_DEFS[id] ?? null,
      isResolvable: (t) => registry.isResolvable(t),
    });
    expect(rows).toEqual([expected]);
  }, 60_000);
});

describe('availability route (real app boot, default posture)', () => {
  let server: http.Server | undefined;
  let base = '';
  beforeAll(async () => {
    vi.resetModules();
    delete process.env.OPENWOP_DEPLOY_POSTURE;
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      const s = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`; res(); });
      server = s;
    });
  }, 120_000);
  afterAll(async () => { if (server) await new Promise<void>((res) => server!.close(() => res())); });

  async function availability(ids: string[]): Promise<{ status: number; rows: Row[] }> {
    const r = await fetch(`${base}/host/openwop-app/workflows/availability?ids=${ids.map(encodeURIComponent).join(',')}`, {
      headers: { authorization: 'Bearer dev-token' },
    });
    const body = (await r.json()) as { availability?: Row[] };
    return { status: r.status, rows: body.availability ?? [] };
  }

  it('answers demo + runnable for a mock-AI template and plain for a non-mock one', async () => {
    const { status, rows } = await availability([DEMO_ID, PLAIN_ID]);
    expect(status).toBe(200);
    expect(rows).toEqual([
      { workflowId: DEMO_ID, known: true, demo: true, runnable: true },
      { workflowId: PLAIN_ID, known: true, demo: false, runnable: true },
    ]);
  });

  it('an unknown or malformed id answers known:false (no 4xx, no oracle)', async () => {
    const { status, rows } = await availability([MISSING_ID, 'bad id with spaces']);
    expect(status).toBe(200);
    expect(rows.map((r) => [r.workflowId, r.known, r.runnable])).toEqual([
      [MISSING_ID, false, false],
      ['bad id with spaces', false, false],
    ]);
  });

  it('an empty ids param answers an empty list', async () => {
    const r = await fetch(`${base}/host/openwop-app/workflows/availability`, { headers: { authorization: 'Bearer dev-token' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ availability: [] });
  });
});

describe('assessWorkflowAvailability (pure)', () => {
  const defs: Record<string, WorkflowDefinition> = {
    parent: { workflowId: 'parent', nodes: [{ nodeId: 'call', typeId: 'core.subWorkflow', config: { workflowId: 'child' } }] } as WorkflowDefinition,
    child: { workflowId: 'child', nodes: [{ nodeId: 'ai', typeId: MOCK_AI_TYPE_ID }] } as WorkflowDefinition,
    loop: { workflowId: 'loop', nodes: [{ nodeId: 'self', typeId: 'core.subWorkflow', config: { workflowId: 'loop' } }] } as WorkflowDefinition,
  };
  const read = async (id: string) => defs[id] ?? null;

  it('finds the mock node through a sub-workflow child', async () => {
    const [row] = await assessWorkflowAvailability(['parent'], { readDefinition: read, isResolvable: () => false });
    expect(row).toEqual({ workflowId: 'parent', known: true, demo: true, runnable: false, reason: 'demo-node-unavailable' });
  });

  it('terminates on a self-referencing sub-workflow and dedupes ids', async () => {
    const rows = await assessWorkflowAvailability(['loop', 'loop'], { readDefinition: read, isResolvable: () => false });
    expect(rows).toEqual([{ workflowId: 'loop', known: true, demo: false, runnable: true }]);
  });
});
