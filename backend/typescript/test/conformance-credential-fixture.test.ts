/**
 * RFC 0199 `conformance-credential` (ADR 0753 D12): the fixture is advertised
 * only while `oauth` is (with the suite's `synthetic` provider), and when it is,
 * its one node suspends on a `credential` interrupt for a Subject with no
 * credential — the gate acts on `config.auth`, the node itself is a no-op.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __resetOAuthAdvertisement } from '../src/features/connections/oauthAdvertisement.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'https://host.example';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  for (const k of ['OPENWOP_OAUTH_ADVERTISE', 'OPENWOP_TEST_SEAM_ENABLED', 'OPENWOP_ENABLE_CONFORMANCE_NODES', 'OPENWOP_OAUTH_CALLBACK_BASE_URL']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

async function fixtures(): Promise<string[]> {
  __resetOAuthAdvertisement();
  const d = (await (await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as { fixtures?: string[] };
  return d.fixtures ?? [];
}

describe('conformance-credential', () => {
  it('is NOT advertised while oauth is not', async () => {
    delete process.env.OPENWOP_OAUTH_ADVERTISE;
    expect(await fixtures()).not.toContain('conformance-credential');
  });

  it('is advertised with oauth, and its run suspends on a credential interrupt', async () => {
    process.env.OPENWOP_OAUTH_ADVERTISE = 'true';
    expect(await fixtures()).toContain('conformance-credential');
    const r = await fetch(`${BASE}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: 'conformance-credential', inputs: {} }) });
    expect([200, 201, 202], await r.clone().text()).toContain(r.status);
    const { runId } = (await r.json()) as { runId: string };
    let status = '';
    for (let i = 0; i < 80 && !status.startsWith('waiting') && status !== 'completed' && status !== 'failed'; i++) {
      status = ((await (await fetch(`${BASE}/runs/${runId}`, { headers: H })).json()) as { status: string }).status;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(status).toBe('waiting-input');
  });
});
