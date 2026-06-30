/**
 * Subject memory (ADR 0041) — ROUTE-level harness. Boots the real app and drives
 * BOTH new surfaces over HTTP:
 *   - Personal Memory (`/profiles/me/memory`): toggle gating (404 when
 *     `profile-memory` off), self-service add/list/delete, validation, and
 *     per-user isolation (a caller only ever sees their OWN memory).
 *   - Agent memory browser (`/agents/:id/knowledge/notes`): list + delete a
 *     curated note (the data behind the agent Memory tab).
 *
 * @see docs/adr/0041-subject-memory.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pm') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const MEM = '/v1/host/openwop-app/profiles/me/memory';

describe('profile-memory — always-on (graduated off its toggle)', () => {
  it('serves a signed-in caller with no toggle enabled, but rejects anonymous (fail-closed)', async () => {
    const c = client();
    await signup(c);
    // No `profile-memory` toggle is enabled anywhere — the surface is always-on.
    expect((await c.get(MEM)).status).toBe(200);
    // An anonymous caller (no session cookie) is unauthenticated, not served.
    expect((await client().get(MEM)).status).toBe(401);
  });
});

describe('profile-memory — self-service add/list/delete', () => {
  it('a user trains, lists, and removes their own memories', async () => {
    const c = client();
    await signup(c);
    expect((await c.get(MEM)).body.notes).toEqual([]);

    const add = await c.post(MEM, { content: 'I prefer concise morning briefings.' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.notes.length).toBe(1);
    expect(add.body.notes[0].content).toBe('I prefer concise morning briefings.');
    expect(add.body.notes[0].contentTrust).toBe('trusted');

    const list = await c.get(MEM);
    expect(list.body.notes.length).toBe(1);
    const noteId = list.body.notes[0].id;

    expect((await c.del(`${MEM}/${noteId}`)).status).toBe(204);
    expect((await c.get(MEM)).body.notes).toEqual([]);
    // Deleting a non-existent memory is a fail-closed 404 (no existence leak).
    expect((await c.del(`${MEM}/mem_nope`)).status).toBe(404);
  });

  it('rejects an empty memory + secret-shaped content is scrubbed (SR-1)', async () => {
    const c = client();
    await signup(c);
    expect((await c.post(MEM, { content: '   ' })).status).toBe(400);
    const add = await c.post(MEM, { content: 'my key is sk-abcd1234efgh5678ijkl and I like tea' });
    expect(add.status).toBe(201);
    const joined = JSON.stringify(add.body.notes);
    expect(joined).toContain('[REDACTED:secret-shaped]');
    expect(joined).not.toContain('sk-abcd1234efgh5678ijkl');
    expect(joined).toContain('I like tea');
  });
});

describe('profile-memory — per-user isolation (CTI-1)', () => {
  it('one user never sees another user\'s memory', async () => {
    const a = client(); await signup(a);
    const b = client(); await signup(b);
    await a.post(MEM, { content: 'A-only personal fact' });
    expect((await b.get(MEM)).body.notes).toEqual([]);
    // B cannot delete A's memory by id (scoped to B's own subject → 404).
    const aNoteId = (await a.get(MEM)).body.notes[0].id;
    expect((await b.del(`${MEM}/${aNoteId}`)).status).toBe(404);
    expect((await a.get(MEM)).body.notes.length).toBe(1); // A's memory intact
  });
});

describe('agent memory browser — notes list + delete (ADR 0041)', () => {
  const k = (rosterId: string, suffix = ''): string => `/v1/host/openwop-app/agents/${encodeURIComponent(rosterId)}/knowledge${suffix}`;
  it('lists and deletes an agent curated note', async () => {
    const owner = client();
    await signup(owner);
    const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'Researcher', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rosterId = r.body.rosterId;
    // An org membership grants the caller workspace:write tenant-wide (the same
    // setup the agent-knowledge route harness uses).
    expect((await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).status).toBe(201);

    // Notes need memoryWritable on. Then add → list → delete.
    expect((await owner.put(k(rosterId, '/memory-writable'), { writable: true })).status).toBe(200);
    expect((await owner.post(k(rosterId, '/notes'), { content: 'Cites the Q3 board deck.' })).status).toBe(201);

    const notes = await owner.get(k(rosterId, '/notes'));
    expect(notes.status).toBe(200);
    expect(notes.body.notes.length).toBe(1);
    const noteId = notes.body.notes[0].id;

    expect((await owner.del(k(rosterId, `/notes/${noteId}`))).status).toBe(204);
    expect((await owner.get(k(rosterId, '/notes'))).body.notes).toEqual([]);
    expect((await owner.del(k(rosterId, '/notes/mem_nope'))).status).toBe(404);
  });
});
