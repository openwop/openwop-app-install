/**
 * Entities public read (ADR 0407 D2 / Phase A1) — route-level coverage of the
 * anonymous `public-entities` surface: closed-by-default (toggle, type status,
 * publicRead flag — ONE uniform 404), entry-level draft filtering, the
 * public projection (no actor subjects / storage internals), cross-tenant
 * probes, limit clamp, and the status lifecycle (draft → live → draft).
 *
 * TST-DAA-5. Every case seeds its own type in its own tenant, so the file
 * passes alone and shuffled; toggle flips restore in `finally`.
 * Honest ceiling: same-named types in two tenants live under tenant-derived
 * storage keys (`typeKeyOf`), so the cross-tenant case proves the public read
 * is keyed by the PATH tenant (both tenants public, each serves only its own
 * row) — there is no shared reader to sabotage.
 *
 * Red when (sabotage-witnessed, wave 70): `gatePublicType` stops requiring
 * `publicRead`, `status === 'published'`, or the `entities` toggle; the single
 * read serves a draft row; `toPublicEntity` leaks record internals; the public
 * list stops clamping `limit` to 50.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createEntity, createEntityType, updateEntityType } from '../src/features/entities/entitiesService.js';

let BASE: string;
let server: http.Server;

interface Client {
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  post: (path: string, body?: unknown) => Promise<Response>;
  patch: (path: string, body?: unknown) => Promise<Response>;
}

function client(): Client & { login: (subject: string, tenantId: string) => Promise<void> } {
  let cookie = '';
  const send = async (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> => {
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

/** Anonymous caller — NEVER logs in (the whole point of this suite). */
const anon = (): Client => client();

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default: ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

const B = '/host/openwop-app/entities';
const P = '/host/openwop-app/public-entities';

interface ErrorBody { error?: string; message?: string }

/** The uniform anonymous 404 — same code + message whichever gate closed. */
async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const body = (await res.json()) as ErrorBody;
  expect(body.error).toBe('not_found');
  expect(body.message).toBe('Not found.');
}

/** Owner logs in, creates + publishes + opens `team-member` in `tenantId`. */
async function seedPublicType(subject: string, tenantId: string): Promise<Client & { login: (s: string, t: string) => Promise<void> }> {
  const owner = client();
  await owner.login(subject, tenantId);
  expect((await owner.post(`${B}/types`, { name: 'team-member', fields: TEAM_FIELDS })).status).toBe(201);
  expect((await owner.patch(`${B}/types/team-member`, { status: 'published' })).status).toBe(200);
  expect((await owner.patch(`${B}/types/team-member`, { publicRead: true })).status).toBe(200);
  return owner;
}

const TEAM_FIELDS = [
  { key: 'name', label: 'Name', type: 'string', required: true },
  { key: 'role', label: 'Role', type: 'string', required: false },
];

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
});

beforeEach(async () => { await setToggle('entities', 'on'); });

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('entities public read (ADR 0407 D2)', () => {
  it('is uniformly 404 while ANY gate is closed: toggle off, type draft, publicRead absent, unknown tenant/type', async () => {
    const owner = client();
    await owner.login('owner-pub', 'tenant-pub');
    expect((await owner.post(`${B}/types`, { name: 'team-member', fields: TEAM_FIELDS })).status).toBe(201);
    expect((await owner.post(`${B}/types/team-member/entities`, { values: { name: 'Ada' } })).status).toBe(201);

    const a = anon();
    // DRAFT type that already carries publicRead → still 404 (the status gate alone).
    expect((await owner.patch(`${B}/types/team-member`, { publicRead: true })).status).toBe(200);
    await expectNotFound(await a.get(`${P}/tenant-pub/types/team-member/entities`));

    // Published but publicRead cleared → still 404 (the flag gate alone).
    expect((await owner.patch(`${B}/types/team-member`, { publicRead: false })).status).toBe(200);
    expect((await owner.patch(`${B}/types/team-member`, { status: 'published' })).status).toBe(200);
    await expectNotFound(await a.get(`${P}/tenant-pub/types/team-member/entities`));

    // Unknown tenant / unknown type → the same 404 shape.
    await expectNotFound(await a.get(`${P}/no-such-tenant/types/team-member/entities`));
    await expectNotFound(await a.get(`${P}/tenant-pub/types/no-such-type/entities`));

    // Every gate open → served (the positive control for the 404s above).
    expect((await owner.patch(`${B}/types/team-member`, { publicRead: true })).status).toBe(200);
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities`)).status).toBe(200);

    // Toggle off closes an already-public type too (fail-closed).
    await setToggle('entities', 'off');
    try {
      await expectNotFound(await a.get(`${P}/tenant-pub/types/team-member/entities`));
    } finally {
      await setToggle('entities', 'on');
    }
  });

  it('serves live entries through the public projection; drafts are invisible; the lifecycle round-trips', async () => {
    const owner = await seedPublicType('owner-pub2', 'tenant-pub2');
    const T2 = 'tenant-pub2';

    const live = await owner.post(`${B}/types/team-member/entities`, { values: { name: 'Ada', role: 'CTO' } });
    expect(live.status).toBe(201);
    const liveId = ((await live.json()) as { entityId: string }).entityId;
    const draft = await owner.post(`${B}/types/team-member/entities`, { values: { name: 'Draft Dan' }, status: 'draft' });
    expect(draft.status).toBe(201);
    const draftId = ((await draft.json()) as { entityId: string }).entityId;

    const a = anon();
    const list = await a.get(`${P}/${T2}/types/team-member/entities`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { entities: Array<Record<string, unknown>> };
    expect(body.entities.map((e) => e.entityId)).toEqual([liveId]);

    // Projection: values + ids + timestamps ONLY — never actor subjects or
    // storage internals (createdBy is a member subject; PII-adjacent).
    expect(Object.keys(body.entities[0] ?? {}).sort()).toEqual(['createdAt', 'entityId', 'updatedAt', 'values']);

    // Single fetch: live 200 (same projection), draft 404, unknown 404.
    const one = await a.get(`${P}/${T2}/types/team-member/entities/${liveId}`);
    expect(one.status).toBe(200);
    expect(Object.keys((await one.json()) as Record<string, unknown>).sort()).toEqual(['createdAt', 'entityId', 'updatedAt', 'values']);
    await expectNotFound(await a.get(`${P}/${T2}/types/team-member/entities/${draftId}`));
    await expectNotFound(await a.get(`${P}/${T2}/types/team-member/entities/nope`));

    // Lifecycle: draft → live appears; live → draft disappears.
    expect((await owner.patch(`${B}/types/team-member/entities/${draftId}`, { status: 'live' })).status).toBe(200);
    expect((await a.get(`${P}/${T2}/types/team-member/entities/${draftId}`)).status).toBe(200);
    expect((await owner.patch(`${B}/types/team-member/entities/${draftId}`, { status: 'draft' })).status).toBe(200);
    await expectNotFound(await a.get(`${P}/${T2}/types/team-member/entities/${draftId}`));

    // Authed reads still see the draft (authoring is unaffected).
    const authedList = await owner.get(`${B}/types/team-member/entities`);
    expect(authedList.status).toBe(200);
    const authedIds = ((await authedList.json()) as { entities: Array<{ entityId: string }> }).entities.map((e) => e.entityId);
    expect(authedIds).toContain(draftId);
  });

  it('validates public query inputs and clamps the limit', async () => {
    // 51 live rows in a public type, so a clamp to 50 is observable.
    const TC = 'tenant-pub-clamp';
    await createEntityType({ tenantId: TC, name: 'member', displayName: 'Member', fields: TEAM_FIELDS, createdBy: 'u-clamp' });
    await updateEntityType({ tenantId: TC, name: 'member', patch: { status: 'published' }, actor: 'u-clamp' });
    await updateEntityType({ tenantId: TC, name: 'member', patch: { publicRead: true }, actor: 'u-clamp' });
    for (let i = 0; i < 51; i += 1) {
      await createEntity({ tenantId: TC, typeName: 'member', entityId: `m-${String(i).padStart(2, '0')}`, values: { name: i === 0 ? 'Ada' : `Member ${i}` }, createdBy: 'u-clamp' });
    }

    const a = anon();
    const notJson = await a.get(`${P}/${TC}/types/member/entities?filters=not-json`);
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as ErrorBody).message).toBe('`filters` must be valid JSON.');
    const unknownKey = await a.get(`${P}/${TC}/types/member/entities?filters=${encodeURIComponent(JSON.stringify([{ key: 'nope', op: 'eq', value: 1 }]))}`);
    expect(unknownKey.status).toBe(400);
    expect(((await unknownKey.json()) as ErrorBody).error).toBe('validation_error');
    // A huge limit is clamped server-side to 50, not an error.
    const res = await a.get(`${P}/${TC}/types/member/entities?limit=5000`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { entities: unknown[]; nextCursor?: string };
    expect(page.entities).toHaveLength(50);
    expect(page.nextCursor).toBeDefined();
    // Sort + equality filter work anonymously over live rows.
    const sorted = await a.get(`${P}/${TC}/types/member/entities?sortKey=name&sortDir=asc&filters=${encodeURIComponent(JSON.stringify([{ key: 'name', op: 'eq', value: 'Ada' }]))}`);
    expect(sorted.status).toBe(200);
    expect(((await sorted.json()) as { entities: Array<{ entityId: string }> }).entities.map((e) => e.entityId)).toEqual(['m-00']);
  });

  it('never leaks another tenant\'s same-named type through the public path', async () => {
    const ownerA = await seedPublicType('owner-xa', 'tenant-pub-xa');
    expect((await ownerA.post(`${B}/types/team-member/entities`, { values: { name: 'Ada' } })).status).toBe(201);
    const ownerB = await seedPublicType('owner-xb', 'tenant-pub-xb');
    expect((await ownerB.post(`${B}/types/team-member/entities`, { values: { name: 'Bee' } })).status).toBe(201);
    // Both tenants are public; each path serves ONLY its own tenant's rows.
    const a = anon();
    const names = async (t: string): Promise<string[]> =>
      ((await (await a.get(`${P}/${t}/types/team-member/entities`)).json()) as { entities: Array<{ values: { name: string } }> }).entities.map((e) => e.values.name);
    expect(await names('tenant-pub-xa')).toEqual(['Ada']);
    expect(await names('tenant-pub-xb')).toEqual(['Bee']);
  });
});
