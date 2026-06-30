/**
 * ADR 0119 Phase 2 — conversation export route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

async function j(path: string, init: RequestInit = {}): Promise<{ status: number; text: string; ct: string }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') ?? '' };
}
const enable = async (s: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('chat-export'); if (d) await saveConfig({ ...d, status: s }, 'test'); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // a conversation owned by the caller
  const r = await fetch(`${BASE}/v1/host/openwop-app/chat/sessions`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Export me' }) });
  const sid = (await r.json() as { sessionId: string }).sessionId;
  (globalThis as Record<string, unknown>).__sid = sid;
  await fetch(`${BASE}/v1/host/openwop-app/chat/sessions/${sid}/messages`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ messageId: 'm0', role: 'user', content: 'hello export' }) });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const sid = (): string => (globalThis as Record<string, unknown>).__sid as string;

describe('chat-export route', () => {
  it('serves without a toggle (always-on)', async () => {
    expect((await j(`/v1/host/openwop-app/chat-export/${sid()}`)).status).toBe(200);
  });

  it('renders markdown by default', async () => {
    await enable('on');
    const r = await j(`/v1/host/openwop-app/chat-export/${sid()}`);
    expect(r.status).toBe(200);
    expect(r.ct).toContain('markdown');
    expect(r.text).toContain('# Export me');
    expect(r.text).toContain('hello export');
  });

  it('renders the openwop-v1 JSON with ?format=json', async () => {
    await enable('on');
    const r = await j(`/v1/host/openwop-app/chat-export/${sid()}?format=json`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as { version: string; messages: unknown[] };
    expect(body.version).toBe('openwop-v1');
    expect(body.messages).toHaveLength(1);
  });

  it('404s a non-existent conversation', async () => {
    await enable('on');
    expect((await j('/v1/host/openwop-app/chat-export/nope-nope')).status).toBe(404);
  });

  it('imports an openwop-v1 export into a NEW conversation (round-trip)', async () => {
    await enable('on');
    const exported = JSON.parse((await j(`/v1/host/openwop-app/chat-export/${sid()}?format=json`)).text) as unknown;
    const imp = await j('/v1/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'openwop', data: exported }) });
    expect(imp.status).toBe(201);
    const { sessionId, imported } = JSON.parse(imp.text) as { sessionId: string; imported: number };
    expect(sessionId).toBeTruthy();
    expect(imported).toBeGreaterThanOrEqual(1);
    // the imported conversation re-exports with the original turn content.
    const reexport = await j(`/v1/host/openwop-app/chat-export/${sessionId}`);
    expect(reexport.status).toBe(200);
    expect(reexport.text).toContain('hello export');
  });

  it('import serves without a toggle (always-on; bad body ⇒ 4xx, not 404-off)', async () => {
    const r = await j('/v1/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'openwop', data: {} }) });
    expect(r.status).not.toBe(404);
  });

  it('CONV-4: a present-but-unknown format is 400 (no silent openwop fallback)', async () => {
    const r = await j('/v1/host/openwop-app/chat-export/import', { method: 'POST', body: JSON.stringify({ format: 'chatgtp', data: {} }) });
    expect(r.status).toBe(400);
  });
});
