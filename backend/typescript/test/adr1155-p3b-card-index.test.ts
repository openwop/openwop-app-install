/**
 * ADR 1155 P3b — kanban cards keep an ADR 1110 P5 store index on every write.
 *
 * Nothing reads the index yet (P3c), so this pins the write half: after any sequence of
 * card writes, the markers the hooks maintained are exactly the markers a full rebuild
 * derives from the stored rows, and the drift check agrees. A legacy card with no
 * tenant gets markers when the hourly stamp gives it one.
 *
 * Red if: a card write bypasses the hooks (the store and the index disagree); the order
 * key stops sorting like the number; or a card write outside the wrapper appears.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createWorkspace } from '../src/host/accessControlService.js';
import {
  KANBAN_CARD_TYPE, createBoard, createCard, deleteCard, moveCard, sortableOrder, stampCardTenants, updateCardFields, __resetKanbanStore,
} from '../src/host/kanbanService.js';
import { checkSystemIndex, rebuildSystemIndex } from '../src/features/entities/systemIndex.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

let storage: Storage;
let tenantId: string;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetKanbanStore();
  tenantId = (await createWorkspace({ name: 'Index', ownerSubject: 'user:owner' })).tenantId;
});

/** The tenant's kanban marker keys, without the family-agnostic bookkeeping rows. */
async function markerKeys(): Promise<string[]> {
  const prefix = `hostext:entity:sysidx:${tenantId}:${encodeURIComponent(KANBAN_CARD_TYPE)}:`;
  return (await storage.kvList(prefix)).map((r) => r.key.slice(prefix.length)).sort();
}

describe('ADR 1155 P3b — the kanban card store index', () => {
  it('sortableOrder sorts like the number, negatives and fractions included', () => {
    const values = [-1e9, -3.5, -1, -0.25, 0, 0.5, 1, 1.5, 2, 3, 10, 1e12];
    const byKey = [...values].reverse().map((v) => ({ v, k: sortableOrder(v) })).sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
    expect(byKey.map((e) => e.v)).toEqual(values);
  });

  it('every card write keeps the index equal to a full rebuild', async () => {
    const board = await createBoard({ tenantId, name: 'House' });
    const a = await createCard({ boardId: board.id, columnId: 'todo', title: 'Tile', assigneeId: 'user:owner', dueAt: '2026-12-01T00:00:00.000Z' });
    const b = await createCard({ boardId: board.id, columnId: 'todo', title: 'Grout', assigneeRole: 'designer' });
    const c = await createCard({ boardId: board.id, columnId: 'todo', title: 'Hood' });
    const afterCreate = await markerKeys();
    expect(afterCreate.some((k) => k.startsWith('assignee:')), 'an assigned card has an assignee marker').toBe(true);
    expect(afterCreate.some((k) => k.startsWith('role:')), 'a role card has a role marker').toBe(true);

    await moveCard(a.id, 'doing');
    await updateCardFields(b.id, { dueAt: '2026-12-09T00:00:00.000Z' });
    await updateCardFields(a.id, { dueAt: null });
    await deleteCard(c.id);

    const incremental = await markerKeys();
    expect(incremental).not.toEqual(afterCreate);
    await rebuildSystemIndex(tenantId, KANBAN_CARD_TYPE);
    expect(await markerKeys(), 'the hooks left the index different from what the rows derive').toEqual(incremental);
    expect(await checkSystemIndex(tenantId, KANBAN_CARD_TYPE)).toBe(true);
  });

  it('a legacy card with no tenant is indexed once the stamp gives it one', async () => {
    const board = await createBoard({ tenantId, name: 'Legacy' });
    const now = new Date().toISOString();
    await storage.kvSet('hostext:kanban:card:legacy-1', JSON.stringify({
      id: 'legacy-1', boardId: board.id, columnId: 'todo', title: 'Old', source: 'human', version: 1, order: 1, createdAt: now, updatedAt: now,
    }));
    expect(await markerKeys()).toEqual([]);
    expect((await stampCardTenants()).stamped).toBe(1);
    expect((await markerKeys()).filter((k) => k.startsWith('board:'))).toHaveLength(1);
  });

  it('every card write goes through the indexed store', () => {
    const service = readFileSync(path.join(SRC, 'host/kanbanService.ts'), 'utf8');
    const start = service.indexOf('const cards = {');
    const end = service.indexOf('\n};\n', start);
    expect(start, 'the indexed card store is gone').toBeGreaterThan(0);
    const RAW_WRITE = /\bcardRows\.(put|putIfAbsent|compareAndSwap|compareAndDelete|delete)\(/g;
    const outside = [...service.matchAll(RAW_WRITE)].filter((m) => m.index < start || m.index > end).map((m) => m[0]);
    expect(outside, 'a card write bypasses the index hooks').toEqual([]);
    expect([...service.slice(start, end).matchAll(RAW_WRITE)]).toHaveLength(4);

    const elsewhere: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith('.ts') || full.endsWith(path.join('host', 'kanbanService.ts'))) continue;
        if (/DurableCollection<[^>]*>\(\s*'kanban:card'/.test(readFileSync(full, 'utf8'))) elsewhere.push(path.relative(SRC, full));
      }
    };
    walk(SRC);
    expect(elsewhere, 'a second module opens the kanban:card store').toEqual([]);
  });
});
