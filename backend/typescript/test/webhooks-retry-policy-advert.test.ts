/**
 * The v2 `webhooks.retryPolicy` advert IS the worker's policy (webhooks.md
 * §Durability: a host retries "per its advertised retryPolicy").
 *
 * The advert was absent until 2026-09-25, so the suite's durable-delivery floor
 * fell back to its 20 s default window. It is derived from the worker's own
 * constants, and this file pins that derivation from both ends: the SERVED
 * document names WEBHOOK_MAX_ATTEMPTS, and "exponential" is true of
 * `webhookBackoffMs` below its cap — so neither side can drift silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WEBHOOK_MAX_ATTEMPTS, webhookBackoffMs } from '../src/host/webhookDeliveryWorker.js';

let server: Server;
let webhooks: Record<string, unknown> | undefined;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const doc = (await (await fetch(`${base}/.well-known/openwop`, {
    headers: { Authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' },
  })).json()) as Record<string, unknown>;
  webhooks = doc.webhooks as Record<string, unknown> | undefined;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('v2 webhooks.retryPolicy is the worker policy', () => {
  it('the served v2 discovery advertises the webhooks family with a retryPolicy', () => {
    expect(webhooks, 'the webhooks family must be served at major 2').toBeTruthy();
    expect(webhooks?.retryPolicy).toEqual({ maxAttempts: WEBHOOK_MAX_ATTEMPTS, backoff: 'exponential' });
  });

  it('maxAttempts is at least 3 — the durable floor fails the first two attempts on purpose', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });

  it('"exponential" is true of the worker: each retry waits strictly longer, below the cap', () => {
    for (let n = 1; n < WEBHOOK_MAX_ATTEMPTS; n += 1) {
      expect(webhookBackoffMs(n + 1), `attempt ${n + 1} vs ${n}`).toBeGreaterThan(webhookBackoffMs(n));
    }
  });
});
