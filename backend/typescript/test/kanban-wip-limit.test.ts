/**
 * KB-R2-5 — soft WIP limits, route level. Invariants:
 *   - the dedicated limit route sets/clears; validation 400s outside 1–999
 *   - the board PATCH still rejects column edits (the 2026-06-05 memo holds)
 *   - THE SOFT PIN: an over-limit column still accepts creates and moves —
 *     the limit is a signal, never a gate (the GitHub/Jira consensus)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client(): { get: (p: string) => Promise<{ status: number; body: any }>; post: (p: string, b?: unknown) => Promise<{ status: number; body: any }>; patch: (p: string, b?: unknown) => Promise<{ status: number; body: any }> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const KB = '/v1/host/openwop-app/kanban';

async function boardOwner(): Promise<{ c: ReturnType<typeof client>; boardId: string; todoId: string }> {
  const c = client();
  expect((await c.post('/v1/host/openwop-app/test/login', { email: `wip-${Date.now()}-${Math.floor(Math.random() * 1e6)}@acme.test` })).status).toBe(201);
  const b = await c.post(`${KB}/boards`, { name: 'WIP board' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const todo = (b.body.columns as Array<{ id: string; name: string }>).find((col) => /to ?do/i.test(col.name) || col.id === 'todo');
  expect(todo, JSON.stringify(b.body.columns)).toBeTruthy();
  return { c, boardId: b.body.id, todoId: todo!.id };
}

describe('KB-R2-5 — the limit route', () => {
  it('sets, reflects, and clears; validates the range', async () => {
    const { c, boardId, todoId } = await boardOwner();
    expect((await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 0 })).status).toBe(400);
    expect((await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 2.5 })).status).toBe(400);
    expect((await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 1000 })).status).toBe(400);

    const set = await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 2 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((set.body.columns as Array<{ id: string; wipLimit?: number }>).find((col) => col.id === todoId)?.wipLimit).toBe(2);

    const cleared = await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body.columns as Array<{ id: string; wipLimit?: number }>).find((col) => col.id === todoId)?.wipLimit).toBeUndefined();

    expect((await c.patch(`${KB}/boards/${boardId}/columns/missing-col/limit`, { wipLimit: 2 })).status).toBe(404);
  });

  it('the board PATCH still rejects column edits (the memo invariant holds)', async () => {
    const { c, boardId } = await boardOwner();
    const res = await c.patch(`${KB}/boards/${boardId}`, { columns: [] });
    expect(res.status).toBe(400);
  });

  it('SOFT: an over-limit column still accepts creates and moves', async () => {
    const { c, boardId, todoId } = await boardOwner();
    expect((await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 1 })).status).toBe(200);
    // Two creates into a limit-1 column: BOTH succeed — the limit never gates.
    expect((await c.post(`${KB}/boards/${boardId}/cards`, { title: 'one', columnId: todoId })).status).toBe(201);
    const second = await c.post(`${KB}/boards/${boardId}/cards`, { title: 'two', columnId: todoId });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
  });
});
