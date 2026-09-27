/**
 * Kanban host-extension (RFCS/0086 "named workflow agents" demo surface).
 *
 * Covers:
 *   1. The pure service (host/kanbanService.ts): board/card CRUD + the
 *      move-trigger logic — a move INTO a column that names a workflow
 *      returns a trigger directive; a same-column move does not; a
 *      card-level `workflowId` overrides the column default.
 *   2. The REST routes (`/v1/host/openwop-app/kanban/*`) against the sqlite
 *      memory backend: create board → add card → move card into the
 *      trigger column → a run is started (`triggeredRunId` returned) —
 *      plus tenant-scoped 404 on a foreign board.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetKanbanStore,
  applyBoardCommand,
  createBoard,
  createCard,
  deleteBoard,
  getCard,
  getWorkItem,
  listCards,
  listPendingWorkItemOutbox,
  listWorkItemProjectionsForBoard,
  listWorkItemsForBoard,
  moveCard,
  notifyBoardChanged,
  completeKanbanOperation,
  purgeTenantKanban,
  reserveKanbanOperation,
  sweepExpiredKanbanOperationReceipts,
  subscribeBoardChanges,
  updateCardFields,
} from '../src/host/kanbanService.js';
import { clearRetentionHold, setRetentionHold } from '../src/host/retentionHold.js';

describe('kanban service (pure)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => {
    initHostExtPersistence(storage);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetKanbanStore();
  });

  it('creates a board with default To Do / Doing / Done lanes', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'Marketing' });
    expect(board.columns.map((c) => c.id)).toEqual(['todo', 'doing', 'done']);
    expect(board.tenantId).toBe('t1');
  });

  it('flags the To Do column as the trigger column when a board trigger workflow is given', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'Marketing', triggerWorkflowId: 'wf-campaign' });
    const todo = board.columns.find((c) => c.id === 'todo');
    expect(todo?.triggerWorkflowId).toBe('wf-campaign');
    expect(board.columns.find((c) => c.id === 'doing')?.triggerWorkflowId).toBeUndefined();
  });

  it('round-trips createdBy / assignmentReason / blockerNote on create + patch', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'M' });
    const card = await createCard({
      boardId: board.id,
      columnId: 'todo',
      title: 'Approve refund',
      createdBy: 'Marcus',
      assignmentReason: 'Over Priya’s auto-approval limit.',
      blockerNote: 'Needs a human sign-off.',
    });
    expect(card.createdBy).toBe('Marcus');
    expect(card.assignmentReason).toBe('Over Priya’s auto-approval limit.');
    expect(card.blockerNote).toBe('Needs a human sign-off.');

    await updateCardFields(card.id, { blockerNote: '' });
    const cleared = await getCard(card.id);
    expect(cleared?.blockerNote).toBe('');
    expect(cleared?.assignmentReason).toBe('Over Priya’s auto-approval limit.');
  });

  it('returns a trigger directive when a card moves INTO a trigger column', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'M', triggerWorkflowId: 'wf-campaign' });
    const card = await createCard({ boardId: board.id, columnId: 'doing', title: 'Draft email' });
    const result = await moveCard(card.id, 'todo');
    expect(result?.trigger).toEqual({
      workflowId: 'wf-campaign',
      boardId: board.id,
      cardId: card.id,
      fromColumnId: 'doing',
      toColumnId: 'todo',
    });
    expect(result?.card.columnId).toBe('todo');
  });

  it('does NOT trigger on a same-column move', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'M', triggerWorkflowId: 'wf-campaign' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'x' });
    const result = await moveCard(card.id, 'todo');
    expect(result?.trigger).toBeNull();
  });

  it('lets a card-level workflowId override the column default', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'M', triggerWorkflowId: 'wf-column' });
    const card = await createCard({ boardId: board.id, columnId: 'doing', title: 'x', workflowId: 'wf-card' });
    expect((await moveCard(card.id, 'todo'))?.trigger?.workflowId).toBe('wf-card');
  });

  it('does not trigger when neither the column nor the card names a workflow', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'M' });
    const card = await createCard({ boardId: board.id, columnId: 'doing', title: 'x' });
    expect((await moveCard(card.id, 'todo'))?.trigger).toBeNull();
  });

  it('materializes reusable scoped work idempotently into card projections, then tracks completion', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'Reusable work' });
    const command = {
      type: 'work-items.materialize' as const,
      tenantId: 't1',
      boardId: board.id,
      scope: { kind: 'canvas.product-spec', externalRef: 'spec-42' },
      source: { kind: 'plan.reviewed', id: 'plan-42', revision: '3' },
      idempotencyKey: 'reviewed-plan-42-v3',
      items: [
        { key: 'research', title: 'Research the user need', columnId: 'todo', input: { privateEvidence: 'do-not-project' } },
        { key: 'build', title: 'Build the experience', columnId: 'todo', dependsOnKeys: ['research'] },
      ],
    };

    const first = await applyBoardCommand(command);
    expect(first.dryRun).toBe(false);
    expect(first.workItems).toHaveLength(2);
    expect(first.cards).toHaveLength(2);
    expect(first.cards.every((card) => card.workItemId !== undefined)).toBe(true);
    expect(first.workItems.map((item) => item.state)).toEqual(['ready', 'proposed']);
    expect(first.cards[1]?.dependsOn).toEqual([first.cards[0]?.id]);

    // A repeated delivery after any partial write converges on the same two
    // aggregates/cards/events rather than creating a second app-specific board.
    const repeated = await applyBoardCommand({ ...command, idempotencyKey: 'retry-after-timeout' });
    expect(repeated.workItems.map((item) => item.workItemId)).toEqual(first.workItems.map((item) => item.workItemId));
    expect((await listWorkItemsForBoard('t1', board.id)).map((item) => item.workItemId)).toEqual(first.workItems.map((item) => item.workItemId));
    const operationalView = await listWorkItemProjectionsForBoard('t1', board.id);
    expect(operationalView.map((item) => item.workItemId)).toEqual(first.workItems.map((item) => item.workItemId));
    expect(operationalView[0]).not.toHaveProperty('input');
    expect(operationalView[0]).not.toHaveProperty('sourceKey');
    expect(operationalView[0]?.scope).toEqual({ kind: 'canvas.product-spec' });
    expect(operationalView[0]?.source).toEqual({ kind: 'plan.reviewed' });
    expect(operationalView[0]).toMatchObject({ dependencyCount: 0 });
    expect(operationalView[0]?.execution).not.toHaveProperty('claimToken');
    expect((await listCards(board.id)).filter((card) => card.workItemId)).toHaveLength(2);
    expect(await listPendingWorkItemOutbox('t1')).toHaveLength(2);

    // A producer must advance its source revision before changing the reviewed
    // dependency graph. Silently accepting that collision would leave an
    // inherited canvas with a stale graph under the same source identity.
    await expect(applyBoardCommand({
      ...command,
      items: [
        { key: 'research', title: 'Research the user need', columnId: 'todo' },
        { key: 'build', title: 'Build the experience', columnId: 'todo' },
      ],
    })).rejects.toMatchObject({ code: 'kanban_work_item_collision' });

    await moveCard(first.cards[0]!.id, 'done');
    expect((await getWorkItem(first.workItems[0]!.workItemId))?.state).toBe('completed');
    expect((await getWorkItem(first.workItems[1]!.workItemId))?.state).toBe('ready');
    expect(await listPendingWorkItemOutbox('t1')).toHaveLength(4);

    await deleteBoard(board.id);
    expect(await getWorkItem(first.workItems[0]!.workItemId)).toBeNull();
    expect(await listPendingWorkItemOutbox('t1')).toHaveLength(0);
  });

  it('uses one generic command to reorder cards inside a lane and across lanes', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'Ordered work' });
    const one = await createCard({ boardId: board.id, columnId: 'todo', title: 'One' });
    const two = await createCard({ boardId: board.id, columnId: 'todo', title: 'Two' });
    const three = await createCard({ boardId: board.id, columnId: 'todo', title: 'Three' });

    const reordered = await applyBoardCommand({
      type: 'card.patch', tenantId: 't1', boardId: board.id, cardId: three.id,
      beforeCardId: one.id, patch: {},
    });
    expect(reordered.trigger).toBeNull();
    expect((await listCards(board.id)).filter((card) => card.columnId === 'todo').map((card) => card.id))
      .toEqual([three.id, one.id, two.id]);

    await applyBoardCommand({
      type: 'card.patch', tenantId: 't1', boardId: board.id, cardId: one.id,
      columnId: 'doing', afterCardId: undefined, patch: {},
    });
    expect((await listCards(board.id)).find((card) => card.id === one.id)?.columnId).toBe('doing');
    await expect(applyBoardCommand({
      type: 'card.patch', tenantId: 't1', boardId: board.id, cardId: two.id,
      beforeCardId: one.id, afterCardId: three.id, patch: {},
    })).rejects.toMatchObject({ code: 'kanban_position_invalid' });
  });

  it('removes durable operation receipts during tenant teardown', async () => {
    const reservation = await reserveKanbanOperation('purge-tenant', 'task.assign', 'receipt-key', 'first-payload');
    expect(reservation.kind).toBe('claimed');
    if (reservation.kind !== 'claimed') throw new Error('expected operation reservation');
    expect(await completeKanbanOperation(reservation.receiptId, reservation.claimToken, { assignedAt: 'now' })).toBe(true);

    const purged = await purgeTenantKanban('purge-tenant');
    expect(purged.operationReceipts).toBe(1);
    // Same key is now a fresh operation, not a retention-conflict tombstone.
    await expect(reserveKanbanOperation('purge-tenant', 'task.assign', 'receipt-key', 'new-payload'))
      .resolves.toMatchObject({ kind: 'claimed' });
  });

  it('retains expired operation receipts for held tenants while compacting free tenants', async () => {
    const completedAt = 0;
    const held = await reserveKanbanOperation('held-tenant', 'task.assign', 'held-key', 'payload', completedAt);
    const free = await reserveKanbanOperation('free-tenant', 'task.assign', 'free-key', 'payload', completedAt);
    if (held.kind !== 'claimed' || free.kind !== 'claimed') throw new Error('expected operation reservations');
    await completeKanbanOperation(held.receiptId, held.claimToken, { assignedAt: 'then' }, completedAt);
    await completeKanbanOperation(free.receiptId, free.claimToken, { assignedAt: 'then' }, completedAt);

    await setRetentionHold('held-tenant', 'litigation: retain Kanban receipts');
    try {
      expect(await sweepExpiredKanbanOperationReceipts(15 * 24 * 60 * 60 * 1_000)).toBe(1);
      await expect(reserveKanbanOperation('held-tenant', 'task.assign', 'held-key', 'payload'))
        .resolves.toMatchObject({ kind: 'completed' });
      await expect(reserveKanbanOperation('free-tenant', 'task.assign', 'free-key', 'payload'))
        .resolves.toMatchObject({ kind: 'claimed' });
    } finally {
      await clearRetentionHold('held-tenant');
    }
  });

  it('validates a reusable work plan before a dry run or write', async () => {
    const board = await createBoard({ tenantId: 't1', name: 'Validation' });
    const result = await applyBoardCommand({
      type: 'work-items.materialize',
      tenantId: 't1',
      boardId: board.id,
      scope: { kind: 'feature.generic' },
      source: { kind: 'plan.reviewed', id: 'plan-dry-run' },
      idempotencyKey: 'dry-run',
      dryRun: true,
      items: [{ key: 'one', title: 'Preview only', columnId: 'todo' }],
    });
    expect(result.dryRun).toBe(true);
    expect(await getWorkItem(result.workItems[0]!.workItemId)).toBeNull();
    expect(await listCards(board.id)).toHaveLength(0);

    // A pre-existing projection collision is rejected before the aggregate is
    // written, so a bad extension cannot strand an orphaned core work item.
    await createCard({
      boardId: board.id,
      columnId: 'todo',
      title: 'An unrelated legacy card',
      cardId: result.cards[0]!.id,
    });
    await expect(applyBoardCommand({
      type: 'work-items.materialize',
      tenantId: 't1',
      boardId: board.id,
      scope: { kind: 'feature.generic' },
      source: { kind: 'plan.reviewed', id: 'plan-dry-run' },
      idempotencyKey: 'collision',
      items: [{ key: 'one', title: 'Would collide', columnId: 'todo' }],
    })).rejects.toMatchObject({ code: 'kanban_card_collision' });
    expect(await getWorkItem(result.workItems[0]!.workItemId)).toBeNull();

    await expect(applyBoardCommand({
      type: 'work-items.materialize',
      tenantId: 'other-tenant',
      boardId: board.id,
      scope: { kind: 'feature.generic' },
      source: { kind: 'plan.reviewed', id: 'plan-wrong-tenant' },
      idempotencyKey: 'wrong-tenant',
      items: [{ key: 'one', title: 'Forbidden', columnId: 'todo' }],
    })).rejects.toMatchObject({ code: 'kanban_board_not_found' });
  });

  it('fans out board-change notifications to subscribers (live refresh)', async () => {
    const seen: string[] = [];
    // On the sqlite (single-node) backend the publish delivers in-process and
    // synchronously, so the assertions need no extra flush; the Postgres
    // LISTEN/NOTIFY cross-instance path is exercised live.
    const unsubscribe = await subscribeBoardChanges((id) => seen.push(id));
    notifyBoardChanged('board-1');
    notifyBoardChanged('board-2');
    expect(seen).toEqual(['board-1', 'board-2']);
    await unsubscribe();
    notifyBoardChanged('board-3');
    expect(seen).toEqual(['board-1', 'board-2']); // no longer notified after unsubscribe
  });
});

describe('kanban routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';

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
    await __resetKanbanStore();
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jsonFetch<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 204) return { status: 204, body: undefined as unknown as T };
    return { status: res.status, body: (await res.json()) as T };
  }

  it('advertises host.kanban in the discovery document', async () => {
    const { body } = await jsonFetch<{ kanban?: { supported?: boolean } }>('/.well-known/openwop');
    expect(body.kanban?.supported).toBe(true);
  });

  it('round-trips board + card CRUD and starts a run on a trigger-column move', async () => {
    // Pick a workflow the catalog actually serves (the loaded conformance
    // fixtures double as runnable workflowIds).
    const disco = await jsonFetch<{ fixtures?: string[] }>('/.well-known/openwop');
    const triggerWorkflowId = disco.body.fixtures?.[0];
    expect(typeof triggerWorkflowId).toBe('string');

    // Create a board whose To Do column fires that workflow.
    const created = await jsonFetch<{ id: string; columns: { id: string }[] }>(
      '/v1/host/openwop-app/kanban/boards',
      { method: 'POST', body: JSON.stringify({ name: 'Sally — Marketing', triggerWorkflowId }) },
    );
    expect(created.status).toBe(201);
    const boardId = created.body.id;

    // It shows up in the list.
    const list = await jsonFetch<{ boards: { id: string }[] }>('/v1/host/openwop-app/kanban/boards');
    expect(list.body.boards.some((b) => b.id === boardId)).toBe(true);

    // Add a card to Doing.
    const card = await jsonFetch<{ id: string; columnId: string }>(
      `/v1/host/openwop-app/kanban/boards/${boardId}/cards`,
      { method: 'POST', body: JSON.stringify({ title: 'Spring campaign', columnId: 'doing' }) },
    );
    expect(card.status).toBe(201);
    expect(card.body.columnId).toBe('doing');

    // Move it INTO To Do → starts a run.
    const moved = await jsonFetch<{ card: { columnId: string }; triggeredRunId: string | null }>(
      `/v1/host/openwop-app/kanban/cards/${card.body.id}`,
      { method: 'PATCH', body: JSON.stringify({ columnId: 'todo' }) },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.card.columnId).toBe('todo');
    expect(typeof moved.body.triggeredRunId).toBe('string');
    expect((moved.body.triggeredRunId ?? '').length).toBeGreaterThan(0);

    // Delete the card, then the board.
    expect((await jsonFetch(`/v1/host/openwop-app/kanban/cards/${card.body.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await jsonFetch(`/v1/host/openwop-app/kanban/boards/${boardId}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('projects redacted reusable WorkItems and manually dispatches through the normal workflow run path', async () => {
    const disco = await jsonFetch<{ fixtures?: string[] }>('/.well-known/openwop');
    const workflowId = disco.body.fixtures?.[0];
    expect(typeof workflowId).toBe('string');
    const created = await jsonFetch<{ id: string; tenantId: string }>('/v1/host/openwop-app/kanban/boards', {
      method: 'POST', body: JSON.stringify({ name: 'Canvas-neutral work' }),
    });
    expect(created.status).toBe(201);
    const plan = await applyBoardCommand({
      type: 'work-items.materialize',
      tenantId: created.body.tenantId,
      boardId: created.body.id,
      scope: { kind: 'canvas.any', externalRef: 'doc-1' },
      source: { kind: 'reviewed.plan', id: 'plan-1', revision: '1' },
      idempotencyKey: 'canvas-any-plan-1',
      items: [{
        key: 'deliver', title: 'Deliver a reusable work item', columnId: 'todo', workflowId,
        input: { privateToken: 'never-return-this' }, execution: { mode: 'manual', maxAttempts: 1 },
      }],
    });
    const workItemId = plan.workItems[0]!.workItemId;

    const detail = await jsonFetch<{
      workItems: Array<{
        workItemId: string;
        execution: { mode: string; claimToken?: string };
        input?: unknown;
        sourceKey?: unknown;
        scope?: { externalRef?: unknown };
        source?: { id?: unknown; revision?: unknown };
      }>;
    }>(`/v1/host/openwop-app/kanban/boards/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.workItems).toContainEqual(expect.objectContaining({
      workItemId,
      execution: expect.objectContaining({ mode: 'manual' }),
    }));
    const projected = detail.body.workItems.find((item) => item.workItemId === workItemId)!;
    expect(projected).not.toHaveProperty('input');
    expect(projected).not.toHaveProperty('sourceKey');
    expect(projected.scope).not.toHaveProperty('externalRef');
    expect(projected.source).not.toHaveProperty('id');
    expect(projected.source).not.toHaveProperty('revision');
    expect(projected.execution).not.toHaveProperty('claimToken');

    const started = await jsonFetch<{ runId: string; workItem: { execution: { status: string; runId?: string } } }>(
      `/v1/host/openwop-app/kanban/boards/${created.body.id}/work-items/${workItemId}/run`,
      { method: 'POST' },
    );
    expect(started.status).toBe(202);
    expect(started.body.runId).toMatch(/^kanban-work-run-/);
    expect(started.body.workItem.execution).toMatchObject({ status: 'running', runId: started.body.runId });
    expect(await getWorkItem(workItemId)).toMatchObject({ input: { privateToken: 'never-return-this' } });

    // A direct aggregate id cannot escape its board boundary, even to another
    // board owned by the same caller.
    const otherBoard = await jsonFetch<{ id: string }>('/v1/host/openwop-app/kanban/boards', {
      method: 'POST', body: JSON.stringify({ name: 'Other board' }),
    });
    expect((await jsonFetch(
      `/v1/host/openwop-app/kanban/boards/${otherBoard.body.id}/work-items/${workItemId}/run`,
      { method: 'POST' },
    )).status).toBe(404);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('rejects an invalid combined card edit without persisting its otherwise-valid fields', async () => {
    const created = await jsonFetch<{ id: string }>('/v1/host/openwop-app/kanban/boards', {
      method: 'POST', body: JSON.stringify({ name: 'Atomic card command' }),
    });
    const card = await jsonFetch<{ id: string; title: string }>(
      `/v1/host/openwop-app/kanban/boards/${created.body.id}/cards`,
      { method: 'POST', body: JSON.stringify({ title: 'Original title', columnId: 'todo' }) },
    );
    const invalid = await jsonFetch(
      `/v1/host/openwop-app/kanban/cards/${card.body.id}`,
      { method: 'PATCH', body: JSON.stringify({ title: 'Do not persist', columnId: 'missing-column' }) },
    );
    expect(invalid.status).toBe(400);
    expect((await getCard(card.body.id))?.title).toBe('Original title');
  });

  it('validates required fields', async () => {
    const bad = await jsonFetch('/v1/host/openwop-app/kanban/boards', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  it('404s an unknown board', async () => {
    const res = await jsonFetch('/v1/host/openwop-app/kanban/boards/board-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('the board SSE events endpoint 404s an unknown board (before opening a stream)', async () => {
    const res = await jsonFetch('/v1/host/openwop-app/kanban/boards/board-nope/events');
    expect(res.status).toBe(404);
  });

  it('opens a text/event-stream for an owned board and pushes board.changed on a card create', async () => {
    const created = await jsonFetch<{ id: string }>('/v1/host/openwop-app/kanban/boards', {
      method: 'POST',
      body: JSON.stringify({ name: 'SSE board' }),
    });
    const boardId = created.body.id;
    const ac = new AbortController();
    const res = await fetch(`${BASE}/v1/host/openwop-app/kanban/boards/${boardId}/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Trigger a change, then read until we see the board.changed event.
    await jsonFetch(`/v1/host/openwop-app/kanban/boards/${boardId}/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'live', columnId: 'todo' }),
    });
    let buf = '';
    const deadline = Date.now() + 3000;
    while (!buf.includes('board.changed') && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    ac.abort();
    expect(buf).toContain('board.changed');
  });
});
