/**
 * v1 end-of-support (2026-10-04) — the SIGNED trigger ingest survives the cut.
 *
 * Senders hold the UNVERSIONED `binding.ingestUrl` (`/host/openwop-app/trigger-
 * ingest/<id>`) and post credential-less with no `OpenWOP-Version`. The route
 * once registered on the `/v1/host/openwop-app` key, which retired with `/v1`
 * (`versioning.md` §5); it registers unversioned since ADR 0812 P3b, and this
 * pins that the address senders hold reaches it while its `/v1` twin is 410.
 * The subscription is registered over major 2 (P3c removed the `/v1` create
 * this file used to register with). If this ever reds, every external
 * webhook integration on the host goes dark silently (raised by openwop-app-31).
 * Also pins the major-2 dead-letter read (RFC 0232) on a retired host.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';

let server: http.Server; let base = '';
const saved = { signing: process.env.OPENWOP_TRIGGER_INBOUND_SIGNING };
const sign = (secret: string, id: string, ts: string, body: string): string =>
  `v1,${createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;
const now = (): string => String(Math.floor(Date.now() / 1000));
const freshId = (): string => `msg_${randomBytes(12).toString('hex')}`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (saved.signing === undefined) delete process.env.OPENWOP_TRIGGER_INBOUND_SIGNING; else process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = saved.signing;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('v1 end-of-support — the signed trigger ingest and the dead-letter read survive the cut', () => {
  it('a registered subscription delivers on its unversioned ingest address, and keeps refusing a bad signature', async () => {
    const reg = await fetch(`${base}/trigger-subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' }, body: JSON.stringify({ source: 'webhook', workflowId: 'openwop-app.uppercase', verification: { mode: 'required' } }) });
    expect(reg.status).toBe(201);
    const { binding, subscription } = (await reg.json()) as { binding: { ingestUrl: string; signingSecret: string }; subscription: { subscriptionId: string } };
    // Major 2 hands out the tenant-bound id; the ingest address carries the bare one.
    const bareId = subscription.subscriptionId.slice(subscription.subscriptionId.lastIndexOf('/') + 1);
    expect(binding.ingestUrl).toBe(`/host/openwop-app/trigger-ingest/${bareId}`);

    const body = JSON.stringify({ text: 'after the cut' });
    const id = freshId(); const ts = now();
    const ok = await fetch(`${base}${binding.ingestUrl}`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sign(binding.signingSecret, id, ts, body) }, body });
    expect(ok.status).toBe(202);
    const bad = await fetch(`${base}${binding.ingestUrl}`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': freshId(), 'webhook-timestamp': now(), 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, body });
    expect(bad.status).toBe(401);
    // Control: the /v1 twin of the same address is retired (a write — never forwarded).
    const twin = await fetch(`${base}/v1${binding.ingestUrl}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(twin.status).toBe(410);

    // RFC 0232 — the dead-letter read under major 2, by tenant-bound id.
    const subs = await fetch(`${base}/trigger-subscriptions`, { headers: { authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' } });
    const list = (await subs.json()) as { subscriptions?: Array<{ subscriptionId: string }>; items?: Array<{ subscriptionId: string }> };
    const bound = (list.subscriptions ?? list.items ?? []).map((s) => s.subscriptionId).find((sid) => sid === subscription.subscriptionId);
    expect(bound, 'the subscription is listed under its tenant-bound id').toBeTruthy();
    const dl = await fetch(`${base}/trigger-subscriptions/${encodeURIComponent(bound!)}/dead-letters`, { headers: { authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' } });
    expect(dl.status).toBe(200);
  });
});
