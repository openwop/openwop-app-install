/**
 * KB-R2-5 — soft WIP limits, route level. Invariants:
 *   - the dedicated limit route sets/clears; validation 400s outside 1–999
 *   - THE SOFT PIN: an over-limit column still accepts creates and moves —
 *     the limit is a signal, never a gate (the GitHub/Jira consensus)
 * (The board PATCH rejecting column edits — the 2026-06-05 memo — is owned by
 * kanban-board-rename.test.ts "rejects other fields".)
 *
 * Red if the 1–999 / integer validation loosens (probes w37g1-wip-range,
 * -wip-integer), a clear keeps the limit or the write is not persisted
 * (-wip-clear, -wip-persisted), or any create/move path starts gating on the
 * limit (-wip-soft-gate).
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

interface Res { status: number; body: unknown }
interface BoardBody { id: string; columns: Array<{ id: string; name: string; wipLimit?: number }> }
const board = (r: Res): BoardBody => r.body as BoardBody;
const errorOf = (r: Res): string | undefined => (r.body as { error?: string } | undefined)?.error;

function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
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

const KB = '/host/openwop-app/kanban';

async function boardOwner(): Promise<{ c: ReturnType<typeof client>; boardId: string; todoId: string }> {
  const c = client();
  expect((await c.post('/host/openwop-app/test/login', { email: `wip-${Date.now()}-${Math.floor(Math.random() * 1e6)}@acme.test` })).status).toBe(201);
  const b = await c.post(`${KB}/boards`, { name: 'WIP board' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const todo = board(b).columns.find((col) => /to ?do/i.test(col.name) || col.id === 'todo');
  expect(todo, JSON.stringify(board(b).columns)).toBeTruthy();
  return { c, boardId: board(b).id, todoId: todo!.id };
}

/** The limit as PERSISTED — a fresh GET, never the write response. */
async function storedLimit(c: ReturnType<typeof client>, boardId: string, columnId: string): Promise<number | undefined> {
  const r = await c.get(`${KB}/boards/${boardId}`);
  expect(r.status).toBe(200);
  return (r.body as { board: BoardBody }).board.columns.find((col) => col.id === columnId)?.wipLimit;
}

describe('KB-R2-5 — the limit route', () => {
  it('sets, reflects, and clears; validates the range', async () => {
    const { c, boardId, todoId } = await boardOwner();
    const zero = await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 0 });
    expect(zero.status).toBe(400);
    expect(errorOf(zero)).toBe('validation_error');
    expect((await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 2.5 })).status).toBe(400);
    expect((await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 1000 })).status).toBe(400);
    expect(await storedLimit(c, boardId, todoId)).toBeUndefined();

    const set = await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 2 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(board(set).columns.find((col) => col.id === todoId)?.wipLimit).toBe(2);
    expect(await storedLimit(c, boardId, todoId)).toBe(2);

    const cleared = await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: null });
    expect(cleared.status).toBe(200);
    expect(await storedLimit(c, boardId, todoId)).toBeUndefined();

    const missing = await c.patch(`${KB}/boards/${boardId}/columns/missing-col/limit`, { wipLimit: 2 });
    expect(missing.status).toBe(404);
    expect(errorOf(missing)).toBe('not_found');
  });

  it('SOFT: an over-limit column still accepts creates and moves', async () => {
    const { c, boardId, todoId } = await boardOwner();
    expect((await c.patch(`${KB}/boards/${boardId}/columns/${todoId}/limit`, { wipLimit: 1 })).status).toBe(200);
    // Two creates into a limit-1 column: BOTH succeed — the limit never gates.
    expect((await c.post(`${KB}/boards/${boardId}/cards`, { title: 'one', columnId: todoId })).status).toBe(201);
    const second = await c.post(`${KB}/boards/${boardId}/cards`, { title: 'two', columnId: todoId });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    // …and a MOVE into the (now over-limit) column also succeeds.
    const elsewhere = await c.post(`${KB}/boards/${boardId}/cards`, { title: 'three', columnId: 'doing' });
    expect(elsewhere.status).toBe(201);
    const moved = await c.patch(`${KB}/cards/${(elsewhere.body as { id: string }).id}`, { columnId: todoId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((moved.body as { card: { columnId: string } }).card.columnId).toBe(todoId);
  });
});
