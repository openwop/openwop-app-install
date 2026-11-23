/**
 * ADR 1155 D1 — a card carries `facets`, a small string-keyed map of grouping keys.
 *
 * Service half: bare persistence and the real service, materialize and eraser.
 * Route half: `createApp` + cookie sessions, because a bad map must be a 400 on
 * create and on PATCH, not a 500, and a per-key `null` must survive the body.
 *
 * Red if: a bad key, value or count is stored; a per-key `null` drops the other
 * keys or a map `null` keeps them; a work item's facets do not reach its card, or
 * a refresh keeps a key the source dropped; or the DSAR eraser leaves them.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import {
  FACETS_MAX,
  applyBoardCommand,
  createBoard,
  createCard,
  eraseSubjectKanban,
  getCard,
  refreshCardFacts,
  updateCardFields,
  type MaterializeKanbanWorkItemsCommand,
} from '../src/host/kanbanService.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const codeOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (err: { code?: unknown }) => err.code);

describe('ADR 1155 D1 — card facets (service)', () => {
  let store: Storage;
  let tenantId: string;

  beforeAll(async () => {
    store = await openStorage('memory://');
    initHostExtPersistence(store);
    ensureNotificationEmitterInstalled(store);
    tenantId = (await createWorkspace({ name: 'Facets', ownerSubject: 'user:owner' })).tenantId;
    await createMember({ tenantId, orgId: tenantId, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await store.close();
  });

  it('a valid map is stored; a bad key, value or count is refused', async () => {
    const board = await createBoard({ tenantId, name: 'Build' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Tile', facets: { stage: 'rough-in', room: 'r-12' } });
    expect((await getCard(card.id))?.facets).toEqual({ stage: 'rough-in', room: 'r-12' });

    const bad = (facets: Record<string, string>) => codeOf(createCard({ boardId: board.id, columnId: 'todo', title: 'x', facets }));
    expect(await bad({ Stage: 'a' })).toBe('kanban_card_invalid');
    expect(await bad({ ['k'.repeat(33)]: 'a' })).toBe('kanban_card_invalid');
    expect(await bad({ room: '' })).toBe('kanban_card_invalid');
    expect(await bad({ room: 'x'.repeat(65) })).toBe('kanban_card_invalid');
    expect(await bad({ room: 'a\nb' })).toBe('kanban_card_invalid');
    expect(await bad(Object.fromEntries(Array.from({ length: FACETS_MAX + 1 }, (_, i) => [`k${i}`, 'v'])))).toBe('kanban_card_invalid');
    expect(await codeOf(createCard({ boardId: board.id, columnId: 'todo', title: 'x', facets: ['a'] as unknown as Record<string, string> }))).toBe('kanban_card_invalid');
  });

  it('a patch merges; a key set to null clears that key; null clears the map; the merged count is capped', async () => {
    const board = await createBoard({ tenantId, name: 'Patch' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Lights', facets: { stage: 'rough-in', room: 'r-1' } });

    expect((await updateCardFields(card.id, { facets: { system: 'electrical', room: null } }))?.facets)
      .toEqual({ stage: 'rough-in', system: 'electrical' });
    const cleared = await updateCardFields(card.id, { facets: null });
    expect(cleared?.facets).toBeUndefined();
    expect('facets' in (await getCard(card.id))!).toBe(false);

    await updateCardFields(card.id, { facets: Object.fromEntries(Array.from({ length: FACETS_MAX }, (_, i) => [`k${i}`, 'v'])) });
    expect(await codeOf(updateCardFields(card.id, { facets: { extra: 'v' } }))).toBe('kanban_card_invalid');
    expect(Object.keys((await getCard(card.id))?.facets ?? {})).toHaveLength(FACETS_MAX);
    expect(await codeOf(updateCardFields(card.id, { facets: { k0: 'a b' } }))).toBe('kanban_card_invalid');
  });

  it('a work item carries facets to its card, and a refresh replaces the map', async () => {
    const board = await createBoard({ tenantId, name: 'Work' });
    const command = (over: Partial<MaterializeKanbanWorkItemsCommand>): MaterializeKanbanWorkItemsCommand => ({
      type: 'work-items.materialize',
      tenantId,
      boardId: board.id,
      scope: { kind: 'adopter.tasks', externalRef: 'project-1' },
      source: { kind: 'adopter.record', id: 'rec-1' },
      idempotencyKey: 'first',
      items: [{ key: 'tile', title: 'Pick tile', columnId: 'todo', facets: { stage: 'finish', room: 'r-2' } }],
      ...over,
    });
    const first = await applyBoardCommand(command({}));
    const cardId = first.cards[0]!.id;
    expect((await getCard(cardId))?.facets).toEqual({ stage: 'finish', room: 'r-2' });

    const again = await applyBoardCommand(command({
      idempotencyKey: 'second', refresh: true,
      items: [{ key: 'tile', title: 'Pick tile', columnId: 'todo', facets: { stage: 'finish', system: 'tile' } }],
    }));
    expect(again.refreshedCardIds).toEqual([cardId]);
    expect((await getCard(cardId))?.facets).toEqual({ stage: 'finish', system: 'tile' });

    expect(await codeOf(applyBoardCommand(command({
      idempotencyKey: 'third',
      items: [{ key: 'grout', title: 'Grout', columnId: 'todo', facets: { Room: 'x' } }],
    })))).toBe('kanban_work_items_invalid');
  });

  it('refreshCardFacts keeps an adopter plain card\'s facets in step', async () => {
    const board = await createBoard({ tenantId, name: 'Plain' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Hood', facets: { room: 'r-3' } });
    const r = await refreshCardFacts(board, card, { title: 'Hood', facets: { room: 'r-4' } });
    expect(r.refreshed).toBe(true);
    expect((await getCard(card.id))?.facets).toEqual({ room: 'r-4' });
    expect((await refreshCardFacts(board, (await getCard(card.id))!, { title: 'Hood', facets: { room: 'r-4' } })).refreshed).toBe(false);
  });

  it('the DSAR eraser clears the facets of the subject\'s cards', async () => {
    const board = await createBoard({ tenantId, name: 'Erase' });
    const mine = await createCard({ boardId: board.id, columnId: 'todo', title: 'Mine', assigneeId: 'user:alice', facets: { room: 'alice-study' } });
    const other = await createCard({ boardId: board.id, columnId: 'todo', title: 'Other', facets: { room: 'r-5' } });
    await eraseSubjectKanban(tenantId, 'user:alice');
    expect((await getCard(mine.id))?.facets).toBeUndefined();
    expect((await getCard(other.id))?.facets).toEqual({ room: 'r-5' });
  });
});

describe('ADR 1155 D1 — card facets (route)', () => {
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
  interface CardBody { id: string; facets?: Record<string, string> }

  it('create and PATCH take facets; a bad map is a 400', async () => {
    const login = await call('POST', '/host/openwop-app/test/login', { email: `facets-${Date.now()}@acme.test` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const board = (await call<{ id: string }>('POST', `${K}/boards`, { name: 'Bath' })).body;

    const bad = await call<{ error?: string }>('POST', `${K}/boards/${board.id}/cards`, { title: 'Vanity', columnId: 'todo', facets: { Room: 'x' } });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body.error).toBe('validation_error');

    const made = await call<CardBody>('POST', `${K}/boards/${board.id}/cards`, { title: 'Vanity', columnId: 'todo', facets: { room: 'bath-1', stage: 'finish' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.facets).toEqual({ room: 'bath-1', stage: 'finish' });

    const patched = await call<{ card: CardBody }>('PATCH', `${K}/cards/${made.body.id}`, { facets: { stage: null } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.card.facets).toEqual({ room: 'bath-1' });

    const badPatch = await call('PATCH', `${K}/cards/${made.body.id}`, { facets: 'room' });
    expect(badPatch.status, JSON.stringify(badPatch.body)).toBe(400);
  });
});
