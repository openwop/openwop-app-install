/**
 * CDP-1c — RFC 0127 stream/CDC ingest SEAM route (the steward's CDP-1b contract), driven
 * over HTTP. POST {source:"stream"|"change", …} to the trigger-bridge ingest seam returns
 * { triggerEvent, deliveryEvent }; triggerEvent carries the source sub-object (op REQUIRED
 * for change; before/after; stream key), deliveryEvent is content-free (SR-1). Registered on
 * BOTH the reference-host route and the `/host/sample/...` alias; flag-off ⇒ 400 (soft-skip).
 *
 * Sabotage-witnessed (/grade-tests w38): leaking the envelope into the delivery event, the route's
 * flag-gated source check, dropping the `/openwop-app` path, and the change `after` mapping each
 * turn a case red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __resetTriggerBridgeStore } from '../src/host/triggerBridgeService.js';

let server: http.Server; let BASE: string;
const TOKEN = 'dev-token';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __resetTriggerBridgeStore();
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED; await new Promise<void>((res) => server.close(() => res())); });

interface SeamBody {
  triggerEvent: { source: string; stream?: { partition?: number; key?: string }; change?: { op?: string; after?: unknown } };
  deliveryEvent: Record<string, unknown> | null;
  error?: string;
  message?: string;
}
async function ingest(path: string, body: unknown): Promise<{ status: number; body: SeamBody }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as SeamBody };
}
const SAMPLE = '/host/sample/trigger-bridge/ingest';
const APP = '/host/openwop-app/trigger-bridge/ingest';

describe('CDP-1c stream/CDC ingest seam (RFC 0127 CDP-1b)', () => {
  it('a stream event delivers, carries the stream sub-object, and the delivery is content-free', async () => {
    const secret = 'SR1-seam-marker-7c1';
    const r = await ingest(SAMPLE, { source: 'stream', verification: { mode: 'none' }, stream: { topic: 'orders', partition: 2, offset: '900', key: 'k1', message: { note: secret } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.triggerEvent.source).toBe('stream');
    expect(r.body.triggerEvent.stream?.partition).toBe(2);
    expect(r.body.triggerEvent.stream?.key).toBe('k1');
    expect(r.body.deliveryEvent).toBeTruthy();
    // SR-1: the message body never appears on the delivery event
    expect(JSON.stringify(r.body.deliveryEvent)).not.toContain(secret);
  });

  it('a change event delivers with the REQUIRED op + before/after', async () => {
    const r = await ingest(SAMPLE, { source: 'change', verification: { mode: 'none' }, change: { op: 'update', table: 'contacts', changelogId: 'lsn-5', before: { s: 'lead' }, after: { s: 'customer' } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.triggerEvent.source).toBe('change');
    expect(r.body.triggerEvent.change?.op).toBe('update');
    expect(r.body.triggerEvent.change?.after).toEqual({ s: 'customer' });
  });

  it('the reference-host /openwop-app path works too (both paths registered)', async () => {
    const r = await ingest(APP, { source: 'stream', stream: { topic: 't', partition: 0, offset: '1', message: { a: 1 } } });
    expect(r.status).toBe(200);
    expect(r.body.triggerEvent.source).toBe('stream');
  });

  it('flag OFF ⇒ 400 on a stream POST (scenario soft-skips pre-impl)', async () => {
    delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
    let r: Awaited<ReturnType<typeof ingest>>;
    try {
      r = await ingest(SAMPLE, { source: 'stream', stream: { topic: 't', partition: 0, offset: '2', message: {} } });
    } finally {
      process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
    }
    expect(r.status).toBe(400);
    // The route's SOURCE refusal (any malformed body is also a 400).
    expect(r.body.error).toBe('validation_error');
    expect(r.body.message).toContain('RFC 0127 flag');
  });
});
