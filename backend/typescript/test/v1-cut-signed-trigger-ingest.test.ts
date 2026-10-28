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
 * Also pins the major-2 dead-letter read (RFC 0232) on a retired host: the
 * refused (bad-signature) post is the one dead-lettered delivery, with reason
 * `verification_failed` (RFC 0232 §C.3 — a refused post dead-letters itself).
 *
 * The signature refusal AND its dead-letter are guarded TWICE, identically:
 * the route's RFC 0230 `mode === 'required'` check refuses and calls
 * `recordRefusedDelivery`, and if it were skipped `ingestExternalEvent`
 * (`preVerified: false`) applies the RFC 0099 §F.2 rule and records the same
 * refusal (same reason, same dedup key) and the same 401. So removing the
 * route's check stays green (probes vc-required, vc-required-r2: vacuous — a
 * recorded double guard, not a gap). Witnessed instead: the route's own
 * record call dropped → no dead letter (vc-deadletter-r2); the shared sink's
 * reason changed → red (vc-shared-r3); the constant-time compare dropped →
 * the bad signature is DELIVERED (vc-timingsafe).
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
    expect(((await bad.json()) as { error?: string }).error).toBe('signature_invalid');
    // Control: the /v1 twin of the same address is retired (a write — never forwarded).
    const twin = await fetch(`${base}/v1${binding.ingestUrl}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(twin.status).toBe(410);

    // RFC 0232 — the dead-letter read under major 2, by tenant-bound id.
    const subs = await fetch(`${base}/trigger-subscriptions`, { headers: { authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' } });
    const list = (await subs.json()) as { subscriptions: Array<{ subscriptionId: string }> };
    const bound = list.subscriptions.map((s) => s.subscriptionId).find((sid) => sid === subscription.subscriptionId);
    expect(bound, 'the subscription is listed under its tenant-bound id').toBe(subscription.subscriptionId);
    const dl = await fetch(`${base}/trigger-subscriptions/${encodeURIComponent(subscription.subscriptionId)}/dead-letters`, { headers: { authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' } });
    expect(dl.status).toBe(200);
    // Exactly the refused post: the good delivery is not dead-lettered.
    // `attempt` is the dead-lettered attempt record (RFC 0232 §B), not a count.
    const letters = ((await dl.json()) as { deliveries: Array<{ reason: string; attempt: { attempt: number; outcome: string } }> }).deliveries;
    expect(letters.map((d) => ({ reason: d.reason, attempt: d.attempt.attempt, outcome: d.attempt.outcome })), JSON.stringify(letters))
      .toEqual([{ reason: 'verification_failed', attempt: 1, outcome: 'dead-lettered' }]);
  });
});
