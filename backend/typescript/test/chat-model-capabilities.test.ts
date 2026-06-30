/**
 * ADR 0124 Phase 1 — chat model-capabilities read endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('GET /chat/model-capabilities', () => {
  it('projects per-provider capabilities', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/chat/model-capabilities`, { headers: { authorization: 'Bearer dev-token' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: Array<{ provider: string; capabilities: string[] }> };
    expect(Array.isArray(body.providers)).toBe(true);
    const names = body.providers.map((p) => p.provider);
    expect(names).toContain('anthropic');
    expect(names).toContain('openai');
    // ADR 0164 — the picker advertises ONLY user-selectable providers. The hidden
    // MiniMax provider (and the managed openwop-free tier) MUST NOT leak in.
    expect(names).not.toContain('minimax');
    expect(names).not.toContain('openwop-free');
    // each entry exposes a capabilities array (RFC 0031 introspection).
    for (const p of body.providers) expect(Array.isArray(p.capabilities)).toBe(true);
  });
});
