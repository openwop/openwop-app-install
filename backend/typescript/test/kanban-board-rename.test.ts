/**
 * Board rename — PATCH /host/openwop-app/kanban/boards/:boardId (architect memo
 * 2026-06-05). Rename is metadata-only: `name` is the ONLY mutable field
 * (owner rebinding alters run attribution per RFC 0086 §C; column edits alter
 * trigger semantics — both rejected), and the route is tenant-fenced like
 * DELETE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createBoard, getBoard } from '../src/host/kanbanService.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((res) => server.close(() => res()));
});

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

describe('board rename — PATCH boards/:boardId', () => {
  const create = async (name: string): Promise<string> => {
    const created = await api<{ id: string }>('/host/openwop-app/kanban/boards', { method: 'POST', body: JSON.stringify({ name }) });
    expect(created.status).toBe(201);
    return created.body.id;
  };
  const patch = (id: string, body: unknown) =>
    api<{ id?: string; name?: string; error?: string }>(`/host/openwop-app/kanban/boards/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  it('renames (name only) and the rename persists', async () => {
    const id = await create('Before');
    const renamed = await patch(id, { name: 'After' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('After');
    // Persisted: a fresh read, not the write response.
    const read = await api<{ board: { name: string } }>(`/host/openwop-app/kanban/boards/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.board.name).toBe('After');
  });

  it('rejects other fields, and an empty name', async () => {
    const id = await create('Keep');
    // Only `name` is mutable — owner/column rebinding is rejected.
    const rejected = await patch(id, { name: 'X', rosterId: 'ros_evil' });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: 'validation_error', message: 'Only `name` is mutable on a board.' });

    const empty = await patch(id, { name: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ error: 'validation_error' });
    expect((await getBoard(id))?.name).toBe('Keep');
  });

  it('404s cross-tenant/missing', async () => {
    // A REAL board in another tenant: the caller (dev-token, tenant `default`) can't see it.
    const foreign = await createBoard({ tenantId: 'tenant-rename-foreign', name: 'Foreign' });
    const refused = await patch(foreign.id, { name: 'Hijacked' });
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: 'not_found' });
    expect((await getBoard(foreign.id))?.name).toBe('Foreign');
    // Positive control: the caller's own board is reachable through the same route.
    const own = await create('Own');
    expect((await patch(own, { name: 'Own 2' })).status).toBe(200);

    const missing = await patch('b_nope', { name: 'X' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'not_found' });
  });
});
