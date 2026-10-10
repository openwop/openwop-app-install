/**
 * ADR 0823 — a run executes only a workflow its tenant may read.
 *
 * The M7 read guard answers tenant B's GET of tenant A's workflow with a 404, but
 * nothing applied it to EXECUTION: the catalog and `resolveLaunchWorkflow` are
 * untenanted, so B could `POST /runs {workflowId: <A's id>}` (201) and run A's
 * definition inside B's tenant, with B's keys, reading A's prompts back through
 * the run's events. A `core.subWorkflow` child, a `:fork`, a host-event binding,
 * a trigger subscription, a starter-driven launch and a cross-canvas invoke all
 * resolved the same id the same way.
 *
 * Every refusal is the launcher's EXISTING not-found, so an owned id is
 * indistinguishable from an unknown one. Positive controls: the owner, a SHARED
 * (seeded) id, and a host system workflow stay runnable by everyone.
 *
 * Route-level on purpose: the boundary is two cookie sessions on two tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import type express from 'express';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { recordOwnership, removeOwnership } from '../src/host/workflowOwnership.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { createCanvasSurface } from '../src/host/canvasSurface.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

describe('ADR 0823 — cross-tenant workflow launch', () => {
  let server: http.Server;
  let BASE: string;
  let storage: Storage;
  let hostSuite: HostAdapterSuite;

  function client() {
    let cookie = '';
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const ck of getSetCookies(res.headers) as string[]) {
        const m = /(__session=[^;]+)/.exec(ck);
        if (m) cookie = m[1];
      }
      return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
    };
  }

  const noopDef = (workflowId: string, marker: string) => ({
    workflowId,
    metadata: { name: marker },
    nodes: [{ nodeId: 'a', typeId: 'core.noop', config: { marker } }],
    edges: [],
  });

  let alice: ReturnType<typeof client>;
  let bob: ReturnType<typeof client>;
  const ALICE_WF = 'wf-xtenant-alice-private';

  async function waitTerminal(runId: string): Promise<string> {
    for (let i = 0; i < 100; i += 1) {
      const run = await storage.getRun(runId);
      if (run && TERMINAL.has(run.status)) return run.status;
      await new Promise((r) => setTimeout(r, 50));
    }
    return (await storage.getRun(runId))?.status ?? 'missing';
  }

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app: express.Express = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage as Storage;
    hostSuite = app.locals.hostSuite as HostAdapterSuite;
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    alice = client();
    bob = client();
    expect((await alice('POST', '/host/openwop-app/test/login', { email: 'alice@acme.test', tenantId: 'org:alice' })).status).toBe(201);
    expect((await bob('POST', '/host/openwop-app/test/login', { email: 'bob@acme.test', tenantId: 'org:bob' })).status).toBe(201);
    expect((await alice('POST', '/host/openwop-app/workflows', noopDef(ALICE_WF, 'alice-secret'))).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  // ── positive controls ────────────────────────────────────────────────────

  it('the OWNER can run its own workflow', async () => {
    const r = await alice('POST', '/runs', { workflowId: ALICE_WF, inputs: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('a host system workflow (unowned) stays runnable by every tenant', async () => {
    const r = await bob('POST', '/runs', { workflowId: 'openwop-app.uppercase', inputs: { text: 'hi' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('a SHARED (seeded) id owned by another tenant stays runnable', async () => {
    // What a seeder does: one shared definition, a per-tenant ownership row.
    const shared = 'tmpl.adr0823-shared-witness';
    registerWorkflow({ ...noopDef(shared, 'shared'), nodes: [{ nodeId: 'a', typeId: 'core.noop' }] } as never);
    await recordOwnership('org:alice', shared, { name: 'shared', nodeCount: 1 });
    const r = await bob('POST', '/runs', { workflowId: shared, inputs: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('a tenant\'s own ADR 0789 FORK of a shared workflow resolves as OWNED (run + starter); others are refused', async () => {
    const shared = 'tmpl.adr0823-fork-witness';
    registerWorkflow({ ...noopDef(shared, 'shared'), nodes: [{ nodeId: 'a', typeId: 'core.noop' }] } as never);
    await recordOwnership('org:bob', shared, { name: 'shared', nodeCount: 1 });
    // Bob edits the shared definition: the save copy-on-write FORKS it to a new id.
    const saved = await bob('POST', '/host/openwop-app/workflows', noopDef(shared, 'bob edit'));
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const forkId = String(saved.body?.workflowId);
    expect(forkId).not.toBe(shared);
    expect((await bob('POST', '/runs', { workflowId: forkId, inputs: {} })).status).toBe(201);
    // A schedule / agent launch of the fork goes through the starter.
    expect(await startWorkflowRun({ storage, hostSuite } as never, { tenantId: 'org:bob', workflowId: forkId, inputs: {} } as never)).toEqual(expect.any(String));
    // The fork is Bob's own content now — not shared, so Alice cannot run it.
    expect((await alice('POST', '/runs', { workflowId: forkId, inputs: {} })).status).toBe(404);
  });

  it('D6 — a wildcard operator (already able to act as any tenant) may launch across tenants', async () => {
    const res = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      body: JSON.stringify({ workflowId: ALICE_WF, inputs: {}, tenantId: 'org:bob' }),
    });
    expect(res.status, await res.text()).toBe(201);
  });

  // ── refusals ─────────────────────────────────────────────────────────────

  it('the read guard already holds (control): B cannot GET A\'s workflow', async () => {
    expect((await bob('GET', `/workflows/${ALICE_WF}`)).status).toBe(404);
  });

  it('run-create: B cannot run A\'s workflow — the same 404 as an unknown id', async () => {
    const r = await bob('POST', '/runs', { workflowId: ALICE_WF, inputs: {} });
    const unknown = await bob('POST', '/runs', { workflowId: 'wf-xtenant-never-registered', inputs: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(unknown.status).toBe(404);
    expect((r.body as { error?: { code?: string } } | undefined)?.error?.code ?? r.body?.code)
      .toBe((unknown.body as { error?: { code?: string } } | undefined)?.error?.code ?? unknown.body?.code);
  });

  it('core.subWorkflow: B\'s own parent cannot dispatch A\'s workflow as its child', async () => {
    const parentOf = async (parentId: string, childId: string) => {
      const created = await bob('POST', '/host/openwop-app/workflows', {
        workflowId: parentId,
        metadata: { name: parentId },
        nodes: [{ nodeId: 'child', typeId: 'core.subWorkflow', config: { workflowId: childId } }],
        edges: [],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const r = await bob('POST', '/runs', { workflowId: parentId, inputs: {} });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      // The response carries the tenant-BOUND id (`o-bob/<uuid>`); storage keys the bare one.
      const runId = String(r.body?.runId).split('/').pop() ?? '';
      const status = await waitTerminal(runId);
      return { runId, status, children: await storage.listRunsByParent(runId), events: await storage.listEvents(runId) };
    };

    // Positive control: the SAME shape with B's own child dispatches it.
    expect((await bob('POST', '/host/openwop-app/workflows', noopDef('wf-xtenant-bob-child', 'bob child'))).status).toBe(201);
    const own = await parentOf('wf-xtenant-bob-parent-own', 'wf-xtenant-bob-child');
    expect(own.children.map((c) => c.workflowId)).toEqual(['wf-xtenant-bob-child']);

    const foreign = await parentOf('wf-xtenant-bob-parent', ALICE_WF);
    expect(foreign.status).toBe('failed');
    expect(foreign.children).toEqual([]);
    // …and it failed for THIS reason, not some unrelated validation error.
    // (The dispatcher's typed code is normalised to `internal_error` on the wire;
    // the message is the same one an unknown child id produces.)
    const failed = foreign.events.find((e) => e.type === 'node.failed');
    expect(JSON.stringify(failed?.payload)).toContain(`child workflow '${ALICE_WF}' not found in catalog`);
  });

  it(':fork: a run of A\'s workflow in B\'s tenant (minted before the fix) cannot be re-executed', async () => {
    // Mint the tainted state the hole left behind: a completed run in B's tenant
    // whose workflow is owned by A. B runs its own workflow (real events), then the
    // ownership row moves to A — the shape a pre-fix `POST /runs` would have left.
    const wf = 'wf-xtenant-bob-then-alice';
    expect((await bob('POST', '/host/openwop-app/workflows', noopDef(wf, 'v1'))).status).toBe(201);
    const r = await bob('POST', '/runs', { workflowId: wf, inputs: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const runId = String(r.body?.runId).split('/').pop() ?? '';
    expect(await waitTerminal(runId)).toBe('completed');
    const statusPath = new URL(String(r.body?.statusUrl)).pathname;
    // Control: while B owns it, the fork is accepted.
    const ok = await bob('POST', `${statusPath}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await removeOwnership('org:bob', wf);
    await recordOwnership('org:alice', wf, { name: 'v1', nodeCount: 1 });
    const fork = await bob('POST', `${statusPath}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(404);
  });

  it('host-event binding: B cannot bind A\'s workflow (the same refusal as an unknown id)', async () => {
    const r = await bob('POST', '/host/openwop-app/host-events/bindings', { eventType: 'host.cms.page.published', workflowId: ALICE_WF });
    const unknown = await bob('POST', '/host/openwop-app/host-events/bindings', { eventType: 'host.cms.page.published', workflowId: 'wf-xtenant-never-registered' });
    expect(r.status, JSON.stringify(r.body)).toBe(unknown.status);
    expect(r.status).not.toBe(201);
  });

  it('trigger subscription: B cannot bind A\'s workflow (the same refusal as an unknown id)', async () => {
    const r = await bob('POST', '/trigger-subscriptions', { source: 'form', workflowId: ALICE_WF, verification: { mode: 'none' } });
    const unknown = await bob('POST', '/trigger-subscriptions', { source: 'form', workflowId: 'wf-xtenant-never-registered', verification: { mode: 'none' } });
    expect(r.status, JSON.stringify(r.body)).toBe(unknown.status);
    expect(r.status).not.toBe(201);
  });

  it('starter-driven launch (schedules, agents, host events, webhooks): refused for B, allowed for A', async () => {
    const deps = { storage, hostSuite };
    expect(await startWorkflowRun(deps as never, { tenantId: 'org:bob', workflowId: ALICE_WF, inputs: {} } as never)).toBeNull();
    expect(await startWorkflowRun(deps as never, { tenantId: 'org:alice', workflowId: ALICE_WF, inputs: {} } as never)).toEqual(expect.any(String));
  });

  it('cross-canvas invoke: B cannot invoke A\'s workflow as a child run', async () => {
    const surface = createCanvasSurface({ tenantId: 'org:bob' });
    await expect(surface.invoke('canvas-x', ALICE_WF, {}, { awaitTerminal: false }))
      .rejects.toMatchObject({ code: 'canvas_invoke_workflow_not_found' });
    // Control: the owner's invoke of the same id still dispatches.
    const own = await createCanvasSurface({ tenantId: 'org:alice' }).invoke('canvas-x', ALICE_WF, {}, { awaitTerminal: false });
    expect(own.childRunId).toEqual(expect.any(String));
  });
});
