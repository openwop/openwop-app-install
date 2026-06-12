/**
 * Connection credential injection at the HTTP egress seam (ADR 0024 §4 /
 * Option C). Proves the host attaches the acting user's token ONLY through the
 * double gate (run allow-list × host-curated apiHost match), keyed on the acting
 * human, and stamps RFC 0079 provenance — plus the eTLD+1 matcher rejects spoofs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeConnectionSafeFetch, hostMatchesApi } from '../src/host/connectionInjection.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

describe('hostMatchesApi — eTLD+1 boundary (the injection security gate)', () => {
  it('matches exact + subdomain, rejects substring/label spoofs', () => {
    expect(hostMatchesApi('googleapis.com', 'googleapis.com')).toBe(true);
    expect(hostMatchesApi('www.googleapis.com', 'googleapis.com')).toBe(true);
    expect(hostMatchesApi('gmail.googleapis.com', 'googleapis.com')).toBe(true);
    // The spoofs an attacker would try:
    expect(hostMatchesApi('googleapis.com.evil.com', 'googleapis.com')).toBe(false);
    expect(hostMatchesApi('evilgoogleapis.com', 'googleapis.com')).toBe(false);
    expect(hostMatchesApi('notgoogleapis.com', 'googleapis.com')).toBe(false);
  });
});

describe('connection injection at the egress seam (ADR 0024 §4 / Option C)', () => {
  let echo: http.Server;
  let port: number;
  let storage: Storage;
  let lastAuth: string | undefined;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // allow loopback egress + http injection in test
    const app = await createApp({ port: 18944, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    echo = http.createServer((req, res) => {
      lastAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => echo.listen(0, r));
    port = (echo.address() as AddressInfo).port;

    // A test provider whose curated apiHost is the loopback echo server.
    registerProvider({ id: 'testapi', label: 'Test API', kind: 'bearer', authFlow: 'none', reach: 'openapi', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.http'], apiHosts: ['127.0.0.1'] });
    await createSecretConnection({ tenantId: 'tinj', provider: 'testapi', kind: 'bearer', secret: 'TESTTOKEN', scope: 'user', userId: 'u1' });
  });

  afterAll(async () => {
    await new Promise<void>((r) => echo.close(() => r()));
  });

  function safeFetchFor(allowed: string[], actingUserId?: string): ReturnType<typeof makeConnectionSafeFetch> {
    return makeConnectionSafeFetch({ storage, tenantId: 'tinj', runId: 'run-inj', allowedProviders: allowed, ...(actingUserId ? { actingUserId } : {}) });
  }
  const drain = async (res: { body?: { cancel?: () => Promise<void> } | null }): Promise<void> => {
    await res.body?.cancel?.().catch(() => undefined);
  };

  it('injects the acting user’s token for an allow-listed, host-matched provider + stamps provenance', async () => {
    lastAuth = undefined;
    await storage.insertRun({ runId: 'run-inj', workflowId: 'w', tenantId: 'tinj', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    const res = await safeFetchFor(['testapi'], 'u1')(`http://127.0.0.1:${port}/data`);
    expect(res.status).toBe(200);
    await drain(res);
    expect(lastAuth).toBe('Bearer TESTTOKEN');
    const meta = (await storage.getRun('run-inj'))?.metadata as Record<string, unknown> | undefined;
    const uses = meta?.connectionUse as Array<{ provider?: string; scopeAxis?: string }> | undefined;
    expect(uses?.[0]?.provider).toBe('testapi');
  });

  it('does NOT inject when the provider is not allow-listed by the run', async () => {
    lastAuth = undefined;
    await drain(await safeFetchFor([], 'u1')(`http://127.0.0.1:${port}/`));
    expect(lastAuth).toBeUndefined();
  });

  it('does NOT inject when the URL host is not a provider apiHost', async () => {
    lastAuth = undefined;
    // google is allow-listed but its apiHost is googleapis.com — the loopback
    // request host doesn't match, so no token attaches.
    await drain(await safeFetchFor(['google'], 'u1')(`http://127.0.0.1:${port}/`));
    expect(lastAuth).toBeUndefined();
  });

  it('does NOT inject without an acting user (system run — fail closed)', async () => {
    lastAuth = undefined;
    await drain(await safeFetchFor(['testapi'])(`http://127.0.0.1:${port}/`)); // no actingUserId
    expect(lastAuth).toBeUndefined(); // no user connection resolves
  });
});
