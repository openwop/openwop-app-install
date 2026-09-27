/**
 * ADR 0474 P1a-3 — the history HTTP surface. Drives the real app: owner-gated
 * revisions list (isHead/published flags), promote stamping publishedRevision,
 * rollback restoring a prior revision as the new head (append-only history,
 * re-head by seq), and the IDOR 404 posture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('workflow revisions routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const WF = 'rev-route-wf-1';
  const API = '/v1/host/openwop-app/workflows';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  }

  const defV = (nodes: Array<{ nodeId: string; typeId: string }>, name: string) => ({
    workflowId: WF, nodes, edges: [], metadata: { name, lifecycle: { transient: true, generatedBy: 'test' } },
  });

  it('save → edit → history lists both revisions with isHead on the newest', async () => {
    const v1 = await call('POST', API, defV([{ nodeId: 'a', typeId: 'core.noop' }], 'v1'));
    expect(v1.status).toBe(201);
    const v2 = await call('POST', API, defV([{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }], 'v2'));
    expect(v2.status).toBe(201);

    const list = await call<{ items: Array<{ revisionHash: string; isHead: boolean; nodeCount: number; supersedes?: string }> }>('GET', `${API}/${WF}/revisions`);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(2);
    expect(list.body.items[0]!.isHead).toBe(true);
    expect(list.body.items[0]!.nodeCount).toBe(2);
    expect(list.body.items[0]!.supersedes).toBe(list.body.items[1]!.revisionHash);
  });

  it('promote stamps publishedRevision (visible in the list)', async () => {
    // promote requires a completed run — create one through the real runs API.
    const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {} });
    expect(run.status).toBe(201);
    for (let i = 0; i < 100; i += 1) {
      const r = await call<{ status: string }>('GET', `/v1/runs/${run.body.runId}`);
      if (r.body.status && r.body.status !== 'pending' && r.body.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const promote = await call<{ publishedRevision?: string }>('POST', `${API}/${WF}/promote`);
    expect(promote.status).toBe(200);
    expect(promote.body.publishedRevision).toBeTruthy();
    const list = await call<{ items: Array<{ revisionHash: string; published: boolean; isHead: boolean }> }>('GET', `${API}/${WF}/revisions`);
    expect(list.body.items.find((r) => r.published)?.isHead).toBe(true);
  });

  it('rollback restores a prior revision as the new head (history stays append-only)', async () => {
    const list = await call<{ items: Array<{ revisionHash: string; nodeCount: number; isHead: boolean }> }>('GET', `${API}/${WF}/revisions`);
    const v1row = list.body.items.find((r) => r.nodeCount === 1)!;
    expect(v1row).toBeTruthy();

    const rb = await call<{ restoredRevision: string }>('POST', `${API}/${WF}/rollback`, { revisionHash: v1row.revisionHash });
    expect(rb.status).toBe(200);
    expect(rb.body.restoredRevision).toBe(v1row.revisionHash);

    const after = await call<{ items: Array<{ revisionHash: string; nodeCount: number; isHead: boolean }> }>('GET', `${API}/${WF}/revisions`);
    expect(after.body.items.length).toBe(2); // append-only: same two rows, re-headed
    expect(after.body.items[0]!.revisionHash).toBe(v1row.revisionHash);
    expect(after.body.items[0]!.isHead).toBe(true);
    expect(after.body.items[0]!.nodeCount).toBe(1);
  });

  it('unknown revision and unknown workflow are 404s; bad body is a 400', async () => {
    expect((await call('POST', `${API}/${WF}/rollback`, { revisionHash: 'nope'.repeat(16) })).status).toBe(404);
    expect((await call('GET', `${API}/does-not-exist/revisions`)).status).toBe(404);
    expect((await call('POST', `${API}/${WF}/rollback`, {})).status).toBe(400);
  });

  it('a fork persists definitionResolvedFrom + the inherited pin (review H1)', async () => {
    const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {} });
    expect(run.status).toBe(201);
    for (let i = 0; i < 100; i += 1) {
      const r = await call<{ status: string }>('GET', `/v1/runs/${run.body.runId}`);
      if (r.body.status && r.body.status !== 'pending' && r.body.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const fork = await call<{ runId: string }>('POST', `/v1/runs/${run.body.runId}:fork`, { mode: 'replay' });
    expect(fork.status).toBe(201);
    const info = await call<{ definitionRevision?: string; definitionResolvedFrom?: string }>('GET', `/v1/host/openwop-app/runs/${fork.body.runId}/revision`);
    expect(info.status).toBe(200);
    expect(info.body.definitionRevision).toBeTruthy();           // inherited pin persisted
    expect(info.body.definitionResolvedFrom).toBe('revision');   // the honesty stamp persisted
  });

  it('rollback preserves the CURRENT lifecycle — a promoted workflow never reverts to a hidden draft (review H2)', async () => {
    // WF was promoted earlier in this suite; every stored snapshot carries
    // transient:true from its save-time lifecycle. Roll back and confirm the
    // workflow is STILL visible/promoted (transient falsy on the scoped list).
    const list0 = await call<{ items: Array<{ revisionHash: string; isHead: boolean }> }>('GET', `${API}/${WF}/revisions`);
    const nonHead = list0.body.items.find((r) => !r.isHead)!;
    const rb = await call('POST', `${API}/${WF}/rollback`, { revisionHash: nonHead.revisionHash });
    expect(rb.status).toBe(200);
    const scoped = await call<{ workflows: Array<{ workflowId: string; transient?: boolean; archivedAt?: string }> }>('GET', API);
    const row = scoped.body.workflows.find((w) => w.workflowId === WF);
    expect(row).toBeTruthy();
    expect(row!.transient ?? false).toBe(false);
    expect(row!.archivedAt ?? undefined).toBeUndefined();
  });

  it('a client-spoofed definitionRevision is stripped at run creation (review M1)', async () => {
    const spoof = 'f'.repeat(64);
    const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {}, metadata: { definitionRevision: spoof, definitionResolvedFrom: 'revision' } });
    expect(run.status).toBe(201);
    const info = await call<{ definitionRevision?: string; definitionResolvedFrom?: string }>('GET', `/v1/host/openwop-app/runs/${run.body.runId}/revision`);
    expect(info.status).toBe(200);
    expect(info.body.definitionRevision).toBeTruthy();
    expect(info.body.definitionRevision).not.toBe(spoof); // the host stamped the truth
    expect(info.body.definitionResolvedFrom).toBeUndefined(); // spoof stripped; only forks set it
  });


  describe('published-launch resolution (ADR 0474 P1b)', () => {
    const WF2 = 'rev-route-wf-launch';
    const def2 = (nodes: Array<{ nodeId: string; typeId: string }>, name: string) => ({
      workflowId: WF2, nodes, edges: [], metadata: { name, lifecycle: { transient: true, generatedBy: 'test' } },
    });
    let publishedHash: string;

    async function settle(runId: string): Promise<void> {
      for (let i = 0; i < 100; i += 1) {
        const r = await call<{ status: string }>('GET', `/v1/runs/${runId}`);
        if (r.body.status && r.body.status !== 'pending' && r.body.status !== 'running') return;
        await new Promise((res) => setTimeout(res, 25));
      }
    }

    it('a production launch runs the PUBLISHED revision after the head moves', async () => {
      expect((await call('POST', API, def2([{ nodeId: 'a', typeId: 'core.noop' }], 'v1'))).status).toBe(201);
      const seed = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF2, inputs: {} });
      await settle(seed.body.runId);
      const promote = await call<{ publishedRevision?: string }>('POST', `${API}/${WF2}/promote`);
      expect(promote.status).toBe(200);
      publishedHash = promote.body.publishedRevision!;

      // Head moves past the published revision.
      expect((await call('POST', API, def2([{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }], 'v2'))).status).toBe(201);

      const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF2, inputs: {} });
      expect(run.status).toBe(201);
      const info = await call<{ definitionRevision?: string }>('GET', `/v1/host/openwop-app/runs/${run.body.runId}/revision`);
      expect(info.body.definitionRevision).toBe(publishedHash); // ran the PUBLISHED def
    });

    it("the builder's draft run (metadata.launch='draft') runs the head", async () => {
      const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF2, inputs: {}, metadata: { launch: 'draft' } });
      expect(run.status).toBe(201);
      const info = await call<{ definitionRevision?: string }>('GET', `/v1/host/openwop-app/runs/${run.body.runId}/revision`);
      expect(info.body.definitionRevision).toBeTruthy();
      expect(info.body.definitionRevision).not.toBe(publishedHash); // the HEAD, not published
    });

    it('the scoped list surfaces publishedBehindHead', async () => {
      const scoped = await call<{ workflows: Array<{ workflowId: string; publishedRevision?: string; publishedBehindHead?: boolean }> }>('GET', API);
      const row = scoped.body.workflows.find((w) => w.workflowId === WF2)!;
      expect(row.publishedRevision).toBe(publishedHash);
      expect(row.publishedBehindHead).toBe(true);
    });
  });

});
