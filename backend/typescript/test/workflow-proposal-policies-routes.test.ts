/**
 * ADR 0473 Phase 5 — the super-admin workflow-proposal auto-approval policy
 * HTTP surface. Drives the real app: super-admin gate on every route (the
 * route-level authz only an HTTP test observes), list/enable/disable round-
 * trip, idempotent delete, and the tenantId validation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('workflow-proposal auto-approval policy routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin
  const ADMIN = '/v1/host/openwop-app/workflow-proposals/admin/policies';
  const TENANT = 'org:policy-route-test';
  const AGENT = 'feature.workflow-author.agents.workflow-architect';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function call<T = unknown>(method: string, path: string, auth = true): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}${path}`, { method, headers });
    const raw = await res.json().catch(() => undefined);
    return { status: res.status, body: raw as T };
  }

  it('rejects a non-super-admin caller on every verb', async () => {
    for (const [method, path] of [
      ['GET', `${ADMIN}?tenantId=${TENANT}`],
      ['PUT', `${ADMIN}/${TENANT}/${AGENT}`],
      ['DELETE', `${ADMIN}/${TENANT}/${AGENT}`],
    ] as const) {
      const r = await call(method, path, false);
      expect([401, 403], `${method} ${path}`).toContain(r.status);
    }
  });

  it('GET without tenantId is a 400', async () => {
    const r = await call('GET', ADMIN);
    expect(r.status).toBe(400);
  });

  it('enable → list → disable round-trips (idempotent delete)', async () => {
    const put = await call<{ policy: { tenantId: string; agentProfileId: string; createdBy: string } }>('PUT', `${ADMIN}/${TENANT}/${AGENT}`);
    expect(put.status).toBe(200);
    expect(put.body.policy.tenantId).toBe(TENANT);
    expect(put.body.policy.agentProfileId).toBe(AGENT);
    expect(put.body.policy.createdBy).toBeTruthy();

    const list = await call<{ items: Array<{ agentProfileId: string }> }>('GET', `${ADMIN}?tenantId=${encodeURIComponent(TENANT)}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((p) => p.agentProfileId === AGENT)).toBe(true);

    const del = await call<{ removed: boolean }>('DELETE', `${ADMIN}/${TENANT}/${AGENT}`);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);

    const delAgain = await call<{ removed: boolean }>('DELETE', `${ADMIN}/${TENANT}/${AGENT}`);
    expect(delAgain.status).toBe(200);
    expect(delAgain.body.removed).toBe(false);

    const after = await call<{ items: unknown[] }>('GET', `${ADMIN}?tenantId=${encodeURIComponent(TENANT)}`);
    expect(after.body.items.length).toBe(0);
  });
});
