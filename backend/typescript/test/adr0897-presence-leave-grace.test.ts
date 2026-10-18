/**
 * ADR 0897 — the presence stream is now ended by the host every few minutes,
 * and the reader reconnects within about a second. Presence IS the connection,
 * so without a grace every bounded close would drop the viewer from everyone
 * else's presence for that second. The route leaves only after a 5 s grace; a
 * reconnect inside it joins first, so the count never reaches zero.
 *
 * Pinned through the real route: right after the host ends the stream the
 * viewer is still present, and after the grace they are gone (no leak).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { snapshotOf } from '../src/features/channels/channelPresenceTracker.js';

const KEY = 'presgrace-aaaaaaaa';
const CH = '/host/openwop-app/channels';
let server: http.Server;
let BASE = '';
const prevKeys = process.env.OPENWOP_API_KEYS;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = KEY;
  process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED;
  delete process.env.OPENWOP_SSE_MAX_AGE_MS;
  if (prevKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = prevKeys;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0897 — presence survives a bounded close', () => {
  it('the viewer stays present through the grace after the host ends the stream, then leaves', async () => {
    const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
    const created = await fetch(`${BASE}${CH}`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `grace-${Date.now()}`, visibility: 'public' }) });
    expect(created.status).toBe(201);
    const channelId = ((await created.json()) as { channel: { conversationId: string } }).channel.conversationId;

    process.env.OPENWOP_SSE_MAX_AGE_MS = '300';
    const res = await fetch(`${BASE}${CH}/${channelId}/presence`, { headers: { ...auth, accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let raw = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break; // the host ended it (bounded close)
      raw += new TextDecoder().decode(value);
    }
    expect(raw).toContain('event: channel.presence');
    expect(raw.endsWith('retry: 1000\n\n')).toBe(true);

    expect(snapshotOf(channelId).present, 'still present inside the grace').toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5_400));
    expect(snapshotOf(channelId).present, 'gone after the grace — no leaked presence').toHaveLength(0);
  }, 15_000);
});
