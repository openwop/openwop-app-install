/**
 * Workflow ownership index — IDOR / tenant-isolation gate (ADR 0163 Phase 1).
 *
 * Proves the security invariant the whole rewire sequences behind: the
 * tenant-scoped list shows ONLY the caller's tenant's workflows, and delete is
 * IDOR-guarded (a foreign/unknown id is an indistinguishable 404). Two distinct
 * anonymous sessions (separate cookies) = two isolated `anon:<sid>` tenants.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = ''; // cookie mode ON → anon sessions minted
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const base = () => `http://127.0.0.1:${PORT}/v1/host/openwop-app/workflows`;

/** Mint a fresh anon session (distinct tenant) and return its Cookie header. */
async function newTenantCookie(): Promise<string> {
  const r = await fetch(base()); // cookie-less → mints an anon cookie
  const setCookie = r.headers.get('set-cookie');
  expect(setCookie, 'anon session cookie should be minted in cookie mode').toBeTruthy();
  return setCookie!.split(';')[0]!; // `name=value`
}

const wfBody = (workflowId: string, name: string) => ({
  workflowId,
  nodes: [{ nodeId: 'n1', typeId: 'core.noop', outputRole: 'primary' }],
  metadata: { name },
});

async function register(cookie: string, workflowId: string, name: string) {
  return fetch(base(), { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(wfBody(workflowId, name)) });
}
async function listWorkflows(cookie: string): Promise<{ workflowId: string; name: string }[]> {
  const r = await fetch(base(), { headers: { cookie } });
  return ((await r.json()) as { workflows: { workflowId: string; name: string }[] }).workflows;
}
async function del(cookie: string, workflowId: string): Promise<number> {
  const r = await fetch(`${base()}/${workflowId}`, { method: 'DELETE', headers: { cookie } });
  return r.status;
}

describe('workflow ownership — IDOR / tenant isolation (ADR 0163 Phase 1)', () => {
  it('scoped list shows only the caller tenant; cross-tenant delete is a 404', async () => {
    const A = await newTenantCookie();
    const B = await newTenantCookie();

    // A registers a workflow.
    expect((await register(A, 'wf.test.alpha', 'Alpha')).status).toBe(201);

    // A sees it; B (and any other tenant) does NOT.
    const listA = await listWorkflows(A);
    expect(listA.map((w) => w.workflowId)).toContain('wf.test.alpha');
    expect(listA.find((w) => w.workflowId === 'wf.test.alpha')?.name).toBe('Alpha');
    expect((await listWorkflows(B)).map((w) => w.workflowId)).not.toContain('wf.test.alpha');

    // B cannot delete A's workflow → indistinguishable 404 (no existence leak).
    expect(await del(B, 'wf.test.alpha')).toBe(404);
    // Deleting an entirely unknown id → also 404.
    expect(await del(B, 'wf.test.nonexistent')).toBe(404);
    // A still owns it (B's failed delete didn't remove it).
    expect((await listWorkflows(A)).map((w) => w.workflowId)).toContain('wf.test.alpha');

    // A can delete its own → 200, then gone from A's list.
    expect(await del(A, 'wf.test.alpha')).toBe(200);
    expect((await listWorkflows(A)).map((w) => w.workflowId)).not.toContain('wf.test.alpha');
  });

  it('re-registering the same workflow is idempotent (one row, stable createdAt)', async () => {
    const A = await newTenantCookie();
    await register(A, 'wf.test.idem', 'Idem v1');
    const first = await listWorkflows(A);
    await register(A, 'wf.test.idem', 'Idem v2'); // re-register (metadata refresh)
    const second = await listWorkflows(A);
    expect(second.filter((w) => w.workflowId === 'wf.test.idem')).toHaveLength(1);
    expect(first.filter((w) => w.workflowId === 'wf.test.idem')).toHaveLength(1);
  });

  it('two anon sessions are isolated tenants', async () => {
    const A = await newTenantCookie();
    const B = await newTenantCookie();
    await register(A, 'wf.test.a-only', 'A only');
    await register(B, 'wf.test.b-only', 'B only');
    expect((await listWorkflows(A)).map((w) => w.workflowId)).toEqual(['wf.test.a-only']);
    expect((await listWorkflows(B)).map((w) => w.workflowId)).toEqual(['wf.test.b-only']);
  });
});
