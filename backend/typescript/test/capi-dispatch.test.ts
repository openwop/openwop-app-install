/**
 * CAPI delivery transport (ADR 0297 D1 follow-on) — the last recorded code
 * follow-on of the Funnel Program:
 *  - adapter.sendConversion posts a Meta CAPI event through the Connections
 *    broker with the OAuth token, the platform-side dedup event_id, and the
 *    HASHED identifier only (never a raw address on the wire);
 *  - unsupported platforms (google) and missing connections report honestly
 *    (unsupported / no_connection), never throw;
 *  - dispatchQueuedConversions + the transport: queued rows flip `sent` on a
 *    successful platform post; the platform filter keeps google-pixel orgs
 *    from wedging the queue; a transport failure leaves the row queued.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import {
  relayConversion, listConversions, dispatchQueuedConversions, upsertPixel, hashEmail, __resetPixels,
  type ConversionEvent, type PixelPlatform,
} from '../src/features/campaign-connectors/pixelService.js';

interface Hit { path: string; auth?: string; body: Record<string, unknown> }

const TENANT = 'capi-t';
const ORG = 'capi-org';

describe('CAPI delivery transport (ADR 0297 D1 follow-on)', () => {
  let meta: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let respondStatus = 200;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18971, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    meta = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.push({ path: req.url ?? '', auth: req.headers.authorization, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
        res.writeHead(respondStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(respondStatus === 200 ? { events_received: 1 } : { error: { message: 'bad pixel' } }));
      });
    });
    await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: TENANT, provider: 'meta-ads', kind: 'bearer', secret: 'META_TOKEN', scope: 'user', userId: 'u1' });
    registerProvider({
      id: 'meta-ads', label: 'Meta Ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi',
      scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'],
    });
    await storage.insertRun({ runId: 'capi-run', workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_META_API_BASE;
    await new Promise<void>((r) => meta.close(() => r()));
  });

  beforeEach(async () => { hits = []; respondStatus = 200; await __resetPixels(); });

  const adapter = () => makeAdsAdapter({ storage, tenantId: TENANT, runId: 'capi-run', actingUserId: 'u1', orgId: ORG });

  const send = (overrides: Record<string, unknown> = {}) => adapter().sendConversion({
    platform: 'meta', pixelId: 'px-9', eventId: 'evt-1', eventName: 'purchase',
    eventTimeIso: '2026-07-06T12:00:00.000Z', emailHash: hashEmail('buyer@x.test'), value: 120, currency: 'USD',
    ...overrides,
  });

  it('posts the Meta CAPI event with the token, dedup event_id, and hashed identifier only', async () => {
    const out = await send();
    expect(out).toEqual({ outcome: 'sent' });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/px-9/events');
    expect(hits[0].auth).toBe('Bearer META_TOKEN');
    const evt = (hits[0].body.data as Array<Record<string, unknown>>)[0];
    expect(evt.event_id).toBe('evt-1');
    expect(evt.event_name).toBe('purchase');
    expect((evt.user_data as { em: string[] }).em).toEqual([hashEmail('buyer@x.test')]);
    expect(JSON.stringify(hits[0].body)).not.toContain('buyer@x.test'); // hashed only, never raw
    expect((evt.custom_data as { value: number; currency: string }).value).toBe(120);
  });

  it('reports unsupported (google) and no_connection (tiktok w/o a connection) honestly', async () => {
    expect(await send({ platform: 'google' })).toEqual({ outcome: 'unsupported', platform: 'google' });
    expect(await send({ platform: 'tiktok' })).toEqual({ outcome: 'no_connection' });
    expect(hits).toHaveLength(0);
  });

  it('dispatch flips queued rows to sent; the platform filter skips google pixels; failures stay queued', async () => {
    await upsertPixel(TENANT, ORG, { platform: 'meta', pixelId: 'px-9' });
    await upsertPixel(TENANT, ORG, { platform: 'google', pixelId: 'gg-1' }); // client-side-only — must not wedge
    await relayConversion(TENANT, ORG, { eventId: 'evt-q1', eventName: 'purchase', email: 'q@x.test', value: 50, currency: 'usd' });

    const transport = async (platform: string, event: ConversionEvent): Promise<void> => {
      const out = await adapter().sendConversion({
        platform, pixelId: 'px-9', eventId: event.eventId, eventName: event.eventName, eventTimeIso: event.at,
        ...(event.emailHash ? { emailHash: event.emailHash } : {}),
      });
      if (out.outcome !== 'sent') throw new Error(out.outcome);
    };

    // a platform failure keeps the row queued
    respondStatus = 500;
    expect(await dispatchQueuedConversions(TENANT, ORG, transport, { platforms: ['meta', 'tiktok'] as PixelPlatform[] })).toBe(0);
    expect((await listConversions(TENANT, ORG))[0].status).toBe('queued');

    // success delivers exactly once and flips sent
    respondStatus = 200;
    hits = [];
    expect(await dispatchQueuedConversions(TENANT, ORG, transport, { platforms: ['meta', 'tiktok'] as PixelPlatform[] })).toBe(1);
    expect((await listConversions(TENANT, ORG))[0].status).toBe('sent');
    expect(hits.filter((h) => h.path === '/px-9/events')).toHaveLength(1);
  });
});
