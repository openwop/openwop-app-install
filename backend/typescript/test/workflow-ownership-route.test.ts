/**
 * Workflow ownership index — IDOR / tenant-isolation gate (ADR 0163 Phase 1).
 *
 * Proves the security invariant the whole rewire sequences behind: the
 * tenant-scoped list shows ONLY the caller's tenant's workflows, and delete is
 * IDOR-guarded (a foreign/unknown id is an indistinguishable 404). Two distinct
 * anonymous sessions (separate cookies) = two isolated `anon:<sid>` tenants.
 *
 * DOUBLE GUARD on delete, named so a single-copy probe is not misread: the route
 * (`routes/workflows.ts`, `getOwned(tenantOf(req), id)` → 404) AND the shared
 * delete recipe (`host/tenantWorkflowDelete.ts`, `getOwned` → `not_owned` → 404)
 * each refuse a foreign id. Removing either one alone stays green (probes
 * `8fw5g4-own-route-guard`, `8fw5g4-own-core-guard`); the shared piece both read is
 * `getOwned`'s tenant-keyed lookup, probed by `8fw5g4-own-getowned`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = ''; // cookie mode ON → anon sessions minted
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Measured (grade-tests wave 64). */
const NOT_FOUND_BODY = (workflowId: string): unknown => ({ error: 'not_found', message: 'workflow not found', details: { workflowId } });
/** A re-register of an owned id answers 201 again (an idempotent overwrite). */
const REREGISTER_STATUS = 201;

const base = () => `http://127.0.0.1:${PORT}/host/openwop-app/workflows`;

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
interface OwnedRow { workflowId: string; name: string; createdAt: string; updatedAt: string }
async function listWorkflows(cookie: string): Promise<OwnedRow[]> {
  const r = await fetch(base(), { headers: { cookie } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { workflows: OwnedRow[] }).workflows;
}
async function delRes(cookie: string, workflowId: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${base()}/${workflowId}`, { method: 'DELETE', headers: { cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function del(cookie: string, workflowId: string): Promise<number> {
  return (await delRes(cookie, workflowId)).status;
}
/** The one 404 body a foreign AND an unknown id both get — a literal, so the two
 *  cannot move together under a sabotage (only `details.workflowId` differs). */
const notFound = (workflowId: string): unknown => NOT_FOUND_BODY(workflowId);

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
    const foreign = await delRes(B, 'wf.test.alpha');
    // Deleting an entirely unknown id → also 404, with the same body.
    const unknown = await delRes(B, 'wf.test.nonexistent');
    expect(foreign).toEqual({ status: 404, body: notFound('wf.test.alpha') });
    expect(unknown).toEqual({ status: 404, body: notFound('wf.test.nonexistent') });
    // A still owns it (B's failed delete didn't remove it).
    expect((await listWorkflows(A)).map((w) => w.workflowId)).toContain('wf.test.alpha');

    // A can delete its own → 200, then gone from A's list.
    expect(await del(A, 'wf.test.alpha')).toBe(200);
    expect((await listWorkflows(A)).map((w) => w.workflowId)).not.toContain('wf.test.alpha');
  });

  it('re-registering the same workflow is idempotent (one row, stable createdAt)', async () => {
    const A = await newTenantCookie();
    // Fake ONLY Date, so the two registers are stamped a minute apart: a createdAt
    // that is re-stamped on every save then differs (W38 — same-ms writes tie).
    // Times are relative to NOW (the session cookie was minted on the real clock, and
    // the gate re-runs with the clock shifted a year), never a fixed calendar date.
    const t1 = new Date(Date.now() + 1_000).toISOString();
    const t2 = new Date(Date.now() + 61_000).toISOString();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(t1));
      const r1 = await register(A, 'wf.test.idem', 'Idem v1');
      const first = await listWorkflows(A);
      vi.setSystemTime(new Date(t2));
      const r2 = await register(A, 'wf.test.idem', 'Idem v2'); // re-register (metadata refresh)
      const second = await listWorkflows(A);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(REREGISTER_STATUS);
      const one = first.filter((w) => w.workflowId === 'wf.test.idem');
      const two = second.filter((w) => w.workflowId === 'wf.test.idem');
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(1);
      expect(one[0]!.createdAt).toBe(t1);
      expect(two[0]!.createdAt, 'createdAt must survive a re-register').toBe(t1);
      expect(two[0]!.updatedAt).toBe(t2);
      expect(two[0]!.name, 'the re-register refreshes the metadata').toBe('Idem v2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('two anon sessions are isolated tenants', async () => {
    const A = await newTenantCookie();
    const B = await newTenantCookie();
    expect((await register(A, 'wf.test.a-only', 'A only')).status).toBe(201);
    expect((await register(B, 'wf.test.b-only', 'B only')).status).toBe(201);
    expect((await listWorkflows(A)).map((w) => w.workflowId)).toEqual(['wf.test.a-only']);
    expect((await listWorkflows(B)).map((w) => w.workflowId)).toEqual(['wf.test.b-only']);
  });
});
