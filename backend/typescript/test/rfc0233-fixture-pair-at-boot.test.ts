/**
 * RFC 0233 §D — with `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES=true` the host
 * installs the vendored fixture pair at boot, BEFORE any request is served: the
 * first pack holds `acme-widgets`, and its rival (same bare id) is refused and
 * listed with the holder. Without the flag nothing is installed (the control).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { installConformanceProviderFixtures } from '../src/features/connections/providerRegistryRead.js';

const FIRST = 'core.openwop.connections.acme-widgets';
const RIVAL = 'core.openwop.connections.acme-widgets-rival';

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_CONFORMANCE_PROVIDER_FIXTURES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.OPENWOP_CONFORMANCE_PROVIDER_FIXTURES;
  await new Promise<void>((r) => server.close(() => r()));
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
    expect((await fetch(`${base}/connection-providers/acme-widgets?pack=${FIRST}`, { headers: h })).status).toBe(200);
    expect((await fetch(`${base}/connection-providers/acme-widgets?pack=${RIVAL}`, { headers: h })).status).toBe(404);
  });

  it('control: without the operator flag nothing is attempted', () => {
    expect(installConformanceProviderFixtures({})).toEqual({ attempted: 0 });
  });
});
