/**
 * ADR 0126 Phase 4 / RFC 0110 — the presence snapshot SEAM (the conformance behavioral
 * leg's driver). Off ⇒ 404 (capability unadvertised); on ⇒ the closed channel.presence
 * shape with the calling member present (non-vacuous); non-member ⇒ 403 (DEFAULT-DENY).
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

async function j(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  let body: unknown = null; try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
}
const enableChannels = async (): Promise<void> => { const d = getToggleDefault('channels'); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await enableChannels();
  const r = await j('/v1/host/openwop-app/channels', { method: 'POST', body: JSON.stringify({ name: 'eng', visibility: 'public' }) });
  (globalThis as Record<string, unknown>).__chId = (r.body as { channel: { conversationId: string } }).channel.conversationId;
});
afterAll(async () => { delete process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED; await new Promise<void>((res) => server.close(() => res())); });
const chId = (): string => (globalThis as Record<string, unknown>).__chId as string;

describe('channel presence snapshot seam (RFC 0110 behavioral)', () => {
  it('404s when presence is disabled (capability unadvertised)', async () => {
    delete process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED;
    expect((await j(`/v1/host/openwop-app/channels/${chId()}/presence/snapshot`)).status).toBe(404);
  });

  it('returns the closed channel.presence shape with the caller present (non-vacuous) when enabled', async () => {
    process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED = 'true';
    const r = await j(`/v1/host/openwop-app/channels/${chId()}/presence/snapshot`);
    expect(r.status).toBe(200);
    const snap = r.body as { conversationId: string; present: string[]; typing: string[] };
    expect(snap.conversationId).toBe(chId());
    expect(Array.isArray(snap.present) && snap.present.length >= 1).toBe(true); // the caller is present
    expect(snap.present.every((ref) => ref.startsWith('user:'))).toBe(true);    // RFC 0041 refs only
    // closed shape — no field beyond the RFC 0110 payload (no PII)
    expect(Object.keys(snap).sort()).toEqual(['conversationId', 'present', 'typing']);
  });

  it('denies a non-member on a private channel (DEFAULT-DENY 403)', async () => {
    process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED = 'true';
    const priv = await j('/v1/host/openwop-app/channels', { method: 'POST', body: JSON.stringify({ name: 'secret', visibility: 'private' }) });
    const pid = (priv.body as { channel: { conversationId: string } }).channel.conversationId;
    const r = await j(`/v1/host/openwop-app/channels/${pid}/presence/snapshot`, { headers: { authorization: 'Bearer other-user-token' } });
    expect([401, 403, 404]).toContain(r.status); // denied — unauth / forbidden / not-visible (all DEFAULT-DENY)
  });
});
