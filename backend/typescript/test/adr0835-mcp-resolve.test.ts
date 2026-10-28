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
 *
 * TST-BWA-5 (grade-tests w62): the fakes are typed against the real `Storage` /
 * `HostAdapterSuite` (the two methods overridden over the app's own instances), and each
 * refusal asserts its OWN message — three different checks answer `forbidden`. Red when the
 * `approvals:respond` check asks a weaker scope, when the gate check stops matching node ids,
 * when a gallery copy's chain is not resolved, when the reviewer is not passed, or when a
 * missing `value` is accepted. DOUBLE GUARD (recorded): the `!reviewer` line is backed by
 * `assertTenantScope`, which also refuses an absent subject — removing the line alone leaves
 * the unidentified caller refused (as `forbidden`, with the scope message); the case pins the
 * identified-caller message so the first guard is the one that answers.
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
import type { NodeContext, NodeOutcome, WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let appStorage: Storage;
let appSuite: HostAdapterSuite;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  appStorage = app.locals.storage as Storage;
  appSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { resolved.length = 0; });

interface Reply<T> { status: number; body: T }
function client(): { post: <T>(p: string, b?: unknown) => Promise<Reply<T>> } {
  let cookie = '';
  return {
    post: async <T>(path: string, body?: unknown): Promise<Reply<T>> => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
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
    ids[role] = (await c.post<{ user: { userId: string } }>(`${H}/test/login`, { email: `m835-${role}-${n++}@acme.test`, tenantId })).body.user.userId;
  }
  const orgId = (await owner.post<{ orgId: string }>(`${H}/orgs`, { name: 'Acme' })).body.orgId;
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
type Outcome = NodeOutcome & { error?: { code: string; message?: string } };
function nodeFor(tenantId: string): (ctx: Partial<NodeContext>) => Promise<Outcome> {
  const at = '2026-10-01T00:00:00.000Z';
  const interrupt = (interruptId: string, runId: string, nodeId: string): InterruptRecord =>
    ({ interruptId, runId, nodeId, kind: 'approval', token: `tok-${interruptId}`, data: {}, createdAt: at });
  const interrupts: Record<string, InterruptRecord> = {
    'int-review': interrupt('int-review', 'run-1', PREFIXED_REVIEW),
    'int-added': interrupt('int-added', 'run-1', 'deploy-approval'),
    // A run of the host-default same-id chain — the one shape main ALLOWED.
    'int-direct': interrupt('int-direct', 'run-2', PREFIXED_REVIEW),
  };
  const run = (runId: string, workflowId: string): RunRecord =>
    ({ runId, tenantId, workflowId, status: 'paused', inputs: {}, metadata: {}, configurable: {}, createdAt: at, updatedAt: at });
  const runs: Record<string, RunRecord> = { 'run-1': run('run-1', REPAIR_COPY), 'run-2': run('run-2', 'app-builder.repair') };
  // The app's own storage and suite, with the two reads this node makes answered from the table above.
  const storage: Storage = { ...appStorage, getInterrupt: async (id: string) => interrupts[id] ?? null, getRun: async (id: string) => runs[id] ?? null };
  const copy: WorkflowDefinition = { workflowId: REPAIR_COPY, metadata: { expandedFrom: { chainId: 'app-builder.repair' } }, nodes: [], edges: [] };
  const hostSuite: HostAdapterSuite = {
    ...appSuite,
    workflowCatalog: { ...appSuite.workflowCatalog, getWorkflow: async (id: string) => (id === REPAIR_COPY ? { workflowId: id, definition: copy } : null) },
  };
  registerAppBuilderMcpNodes({ storage, hostSuite });
  return async (ctx) => {
    const node = await getNodeRegistry().resolve(`${MCP_NODE_PREFIX}resolve-paused-task`);
    const full: NodeContext = { runId: 'mcp-run', nodeId: 'n', tenantId, inputs: {}, config: {}, configurable: {}, attempt: 1, secrets: {}, emit: async () => ({ eventId: '', sequence: 0 }), ...ctx };
    return (await node!.execute(full)) as Outcome;
  };
}

describe('ADR 0835 D4 — who may answer an app-builder review over MCP', () => {
  it('refuses a caller without approvals:respond (a Viewer), and never reaches the resume', async () => {
    const m = await members();
    for (const interruptId of ['int-direct', 'int-review']) {
      const out = await nodeFor(m.tenantId)({ actingUserId: m.viewerId, inputs: { interruptId, value: { action: 'approve' } } });
      expect(out.status, interruptId).toBe('failure');
      expect(out.error, interruptId).toEqual({ code: 'forbidden', message: 'Your role in this workspace cannot answer reviews (approvals:respond).' });
    }
    expect(resolved).toHaveLength(0);
  });

  it('refuses an unidentified caller', async () => {
    const m = await members();
    const out = await nodeFor(m.tenantId)({ inputs: { interruptId: 'int-direct', value: { action: 'approve' } } });
    expect(out.error).toEqual({ code: 'forbidden', message: 'Resolving a review needs an identified caller.' });
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
    expect(out.error).toEqual({ code: 'forbidden', message: "Only the app-builder design and repair chains' own review gates can be resolved over MCP." });
    expect(resolved).toHaveLength(0);
  });

  it('refuses a missing answer instead of inventing { resolved: true }', async () => {
    const m = await members();
    const out = await nodeFor(m.tenantId)({ actingUserId: m.editorId, inputs: { interruptId: 'int-review' } });
    expect(out.error?.code).toBe('validation_error');
    expect(out.error?.message).toContain('`value` is required');
    expect(resolved).toHaveLength(0);
  });
});
