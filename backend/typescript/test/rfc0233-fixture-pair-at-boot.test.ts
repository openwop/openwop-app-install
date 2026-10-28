/**
 * RFC 0233 §D — with `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES=true` the host
 * installs the vendored fixture pair at boot, BEFORE any request is served: the
 * first pack holds `acme-widgets`, and its rival (same bare id) is refused and
 * listed with the holder. Without the flag nothing is installed (the control).
 * Env is saved and restored, so the flag does not leak to a later file in the worker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { installConformanceProviderFixtures } from '../src/features/connections/providerRegistryRead.js';

const FIRST = 'core.openwop.connections.acme-widgets';
const RIVAL = 'core.openwop.connections.acme-widgets-rival';

let server: http.Server; let base = '';
const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_CONFORMANCE_PROVIDER_FIXTURES'] as const;
const prevEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_CONFORMANCE_PROVIDER_FIXTURES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of prevEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('RFC 0233 §D — the fixture pair at boot', () => {
  it('the first pack holds acme-widgets; the rival is refused with the holder', async () => {
    const res = await fetch(`${base}/connection-providers`, { headers: { Authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' } });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { providers: Array<Record<string, unknown>>; refusals: Array<Record<string, unknown>> };
    expect(page.providers.filter((p) => p.id === 'acme-widgets')).toEqual([{ id: 'acme-widgets', source: 'pack', packName: FIRST }]);
    expect(page.refusals).toContainEqual({ packName: RIVAL, providerId: 'acme-widgets', code: 'connection_provider_conflict', heldBy: FIRST });
  });

  it('the qualified forms resolve as §C requires', async () => {
    const h = { Authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
    const held = await fetch(`${base}/connection-providers/acme-widgets?pack=${FIRST}`, { headers: h });
    expect(held.status).toBe(200);
    expect(await held.json()).toEqual({ id: 'acme-widgets', source: 'pack', packName: FIRST });
    const rival = await fetch(`${base}/connection-providers/acme-widgets?pack=${RIVAL}`, { headers: h });
    expect(rival.status).toBe(404);
    expect(((await rival.json()) as { error?: string }).error).toBe('connection_provider_unresolved');
  });

  it('control: without the operator flag nothing is attempted', () => {
    expect(installConformanceProviderFixtures({})).toEqual({ attempted: 0 });
  });
});
