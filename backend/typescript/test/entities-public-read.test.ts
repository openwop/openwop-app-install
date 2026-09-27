/**
 * Entities public read (ADR 0407 D2 / Phase A1) — route-level coverage of the
 * anonymous `public-entities` surface: closed-by-default (toggle, type status,
 * publicRead flag — ONE uniform 404), entry-level draft filtering, the
 * public projection (no actor subjects / storage internals), cross-tenant
 * probes, limit clamp, and the status lifecycle (draft → live → draft).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

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
      const res = await send('POST', '/v1/host/openwop-app/test/login', { subject, tenantId });
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

const B = '/v1/host/openwop-app/entities';
const P = '/v1/host/openwop-app/public-entities';

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

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('entities public read (ADR 0407 D2)', () => {
  it('is uniformly 404 while ANY gate is closed: toggle off, type draft, publicRead absent, unknown tenant/type', async () => {
    await setToggle('entities', 'on');
    const owner = client();
    await owner.login('owner-pub', 'tenant-pub');
    expect((await owner.post(`${B}/types`, { name: 'team-member', fields: TEAM_FIELDS })).status).toBe(201);

    const a = anon();
    // Type exists but is DRAFT → 404.
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities`)).status).toBe(404);

    // Published but publicRead never flipped → still 404.
    expect((await owner.patch(`${B}/types/team-member`, { status: 'published' })).status).toBe(200);
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities`)).status).toBe(404);

    // Unknown tenant / unknown type → the same 404 shape.
    expect((await a.get(`${P}/no-such-tenant/types/team-member/entities`)).status).toBe(404);
    expect((await a.get(`${P}/tenant-pub/types/no-such-type/entities`)).status).toBe(404);

    // Toggle off closes an already-public type too (fail-closed).
    expect((await owner.patch(`${B}/types/team-member`, { publicRead: true })).status).toBe(200);
    await setToggle('entities', 'off');
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities`)).status).toBe(404);
    await setToggle('entities', 'on');
  });

  it('serves live entries through the public projection; drafts are invisible; the lifecycle round-trips', async () => {
    const owner = client();
    await owner.login('owner-pub', 'tenant-pub');

    const live = await owner.post(`${B}/types/team-member/entities`, { values: { name: 'Ada', role: 'CTO' } });
    expect(live.status).toBe(201);
    const liveId = ((await live.json()) as { entityId: string }).entityId;
    const draft = await owner.post(`${B}/types/team-member/entities`, { values: { name: 'Draft Dan' }, status: 'draft' });
    expect(draft.status).toBe(201);
    const draftId = ((await draft.json()) as { entityId: string }).entityId;

    const a = anon();
    const list = await a.get(`${P}/tenant-pub/types/team-member/entities`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { entities: Array<Record<string, unknown>> };
    const ids = body.entities.map((e) => e.entityId);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(draftId);

    // Projection: values + ids + timestamps ONLY — never actor subjects or
    // storage internals (createdBy is a member subject; PII-adjacent).
    for (const e of body.entities) {
      expect(e.createdBy).toBeUndefined();
      expect(e.updatedBy).toBeUndefined();
      expect(e.tenantId).toBeUndefined();
      expect(e.recordKey).toBeUndefined();
      expect(e.typeId).toBeUndefined();
      expect(e.values).toBeDefined();
    }

    // Single fetch: live 200 (same projection), draft 404, unknown 404.
    const one = await a.get(`${P}/tenant-pub/types/team-member/entities/${liveId}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as Record<string, unknown>).createdBy).toBeUndefined();
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities/${draftId}`)).status).toBe(404);
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities/nope`)).status).toBe(404);

    // Lifecycle: draft → live appears; live → draft disappears.
    expect((await owner.patch(`${B}/types/team-member/entities/${draftId}`, { status: 'live' })).status).toBe(200);
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities/${draftId}`)).status).toBe(200);
    expect((await owner.patch(`${B}/types/team-member/entities/${draftId}`, { status: 'draft' })).status).toBe(200);
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities/${draftId}`)).status).toBe(404);

    // Authed reads still see the draft (authoring is unaffected).
    const authedList = await owner.get(`${B}/types/team-member/entities`);
    expect(authedList.status).toBe(200);
    const authedIds = ((await authedList.json()) as { entities: Array<{ entityId: string }> }).entities.map((e) => e.entityId);
    expect(authedIds).toContain(draftId);
  });

  it('validates public query inputs and clamps the limit', async () => {
    const a = anon();
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities?filters=not-json`)).status).toBe(400);
    expect((await a.get(`${P}/tenant-pub/types/team-member/entities?filters=${encodeURIComponent(JSON.stringify([{ key: 'nope', op: 'eq', value: 1 }]))}`)).status).toBe(400);
    // A huge limit is clamped server-side, not an error.
    const res = await a.get(`${P}/tenant-pub/types/team-member/entities?limit=5000`);
    expect(res.status).toBe(200);
    // Sort + equality filter work anonymously over live rows.
    const sorted = await a.get(`${P}/tenant-pub/types/team-member/entities?sortKey=name&sortDir=asc&filters=${encodeURIComponent(JSON.stringify([{ key: 'name', op: 'eq', value: 'Ada' }]))}`);
    expect(sorted.status).toBe(200);
    expect(((await sorted.json()) as { entities: unknown[] }).entities.length).toBe(1);
  });

  it('never leaks another tenant\'s same-named type through the public path', async () => {
    const ownerB = client();
    await ownerB.login('owner-b', 'tenant-pub-b');
    expect((await ownerB.post(`${B}/types`, { name: 'team-member', fields: TEAM_FIELDS })).status).toBe(201);
    expect((await ownerB.post(`${B}/types/team-member/entities`, { values: { name: 'Bee' } })).status).toBe(201);
    // tenant-b never opted in → 404 under its OWN tenant path; tenant-a's
    // public list never contains tenant-b rows.
    const a = anon();
    expect((await a.get(`${P}/tenant-pub-b/types/team-member/entities`)).status).toBe(404);
    const listA = await a.get(`${P}/tenant-pub/types/team-member/entities`);
    const names = ((await listA.json()) as { entities: Array<{ values: { name: string } }> }).entities.map((e) => e.values.name);
    expect(names).not.toContain('Bee');
  });
});
