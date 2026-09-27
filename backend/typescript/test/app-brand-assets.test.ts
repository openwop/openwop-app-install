/**
 * App-brand asset publication (ADR 0511) — copy-on-select into `host:brand`.
 * Asserts: superadmin-only; magic-byte validation (declared type must match the
 * sniffed bytes); SVG rejected on this path (no sanitizer dependency — §2);
 * byte cap; the returned capability URL serves ANONYMOUSLY (the public-logo
 * requirement); slot replacement frees the previous copy (old URL 404s).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;

// A real 1×1 PNG — the magic bytes must survive the round trip.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const publish = (body: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${BASE}/v1/host/openwop-app/app-brand/assets`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('app-brand assets (ADR 0511)', () => {
  it('publishes a valid PNG and the copy serves ANONYMOUSLY', async () => {
    const res = await publish({ slot: 'mark', contentBase64: PNG_1PX, contentType: 'image/png' });
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/v1\/host\/openwop-app\/assets\//);
    // The whole point: an anonymous visitor renders the public logo.
    const served = await fetch(`${BASE}${url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await served.arrayBuffer());
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('replacing a slot frees the previous copy (old URL 404s, new serves)', async () => {
    const first = await publish({ slot: 'favicon', contentBase64: PNG_1PX, contentType: 'image/png' });
    const { url: oldUrl } = (await first.json()) as { url: string };
    const second = await publish({ slot: 'favicon', contentBase64: PNG_1PX, contentType: 'image/png' });
    const { url: newUrl } = (await second.json()) as { url: string };
    expect(newUrl).not.toBe(oldUrl);
    expect((await fetch(`${BASE}${newUrl}`)).status).toBe(200);
    expect((await fetch(`${BASE}${oldUrl}`)).status).toBe(404);
  });

  it('rejects SVG on this path (415, names the ADR rationale)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const res = await publish({ slot: 'mark', contentBase64: svg, contentType: 'image/svg+xml' });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { message: string }).message).toMatch(/SVG is not accepted/);
  });

  it('rejects bytes that do not match the declared type (400)', async () => {
    const notPng = Buffer.from('<script>alert(1)</script>').toString('base64');
    const res = await publish({ slot: 'mark', contentBase64: notPng, contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('type_mismatch');
  });

  it('rejects oversize payloads (413)', async () => {
    // Valid PNG header followed by >512KB of padding — sniff passes, cap trips.
    const big = Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(600 * 1024)]).toString('base64');
    const res = await publish({ slot: 'mark', contentBase64: big, contentType: 'image/png' });
    expect(res.status).toBe(413);
  });

  it('rejects an unknown slot (400)', async () => {
    const res = await publish({ slot: 'banner', contentBase64: PNG_1PX, contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_slot');
  });

  it('is superadmin-only — a signed-in NON-superadmin is 403', async () => {
    let cookie = '';
    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'assets-nonadmin@x.test' }),
    });
    expect(login.status).toBe(201);
    for (const ck of getSetCookies(login.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const res = await publish({ slot: 'mark', contentBase64: PNG_1PX, contentType: 'image/png' }, { 'content-type': 'application/json', cookie });
    expect(res.status).toBe(403);
  });
});
