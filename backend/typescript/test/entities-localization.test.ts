/**
 * Entity localization (ADR 0406 Phases 2–3) — route-level coverage: the
 * `localizable` flag (string-only), overlay writes fail-closed behind the
 * `entities-localization` toggle, overlay validation (locale shape, field
 * allowlist, one-validator values), locale-negotiated public delivery
 * (Accept-Language, explicit ?locale wins, Content-Language + Vary, overlays
 * never leak), and the NDJSON round-trip with per-row toggle errors.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { updateContentLanguageSettings } from '../src/host/contentLocales.js';

let BASE: string;
let server: http.Server;

interface Client {
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  post: (path: string, body?: unknown) => Promise<Response>;
  patch: (path: string, body?: unknown) => Promise<Response>;
}

function client(): Client & { login: (subject: string, tenantId: string) => Promise<void> } {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(extraHeaders ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    return res;
  };
  return {
    get: (p, h) => send('GET', p, undefined, h),
    post: (p, b) => send('POST', p, b),
    patch: (p, b) => send('PATCH', p, b),
    login: async (subject, tenantId) => {
      const res = await send('POST', '/v1/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

const B = '/v1/host/openwop-app/entities';
const P = '/v1/host/openwop-app/public-entities';
const T = 'tenant-loc';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({
    port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  await setToggle('entities', 'on');
  // Locale-settings anchor: the tenant's primary org (ADR 0406 — entities are
  // tenant-scoped; the org is the settings key). Arranged via core services.
  const org = await createOrg({ tenantId: T, createdBy: 'owner-loc', name: 'Loc Org' });
  await updateContentLanguageSettings(T, org.orgId, { baseLocale: 'en', supportedLocales: ['es', 'pt-BR'] }, 'test');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('entity localization (ADR 0406)', () => {
  it('localizable is string-only and closed-world at type save', async () => {
    const owner = client();
    await owner.login('owner-loc', T);
    const bad = await owner.post(`${B}/types`, {
      name: 'bad-type',
      fields: [{ key: 'count', label: 'Count', type: 'number', required: false, localizable: true }],
    });
    expect(bad.status).toBe(400);
    const ok = await owner.post(`${B}/types`, {
      name: 'story',
      fields: [
        { key: 'title', label: 'Title', type: 'string', required: true, localizable: true },
        { key: 'body', label: 'Body', type: 'string', required: false, localizable: true },
        { key: 'rank', label: 'Rank', type: 'number', required: false },
      ],
    });
    expect(ok.status).toBe(201);
    expect((await owner.patch(`${B}/types/story`, { status: 'published' })).status).toBe(200);
    expect((await owner.patch(`${B}/types/story`, { publicRead: true })).status).toBe(200);
  });

  it('overlay writes fail closed while the entities-localization toggle is OFF', async () => {
    await setToggle('entities-localization', 'off');
    const owner = client();
    await owner.login('owner-loc', T);
    const res = await owner.post(`${B}/types/story/entities`, {
      values: { title: 'Hello', rank: 1 },
      localizations: { es: { title: 'Hola' } },
    });
    expect(res.status).toBe(400);
    // Without overlays the write is untouched by the toggle.
    expect((await owner.post(`${B}/types/story/entities`, { entityId: 'st-plain', values: { title: 'Plain' } })).status).toBe(201);
  });

  it('validates overlays closed-world and serves locale-negotiated public reads', async () => {
    await setToggle('entities-localization', 'on');
    const owner = client();
    await owner.login('owner-loc', T);

    // Bad locale key / non-localizable field → 400.
    expect((await owner.post(`${B}/types/story/entities`, { values: { title: 'X' }, localizations: { nope_x: { title: 'Y' } } })).status).toBe(400);
    expect((await owner.post(`${B}/types/story/entities`, { values: { title: 'X' }, localizations: { es: { rank: 2 } } })).status).toBe(400);

    const created = await owner.post(`${B}/types/story/entities`, {
      entityId: 'st-hello',
      values: { title: 'Hello', body: 'World', rank: 1 },
      localizations: { es: { title: 'Hola', body: 'Mundo' }, 'pt-BR': { title: 'Olá' } },
    });
    expect(created.status).toBe(201);
    const raw = (await created.json()) as { localizations?: Record<string, unknown> };
    expect(raw.localizations?.es).toEqual({ title: 'Hola', body: 'Mundo' });

    const a = client(); // anonymous
    // Accept-Language negotiation → es values + headers.
    const es = await a.get(`${P}/${T}/types/story/entities/st-hello`, { 'accept-language': 'es, en;q=0.5' });
    expect(es.status).toBe(200);
    expect(es.headers.get('content-language')).toBe('es');
    expect(es.headers.get('vary')).toContain('Accept-Language');
    const esBody = (await es.json()) as { values: Record<string, unknown>; localizations?: unknown };
    expect(esBody.values.title).toBe('Hola');
    expect(esBody.values.rank).toBe(1); // non-localized fields ride along
    expect(esBody.localizations).toBeUndefined(); // the overlay map never leaks

    // Explicit ?locale wins over the header (non-normative surface — D5).
    const pt = await a.get(`${P}/${T}/types/story/entities/st-hello?locale=pt-BR`, { 'accept-language': 'es' });
    expect(((await pt.json()) as { values: Record<string, unknown> }).values.title).toBe('Olá');
    // pt-BR overlay is partial → body falls back to base.
    expect(((await a.get(`${P}/${T}/types/story/entities/st-hello?locale=pt-BR`).then((r) => r.json())) as { values: Record<string, unknown> }).values.body).toBe('World');

    // Unsupported negotiation → base; malformed explicit locale → 400.
    const de = await a.get(`${P}/${T}/types/story/entities/st-hello`, { 'accept-language': 'de' });
    expect(((await de.json()) as { values: Record<string, unknown> }).values.title).toBe('Hello');
    expect((await a.get(`${P}/${T}/types/story/entities/st-hello?locale=not!valid`)).status).toBe(400);

    // List path resolves too.
    const list = await a.get(`${P}/${T}/types/story/entities?sortKey=title&sortDir=asc`, { 'accept-language': 'es' });
    expect(list.headers.get('content-language')).toBe('es');
    const rows = ((await list.json()) as { entities: Array<{ entityId: string; values: Record<string, unknown> }> }).entities;
    expect(rows.find((r) => r.entityId === 'st-hello')?.values.title).toBe('Hola');

    // Toggle OFF ⇒ base values, no negotiation headers (byte-identical).
    await setToggle('entities-localization', 'off');
    const off = await a.get(`${P}/${T}/types/story/entities/st-hello`, { 'accept-language': 'es' });
    expect(off.headers.get('content-language')).toBeNull();
    expect(((await off.json()) as { values: Record<string, unknown> }).values.title).toBe('Hello');
    await setToggle('entities-localization', 'on');
  });

  it('round-trips overlays through NDJSON export/import; toggle-off rows error per-row', async () => {
    const owner = client();
    await owner.login('owner-loc', T);
    const exported = await owner.get(`${B}/types/story/export`);
    expect(exported.status).toBe(200);
    const ndjson = await exported.text();
    expect(ndjson).toContain('"localizations"');

    // Import into a second tenant WITHOUT localization → per-row errors.
    const owner2 = client();
    await owner2.login('owner-loc2', 'tenant-loc2');
    expect((await owner2.post(`${B}/types`, {
      name: 'story',
      fields: [
        { key: 'title', label: 'Title', type: 'string', required: true, localizable: true },
        { key: 'body', label: 'Body', type: 'string', required: false, localizable: true },
        { key: 'rank', label: 'Rank', type: 'number', required: false },
      ],
    })).status).toBe(201);
    const rows = ndjson.trim().split('\n').filter((l) => l.includes('"localizations"'));
    expect(rows.length).toBeGreaterThan(0);

    // Toggle OFF ⇒ overlay-carrying rows error PER-ROW (never a silent drop).
    await setToggle('entities-localization', 'off');
    const blocked = await owner2.post(`${B}/types/story/import`, { ndjson: rows.join('\n') });
    expect(blocked.status).toBe(200);
    const blockedResult = (await blocked.json()) as { created: number; errors: Array<{ message: string }> };
    expect(blockedResult.errors.length).toBeGreaterThan(0);
    expect(blockedResult.errors[0]?.message).toContain('entities-localization');
    expect(blockedResult.created).toBe(0);

    // Toggle ON ⇒ the same rows import with overlays intact.
    await setToggle('entities-localization', 'on');
    const ok = await owner2.post(`${B}/types/story/import`, { ndjson: rows.join('\n') });
    const okResult = (await ok.json()) as { created: number; errors: Array<{ message: string }> };
    expect(okResult.errors.length).toBe(0);
    expect(okResult.created).toBeGreaterThan(0);
    const reread = await owner2.get(`${B}/types/story/entities/st-hello`);
    expect(reread.status).toBe(200);
    expect((((await reread.json()) as { localizations?: Record<string, unknown> }).localizations)?.es).toEqual({ title: 'Hola', body: 'Mundo' });
  });
});
