/**
 * ADR 1155 P3c-2 — "Assigned to me" reads the card index, not every card and board.
 *
 * Before: `listCardsAssignedToUser` scanned every board in the table and read every
 * card in the tenant, then joined. Now it reads the caller's slice of the `assignee`
 * family and the tenant's `role` family, point-reads those cards and only their boards,
 * and judges each stored row as before.
 *
 * Red if: a card addressed to the caller is missing, or one that is not addressed to
 * them (reassigned, another tenant's, another role) appears; or the read goes back to
 * costing one read per card in the tenant.
 */
import { appendFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import {
  __resetKanbanStore, createBoard, createCard, listCardsAssignedToUser, moveCard, updateCardFields,
} from '../src/host/kanbanService.js';

let storage: Storage;
let tenantId: string;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetKanbanStore();
  tenantId = (await createWorkspace({ name: 'Mine', ownerSubject: 'user:owner' })).tenantId;
  for (const [subject, displayName] of [['user:alice', 'Alice'], ['user:bob', 'Bob']] as const) {
    await createMember({ tenantId, orgId: tenantId, subject, displayName, roles: ['editor'] });
  }
});

describe('ADR 1155 P3c-2 — the assigned view on the index', () => {
  it('returns exactly the caller\'s direct and role cards, with their lane facts', async () => {
    const house = await createBoard({ tenantId, name: 'House' });
    const garden = await createBoard({ tenantId, name: 'Garden' });
    const direct = await createCard({ boardId: house.id, columnId: 'todo', title: 'Tile', assigneeId: 'user:alice' });
    const role = await createCard({ boardId: garden.id, columnId: 'doing', title: 'Beds', assigneeRole: 'gardener' });
    const finished = await createCard({ boardId: house.id, columnId: 'todo', title: 'Grout', assigneeId: 'user:alice' });
    await moveCard(finished.id, 'done');
    const reassigned = await createCard({ boardId: house.id, columnId: 'todo', title: 'Hood', assigneeId: 'user:alice' });
    await updateCardFields(reassigned.id, { title: 'Hood' }); // a write that keeps its markers
    await createCard({ boardId: house.id, columnId: 'todo', title: 'Not hers', assigneeId: 'user:bob' });
    await createCard({ boardId: garden.id, columnId: 'todo', title: 'Other role', assigneeRole: 'electrician' });
    const other = (await createWorkspace({ name: 'Other', ownerSubject: 'user:other' })).tenantId;
    await createMember({ tenantId: other, orgId: other, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
    const theirs = await createBoard({ tenantId: other, name: 'Theirs' });
    await createCard({ boardId: theirs.id, columnId: 'todo', title: 'Another tenant', assigneeId: 'user:alice' });

    // Reassign behind the index's back: the marker still says alice, the row says bob.
    const row = JSON.parse((await storage.kvGet(`hostext:kanban:card:${reassigned.id}`))!) as Record<string, unknown>;
    await storage.kvSet(`hostext:kanban:card:${reassigned.id}`, JSON.stringify({ ...row, assigneeId: 'user:bob' }));

    const got = await listCardsAssignedToUser(tenantId, 'user:alice', ['gardener']);
    expect(got.map((c) => c.title).sort()).toEqual(['Beds', 'Grout', 'Tile']);
    const byId = new Map(got.map((c) => [c.id, c]));
    expect(byId.get(direct.id)).toMatchObject({ boardName: 'House', columnName: 'To Do', terminal: false, doneColumnId: 'done' });
    expect(byId.get(role.id)).toMatchObject({ boardName: 'Garden', columnName: 'Doing' });
    expect(byId.get(finished.id)).toMatchObject({ terminal: true });
  });

  it('reads the caller\'s cards, not every card in the tenant', async () => {
    const board = await createBoard({ tenantId, name: 'Big' });
    for (let i = 0; i < 80; i += 1) {
      await createCard({ boardId: board.id, columnId: 'todo', title: `Card ${i}`, ...(i % 20 === 0 ? { assigneeId: 'user:alice' } : {}) });
    }
    await listCardsAssignedToUser(tenantId, 'user:alice'); // builds the index
    // Rows read, not calls: one list call can return the whole table, which is what
    // the old path did. Every row a get or a list returns counts.
    let rowsRead = 0;
    const get = storage.kvGet.bind(storage);
    const list = storage.kvList.bind(storage);
    vi.spyOn(storage, 'kvGet').mockImplementation(async (k) => { rowsRead += 1; return get(k); });
    vi.spyOn(storage, 'kvList').mockImplementation(async (prefix) => { const r = await list(prefix); rowsRead += r.length; return r; });
    if (storage.kvListPage) {
      const page = storage.kvListPage.bind(storage);
      vi.spyOn(storage, 'kvListPage').mockImplementation(async (prefix, opts) => { const r = await page(prefix, opts); rowsRead += r.length; return r; });
    }
    const got = await listCardsAssignedToUser(tenantId, 'user:alice');
    vi.restoreAllMocks();
    expect(got).toHaveLength(4);
    // For the PR's before/after numbers: vitest swallows console output here.
    if (process.env.P3C2_OUT) appendFileSync(process.env.P3C2_OUT, `rowsRead ${rowsRead}\n`);
    // 4 markers + 4 cards + 1 board + the index's own bookkeeping; the old path read all
    // 80 cards and every board in the table.
    expect(rowsRead, `rows read: ${rowsRead}`).toBeLessThan(30);
  });
});
