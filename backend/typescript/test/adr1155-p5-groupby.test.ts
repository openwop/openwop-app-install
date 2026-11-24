/**
 * ADR 1155 D3 / D7 (P5, backend) — facet filters, group counts, and a board's group-by key.
 *
 * Every card's facets ride its two board markers' projection, so `facet.<key>` filters
 * and `groupCounts` come from the same marker walk as every other filter, and changing
 * a board's `groupBy` needs no rebuild. The projection's new shape is declared as index
 * version 1: a tenant built at version 0 reads as not built and is rebuilt, so no read
 * trusts markers that lack facets.
 *
 * Red if: a facet filter or a group count disagrees with the same query over today's
 * full read (on either path); a group-by change serves stale groups; an index built at
 * the old version is trusted; or the board PATCH accepts a bad key.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createWorkspace } from '../src/host/accessControlService.js';
import {
  KANBAN_CARD_TYPE, __listBoardCardsPageFromRows, __resetKanbanStore, createBoard, createCard, listBoardCardsPage, listCards,
  setBoardGroupBy, updateCardFields, type KanbanBoard, type KanbanBoardPageQuery, type KanbanCard,
} from '../src/host/kanbanService.js';
import { __forgetVerifiedIndexes } from '../src/features/entities/systemIndex.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const NOW = Date.parse('2026-12-10T12:00:00.000Z');

describe('ADR 1155 P5 — facet filters and group counts (service)', () => {
  let store: Storage;
  let tenantId: string;
  let board: KanbanBoard;
  let all: KanbanCard[];

  beforeEach(async () => {
    store = await openStorage('memory://');
    initHostExtPersistence(store);
    await __resetKanbanStore();
    tenantId = (await createWorkspace({ name: 'Groups', ownerSubject: 'user:owner' })).tenantId;
    board = await createBoard({ tenantId, name: 'House' });
    const spec: Array<[string, Record<string, string>]> = [
      ['todo', { room: 'kitchen', stage: 'rough-in' }],
      ['todo', { room: 'kitchen', stage: 'finish' }],
      ['doing', { room: 'bath', stage: 'finish' }],
      ['todo', { room: 'bath' }],
      ['done', { stage: 'rough-in' }],
      ['todo', {}],
      ['doing', { room: 'kitchen', stage: 'finish' }],
    ];
    let i = 0;
    for (const [columnId, facets] of spec) {
      i += 1;
      await createCard({ boardId: board.id, columnId, title: `Card ${i}`, ...(Object.keys(facets).length ? { facets } : {}) });
    }
    all = await listCards(board.id);
  });

  async function walk(q: Omit<KanbanBoardPageQuery, 'cursor'>, path: 'index' | 'rows'): Promise<{ ids: string[]; counts: Array<Record<string, number> | undefined> }> {
    const read = path === 'index' ? listBoardCardsPage : __listBoardCardsPageFromRows;
    const ids: string[] = [];
    const counts: Array<Record<string, number> | undefined> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await read(board, { ...q, ...(cursor ? { cursor } : {}) }, NOW);
      ids.push(...page.cards.map((c) => c.id));
      counts.push(page.groupCounts);
      if (!page.nextCursor) return { ids, counts };
      cursor = page.nextCursor;
    }
    throw new Error('the page walk did not end');
  }

  const countBy = (cards: KanbanCard[], groupOf: (c: KanbanCard) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of cards) out[groupOf(c)] = (out[groupOf(c)] ?? 0) + 1;
    return out;
  };

  const cases: Array<[string, Omit<KanbanBoardPageQuery, 'cursor'>, (c: KanbanCard) => boolean, ((c: KanbanCard) => string) | null]> = [
    ['one facet', { limit: 2, facets: { room: 'kitchen' } }, (c) => c.facets?.room === 'kitchen', null],
    ['two facets (AND)', { limit: 1, facets: { room: 'kitchen', stage: 'finish' } }, (c) => c.facets?.room === 'kitchen' && c.facets?.stage === 'finish', null],
    ['a missing facet', { limit: 2, facets: { room: '' } }, (c) => c.facets?.room === undefined, null],
    ['group by a facet', { limit: 3, groupBy: 'room' }, () => true, (c) => c.facets?.room ?? ''],
    ['group by column, filtered', { limit: 2, groupBy: 'column', facets: { stage: 'finish' } }, (c) => c.facets?.stage === 'finish', (c) => c.columnId],
    ['group by a facet in one lane', { limit: 1, groupBy: 'stage', columns: ['todo'] }, (c) => c.columnId === 'todo', (c) => c.facets?.stage ?? ''],
  ];

  it.each(cases)('%s: exactly the matching cards and counts, on both paths', async (_label, q, keep, groupOf) => {
    const matching = all.filter(keep);
    expect(matching.length, 'the fixture must exercise this query').toBeGreaterThan(0);
    const viaIndex = await walk(q, 'index');
    expect(new Set(viaIndex.ids)).toEqual(new Set(matching.map((c) => c.id)));
    expect(viaIndex.ids).toHaveLength(matching.length);
    if (groupOf) for (const counts of viaIndex.counts) expect(counts).toEqual(countBy(matching, groupOf));
    else for (const counts of viaIndex.counts) expect(counts).toBeUndefined();
    expect(await walk(q, 'rows')).toEqual(viaIndex);
  });

  it('a facet edit moves the card between groups at once; a group-by change needs no rebuild', async () => {
    const before = (await listBoardCardsPage(board, { limit: 1, groupBy: 'room' }, NOW)).groupCounts;
    expect(before).toEqual({ kitchen: 3, bath: 2, '': 2 });
    const bath = all.find((c) => c.facets?.room === 'bath' && c.columnId === 'todo')!;
    await updateCardFields(bath.id, { facets: { room: 'kitchen' } });
    expect((await listBoardCardsPage(board, { limit: 1, groupBy: 'room' }, NOW)).groupCounts).toEqual({ kitchen: 4, bath: 1, '': 2 });

    const markerCount = async () => (await store.kvList(`hostext:entity:sysidx:${tenantId}:`)).length;
    const markersBefore = await markerCount();
    expect((await setBoardGroupBy(board.id, 'stage'))?.groupBy).toBe('stage');
    expect((await listBoardCardsPage(board, { limit: 1, groupBy: 'stage' }, NOW)).groupCounts).toEqual({ 'rough-in': 2, finish: 3, '': 2 });
    expect(await markerCount()).toBe(markersBefore);
    expect((await setBoardGroupBy(board.id, null))?.groupBy).toBeUndefined();
  });

  it('an index built at the old version is rebuilt, never trusted', async () => {
    await listBoardCardsPage(board, { limit: 1 }, NOW); // builds the index at version 1
    // Make it look like a version-0 build: no `v` on the built row and no facets on
    // any board marker, as a tenant built before P5 has.
    const builtKey = `hostext:entity:sysidx-built:${tenantId}:${encodeURIComponent(KANBAN_CARD_TYPE)}:`;
    const builtRow = JSON.parse((await store.kvGet(builtKey))!) as Record<string, unknown>;
    const { v: _v, ...v0 } = builtRow;
    await store.kvSet(builtKey, JSON.stringify(v0));
    for (const { key, value } of await store.kvList(`hostext:entity:sysidx:${tenantId}:`)) {
      const row = JSON.parse(value) as { p: Record<string, unknown> };
      if ('facets' in row.p) { const { facets: _f, ...rest } = row.p; await store.kvSet(key, JSON.stringify({ ...row, p: rest })); }
    }
    __forgetVerifiedIndexes();
    const kitchen = await listBoardCardsPage(board, { limit: 100, facets: { room: 'kitchen' } }, NOW);
    expect(kitchen.cards).toHaveLength(3);
    expect((JSON.parse((await store.kvGet(builtKey))!) as { v?: number }).v).toBe(1);
  });

  it('setBoardGroupBy refuses a bad key', async () => {
    await expect(setBoardGroupBy(board.id, 'Room')).rejects.toMatchObject({ code: 'kanban_command_invalid' });
  });
});

describe('ADR 1155 P5 — groupBy over HTTP', () => {
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

  it('PATCH sets and clears groupBy; a page filters by facet and counts groups', async () => {
    expect((await call('POST', '/host/openwop-app/test/login', { email: `groups-${Date.now()}@acme.test` })).status).toBe(201);
    const board = (await call<{ id: string }>('POST', `${K}/boards`, { name: 'Bath' })).body;
    for (const [title, room] of [['Vanity', 'bath-1'], ['Mirror', 'bath-1'], ['Tub', 'bath-2']] as const) {
      expect((await call('POST', `${K}/boards/${board.id}/cards`, { title, columnId: 'todo', facets: { room } })).status).toBe(201);
    }
    const set = await call<{ groupBy?: string; name: string }>('PATCH', `${K}/boards/${board.id}`, { groupBy: 'room' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ groupBy: 'room', name: 'Bath' });
    expect((await call('PATCH', `${K}/boards/${board.id}`, { groupBy: 'Room' })).status).toBe(400);
    expect((await call('PATCH', `${K}/boards/${board.id}`, {})).status).toBe(400);
    expect((await call<{ name: string }>('PATCH', `${K}/boards/${board.id}`, { name: 'Baths' })).body.name).toBe('Baths');

    const page = await call<{ cards: Array<{ title: string }>; total: number; groupCounts?: Record<string, number> }>(
      'GET', `${K}/boards/${board.id}?limit=10&groupBy=room&facet.room=bath-1`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.cards.map((c) => c.title).sort()).toEqual(['Mirror', 'Vanity']);
    expect(page.body.groupCounts).toEqual({ 'bath-1': 2 });
    expect((await call('GET', `${K}/boards/${board.id}?limit=10&groupBy=Rooms`)).status).toBe(400);
    expect((await call('GET', `${K}/boards/${board.id}?limit=10&facet.Room=x`)).status).toBe(400);

    const cleared = await call<{ groupBy?: string }>('PATCH', `${K}/boards/${board.id}`, { groupBy: null });
    expect(cleared.body.groupBy).toBeUndefined();
  });
});
