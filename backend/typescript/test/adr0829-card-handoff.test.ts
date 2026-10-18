/**
 * ADR 0829 P4 — a person hands a kanban card to someone else with a note.
 *
 * Real HTTP against a real app for the route (the note is written with the
 * assignment, by the caller, and nowhere else), and the service for DSAR:
 *
 *   - ON: the note is normalized (`producedBy: 'human'`), stored with its author
 *     and time; a note without an intent is a 400, never a silent drop;
 *   - every reassignment REPLACES the note (absent ⇒ cleared); unassign clears it;
 *   - DSAR: the note is erased when the subject wrote it — even on a card they
 *     neither created nor are assigned (the assigner's own free text) — or is
 *     named in its decisions; untouched otherwise.
 *
 * Sabotages that turn it red: the route normalizing as 'agent'; dropping the
 * intent-less 400; `{handoff:null}` → `{}` on reassign; removing either
 * `noteTouches` leg in `eraseSubjectKanban`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { normalizeHandoffRecord } from '../src/host/handoff/handoffRecord.js';
import * as kanban from '../src/host/kanbanService.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';

const NOTE = {
  intent: 'Finish the launch brief for Friday',
  decisions: [{ summary: 'EU first', decidedBy: 'user:owner' }],
  openQuestions: ['Is the date fixed?'],
  tried: [{ approach: 'Reusing the Q2 brief', droppedBecause: 'wrong audience' }],
};

describe('ADR 0829 P4 — POST /kanban/cards/:cardId/assign carries a handoff note', () => {
  let server: http.Server;
  let BASE = '';
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  }
  type Card = { id: string; handoff?: Record<string, unknown>; handoffBy?: string; handoffAt?: string };
  async function newCard(): Promise<string> {
    const b = await api<{ id: string }>('/host/openwop-app/kanban/boards', { method: 'POST', body: JSON.stringify({ name: 'Handoffs' }) });
    const c = await api<{ id: string }>(`/host/openwop-app/kanban/boards/${b.body.id}/cards`, { method: 'POST', body: JSON.stringify({ columnId: 'todo', title: 'Launch brief' }) });
    expect(c.status).toBe(201);
    return c.body.id;
  }
  const assign = (id: string, body: Record<string, unknown>) =>
    api<{ card: Card; error?: string }>(`/host/openwop-app/kanban/cards/${id}/assign`, { method: 'POST', body: JSON.stringify(body) });

  it('ON: stores the normalized note with its author and time', async () => {
    const id = await newCard();
    const r = await assign(id, { assigneeRole: 'editor', handoff: { ...NOTE, producedBy: 'agent' } });
    expect(r.status).toBe(200);
    expect(r.body.card.handoff).toMatchObject({ v: 1, intent: NOTE.intent, openQuestions: NOTE.openQuestions, producedBy: 'human' });
    expect(r.body.card.handoffBy).toBeTruthy();
    expect(r.body.card.handoffBy).not.toBe('unknown'); // the caller, not the fallback
    expect(Number.isNaN(Date.parse(r.body.card.handoffAt ?? ''))).toBe(false);
  });

  it('ON: a note without an intent is a 400, and nothing changes', async () => {
    const id = await newCard();
    expect((await assign(id, { assigneeRole: 'editor', handoff: NOTE })).status).toBe(200);
    const r = await assign(id, { assigneeRole: 'reviewer', handoff: { openQuestions: ['x'] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    // Nothing changed: the prior note and role survive the refused request (a route
    // that cleared the note before validating would fail here).
    const after = await kanban.getCard(id);
    expect(after?.handoff?.intent).toBe(NOTE.intent);
    expect(after?.assigneeRole).toBe('editor');
  });

  it('ON: reassignment without a note clears the old one; unassign clears it', async () => {
    const id = await newCard();
    expect((await assign(id, { assigneeRole: 'editor', handoff: NOTE })).body.card.handoff).toBeDefined();
    const again = await assign(id, { assigneeRole: 'reviewer' });
    expect(again.body.card.handoff).toBeUndefined();
    expect(again.body.card.handoffBy).toBeUndefined();
    expect((await assign(id, { assigneeRole: 'editor', handoff: NOTE })).body.card.handoff).toBeDefined();
    const cleared = await assign(id, { assigneeId: null });
    expect(cleared.body.card.handoff).toBeUndefined();
  });
});

describe('ADR 0829 P4 — DSAR erases the handoff note', () => {
  const T = 'tenant-dsar';
  const ERASED_KEY = 'user:alice';
  beforeEach(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0829-')) });
    initHostExtPersistence(await openStorage('memory://'));
    await kanban.__resetKanbanStore();
  });
  const note = (decidedBy?: string) => normalizeHandoffRecord({ intent: 'i', decisions: [{ summary: 'd', ...(decidedBy ? { decidedBy } : {}) }] }, 'human')!;

  it('the assigner wrote it on a card that is not otherwise theirs ⇒ the note goes, the card stays', async () => {
    const board = await kanban.createBoard({ tenantId: T, name: 'B' });
    const c = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 'Bob task', assigneeId: 'bob', createdBy: 'bob' });
    await kanban.updateCardFields(c.id, { handoff: note(), handoffBy: 'alice', handoffAt: '2026-10-05T00:00:00Z' });
    await kanban.eraseSubjectKanban(T, ERASED_KEY);
    const after = await kanban.getCard(c.id);
    expect(after?.handoff).toBeUndefined();
    expect(after?.handoffBy).toBeUndefined();
    expect(after?.title).toBe('Bob task'); // not her card: nothing else is touched
  });

  it('named in a decision ⇒ the note goes', async () => {
    const board = await kanban.createBoard({ tenantId: T, name: 'B' });
    const c = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 't', assigneeId: 'bob', createdBy: 'bob' });
    await kanban.updateCardFields(c.id, { handoff: note('alice'), handoffBy: 'carol' });
    await kanban.eraseSubjectKanban(T, ERASED_KEY);
    expect((await kanban.getCard(c.id))?.handoff).toBeUndefined();
  });

  it('her own card ⇒ erased with the rest of its free text', async () => {
    const board = await kanban.createBoard({ tenantId: T, name: 'B' });
    const c = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 't', assigneeId: 'alice' });
    await kanban.updateCardFields(c.id, { handoff: note(), handoffBy: 'bob' });
    await kanban.eraseSubjectKanban(T, ERASED_KEY);
    expect((await kanban.getCard(c.id))?.handoff).toBeUndefined();
  });

  it('nobody erased is involved ⇒ the note stays', async () => {
    const board = await kanban.createBoard({ tenantId: T, name: 'B' });
    const c = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 't', assigneeId: 'bob' });
    await kanban.updateCardFields(c.id, { handoff: note('dave'), handoffBy: 'carol' });
    await kanban.eraseSubjectKanban(T, ERASED_KEY);
    expect((await kanban.getCard(c.id))?.handoff).toBeDefined();
  });
});
