/**
 * ADR 0907 P0 / D1 — TikTok Events API 2.0 conversion delivery.
 *
 * Before this: `sendConversion` for TikTok sent the token as `Authorization:
 * Bearer` (TikTok reads a RAW `Access-Token` header, as the publish path already
 * did) with a pre-2.0 body (`pixel_code` + a top-level `event`), and it treated
 * any HTTP 200 as delivered — but TikTok answers 200 with `{code, message}` and a
 * non-zero `code` is a rejection. So every TikTok conversion was rejected AND
 * marked sent. These tests pin the three halves: header, body shape, and the
 * `code` discriminator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter, buildTiktokConversionBody } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { hashEmail } from '../src/features/campaign-connectors/pixelService.js';

interface Hit { path: string; auth?: string; access?: string; body: Record<string, unknown> }

describe('TikTok Events API 2.0 conversion (ADR 0907 D1)', () => {
  let tk: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let reply: Record<string, unknown> = { code: 0, message: 'OK', data: {} };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18991, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    tk = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.push({ path: req.url ?? '', auth: req.headers.authorization, access: req.headers['access-token'] as string, body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => tk.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_TIKTOK_ADS_API_BASE = `http://127.0.0.1:${(tk.address() as AddressInfo).port}`;
    process.env.OPENWOP_ADS_VERIFIED_SENDERS = 'tiktok'; // ADR 0907 D2 — the sender is gated until sandbox-verified
    await createSecretConnection({ tenantId: 'ttc', provider: 'tiktok-ads', kind: 'bearer', secret: 'TT_TOKEN', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'ttc-run', workflowId: 'w', tenantId: 'ttc', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_TIKTOK_ADS_API_BASE;
    delete process.env.OPENWOP_ADS_VERIFIED_SENDERS;
    await new Promise<void>((r) => tk.close(() => r()));
  });

  beforeEach(() => { hits = []; reply = { code: 0, message: 'OK', data: {} }; });

  const send = () => makeAdsAdapter({ storage, tenantId: 'ttc', runId: 'ttc-run', actingUserId: 'u1', orgId: 'ttc' }).sendConversion({
    platform: 'tiktok', pixelId: 'CPIXEL123', eventId: 'evt-tt-1', eventName: 'CompletePayment',
    eventTimeIso: '2026-10-01T12:00:00.000Z', emailHash: hashEmail('buyer@x.test'), value: 42.5, currency: 'USD',
  });

  it('authenticates with a RAW Access-Token header, never Authorization', async () => {
    expect(await send()).toEqual({ outcome: 'sent' });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/event/track/');
    expect(hits[0].access).toBe('TT_TOKEN');
    expect(hits[0].auth).toBeUndefined();
  });

  it('sends the Events API 2.0 body (golden)', async () => {
    await send();
    expect(hits[0].body).toEqual({
      event_source: 'web',
      event_source_id: 'CPIXEL123',
      data: [{
        event: 'CompletePayment',
        event_time: Math.floor(Date.parse('2026-10-01T12:00:00.000Z') / 1000),
        event_id: 'evt-tt-1',
        user: { email: [hashEmail('buyer@x.test')] },
        properties: { value: 42.5, currency: 'USD' },
      }],
    });
    expect(JSON.stringify(hits[0].body)).not.toContain('buyer@x.test');
  });

  it('a 200 with a non-zero TikTok code is a FAILURE, not a delivery', async () => {
    reply = { code: 40001, message: 'Access token is invalid' };
    expect(await send()).toEqual({ outcome: 'failed', error: 'Access token is invalid' });
  });

  it('the pure builder omits absent identifiers and properties', () => {
    const body = buildTiktokConversionBody({ pixelId: 'P', eventId: 'e', eventName: 'Lead', eventTimeIso: '2026-10-01T00:00:00.000Z' });
    expect(body).toEqual({ event_source: 'web', event_source_id: 'P', data: [{ event: 'Lead', event_time: 1790812800, event_id: 'e', user: {} }] });
  });
});
