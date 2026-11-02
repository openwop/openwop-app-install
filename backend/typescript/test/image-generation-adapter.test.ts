/**
 * ADR 0115 Phase 1 — ctx.callImageGenerator adapter.
 * The deterministic test-seam mock persists a Media asset; validation + honest
 * errors for a real provider with no credential (this host has no managed
 * image key, so a provider without a BYOK credentialRef is refused).
 *
 * TST-DGC-5. Red when the mock returns raw bytes instead of a Media asset URL,
 * when an empty prompt is accepted, when `n` is not clamped to 4, and when the
 * BYOK-required refusal is removed. That refusal and the final honest-off throw
 * share the code `host_capability_missing`, so the case pins the BYOK message
 * (sabotage-witnessed, wave 71).
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
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
    const err: unknown = await adapter.callImageGenerator({ prompt: 'a cat', provider: 'openai' }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'host_capability_missing' });
    expect(err instanceof Error ? err.message : '').toMatch(/requires a BYOK credential/);
  });

  it('clamps n to the host max', async () => {
    const r = await adapter.callImageGenerator({ prompt: 'x', provider: 'mock', n: 99 });
    expect(r.images).toHaveLength(4);
    expect(r.usage?.images).toBe(4);
  });
});
