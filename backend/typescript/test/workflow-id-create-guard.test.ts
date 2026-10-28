/**
 * ADR 0794 — a server-minted origin is never CREATED through a tenant route.
 *
 * `wf.sub.<child>.<hash>` and `wf.cadence.<chain>.<hash>` are deterministic from
 * the tenant id. Before this guard a FREE one passed `isWriteProtected` (it only
 * refused ids already registered), so anyone who knew a tenant's id could
 * register its sub-workflow or cadence id first — the `wf.seed.*` pre-squat ADR
 * 0789 closed, one origin over. `copy` and `fork` are random, but a client has no
 * business choosing one either.
 *
 * Route-level: the boundary is only observable through HTTP with a tenant session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { blankWorkflowId, cadenceWorkflowId, copyWorkflowId, dupWorkflowId, forkWorkflowId, subWorkflowId } from '../src/host/workflowId.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';

describe('ADR 0794 — tenant routes create only client-minted origins', () => {
  let server: http.Server;
  let BASE: string;

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
        if (m) cookie = m[1]!;
      }
      return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
    };
  }
  /** The route's refusal for a write-protected id: a UNIFORM not-found (the id's
   *  existence is not disclosed), asserted literally so a route-miss 404 or any
   *  other refusal cannot satisfy it (`routes/workflows.ts` POST handler). */
  const expectRefused = (r: { status: number; body: Record<string, unknown> | undefined }, id: string): void => {
    expect(r.status, id).toBe(404);
    expect(r.body).toEqual({ error: 'workflow_not_found', message: 'workflow not found', details: { workflowId: id } });
  };
  const def = (workflowId: string) => ({ workflowId, metadata: { name: 'x' }, nodes: [{ nodeId: 'a', typeId: 'core.noop', config: {} }], edges: [] });

  let mallory: ReturnType<typeof client>;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    mallory = client();
    expect((await mallory('POST', '/host/openwop-app/test/login', { email: 'mallory@evil.test', tenantId: 'org:mallory' })).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('the origins the browser mints are creatable', async () => {
    for (const id of [blankWorkflowId(), dupWorkflowId()]) {
      expect((await mallory('POST', '/host/openwop-app/workflows', def(id))).status, id).toBe(201);
      expect((await getRegisteredWorkflowAsync(id))?.workflowId, `${id} must have been registered`).toBe(id);
    }
  });

  it("another tenant's deterministic sub-workflow and cadence ids cannot be pre-registered", async () => {
    // Everything Mallory needs is the victim's tenant id.
    const victimSub = subWorkflowId('org:victim', 'review.step', '1.0.0');
    const victimCadence = cadenceWorkflowId('org:victim', 'strategy.weekly-checkin');
    for (const id of [victimSub, victimCadence]) {
      expectRefused(await mallory('POST', '/host/openwop-app/workflows', def(id)), id);
      expect(await getRegisteredWorkflowAsync(id), `${id} must not have been registered`).toBeFalsy();
    }
  });

  it('a client cannot choose a copy or fork id either', async () => {
    for (const id of [copyWorkflowId('approvals.request-sign-off'), forkWorkflowId('wf.seed.digest')]) {
      expectRefused(await mallory('POST', '/host/openwop-app/workflows', def(id)), id);
      expect(await getRegisteredWorkflowAsync(id)).toBeFalsy();
    }
  });
});
