/**
 * ADR 1042 D5 + D6 (CHAN-P0-5, CHAN-P0-6) — inbound dedup on the device relay
 * and a per-connection inbound budget on both lanes.
 *
 * D5: the relay validated `platformMessageId` and never used it, so a device
 * retry processed one message twice (two session turns, two bridge runs). Now
 * `(relayId, platformMessageId)` is claimed before any work, and the bridge's
 * `POST /runs` carries an Idempotency-Key derived from it.
 * D6: only the per-IP limit existed. Now each hosted connection and each relay
 * device has its own 60 s budget (`OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN`),
 * refused with the canonical 429 (`details.reason: channel_inbound_rate`) and
 * counted only AFTER the signature check on the hosted lane.
 *
 * Red when: the relay claim is skipped (the duplicate is processed: session
 * count 2); the bridge drops the Idempotency-Key; either budget is not enforced;
 * the hosted budget is taken before signature verification (forged requests
 * would then starve the real ones).
 * Security review of #5543: the claim is per (device, conversation, message)
 * (H1), and claims expire and are swept (L7).
 * Sabotage-witnessed 2026-11-03: dropping the conversation from the claim key
 * (H1) and removing the TTL-on-read re-claim (L7) each turned their case red;
 * earlier, removing the `claimRelayInbound` early return,
 * removing the bridge header, removing the relay `enforceChannelInboundRateLimit`
 * call, and moving the hosted `takeChannelInbound` above the signature check
 * each turned exactly their case red.
 * Wave 87: the bridge key is pinned to a literal (dropping the conversation from
 * `relayInboundIdempotencyKey` turns the bridge case red), and the sweep is shown
 * to DELETE (a sweep that counts without deleting turns the L7 case red).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { createSelfHttpBridge, relayInboundIdempotencyKey } from '../src/messaging/bridge.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setInboundConfig } from '../src/features/connections/inboundWebhooks.js';
import type { Storage } from '../src/storage/storage.js';

const OP = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;
let ORIGIN = '';
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // The per-IP floor must not be what refuses; OPENWOP_RATELIMIT_DISABLED would
  // also turn off the budget under test.
  process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '10000';
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const app = await createApp({ port, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  server.on('request', app);
  ORIGIN = `http://127.0.0.1:${port}`;
}, 120_000);
afterAll(async () => {
  delete process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN;
  delete process.env.OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN;
  await new Promise<void>((res) => server.close(() => res()));
});

const M = '/host/openwop-app/messaging';
async function post(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
}
async function activeRelay(): Promise<{ relayId: string; dev: Record<string, string> }> {
  const reg = await post(`${M}/relay/register`, OP, { channel: 'signal' });
  const act = await post(`${M}/relay/activate`, OP, { relayId: reg.body.relayId, activationCode: reg.body.activationCode });
  return { relayId: String(reg.body.relayId), dev: { 'x-openwop-device-token': String(act.body.deviceToken), 'content-type': 'application/json' } };
}
const msg = (id: string, conversationId = 'c-dedup') => ({ platformMessageId: id, conversationId, peerId: 'peer-1', text: `hello ${id}` });

describe('D5 — relay inbound dedup', () => {
  it('a second delivery of one platform message is acknowledged and does nothing', async () => {
    const { dev } = await activeRelay();
    const first = await post(`${M}/device/inbound`, dev, msg('pm-1'));
    expect(first.status).toBe(202);
    expect(first.body.deduped).toBeUndefined();
    const again = await post(`${M}/device/inbound`, dev, msg('pm-1'));
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ accepted: true, deduped: true });
    expect((await storage.getMessagingSession('signal:c-dedup'))?.messageCount).toBe(1);
    // A different message still lands (the claim is per message, not per chat).
    await post(`${M}/device/inbound`, dev, msg('pm-2'));
    expect((await storage.getMessagingSession('signal:c-dedup'))?.messageCount).toBe(2);
  });

  it('H1: the same platform message id in two conversations is two messages', async () => {
    const { dev } = await activeRelay();
    expect((await post(`${M}/device/inbound`, dev, msg('pm-same', 'c-one'))).body.deduped).toBeUndefined();
    expect((await post(`${M}/device/inbound`, dev, msg('pm-same', 'c-two'))).body.deduped).toBeUndefined();
    expect((await storage.getMessagingSession('signal:c-two'))?.messageCount).toBe(1);
  });

  it('the bridge creates the run with an idempotency key from the platform message id', async () => {
    const seen: Array<string | null> = [];
    const bridge = createSelfHttpBridge({
      storage: openSqliteStorage(':memory:'),
      baseUrl: 'http://bridge.test',
      bearer: 't',
      defaultWorkflowId: 'wf',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('idempotency-key'));
        return new Response(JSON.stringify({}), { status: 500 });
      }) as typeof fetch,
    });
    await bridge.onInbound({
      device: { relayId: 'relay_x', tenantId: 't1', channel: 'signal' },
      envelope: { channel: 'signal', platformMessageId: 'pm-77', conversationId: 'c', peerId: 'p', text: 'hi', timestamp: new Date().toISOString() },
      sessionKey: 'signal:c',
    });
    const key = seen[0];
    // A literal derived outside the product (sha256 of `relay_x\0c\0pm-77`), so a
    // key that drops the conversation or the message id cannot move the expectation.
    expect(key).toBe('relay-inbound-6128692701a9ca8208afab7f4b5fb6efc54d635540d016cb9acb3cd27bd50b12');
    // The v2 Idempotency-Key grammar — a key outside it is a 400 and no run at all.
    expect(key).toMatch(/^[A-Za-z0-9._~-]{22,128}$/);
    expect(relayInboundIdempotencyKey('relay_x', 'c', 'pm-78')).not.toBe(key);
    // H1 for runs: the same message id in another conversation is another run.
    expect(relayInboundIdempotencyKey('relay_x', 'c2', 'pm-77')).not.toBe(key);
  });
});

describe('L7 — relay inbound claims expire', () => {
  it('an expired claim no longer blocks, and the sweep removes it', async () => {
    const { claimRelayInbound, sweepRelayInboundClaims } = await import('../src/messaging/inboundClaims.js');
    const dev = { relayId: 'relay_ttl', tenantId: 't-ttl' };
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    expect(await claimRelayInbound(dev, 'c', 'pm-ttl', t0)).toBe(true);
    expect(await claimRelayInbound(dev, 'c', 'pm-ttl', t0 + day)).toBe(false); // live: blocks
    expect(await claimRelayInbound(dev, 'c', 'pm-ttl', t0 + 8 * day)).toBe(true); // expired: re-claimed
    expect(await claimRelayInbound(dev, 'c', 'pm-old', t0)).toBe(true);
    // Exactly pm-old: every other claim in this file is newer than the cutoff (t0 + 1 day).
    expect(await sweepRelayInboundClaims(t0 + 8 * day)).toBe(1);
    // At t0 + 1 day a surviving pm-old claim would still be live and block; only a
    // real delete lets this claim win (TTL-on-read cannot).
    expect(await claimRelayInbound(dev, 'c', 'pm-old', t0 + day)).toBe(true); // swept
  });
});

describe('D6 — per-connection inbound budget', () => {
  it('a relay device over its budget gets the canonical 429', async () => {
    process.env.OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN = '2';
    try {
      const { dev } = await activeRelay();
      expect((await post(`${M}/device/inbound`, dev, msg('rl-1', 'c-rl'))).status).toBe(202);
      expect((await post(`${M}/device/inbound`, dev, msg('rl-2', 'c-rl'))).status).toBe(202);
      const over = await post(`${M}/device/inbound`, dev, msg('rl-3', 'c-rl'));
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(over.body).toMatchObject({ error: 'rate_limited', details: { reason: 'channel_inbound_rate', scope: 'key' } });
      // Another device has its own budget.
      const other = await activeRelay();
      expect((await post(`${M}/device/inbound`, other.dev, msg('rl-4', 'c-rl2'))).status).toBe(202);
    } finally {
      delete process.env.OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN;
    }
  });

  it('a hosted connection counts only verified deliveries', async () => {
    process.env.OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN = '2';
    try {
      const conn = await createSecretConnection({ tenantId: 't-rl', provider: 'telegram', kind: 'bearer', secret: '1:abc', scope: 'user', userId: 'u-rl' });
      const secret = 'tg-rate-limit-secret-123';
      await setInboundConfig({ tenantId: 't-rl', connectionId: conn.connectionId, provider: 'telegram', workflowId: 'wf-none', signingSecret: secret });
      const send = (token: string, updateId: number) => post(`/host/openwop-app/connections-inbound/${encodeURIComponent(conn.connectionId)}`, {
        'content-type': 'application/json', 'x-telegram-bot-api-secret-token': token,
      }, { update_id: updateId, message: { message_id: updateId, chat: { id: 5, type: 'private' }, from: { id: 5 }, text: 'x' } });
      // Forged deliveries are refused by the signature check and spend nothing.
      for (let i = 0; i < 3; i++) expect((await send('forged-token-forged-tok', 100 + i)).status).toBe(401);
      expect((await send(secret, 1)).status).toBe(202);
      expect((await send(secret, 2)).status).toBe(202);
      const over = await send(secret, 3);
      expect(over.status).toBe(429);
      expect(over.body).toMatchObject({ details: { reason: 'channel_inbound_rate' } });
    } finally {
      delete process.env.OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN;
    }
  });
});
