/**
 * ADR 0835 D4 — `app-builder-resolve-paused-task` over MCP (S4, S5).
 *
 * On `origin/main` the node called `resolveAndResume` with no reviewer. That
 * takes the token lane, which on an open single-approver gate — the repair
 * chain's review is one — consults no scope: any MCP client in the tenant could
 * approve a repair that then wrote the canvas, attributed to nobody. And the
 * workflow allowlist matched `run.workflowId` exactly, so every run started
 * from the gallery (a template copy with a minted id) was refused.
 *
 * `resolveAndResume` is stubbed: these legs pin WHO may reach it and with what
 * reviewer, not the resume machinery (covered by the interrupts suites).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const resolved: { interruptId: string; value: unknown; reviewer: unknown }[] = [];
vi.mock('../src/routes/interrupts.js', async (orig) => ({
  ...(await orig<typeof import('../src/routes/interrupts.js')>()),
  resolveAndResume: async (_s: unknown, _h: unknown, interruptId: string, value: unknown, reviewer: unknown) => { resolved.push({ interruptId, value, reviewer }); },
}));

import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerAppBuilderMcpNodes, MCP_NODE_PREFIX } from '../src/features/app-builder/mcpControlNodes.js';
import type { NodeContext } from '../src/executor/types.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { resolved.length = 0; });

function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: any }> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
  };
}
const H = '/host/openwop-app';

/** One shared tenant: an editor (approvals:respond) and a viewer (not). */
async function members() {
  const tenantId = `org:mcp835-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post(`${H}/test/login`, { email: `m835-o-${n++}@acme.test`, tenantId });
  const ids: Record<string, string> = {};
  for (const role of ['editor', 'viewer']) {
    const c = client();
    ids[role] = (await c.post(`${H}/test/login`, { email: `m835-${role}-${n++}@acme.test`, tenantId })).body.user.userId;
  }
  const orgId: string = (await owner.post(`${H}/orgs`, { name: 'Acme' })).body.orgId;
  for (const role of ['editor', 'viewer']) {
    const add = await owner.post(`${H}/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject: ids[role], roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  return { tenantId, editorId: ids.editor!, viewerId: ids.viewer! };
}

const REPAIR_COPY = 'wf-tenant-copy-of-repair';
const PREFIXED_REVIEW = 'app-builder_repair_0123456789ab_review';

/** Register the nodes over a fake storage + catalog: one interrupt on a
 *  gallery copy of the repair chain, one on a gate a member added to it. */
function nodeFor(tenantId: string): (ctx: Partial<NodeContext>) => Promise<{ status: string; error?: { code: string } }> {
  const interrupts: Record<string, { interruptId: string; runId: string; nodeId: string; kind: string }> = {
    'int-review': { interruptId: 'int-review', runId: 'run-1', nodeId: PREFIXED_REVIEW, kind: 'approval' },
    'int-added': { interruptId: 'int-added', runId: 'run-1', nodeId: 'deploy-approval', kind: 'approval' },
    // A run of the host-default same-id chain — the one shape main ALLOWED.
    'int-direct': { interruptId: 'int-direct', runId: 'run-2', nodeId: PREFIXED_REVIEW, kind: 'approval' },
  };
  const runs: Record<string, { runId: string; tenantId: string; workflowId: string; status: string }> = {
    'run-1': { runId: 'run-1', tenantId, workflowId: REPAIR_COPY, status: 'paused' },
    'run-2': { runId: 'run-2', tenantId, workflowId: 'app-builder.repair', status: 'paused' },
  };
  const storage = {
    getInterrupt: async (id: string) => interrupts[id] ?? null,
    getRun: async (id: string) => runs[id] ?? null,
  };
  const hostSuite = {
    workflowCatalog: { getWorkflow: async (id: string) => (id === REPAIR_COPY ? { workflowId: id, definition: { workflowId: id, metadata: { expandedFrom: { chainId: 'app-builder.repair' } }, nodes: [], edges: [] } } : null) },
  };
  registerAppBuilderMcpNodes({ storage: storage as never, hostSuite: hostSuite as never });
  return async (ctx) => {
    const node = await getNodeRegistry().resolve(`${MCP_NODE_PREFIX}resolve-paused-task`);
    return (await node!.execute({ runId: 'mcp-run', nodeId: 'n', tenantId, config: {}, configurable: {}, attempt: 1, secrets: {}, emit: async () => ({ eventId: '', sequence: 0 }), ...ctx } as NodeContext)) as never;
  };
}

describe('ADR 0835 D4 — who may answer an app-builder review over MCP', () => {
  it('refuses a caller without approvals:respond (a Viewer), and never reaches the resume', async () => {
    const m = await members();
    for (const interruptId of ['int-direct', 'int-review']) {
      const out = await nodeFor(m.tenantId)({ actingUserId: m.viewerId, inputs: { interruptId, value: { action: 'approve' } } });
      expect(out.status, interruptId).toBe('failure');
      expect(out.error?.code, interruptId).toBe('forbidden');
    }
    expect(resolved).toHaveLength(0);
  });

  it('refuses an unidentified caller', async () => {
    const m = await members();
    const out = await nodeFor(m.tenantId)({ inputs: { interruptId: 'int-direct', value: { action: 'approve' } } });
    expect(out.error?.code).toBe('forbidden');
    expect(resolved).toHaveLength(0);
  });

  it('answers the review of a GALLERY COPY for an editor, attributed to them', async () => {
    const m = await members();
    const out = await nodeFor(m.tenantId)({ actingUserId: m.editorId, inputs: { interruptId: 'int-review', value: { action: 'approve' } } });
    expect(out.status, JSON.stringify(out)).toBe('success');
    expect(resolved).toEqual([{ interruptId: 'int-review', value: { action: 'approve' }, reviewer: { subjectRef: m.editorId } }]);
  });

  it('refuses a gate the chain does not own, even on a chain copy', async () => {
    const m = await members();
    const out = await nodeFor(m.tenantId)({ actingUserId: m.editorId, inputs: { interruptId: 'int-added', value: { action: 'approve' } } });
    expect(out.error?.code).toBe('forbidden');
    expect(resolved).toHaveLength(0);
  });

  it('refuses a missing answer instead of inventing { resolved: true }', async () => {
    const m = await members();
    const out = await nodeFor(m.tenantId)({ actingUserId: m.editorId, inputs: { interruptId: 'int-review' } });
    expect(out.error?.code).toBe('validation_error');
    expect(resolved).toHaveLength(0);
  });
});
