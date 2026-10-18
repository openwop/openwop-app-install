/**
 * ADR 0126 Phase 4 / RFC 0110 — the presence snapshot SEAM (the conformance behavioral
 * leg's driver). Off ⇒ 404 (capability unadvertised); on ⇒ the closed channel.presence
 * shape with exactly the calling member present (non-vacuous); a SAME-TENANT
 * authenticated non-member of a private channel ⇒ 403 (DEFAULT-DENY).
 *
 * What breaks it: the snapshot route skipping `assertChannelAccess` (any principal in
 * the tenant reads who is online in a private channel), leaking fields beyond the RFC
 * 0110 payload, or answering while the presence flag is off. The non-member is a
 * second configured API key in the same `default` tenant (the channels-authz-route
 * pattern) — an UNKNOWN bearer is refused 401 by auth before the gate runs, which
 * is why the pre-w26 version of this case could not fail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

const OWNER_KEY = 'presowner-aaaaaaaa';
const OTHER_KEY = 'presother-bbbbbbbb';
const CH = '/host/openwop-app/channels';

let server: http.Server;
let BASE: string;
const prevKeys = process.env.OPENWOP_API_KEYS;

async function j(path: string, key: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  let body: unknown = null; try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
}
const createAs = async (key: string, name: string, visibility: 'public' | 'private'): Promise<string> => {
  const r = await j(CH, key, { method: 'POST', body: JSON.stringify({ name, visibility }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { channel: { conversationId: string } }).channel.conversationId;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = `${OWNER_KEY},${OTHER_KEY}`; // both scoped to `default`
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED;
  if (prevKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = prevKeys;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('channel presence snapshot seam (RFC 0110 behavioral)', () => {
  it('404s when presence is disabled (capability unadvertised)', async () => {
    delete process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED;
    const chId = await createAs(OWNER_KEY, `eng-off-${Date.now()}`, 'public');
    const r = await j(`${CH}/${chId}/presence/snapshot`, OWNER_KEY);
    expect(r.status).toBe(404);
    // The FLAG's 404 — not a missing channel's.
    expect((r.body as { message?: string }).message).toContain('presence is not enabled');
  });

  it('returns the closed channel.presence shape with the caller present (non-vacuous) when enabled', async () => {
    process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED = 'true';
    const id = await createAs(OWNER_KEY, `eng-on-${Date.now()}`, 'public');
    const r = await j(`${CH}/${id}/presence/snapshot`, OWNER_KEY);
    expect(r.status).toBe(200);
    const snap = r.body as { conversationId: string; present: string[]; typing: string[] };
    expect(snap.conversationId).toBe(id);
    expect(snap.present).toHaveLength(1);                                       // exactly the caller (transient join)
    expect(snap.present.every((ref) => ref.startsWith('user:'))).toBe(true);    // RFC 0041 refs only
    expect(snap.typing).toEqual([]);
    // closed shape — no field beyond the RFC 0110 payload (no PII)
    expect(Object.keys(snap).sort()).toEqual(['conversationId', 'present', 'typing']);
  });

  it('denies a non-member on a private channel (DEFAULT-DENY 403)', async () => {
    process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED = 'true';
    const pid = await createAs(OWNER_KEY, `secret-${Date.now()}`, 'private');
    // Positive control: the OTHER key is authenticated in the same tenant (it can list).
    expect((await j(CH, OTHER_KEY)).status).toBe(200);
    const r = await j(`${CH}/${pid}/presence/snapshot`, OTHER_KEY);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect((r.body as { error?: string }).error).toBe('forbidden');
  });
});
