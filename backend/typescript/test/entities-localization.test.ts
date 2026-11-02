/**
 * Entity localization (ADR 0406 Phases 2–3) — TST-DAA-1. Route-level coverage:
 * the `localizable` flag (string-only), overlay writes fail-closed behind the
 * `entities-localization` toggle, overlay validation (locale shape, field
 * allowlist), locale-negotiated public delivery (Accept-Language, explicit
 * ?locale wins, Content-Language + Vary, overlays never leak), and the NDJSON
 * round-trip with per-row toggle errors.
 *
 * Each case seeds its own type, so the file passes alone and shuffled; the
 * global toggle is set in `beforeEach` and every flip restores in `finally`.
 *
 * Red when (sabotage-witnessed, wave 70): the customFields string-only check is
 * dropped; the route's write gate (`requireLocalizationForWrite`) is dropped;
 * the overlay locale check or the non-localizable-field check is dropped;
 * `toPublicEntity` stops resolving overlays; the single-entity route stops
 * setting `Vary: Accept-Language`; an explicit `?locale` stops winning; the
 * public read ignores the toggle; NDJSON import stops refusing overlay rows
 * while the toggle is off.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { updateContentLanguageSettings } from '../src/host/contentLocales.js';

let BASE: string;
let server: http.Server;

interface ErrorBody { error?: string; message?: string }

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
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

/** A refusal must be THIS refusal: same status, same code, the named message. */
async function expectRefusal(res: Response, message: string): Promise<void> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as ErrorBody;
  expect(body.error).toBe('validation_error');
  expect(body.message).toContain(message);
}

const B = '/host/openwop-app/entities';
const P = '/host/openwop-app/public-entities';
const T = 'tenant-loc';

const STORY_FIELDS = [
  { key: 'title', label: 'Title', type: 'string', required: true, localizable: true },
  { key: 'body', label: 'Body', type: 'string', required: false, localizable: true },
  { key: 'rank', label: 'Rank', type: 'number', required: false },
];

/** Create + publish + publicRead a localizable type, owned by this case. */
async function seedType(owner: Client, name: string): Promise<void> {
  expect((await owner.post(`${B}/types`, { name, fields: STORY_FIELDS })).status).toBe(201);
  expect((await owner.patch(`${B}/types/${name}`, { status: 'published' })).status).toBe(200);
  expect((await owner.patch(`${B}/types/${name}`, { publicRead: true })).status).toBe(200);
}

async function owner(subject = 'owner-loc', tenantId = T): Promise<Client> {
  const c = client();
  await c.login(subject, tenantId);
  return c;
}

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

beforeEach(async () => { await setToggle('entities-localization', 'on'); });

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('entity localization (ADR 0406)', () => {
  it('localizable is string-only and closed-world at type save', async () => {
    const o = await owner();
    const bad = await o.post(`${B}/types`, {
      name: 'bad-type',
      fields: [{ key: 'count', label: 'Count', type: 'number', required: false, localizable: true }],
    });
    await expectRefusal(bad, '`localizable` is only valid for a `string` field');
    // The same type with the flag on a STRING field saves (positive control).
    const ok = await o.post(`${B}/types`, {
      name: 'bad-type',
      fields: [{ key: 'count', label: 'Count', type: 'string', required: false, localizable: true }],
    });
    expect(ok.status).toBe(201);
  });

  it('overlay writes fail closed while the entities-localization toggle is OFF', async () => {
    const o = await owner();
    await seedType(o, 'story-off');
    await setToggle('entities-localization', 'off');
    try {
      const res = await o.post(`${B}/types/story-off/entities`, {
        values: { title: 'Hello', rank: 1 },
        localizations: { es: { title: 'Hola' } },
      });
      await expectRefusal(res, 'Entity localization is not enabled');
      // Without overlays the write is untouched by the toggle.
      expect((await o.post(`${B}/types/story-off/entities`, { entityId: 'st-plain', values: { title: 'Plain' } })).status).toBe(201);
    } finally {
      await setToggle('entities-localization', 'on');
    }
  });

  it('validates overlays closed-world and serves locale-negotiated public reads', async () => {
    const o = await owner();
    await seedType(o, 'story-read');
    const S = 'story-read';

    // Bad locale key / non-localizable field → the NAMED 400.
    await expectRefusal(
      await o.post(`${B}/types/${S}/entities`, { values: { title: 'X' }, localizations: { nope_x: { title: 'Y' } } }),
      'Invalid overlay locale `nope_x`',
    );
    await expectRefusal(
      await o.post(`${B}/types/${S}/entities`, { values: { title: 'X' }, localizations: { es: { rank: 2 } } }),
      'Field `rank` is not localizable',
    );

    const created = await o.post(`${B}/types/${S}/entities`, {
      entityId: 'st-hello',
      values: { title: 'Hello', body: 'World', rank: 1 },
      localizations: { es: { title: 'Hola', body: 'Mundo' }, 'pt-BR': { title: 'Olá' } },
    });
    expect(created.status).toBe(201);
    const raw = (await created.json()) as { localizations?: Record<string, unknown> };
    expect(raw.localizations?.es).toEqual({ title: 'Hola', body: 'Mundo' });

    const a = client(); // anonymous
    // Accept-Language negotiation → es values + headers.
    const es = await a.get(`${P}/${T}/types/${S}/entities/st-hello`, { 'accept-language': 'es, en;q=0.5' });
    expect(es.status).toBe(200);
    expect(es.headers.get('content-language')).toBe('es');
    const vary = (es.headers.get('vary') ?? '').split(',').map((t) => t.trim().toLowerCase());
    expect(vary).toContain('accept-language');
    const esBody = (await es.json()) as { values: Record<string, unknown>; localizations?: unknown };
    expect(esBody.values.title).toBe('Hola');
    expect(esBody.values.rank).toBe(1); // non-localized fields ride along
    expect(esBody.localizations).toBeUndefined(); // the overlay map never leaks

    // Explicit ?locale wins over the header (non-normative surface — D5).
    const pt = await a.get(`${P}/${T}/types/${S}/entities/st-hello?locale=pt-BR`, { 'accept-language': 'es' });
    expect(((await pt.json()) as { values: Record<string, unknown> }).values.title).toBe('Olá');
    // pt-BR overlay is partial → body falls back to base.
    expect(((await a.get(`${P}/${T}/types/${S}/entities/st-hello?locale=pt-BR`).then((r) => r.json())) as { values: Record<string, unknown> }).values.body).toBe('World');

    // Unsupported negotiation → base; malformed explicit locale → the NAMED 400.
    const de = await a.get(`${P}/${T}/types/${S}/entities/st-hello`, { 'accept-language': 'de' });
    expect(((await de.json()) as { values: Record<string, unknown> }).values.title).toBe('Hello');
    await expectRefusal(await a.get(`${P}/${T}/types/${S}/entities/st-hello?locale=not!valid`), 'Invalid locale `not!valid`');

    // List path resolves too.
    const list = await a.get(`${P}/${T}/types/${S}/entities?sortKey=title&sortDir=asc`, { 'accept-language': 'es' });
    expect(list.headers.get('content-language')).toBe('es');
    const rows = ((await list.json()) as { entities: Array<{ entityId: string; values: Record<string, unknown> }> }).entities;
    expect(rows.find((r) => r.entityId === 'st-hello')?.values.title).toBe('Hola');

    // Toggle OFF ⇒ base values, no negotiation headers (byte-identical).
    await setToggle('entities-localization', 'off');
    try {
      const off = await a.get(`${P}/${T}/types/${S}/entities/st-hello`, { 'accept-language': 'es' });
      expect(off.headers.get('content-language')).toBeNull();
      expect(((await off.json()) as { values: Record<string, unknown> }).values.title).toBe('Hello');
    } finally {
      await setToggle('entities-localization', 'on');
    }
  });

  it('round-trips overlays through NDJSON export/import; toggle-off rows error per-row', async () => {
    const o = await owner();
    await seedType(o, 'story-nd');
    expect((await o.post(`${B}/types/story-nd/entities`, {
      entityId: 'nd-1',
      values: { title: 'Hello', body: 'World', rank: 1 },
      localizations: { es: { title: 'Hola', body: 'Mundo' } },
    })).status).toBe(201);
    const exported = await o.get(`${B}/types/story-nd/export`);
    expect(exported.status).toBe(200);
    const ndjson = await exported.text();
    const rows = ndjson.trim().split('\n').filter((l) => l.includes('"localizations"'));
    expect(rows).toHaveLength(1);

    // Import into a second tenant.
    const o2 = await owner('owner-loc2', 'tenant-loc2');
    expect((await o2.post(`${B}/types`, { name: 'story-nd', fields: STORY_FIELDS })).status).toBe(201);

    // Toggle OFF ⇒ the overlay-carrying row errors PER-ROW (never a silent drop).
    await setToggle('entities-localization', 'off');
    try {
      const blocked = await o2.post(`${B}/types/story-nd/import`, { ndjson: rows.join('\n') });
      expect(blocked.status).toBe(200);
      const blockedResult = (await blocked.json()) as { created: number; errors: Array<{ line: number; message: string }> };
      expect(blockedResult.errors).toHaveLength(1);
      expect(blockedResult.errors[0]?.message).toContain('entities-localization');
      expect(blockedResult.created).toBe(0);
    } finally {
      await setToggle('entities-localization', 'on');
    }

    // Toggle ON ⇒ the same row imports with overlays intact.
    const ok = await o2.post(`${B}/types/story-nd/import`, { ndjson: rows.join('\n') });
    const okResult = (await ok.json()) as { created: number; errors: Array<{ message: string }> };
    expect(okResult.errors).toHaveLength(0);
    expect(okResult.created).toBe(1);
    const reread = await o2.get(`${B}/types/story-nd/entities/nd-1`);
    expect(reread.status).toBe(200);
    expect((((await reread.json()) as { localizations?: Record<string, unknown> }).localizations)?.es).toEqual({ title: 'Hola', body: 'Mundo' });
  });
});
