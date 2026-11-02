/**
 * ADR 0124 Phase 1 — chat model-capabilities read endpoint (the route WIRING;
 * the selectable-provider mechanism is pinned by `provider-catalog-selectable.test.ts`,
 * whose header names this file as its route-level twin).
 *
 * Tracker TST-CEC-5. Both expectations are read as DATA, never from the code
 * under test: the provider list from the repo-root `providers.json`
 * (`!managed && !hidden`, ADR 0164), and the Anthropic capabilities as literals
 * from RFC 0031's reserved set.
 * Red when (w67g3): the route lists a hidden provider (minimax); the route stops
 * projecting each provider's capabilities.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

interface RawProvider { id: string; managed?: boolean; hidden?: boolean }
const RAW: RawProvider[] = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'providers.json'), 'utf8')) as { providers: RawProvider[] }).providers;

interface ProviderEntry { provider: string; capabilities: string[]; models: Array<{ id: string; label: string }> }

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('GET /chat/model-capabilities', () => {
  it('projects per-provider capabilities', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/chat/model-capabilities`, { headers: { authorization: 'Bearer dev-token' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: ProviderEntry[] };
    const names = body.providers.map((p) => p.provider);
    // ADR 0164 — the picker advertises ONLY user-selectable providers, in catalog order.
    expect(names).toEqual(RAW.filter((p) => p.managed !== true && p.hidden !== true).map((p) => p.id));
    // Fixture guards: the exclusion is not vacuous.
    expect(RAW.find((p) => p.id === 'minimax')?.hidden).toBe(true);
    expect(names).not.toContain('minimax');
    expect(names).not.toContain('openwop-free');
    // RFC 0031 introspection — the capabilities are projected, not an empty stub.
    const anthropic = body.providers.find((p) => p.provider === 'anthropic');
    expect(anthropic?.capabilities).toEqual(expect.arrayContaining(['structured-output', 'function-calling']));
    // ADR 0124 Phase 2c — the selectable models ride along.
    expect(anthropic?.models.length).toBeGreaterThan(0);
    for (const m of anthropic?.models ?? []) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
    }
  });
});
