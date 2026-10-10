/**
 * RFC 0233 — the connection-provider registry reads (`GET /connection-providers`,
 * `GET /connection-providers/{providerId}?pack=`), the normative observation path
 * for `connection-packs.md` §Provider identity and §The qualified form.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { installConnectionPackManifest } from '../src/features/connections/connectionPackLoader.js';
import { listProviders } from '../src/features/connections/providerRegistry.js';

type Manifest = Record<string, unknown> & { name: string; version: string; provider: Record<string, unknown> & { id: string } };
const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), '../../conformance-fixtures/connection-packs/connection-pack-acme-widgets.json'), 'utf8')) as Manifest;
const BUILTIN = listProviders()[0]!.id;
const ID = `rfc0233-${Date.now()}`;
const FIRST = 'vendor.test.rfc0233-first';
const RIVAL = 'vendor.test.rfc0233-rival';
const pack = (name: string, id: string, version = '1.0.0'): Manifest =>
  ({ ...FIXTURE, name, version, engines: { openwop: '>=2.0.0 <3.0.0' }, provider: { ...FIXTURE.provider, id } });

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The §D shape, driven directly: a first pack, then a rival for the same bare
  // id (refused), then a v2 pack shadowing a built-in (refused, held by builtin).
  expect(installConnectionPackManifest(pack(FIRST, ID)).installed).toBe(true);
  expect(installConnectionPackManifest(pack(RIVAL, ID, '9.0.0')).installed).toBe(false);
  expect(installConnectionPackManifest(pack('vendor.test.rfc0233-shadow', BUILTIN)).installed).toBe(false);
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const V2 = { Authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
async function get(path: string, headers: Record<string, string> = V2): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe('RFC 0233 §B — the registry read', () => {
  it('lists every definition once, built-ins included, and the refusals with their holder', async () => {
    const r = await get('/connection-providers');
    expect(r.status).toBe(200);
    const ids = (r.json.providers as Array<{ id: string }>).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);                                   // §B.4
    expect(r.json.providers).toContainEqual({ id: ID, source: 'pack', packName: FIRST });
    expect(r.json.providers).toContainEqual({ id: BUILTIN, source: 'builtin' });
    expect(r.json.refusals).toContainEqual({ packName: RIVAL, providerId: ID, code: 'connection_provider_conflict', heldBy: FIRST });
    expect(r.json.refusals).toContainEqual({ packName: 'vendor.test.rfc0233-shadow', providerId: BUILTIN, code: 'connection_provider_conflict', heldBy: 'builtin' });
  });

  it('is content-free: a row carries only id / source / packName, a refusal only its four fields', async () => {
    const r = await get('/connection-providers');
    for (const p of r.json.providers) expect(Object.keys(p).sort()).toEqual(p.source === 'pack' ? ['id', 'packName', 'source'] : ['id', 'source']);
    for (const f of r.json.refusals) expect(Object.keys(f).every((k) => ['packName', 'providerId', 'code', 'heldBy'].includes(k))).toBe(true);
  });

  // ADR 0812 P3c-0 — the "is major-2 only" leg (a `/v1/connection-providers` 404) is deleted
  // with v1: the `/v1` path space is gone, so there is no major-1 spelling left to refuse.

  it('refuses an unauthenticated caller', async () => {
    expect((await get('/connection-providers', { 'OpenWOP-Version': '2' })).status).toBe(401);
  });
});

describe('RFC 0233 §C — the resolve read', () => {
  it('a qualified reference resolves only to the named pack', async () => {
    expect(await get(`/connection-providers/${ID}?pack=${FIRST}`)).toMatchObject({ status: 200, json: { id: ID, source: 'pack', packName: FIRST } });
    const rival = await get(`/connection-providers/${ID}?pack=${RIVAL}`);
    expect(rival.status).toBe(404);
    expect(rival.json.error).toBe('connection_provider_unresolved');
  });

  it('a bare id resolves to its one definition; an unknown id is 404 connection_provider_unresolved', async () => {
    expect(await get(`/connection-providers/${ID}`)).toMatchObject({ status: 200, json: { id: ID, packName: FIRST } });
    expect(await get(`/connection-providers/${BUILTIN}`)).toMatchObject({ status: 200, json: { id: BUILTIN, source: 'builtin' } });
    const none = await get('/connection-providers/no-such-provider-0233');
    expect(none.status).toBe(404);
    expect(none.json.error).toBe('connection_provider_unresolved');
  });
});
