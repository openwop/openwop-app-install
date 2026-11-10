import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { blankFilm } from '../../../contracts/films.js';
import { getSetCookies } from './headerCookies.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';

let server: http.Server, base: string;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'films-test-session-secret-at-least-32-characters';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'films-test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }); });
  for (const id of ['films', 'slides']) { const config = getToggleDefault(id)!; await saveConfig({ ...config, status: 'on' }, 'test'); }
}, 60_000);
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

interface Reply { canvasId?: string; orgId?: string; version?: number; ownerSubject?: { kind: string; id: string }; user?: { userId: string }; film?: unknown }
async function login(tenantId: string, name: string) {
  let cookie = '';
  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const set of getSetCookies(response.headers)) { const match = /(__session=[^;]+)/.exec(set); if (match) cookie = match[1]!; }
    return { status: response.status, body: await response.json() as Reply, cache: response.headers.get('cache-control') };
  }
  const user = await call('POST', '/host/openwop-app/test/login', { email: `${name}@films.test`, tenantId });
  expect(user.status).toBe(201);
  return { call, userId: user.body.user!.userId };
}
describe('film canvas authority and lifecycle', () => {
  it('reports malformed stored films through the canonical error envelope on both projections', async () => {
    await saveConfig({ ...getToggleDefault('films')!, status: 'on' }, 'test');
    const tenant = 'org:films-invalid'; const owner = await login(tenant, 'invalid-owner');
    const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Invalid film fixture' });
    expect(org.status).toBe(201);
    const canvas = await createCanvasForTenant(tenant, {
      canvasTypeId: 'canvas.film', ownerSubject: { kind: 'user', id: owner.userId }, initialState: { malformed: true },
    });
    for (const projection of ['presenter', 'audience']) {
      const reply = await owner.call('GET', `/host/openwop-app/films/orgs/${org.body.orgId!}/canvases/${canvas.canvasId}/${projection}`);
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ error: 'validation_error', message: 'Film is invalid.', details: { errors: expect.any(Array) } });
      expect(reply.body).not.toHaveProperty('errors');
    }
  });

  it('creates private films, refuses another org member, strips audience notes, and preserves CAS', async () => {
    const tenant = 'org:films-access'; const owner = await login(tenant, 'owner');
    const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Films' });
    const orgId = org.body.orgId!; expect(org.status).toBe(201);
    const root = `/host/openwop-app/films/orgs/${orgId}/canvases`;
    const created = await owner.call('POST', root, { name: 'Live story', idempotencyKey: 'same-request-key' }); expect(created.status).toBe(201);
    const id = created.body.canvasId!;
    expect(created.body.ownerSubject).toEqual({ kind: 'user', id: owner.userId });
    const film = blankFilm('Live story'); film.scenes[0]!.notes = 'PRIVATE-CANARY';
    expect((await owner.call('PATCH', `${root}/${id}`, { state: film, expectedVersion: 1 })).status).toBe(200);
    expect((await owner.call('PATCH', `${root}/${id}`, { state: film, expectedVersion: 1 })).status).toBe(409);
    const presenter = await owner.call('GET', `${root}/${id}/presenter`); expect(presenter.status).toBe(200);
    expect(JSON.stringify(presenter.body.film)).toContain('PRIVATE-CANARY'); expect(presenter.cache).toBe('no-store');
    const audience = await owner.call('GET', `${root}/${id}/audience`); expect(audience.status).toBe(200);
    expect(JSON.stringify(audience.body)).not.toContain('PRIVATE-CANARY');
    const other = await login(tenant, 'other');
    await createMember({ tenantId: tenant, orgId, subject: other.userId, displayName: 'Other', roles: ['editor'] });
    const retry = await owner.call('POST', root, { name: 'Live story', idempotencyKey: 'same-request-key' });
    expect(retry.body.canvasId).toBe(id);
    const separate = await other.call('POST', root, { name: 'Other story', idempotencyKey: 'same-request-key' });
    expect(separate.status).toBe(201); expect(separate.body.canvasId).not.toBe(id);
    expect(separate.body.ownerSubject).toEqual({ kind: 'user', id: other.userId });
    for (const suffix of ['', '/presenter', '/audience']) expect((await other.call('GET', `${root}/${id}${suffix}`)).status).toBe(404);
    expect((await other.call('PATCH', `${root}/${id}`, { state: film, expectedVersion: 2 })).status).toBe(404);
    const invalid = structuredClone(film); invalid.scenes[0]!.cues[0]!.changes[0]!.elementId = 'missing';
    expect((await owner.call('PATCH', `${root}/${id}`, { state: invalid, expectedVersion: 2 })).status).toBe(422);
    // Opt-in privacy leaves the established default of existing types intact.
    const slides = await owner.call('POST', `/host/openwop-app/slides/orgs/${orgId}/canvases`, { name: 'Existing type' });
    expect(slides.status).toBe(201); expect(slides.body.ownerSubject).toBeUndefined();
    const config = getToggleDefault('films')!; await saveConfig({ ...config, status: 'off' }, 'test');
    expect((await owner.call('GET', `${root}/${id}/presenter`)).status).toBe(404); // disabled features conceal their resources
  }, 60_000);
});
