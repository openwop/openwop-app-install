/**
 * ADR 0411 P1 — ctx.callVideoGenerator adapter.
 * The deterministic test-seam mock persists a Media asset and returns a host URL
 * (never inline base64 — the spec's "videos are too large" contract); validation
 * + honest capability-missing for the real path when no BYOK credential is present.
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
    runId: 'vid-run', nodeId: 'video.generate', tenantId: 'default', attempt: 1,
    secrets: {}, policyResolver: hostSuite.providerPolicyResolver,
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ctx.callVideoGenerator', () => {
  it('mock provider persists a Media asset and returns a host video URL (never base64)', async () => {
    const r = await adapter.callVideoGenerator!({ prompt: 'a fox running through snow', provider: 'mock', durationSeconds: 8, width: 1080, height: 1920 });
    expect(r.video.mimeType).toBe('video/mp4');
    expect(r.video.url).toMatch(/assets\//); // a host Media asset URL, not raw base64
    expect(r.video.url).not.toMatch(/^data:|^[A-Za-z0-9+/=]{80,}$/);
    expect(r.video.durationSeconds).toBe(8);
    expect(r.video.width).toBe(1080);
    expect(r.video.height).toBe(1920);
    expect(r.video.safetyFiltered).toBe(false);
    expect(r.usage?.videos).toBe(1);
  });

  it('rejects an empty prompt', async () => {
    await expect(adapter.callVideoGenerator!({ prompt: '   ', provider: 'mock' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('clamps duration + dimensions to the host bounds', async () => {
    const r = await adapter.callVideoGenerator!({ prompt: 'x', provider: 'mock', durationSeconds: 999, width: 99999, height: -5 });
    expect(r.video.durationSeconds).toBeLessThanOrEqual(30);
    expect(r.video.width).toBeLessThanOrEqual(2160);
    expect(r.video.height).toBeGreaterThanOrEqual(1);
  });

  it('fails honest (host_capability_missing) for a real provider with no BYOK credential', async () => {
    await expect(adapter.callVideoGenerator!({ prompt: 'a cat', provider: 'replicate' })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('rejects an unsupported provider as host_capability_missing', async () => {
    await expect(adapter.callVideoGenerator!({ prompt: 'x', provider: 'runway' })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('rejects a prompt over the host character cap (content_too_long)', async () => {
    await expect(adapter.callVideoGenerator!({ prompt: 'a'.repeat(4_001), provider: 'mock' })).rejects.toMatchObject({ code: 'content_too_long' });
  });
});
