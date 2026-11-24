/**
 * ADR 1155 follow-up — the unpaged board read uses the card index, and "Assigned to me"
 * pages.
 *
 * `listCards` (the unpaged `GET /boards/:id` and every display read) reads the board's
 * slice of the card index and only its cards, once the tenant's index is built and its
 * legacy tenant index is verified. Otherwise it reads as before, so a legacy card with
 * no tenant (and so no marker) never disappears. `GET /kanban/assigned?limit=` returns
 * one page with `total` and `nextCursor`; without `limit` the response is unchanged.
 *
 * Red if: the index path returns different cards or order; it costs rows for the whole
 * tenant; a legacy unstamped card vanishes; or an assigned page overlaps, skips, or
 * accepts a bad cursor.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createWorkspace } from '../src/host/accessControlService.js';
import { reconcileTenantIndexesOnce } from '../src/host/tenantIndexAdoption.js';
import {
  __listCardsWithoutStoreIndex, __resetKanbanStore, createBoard, createCard, listBoardCardsPage, listCards, moveCard, pageAssignedCards,
} from '../src/host/kanbanService.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const HOUR = 60 * 60 * 1000;

describe('ADR 1155 — listCards on the card index', () => {
  let storage: Storage;
  let tenantId: string;
  beforeEach(async () => {
    storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    await __resetKanbanStore();
    tenantId = (await createWorkspace({ name: 'Unpaged', ownerSubject: 'user:owner' })).tenantId;
  });

  const verify = async (): Promise<void> => {
    const t0 = Date.now();
    await reconcileTenantIndexesOnce(storage, t0);
    await reconcileTenantIndexesOnce(storage, t0 + 4 * HOUR);
  };

  it('returns the same cards in the same order, reading the board and not the tenant', async () => {
    const board = await createBoard({ tenantId, name: 'House' });
    const other = await createBoard({ tenantId, name: 'Garden' });
    for (let i = 0; i < 12; i += 1) await createCard({ boardId: board.id, columnId: i % 3 === 0 ? 'doing' : 'todo', title: `Card ${i}` });
    for (let i = 0; i < 60; i += 1) await createCard({ boardId: other.id, columnId: 'todo', title: `Other ${i}` });
    await moveCard((await __listCardsWithoutStoreIndex(board.id))[0]!.id, 'done');
    const elsewhere = (await createWorkspace({ name: 'Elsewhere', ownerSubject: 'user:x' })).tenantId;
    await createCard({ boardId: (await createBoard({ tenantId: elsewhere, name: 'X' })).id, columnId: 'todo', title: 'Not here' });
    await verify();
    await listBoardCardsPage(board, { limit: 1 }); // builds the card index

    let rowsRead = 0;
    const get = storage.kvGet.bind(storage);
    const list = storage.kvList.bind(storage);
    vi.spyOn(storage, 'kvGet').mockImplementation(async (k) => { rowsRead += 1; return get(k); });
    vi.spyOn(storage, 'kvList').mockImplementation(async (p) => { const r = await list(p); rowsRead += r.length; return r; });
    if (storage.kvListPage) {
      const page = storage.kvListPage.bind(storage);
      vi.spyOn(storage, 'kvListPage').mockImplementation(async (p, o) => { const r = await page(p, o); rowsRead += r.length; return r; });
    }
    const viaIndex = await listCards(board.id);
    const indexRows = rowsRead;
    rowsRead = 0;
    const before = await __listCardsWithoutStoreIndex(board.id);
    const oldRows = rowsRead;
    vi.restoreAllMocks();

    expect(viaIndex.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(viaIndex).toHaveLength(12);
    // 12 markers + 12 cards + bookkeeping, against every card in the tenant.
    expect(indexRows, `index ${indexRows} vs old ${oldRows}`).toBeLessThan(40);
    expect(oldRows).toBeGreaterThan(72);
  });

  it('a tenant whose legacy index is not verified reads as before, so an unstamped card stays', async () => {
    const board = await createBoard({ tenantId, name: 'Legacy' });
    await createCard({ boardId: board.id, columnId: 'todo', title: 'Stamped' });
    const now = new Date().toISOString();
    await storage.kvSet('hostext:kanban:card:legacy-1', JSON.stringify({ id: 'legacy-1', boardId: board.id, columnId: 'todo', title: 'Unstamped', source: 'human', version: 1, order: 9, createdAt: now, updatedAt: now }));
    await listBoardCardsPage(board, { limit: 1 });
    expect((await listCards(board.id)).map((c) => c.title).sort()).toEqual(['Stamped', 'Unstamped']);
  });
});

describe('ADR 1155 — pageAssignedCards', () => {
  const at = (n: number): string => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();
  const list = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, updatedAt: at(i % 3) }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : 1));

  it('walks every card once, in order, with the total on each page', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = pageAssignedCards(list, { limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(7);
      seen.push(...page.cards.map((c) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(list.map((c) => c.id));
  });

  it('refuses a bad cursor and a bad limit', () => {
    expect(() => pageAssignedCards(list, { limit: 3, cursor: 'nope' })).toThrow(expect.objectContaining({ code: 'kanban_cursor_invalid' }));
    expect(() => pageAssignedCards(list, { limit: 0 })).toThrow(expect.objectContaining({ code: 'kanban_command_invalid' }));
  });
});

describe('ADR 1155 — GET /kanban/assigned?limit=', () => {
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

  it('pages with limit; a bad cursor is a 400; the unpaged response is unchanged', async () => {
    const login = await call<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email: `assigned-${Date.now()}@acme.test` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const me = login.body.user.userId;
    const board = (await call<{ id: string }>('POST', `${K}/boards`, { name: 'Mine' })).body;
    for (const title of ['A', 'B', 'C']) {
      const made = await call<{ id: string }>('POST', `${K}/boards/${board.id}/cards`, { title, columnId: 'todo' });
      expect((await call('POST', `${K}/cards/${made.body.id}/assign`, { assigneeId: me })).status).toBe(200);
    }
    const first = await call<{ cards: Array<{ title: string }>; total: number; nextCursor?: string }>('GET', `${K}/assigned?limit=2`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.total).toBe(3);
    expect(first.body.cards).toHaveLength(2);
    const second = await call<{ cards: Array<{ title: string }>; nextCursor?: string }>('GET', `${K}/assigned?limit=2&cursor=${first.body.nextCursor}`);
    expect([...first.body.cards, ...second.body.cards].map((c) => c.title).sort()).toEqual(['A', 'B', 'C']);
    expect(second.body.nextCursor).toBeUndefined();
    expect((await call('GET', `${K}/assigned?limit=2&cursor=nope`)).status).toBe(400);
    expect((await call('GET', `${K}/assigned?limit=0`)).status).toBe(400);
    const unpaged = await call<Record<string, unknown>>('GET', `${K}/assigned`);
    expect(Object.keys(unpaged.body)).toEqual(['cards']);
  });
});
