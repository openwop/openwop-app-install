/**
 * ADR 0244 — the image seam resolves its api_key through the Connections broker
 * (a workspace-scoped Connection wins over the host-wide env key); the endpoint
 * stays env-configured. The mock endpoint echoes the Authorization header so we
 * can assert WHICH key was used.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { dispatchImageGeneration } from '../src/host/imageProviderAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

let server: http.Server;
let PORT = 0;
let lastAuth = '';
// A non-signed-in tenant → byok uses the local-aes secret tier (no KMS in the test host).
const T = 'img-tenant';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __resetConnectionsStore();
  registerProvider({
    id: 'openai-images', label: 'OpenAI Images', kind: 'api_key', authFlow: 'manual', reach: 'openapi',
    scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'],
  });
  server = http.createServer((req, res) => {
    lastAuth = (req.headers.authorization as string) ?? '';
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ images: [{ base64: 'aGk=', mimeType: 'image/png' }] })); });
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; r(); }); });
  process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = `http://127.0.0.1:${PORT}/v1/images`;
  process.env.OPENWOP_IMAGE_PROVIDER_KEY = 'ENV_KEY';
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('OPENWOP_IMAGE_PROVIDER_') || k === 'OPENWOP_WEBHOOK_ALLOW_PRIVATE') delete process.env[k];
  }
});

describe('ADR 0244 — broker-resolved image key', () => {
  it('a workspace Connection key WINS over the host-wide env key', async () => {
    await createSecretConnection({ tenantId: T, provider: 'openai-images', kind: 'api_key', secret: 'BROKER_KEY', scope: 'workspace' });
    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'openai', tenantId: T });
    expect(lastAuth).toBe('Bearer BROKER_KEY'); // broker beats env
  });

  it('falls back to the env key when the tenant has no image Connection', async () => {
    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'openai', tenantId: 'no-conn-tenant' });
    expect(lastAuth).toBe('Bearer ENV_KEY');
  });

  it('no tenantId → the env key (no broker lookup at all)', async () => {
    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'openai' });
    expect(lastAuth).toBe('Bearer ENV_KEY');
  });
});

describe('ADR 0253 — RFC 0079 connection-use provenance stamp', () => {
  it('a broker-resolved image call stamps run.metadata.connectionUse; the env-key path stamps nothing', async () => {
    const storage = hostExtStorage();
    await createSecretConnection({ tenantId: T, provider: 'openai-images', kind: 'api_key', secret: 'BROKER_KEY', scope: 'workspace' });

    // Broker path: a Connection served the call → the use is stamped on the run.
    await storage.insertRun({ runId: 'run-img-1', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'openai', tenantId: T, runId: 'run-img-1' });
    const meta = (await storage.getRun('run-img-1'))?.metadata as Record<string, unknown> | undefined;
    const uses = meta?.connectionUse as Array<{ provider?: string }> | undefined;
    expect(uses?.some((u) => u.provider === 'openai-images')).toBe(true);

    // Idempotent: a re-dispatch on the same run doesn't double-stamp (dedup by connectionId).
    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'openai', tenantId: T, runId: 'run-img-1' });
    const metaAgain = (await storage.getRun('run-img-1'))?.metadata as Record<string, unknown> | undefined;
    expect((metaAgain?.connectionUse as unknown[] | undefined)?.length).toBe(1);

    // Env-key path: a tenant with no Connection has no provenance → nothing stamped.
    await storage.insertRun({ runId: 'run-img-2', workflowId: 'w', tenantId: 'no-conn-tenant', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'openai', tenantId: 'no-conn-tenant', runId: 'run-img-2' });
    const meta2 = (await storage.getRun('run-img-2'))?.metadata as Record<string, unknown> | undefined;
    expect(meta2?.connectionUse).toBeUndefined();
  });
});
