/**
 * ADR 0655 D9 (EM-8) — a bounce whose suppression write did NOT land is COUNTED
 * (`failed`) by the service and answered 503 by the route, so the provider redelivers.
 * It used to be swallowed into a `200 {received:true}` — "received" over a bounce
 * that never suppressed. Born red on the pre-ADR shape.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../src/features/crm/suppressionService.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/features/crm/suppressionService.js')>();
  return {
    ...orig,
    addSuppression: vi.fn(async (tenantId: string, email: string, ...rest: unknown[]) => {
      if (email.startsWith('kvdown')) throw new Error('kv write failed');
      return (orig.addSuppression as (...a: unknown[]) => Promise<unknown>)(tenantId, email, ...rest);
    }),
  };
});

import { createApp } from '../src/index.js';
import { setWebhookConfig, ingestBounceWebhook, __resetBounceWebhookStore } from '../src/features/email/bounceWebhooks.js';
import { isSuppressed, __clearSuppressions } from '../src/features/crm/suppressionService.js';

const T = 'tBounceFail';
let server: http.Server; let BASE = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await __resetBounceWebhookStore(); await __clearSuppressions();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const basic = (userPass: string): string => `Basic ${Buffer.from(userPass).toString('base64')}`;

describe('EM-8 — a failed suppression write is counted and redelivered', () => {
  it('service: one good bounce suppresses, one whose write fails is COUNTED, not swallowed', async () => {
    const cfg = await setWebhookConfig({ tenantId: T, orgId: 'o1', provider: 'postmark', verificationSecret: 'user:pass' });
    const body = [
      { RecordType: 'Bounce', Type: 'HardBounce', Email: 'ok-bounce@ex.com' },
      { RecordType: 'Bounce', Type: 'HardBounce', Email: 'kvdown@ex.com' },
    ];
    const out = await ingestBounceWebhook({ webhookId: cfg.webhookId, rawBody: JSON.stringify(body), body, headers: { authorization: basic('user:pass') }, now: Date.now() });
    expect(out).toMatchObject({ status: 'ok', suppressed: 1, failed: 1 });
    expect(await isSuppressed(T, 'ok-bounce@ex.com')).toBe(true);
    expect(await isSuppressed(T, 'kvdown@ex.com')).toBe(false);
  });

  it('route: a batch with a failed write answers 503 (redeliver), a clean batch 200', async () => {
    const cfg = await setWebhookConfig({ tenantId: T, orgId: 'o1', provider: 'postmark', verificationSecret: 'user:pass' });
    const url = `${BASE}/v1/host/openwop-app/public-email/events/${encodeURIComponent(cfg.webhookId)}`;
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: basic('user:pass') }, body: JSON.stringify(body) });
    const bad = await post([{ RecordType: 'Bounce', Type: 'HardBounce', Email: 'kvdown2@ex.com' }]);
    expect(bad.status).toBe(503);
    expect(await bad.json()).toMatchObject({ received: false, failed: 1 });
    const good = await post([{ RecordType: 'Bounce', Type: 'HardBounce', Email: 'fine@ex.com' }]);
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ received: true, suppressed: 1, failed: 0 });
  });
});
