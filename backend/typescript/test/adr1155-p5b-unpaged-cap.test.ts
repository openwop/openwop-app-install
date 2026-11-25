/**
 * ADR 1155 OQ-2 / P5b — an unpaged read above 2,000 cards is refused, not truncated.
 *
 * `GET /boards/:id` with no `limit` counts the board; `GET /assigned` with no `limit`
 * counts the caller's matching cards. Above `KANBAN_UNPAGED_MAX` either answers a typed
 * 400 (`details.reason: kanban_board_page_required`, with `total` and `cap`) and no
 * cards. At the cap both still answer whole. A paged read is never capped.
 *
 * Red if: a read at the cap is refused; a read above it returns any cards (a truncated
 * 200 an old client would render as the whole board); the refusal loses its reason,
 * total or cap (the CLI and SPA key on the reason); or a paged read is refused.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { KANBAN_BATCH_CREATE_MAX, KANBAN_UNPAGED_MAX, applyBoardCommand } from '../src/host/kanbanService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  __resetHostExtPersistence();
});

let cookie = '';
const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const single = res.headers.get('set-cookie');
  const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
  for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
  // JSON response bodies are typed by each call site's view (`T`).
  const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
  return { status: res.status, body: out };
};
const K = '/host/openwop-app/kanban';
interface ReadBody { cards?: unknown[]; total?: number; error?: string; details?: { reason?: string; total?: number; cap?: number } }

describe('ADR 1155 P5b — the unpaged cap', () => {
  it('reads whole at the cap, refuses above it with a typed 400, and never caps a page', async () => {
    const login = await call<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email: `cap-${Date.now()}@acme.test` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const me = login.body.user.userId;
    const ws = (await call<{ workspaceId: string }>('POST', '/host/openwop-app/workspaces', { name: 'Cap' })).body.workspaceId;
    await call('POST', `/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const board = (await call<{ id: string; tenantId: string }>('POST', `${K}/boards`, { name: 'Selections' })).body;

    // Every card is assigned to the caller, so one board fills both reads.
    const fill = async (from: number, to: number): Promise<void> => {
      for (let start = from; start < to; start += KANBAN_BATCH_CREATE_MAX) {
        const items = Array.from({ length: Math.min(KANBAN_BATCH_CREATE_MAX, to - start) }, (_, i) => ({
          sourceId: `sel-${start + i}`, title: `Selection ${start + i}`, columnId: 'todo', assigneeId: me,
        }));
        const r = await applyBoardCommand({ type: 'cards.create-batch', tenantId: board.tenantId, boardId: board.id, items });
        expect(r.items.every((x) => x.status === 'created')).toBe(true);
      }
    };

    await fill(0, KANBAN_UNPAGED_MAX);
    const atCapBoard = await call<ReadBody>('GET', `${K}/boards/${board.id}`);
    expect(atCapBoard.status, JSON.stringify(atCapBoard.body).slice(0, 300)).toBe(200);
    expect(atCapBoard.body.cards).toHaveLength(KANBAN_UNPAGED_MAX);
    const atCapAssigned = await call<ReadBody>('GET', `${K}/assigned`);
    expect(atCapAssigned.status).toBe(200);
    expect(atCapAssigned.body.cards).toHaveLength(KANBAN_UNPAGED_MAX);

    await fill(KANBAN_UNPAGED_MAX, KANBAN_UNPAGED_MAX + 1);
    const refusal = { reason: 'kanban_board_page_required', total: KANBAN_UNPAGED_MAX + 1, cap: KANBAN_UNPAGED_MAX };
    for (const path of [`${K}/boards/${board.id}`, `${K}/assigned`]) {
      const over = await call<ReadBody>('GET', path);
      expect(over.status, path).toBe(400);
      expect(over.body.details, path).toMatchObject(refusal);
      expect(over.body.cards, path).toBeUndefined();
    }

    const pagedBoard = await call<ReadBody>('GET', `${K}/boards/${board.id}?limit=100`);
    expect(pagedBoard.status).toBe(200);
    expect(pagedBoard.body.cards).toHaveLength(100);
    expect(pagedBoard.body.total).toBe(KANBAN_UNPAGED_MAX + 1);
    const pagedAssigned = await call<ReadBody>('GET', `${K}/assigned?limit=100`);
    expect(pagedAssigned.status).toBe(200);
    expect(pagedAssigned.body.cards).toHaveLength(100);
    expect(pagedAssigned.body.total).toBe(KANBAN_UNPAGED_MAX + 1);
  }, 120_000);
});
