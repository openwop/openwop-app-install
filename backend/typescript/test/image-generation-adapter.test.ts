/**
 * ADR 0115 Phase 1 — ctx.callImageGenerator adapter.
 * The deterministic test-seam mock persists a Media asset; validation + honest
 * unsupported errors for the real path (no provider wired yet).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import type { HostAdapterSuite } from '../src/host/index.js';

let server: http.Server;
let adapter: ReturnType<typeof createAiProvidersAdapter>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, res); });
  const hostSuite = app.locals.hostSuite as HostAdapterSuite;
  adapter = createAiProvidersAdapter({
    runId: 'img-run', nodeId: 'image.generate', tenantId: 'default', attempt: 1,
    secrets: {}, policyResolver: hostSuite.providerPolicyResolver,
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ctx.callImageGenerator', () => {
  it('mock provider persists a Media asset and returns image refs', async () => {
    const r = await adapter.callImageGenerator({ prompt: 'a red square', provider: 'mock', n: 2 });
    expect(r.images).toHaveLength(2);
    expect(r.images[0]!.mimeType).toBe('image/png');
    expect(r.images[0]!.url).toMatch(/assets\//); // a host Media asset URL, not raw base64
    expect(r.usage?.images).toBe(2);
  });

  it('rejects an empty prompt', async () => {
    await expect(adapter.callImageGenerator({ prompt: '', provider: 'mock' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('fails honest (host_capability_missing) for a real provider with no credential', async () => {
    await expect(adapter.callImageGenerator({ prompt: 'a cat', provider: 'openai' })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('clamps n to the host max', async () => {
    const r = await adapter.callImageGenerator({ prompt: 'x', provider: 'mock', n: 99 });
    expect(r.images.length).toBeLessThanOrEqual(4);
  });
});
