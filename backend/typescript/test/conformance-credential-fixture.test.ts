/**
 * RFC 0199 `conformance-credential` (ADR 0753 D12): the fixture is advertised
 * only while `oauth` is (with the suite's `synthetic` provider), and when it is,
 * its one node suspends on a `credential` interrupt for a Subject with no
 * credential — the gate acts on `config.auth`, the node itself is a no-op.
 *
 * Tracker: TST-CGK-2. Red when: the fixture is advertised without oauth's
 * `synthetic` provider (host/index.ts), or the run parks on anything but a
 * `credential` interrupt (the run's `interrupt.requested` event is read, not
 * inferred from the `waiting-input` status). The settle poll is bounded (80 × 50 ms) — an
 * honest ceiling: the run has no settle hook this test can await.
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
    expect(r.status, await r.clone().text()).toBe(201);
    const { runId } = (await r.json()) as { runId: string };
    let snap: { status: string } = { status: '' };
    for (let i = 0; i < 80 && !snap.status.startsWith('waiting') && snap.status !== 'completed' && snap.status !== 'failed'; i++) {
      snap = (await (await fetch(`${BASE}/runs/${runId}`, { headers: H })).json()) as typeof snap;
      if (snap.status.startsWith('waiting')) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(snap.status).toBe('waiting-input');
    // The CLAIM: a credential interrupt, not merely some input wait — read from
    // the run's own `interrupt.requested` event.
    const ev = await fetch(`${BASE}/runs/${runId}/events/poll?timeout=0`, { headers: H });
    const events = ((await ev.json()) as { events?: Array<{ type: string; payload?: { kind?: string } }> }).events ?? [];
    expect(events.find((e) => e.type === 'interrupt.requested')?.payload?.kind).toBe('credential');
  });
});
