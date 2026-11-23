/**
 * ADR 1155 D3 / P3c-1 — `GET /boards/:id` serves one filtered page from the card index.
 *
 * Service half: bare persistence and the real service. Every query is checked against
 * the same query evaluated over today's full read, on both the index path and the
 * while-building path, and a cursor from one path resumes on the other.
 * Route half: `createApp` + cookie sessions, because the query parsing, the 400s and
 * the unchanged unpaged response are only visible over HTTP.
 *
 * Red if: a filter keeps or drops the wrong card; pages overlap, skip or reorder; the
 * two paths disagree; a cursor resumes under another query; a stale marker serves a
 * card that no longer matches; or the unpaged response changes shape.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createWorkspace } from '../src/host/accessControlService.js';
import {
  __listBoardCardsPageFromRows, __resetKanbanStore, createBoard, createCard, getBoard, listBoardCardsPage, listCards, moveCard,
  type KanbanBoard, type KanbanBoardPageQuery, type KanbanCard,
} from '../src/host/kanbanService.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const NOW = Date.parse('2026-12-10T12:00:00.000Z');
const day = (d: number): string => new Date(Date.UTC(2026, 11, d)).toISOString();
const codeOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (err: { code?: unknown }) => err.code);

describe('ADR 1155 P3c-1 — the paged board read (service)', () => {
  let store: Storage;
  let tenantId: string;
  let board: KanbanBoard;
  let all: KanbanCard[];

  beforeEach(async () => {
    store = await openStorage('memory://');
    initHostExtPersistence(store);
    await __resetKanbanStore();
    tenantId = (await createWorkspace({ name: 'Pages', ownerSubject: 'user:owner' })).tenantId;
    board = await createBoard({ tenantId, name: 'House' });
    const spec: Array<Partial<KanbanCard> & { columnId: string }> = [
      { columnId: 'todo', dueAt: day(3), assigneeId: 'user:alice', labels: ['selections'] },
      { columnId: 'todo', dueAt: day(12), assigneeRole: 'designer' },
      { columnId: 'todo' },
      { columnId: 'todo', dueAt: day(8), assigneeId: 'user:bob', labels: ['decisions'] },
      { columnId: 'doing', dueAt: day(1), assigneeId: 'user:alice' },
      { columnId: 'doing', labels: ['selections', 'decisions'] },
      { columnId: 'doing', dueAt: day(20), assigneeRole: 'designer' },
      { columnId: 'done', dueAt: day(2), assigneeId: 'user:alice' },
      { columnId: 'done' },
      { columnId: 'todo', dueAt: day(10), assigneeId: 'user:alice' },
      { columnId: 'doing', dueAt: day(10) },
      { columnId: 'todo', labels: ['reminders'] },
    ];
    let i = 0;
    for (const s of spec) {
      i += 1;
      await createCard({
        boardId: board.id, columnId: s.columnId, title: `Card ${i}`,
        ...(s.dueAt ? { dueAt: s.dueAt } : {}), ...(s.assigneeId ? { assigneeId: s.assigneeId } : {}),
        ...(s.assigneeRole ? { assigneeRole: s.assigneeRole } : {}), ...(s.labels ? { labels: s.labels } : {}),
      });
    }
    // A move re-ranks a card within its lane, so orders are not simply 1..n.
    await moveCard((await listCards(board.id)).find((c) => c.title === 'Card 12')!.id, 'todo');
    all = await listCards(board.id);
  });

  /** Every page of a query, in order, on one path. */
  async function walk(q: Omit<KanbanBoardPageQuery, 'cursor'>, path: 'index' | 'rows' = 'index'): Promise<{ ids: string[]; totals: number[] }> {
    const read = path === 'index' ? listBoardCardsPage : __listBoardCardsPageFromRows;
    const ids: string[] = [];
    const totals: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await read(board, { ...q, ...(cursor ? { cursor } : {}) }, NOW);
      ids.push(...page.cards.map((c) => c.id));
      totals.push(page.total);
      if (!page.nextCursor) return { ids, totals };
      cursor = page.nextCursor;
    }
    throw new Error('the page walk did not end');
  }

  const byOrder = (a: KanbanCard, b: KanbanCard): number => (a.columnId < b.columnId ? -1 : a.columnId > b.columnId ? 1 : a.order - b.order || (a.id < b.id ? -1 : 1));
  const byDue = (a: KanbanCard, b: KanbanCard): number => {
    const x = a.dueAt ?? '~'; const y = b.dueAt ?? '~';
    return x < y ? -1 : x > y ? 1 : (a.id < b.id ? -1 : 1);
  };

  const cases: Array<[string, Omit<KanbanBoardPageQuery, 'cursor'>, (c: KanbanCard) => boolean]> = [
    ['everything', { limit: 5 }, () => true],
    ['one column', { limit: 2, columns: ['todo'] }, (c) => c.columnId === 'todo'],
    ['two columns', { limit: 3, columns: ['todo', 'done'] }, (c) => c.columnId === 'todo' || c.columnId === 'done'],
    ['a date range', { limit: 2, dueFrom: day(2), dueTo: day(10) }, (c) => !!c.dueAt && c.dueAt >= day(2) && c.dueAt <= day(10)],
    ['overdue', { limit: 2, overdue: true }, (c) => !!c.dueAt && Date.parse(c.dueAt) < NOW && c.columnId !== 'done'],
    ['an assignee', { limit: 2, assignee: 'user:alice' }, (c) => c.assigneeId === 'user:alice'],
    ['a role', { limit: 1, assignee: 'role:designer' }, (c) => c.assigneeRole === 'designer'],
    ['nobody', { limit: 3, assignee: 'none' }, (c) => !c.assigneeId && !c.assigneeRole],
    ['labels, any of', { limit: 2, labels: ['decisions', 'reminders'] }, (c) => (c.labels ?? []).some((l) => l === 'decisions' || l === 'reminders')],
    ['by due date', { limit: 4, sort: 'dueAt' }, () => true],
    ['by due date, one column', { limit: 2, sort: 'dueAt', columns: ['doing'] }, (c) => c.columnId === 'doing'],
  ];

  it.each(cases)('%s: the pages are exactly the matching cards, in order, on both paths', async (_label, q, keep) => {
    const want = all.filter(keep).sort(q.sort === 'dueAt' ? byDue : byOrder).map((c) => c.id);
    expect(want.length, 'the fixture must exercise this query').toBeGreaterThan(0);
    const viaIndex = await walk(q, 'index');
    expect(viaIndex.ids).toEqual(want);
    expect(new Set(viaIndex.totals)).toEqual(new Set([want.length]));
    expect(await walk(q, 'rows')).toEqual(viaIndex);
  });

  it('a cursor from the while-building path resumes on the index path', async () => {
    const first = await __listBoardCardsPageFromRows(board, { limit: 4 }, NOW);
    const second = await listBoardCardsPage(board, { limit: 100, cursor: first.nextCursor! }, NOW);
    expect([...first.cards, ...second.cards].map((c) => c.id)).toEqual([...all].sort(byOrder).map((c) => c.id));
  });

  it('a cursor reused with another query is refused, and a bad limit is refused', async () => {
    const page = await listBoardCardsPage(board, { limit: 2, columns: ['todo'] }, NOW);
    expect(await codeOf(listBoardCardsPage(board, { limit: 2, columns: ['doing'], cursor: page.nextCursor! }, NOW))).toBe('kanban_cursor_invalid');
    expect(await codeOf(listBoardCardsPage(board, { limit: 2, cursor: 'not-a-cursor' }, NOW))).toBe('kanban_cursor_invalid');
    expect(await codeOf(listBoardCardsPage(board, { limit: 101 }, NOW))).toBe('kanban_command_invalid');
  });

  it('a stale marker never serves a card that no longer matches, and is healed', async () => {
    await listBoardCardsPage(board, { limit: 1 }, NOW); // builds the index
    const victim = all.find((c) => c.columnId === 'todo')!;
    // Rewrite the row behind the index's back, as an older revision might.
    await store.kvSet(`hostext:kanban:card:${victim.id}`, JSON.stringify({ ...victim, columnId: 'done' }));
    const page = await listBoardCardsPage(board, { limit: 100, columns: ['todo'] }, NOW);
    expect(page.cards.map((c) => c.id)).not.toContain(victim.id);
    const healed = await listBoardCardsPage(board, { limit: 100, columns: ['done'] }, NOW);
    expect(healed.cards.map((c) => c.id)).toContain(victim.id);
  });

  it('a marker without the facts projection is judged by its row, never skipped', async () => {
    await listBoardCardsPage(board, { limit: 1 }, NOW); // builds the index
    const target = all.find((c) => c.columnId === 'doing')!;
    // Strip the facts from the card's board markers, as a marker written before P3c-1 had them.
    const prefix = `hostext:entity:sysidx:${tenantId}:`;
    let stripped = 0;
    for (const { key, value } of await store.kvList(prefix)) {
      const row = JSON.parse(value) as { id: string; k: string; p: Record<string, unknown> };
      if (row.id !== target.id || !/:board(-due)?:/.test(row.k)) continue;
      await store.kvSet(key, JSON.stringify({ ...row, p: {} }));
      stripped += 1;
    }
    expect(stripped).toBe(2);
    const page = await listBoardCardsPage(board, { limit: 100, columns: ['doing'] }, NOW);
    expect(page.cards.map((c) => c.id)).toContain(target.id);
    const healed = (await store.kvList(prefix)).map(({ value }) => JSON.parse(value) as { id: string; k: string; p: Record<string, unknown> })
      .filter((r) => r.id === target.id && /:board(-due)?:/.test(r.k));
    expect(healed.every((r) => r.p.columnId === 'doing')).toBe(true);
  });

  it('a board page never carries another tenant\'s cards', async () => {
    const otherTenant = (await createWorkspace({ name: 'Other', ownerSubject: 'user:other' })).tenantId;
    const other = await createBoard({ tenantId: otherTenant, name: 'Theirs' });
    await createCard({ boardId: other.id, columnId: 'todo', title: 'Not yours' });
    const ids = (await walk({ limit: 100 })).ids;
    expect(ids).toHaveLength(all.length);
    expect((await listBoardCardsPage((await getBoard(other.id))!, { limit: 100 }, NOW)).cards.map((c) => c.title)).toEqual(['Not yours']);
  });
});

describe('ADR 1155 P3c-1 — the paged board read (route)', () => {
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
  interface PageBody { cards: Array<{ id: string; title: string }>; workItems: unknown[]; total?: number; nextCursor?: string; error?: string; details?: { reason?: string } }

  it('pages with limit; bad input is a 400; the unpaged response is unchanged', async () => {
    const login = await call('POST', '/host/openwop-app/test/login', { email: `pages-${Date.now()}@acme.test` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const board = (await call<{ id: string }>('POST', `${K}/boards`, { name: 'Bath' })).body;
    for (const title of ['A', 'B', 'C']) {
      expect((await call('POST', `${K}/boards/${board.id}/cards`, { title, columnId: 'todo' })).status).toBe(201);
    }

    const first = await call<PageBody>('GET', `${K}/boards/${board.id}?limit=2`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.cards.map((c) => c.title)).toEqual(['A', 'B']);
    expect(first.body.total).toBe(3);
    const second = await call<PageBody>('GET', `${K}/boards/${board.id}?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.cards.map((c) => c.title)).toEqual(['C']);
    expect(second.body.nextCursor).toBeUndefined();

    const reused = await call<PageBody>('GET', `${K}/boards/${board.id}?limit=2&column=doing&cursor=${first.body.nextCursor}`);
    expect(reused.status).toBe(400);
    expect(reused.body.details?.reason).toBe('kanban_cursor_invalid');
    expect((await call('GET', `${K}/boards/${board.id}?limit=0`)).status).toBe(400);
    expect((await call('GET', `${K}/boards/${board.id}?limit=2&sort=title`)).status).toBe(400);
    expect((await call('GET', `${K}/boards/${board.id}?limit=2&dueFrom=soon`)).status).toBe(400);

    const unpaged = await call<PageBody & Record<string, unknown>>('GET', `${K}/boards/${board.id}`);
    expect(unpaged.status).toBe(200);
    expect(Object.keys(unpaged.body).sort()).toEqual(['board', 'cards', 'workItems']);
    expect(unpaged.body.cards).toHaveLength(3);
  });
});
