/**
 * ADR 0854 D2 — a card in the project's conversations when a handoff reaches a person.
 *   - assigning a project-board card WITH a note posts ONE system message in the
 *     project's chat and in each channel bound to the project — who, what, to
 *     whom, the intent — and never the note's decisions or "tried" text;
 *   - the same handoff announced again posts nothing more;
 *   - a board that is not a project's posts nothing; a project with no chat yet
 *     gets no chat created to hold a card;
 *   - a dispatch handoff on a REAL project-bound run posts nothing, while an
 *     escalation (`interrupt:` ref) on the same run posts its card — the positive
 *     control that makes the dispatch leg able to fail.
 *
 * Sabotages that turn it red (probed w28): the `putIfAbsent` dedupe dropped; the
 * decisions appended to the text; the channel binding not listed; the
 * `interrupt:` filter removed. Structural ceiling: a loose board has no project,
 * so there is no conversation its kind check alone keeps a card out of.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { subjectConversationId } from '../src/host/conversationStore.js';
import { notifyHandoffRecorded } from '../src/host/handoff/handoffObservers.js';
import { normalizeHandoffRecord, type HandoffRecordV1 } from '../src/host/handoff/handoffRecord.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return { post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b), put: <T = unknown>(p: string, b?: unknown) => call<T>('PUT', p, b) };
}
type AssignBody = { card: { handoff: HandoffRecordV1; handoffAt: string } };
const NOTE = { intent: 'Finish the EU launch brief', decisions: [{ summary: 'SECRET-DECISION-TEXT' }], tried: [{ approach: 'SECRET-TRIED-TEXT' }] };
const systemTexts = async (sessionId: string) => (await storage.listChatSessionMessages(sessionId)).filter((m) => m.role === 'system').map((m) => m.content);

async function setup(opts: { chat?: boolean } = {}) {
  const tenantId = `org:hc-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `hc-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'CardCo' })).body.orgId;
  const proj = (await owner.post<{ id: string; boardId: string }>('/host/openwop-app/projects', { orgId, name: 'Launch' })).body;
  if (opts.chat !== false) expect((await owner.post(`/host/openwop-app/projects/${proj.id}/chat`)).status).toBeLessThan(300);
  const ch = await owner.post<{ channel: { conversationId: string } }>('/host/openwop-app/channels', { name: `launch-${n++}`, visibility: 'public' });
  const channelId = ch.body.channel.conversationId;
  expect((await owner.put(`/host/openwop-app/channels/${channelId}/project`, { projectId: proj.id })).status).toBe(200);
  const card = await owner.post<{ id: string }>(`/host/openwop-app/kanban/boards/${proj.boardId}/cards`, { columnId: 'todo', title: 'EU brief' });
  return { tenantId, owner, projectId: proj.id, boardId: proj.boardId, channelId, cardId: card.body.id, projectChat: subjectConversationId(tenantId, { kind: 'project', id: proj.id }) };
}

describe('ADR 0854 D2 — handoff cards', () => {
  it("a note on a project card posts one card in the project chat and each bound channel; never the note's decisions or tried text", async () => {
    const s = await setup();
    const r = await s.owner.post<AssignBody>(`/host/openwop-app/kanban/cards/${s.cardId}/assign`, { assigneeRole: 'editor', handoff: NOTE });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const conv of [s.projectChat, s.channelId]) {
      const texts = await systemTexts(conv);
      expect(texts, conv).toHaveLength(1);
      expect(texts[0]).toContain('“EU brief” to the editor role: Finish the EU launch brief');
      expect(texts[0]).not.toMatch(/SECRET-/);
    }
    // Announced again (a retry): nothing more.
    await notifyHandoffRecorded({ tenantId: s.tenantId, record: r.body.card.handoff, origin: { kind: 'card', cardId: s.cardId, boardId: s.boardId, ref: `card:${s.cardId}:${r.body.card.handoffAt}`, by: 'x' } });
    expect(await systemTexts(s.channelId)).toHaveLength(1);
  });

  it('no project chat yet ⇒ none is created; the bound channel still gets its card', async () => {
    const s = await setup({ chat: false });
    expect((await s.owner.post(`/host/openwop-app/kanban/cards/${s.cardId}/assign`, { assigneeRole: 'editor', handoff: NOTE })).status).toBe(200);
    expect(await storage.getChatSession(s.tenantId, s.projectChat)).toBeNull();
    expect(await systemTexts(s.channelId)).toHaveLength(1);
  });

  it("a board that is not a project's, and an agent-to-agent dispatch, post nothing", async () => {
    const s = await setup();
    const loose = await s.owner.post<{ id: string }>('/host/openwop-app/kanban/boards', { name: 'Loose' });
    const card = await s.owner.post<{ id: string }>(`/host/openwop-app/kanban/boards/${loose.body.id}/cards`, { columnId: 'todo', title: 'Loose card' });
    expect((await s.owner.post(`/host/openwop-app/kanban/cards/${card.body.id}/assign`, { assigneeRole: 'editor', handoff: NOTE })).status).toBe(200);
    // A REAL run on the project's board, so only the dispatch-vs-escalation filter
    // stands between the record and the project's conversations.
    const now = new Date().toISOString();
    const runId = `run-hc-${n++}`;
    await insertRunWithStartContext(storage, {
      runId, workflowId: 'wf.test.hc', tenantId: s.tenantId, status: 'pending', inputs: {},
      metadata: { kanban: { boardId: s.boardId, cardId: s.cardId } }, configurable: {}, createdAt: now, updatedAt: now,
    });
    const record = normalizeHandoffRecord({ intent: 'worker task' }, 'agent')!;
    await notifyHandoffRecorded({ tenantId: s.tenantId, record, origin: { kind: 'run', runId, ref: 'dispatch:e1:w' } });
    expect(await systemTexts(s.projectChat)).toHaveLength(0);
    expect(await systemTexts(s.channelId)).toHaveLength(0);
    // Positive control: the same run's ESCALATION does reach the project's people.
    await notifyHandoffRecorded({ tenantId: s.tenantId, record, origin: { kind: 'run', runId, ref: 'interrupt:i-1' } });
    const texts = await systemTexts(s.channelId);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('A run needs a person to decide: worker task');
  });
});
