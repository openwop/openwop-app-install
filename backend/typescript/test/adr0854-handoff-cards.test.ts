/**
 * ADR 0854 D2 — a card in the project's conversations when a handoff reaches a person.
 *   - assigning a project-board card WITH a note posts ONE system message in the
 *     project's chat and in each channel bound to the project — who, what, to
 *     whom, the intent — and never the note's decisions or "tried" text;
 *   - the same handoff announced again posts nothing more;
 *   - a board that is not a project's posts nothing; a project with no chat yet
 *     gets no chat created to hold a card.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { subjectConversationId } from '../src/host/conversationStore.js';
import { notifyHandoffRecorded } from '../src/host/handoff/handoffObservers.js';
import { normalizeHandoffRecord } from '../src/host/handoff/handoffRecord.js';

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
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
const NOTE = { intent: 'Finish the EU launch brief', decisions: [{ summary: 'SECRET-DECISION-TEXT' }], tried: [{ approach: 'SECRET-TRIED-TEXT' }] };
const systemTexts = async (sessionId: string) => (await storage.listChatSessionMessages(sessionId)).filter((m) => m.role === 'system').map((m) => m.content);

async function setup(opts: { chat?: boolean } = {}) {
  const tenantId = `org:hc-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `hc-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'CardCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string; boardId: string };
  if (opts.chat !== false) expect((await owner.post(`/host/openwop-app/projects/${proj.id}/chat`)).status).toBeLessThan(300);
  const ch = await owner.post('/host/openwop-app/channels', { name: `launch-${n++}`, visibility: 'public' });
  const channelId = ch.body.channel.conversationId as string;
  expect((await owner.put(`/host/openwop-app/channels/${channelId}/project`, { projectId: proj.id })).status).toBe(200);
  const card = await owner.post(`/host/openwop-app/kanban/boards/${proj.boardId}/cards`, { columnId: 'todo', title: 'EU brief' });
  return { tenantId, owner, projectId: proj.id, boardId: proj.boardId, channelId, cardId: card.body.id as string, projectChat: subjectConversationId(tenantId, { kind: 'project', id: proj.id }) };
}

describe('ADR 0854 D2 — handoff cards', () => {
  it("a note on a project card posts one card in the project chat and each bound channel; never the note's decisions or tried text", async () => {
    const s = await setup();
    const r = await s.owner.post(`/host/openwop-app/kanban/cards/${s.cardId}/assign`, { assigneeRole: 'editor', handoff: NOTE });
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
    await s.owner.post(`/host/openwop-app/kanban/cards/${s.cardId}/assign`, { assigneeRole: 'editor', handoff: NOTE });
    expect(await storage.getChatSession?.(s.tenantId, s.projectChat).catch(() => null) ?? null).toBeNull();
    expect(await systemTexts(s.channelId)).toHaveLength(1);
  });

  it("a board that is not a project's, and an agent-to-agent dispatch, post nothing", async () => {
    const s = await setup();
    const loose = await s.owner.post('/host/openwop-app/kanban/boards', { name: 'Loose' });
    const card = await s.owner.post(`/host/openwop-app/kanban/boards/${loose.body.id}/cards`, { columnId: 'todo', title: 'Loose card' });
    await s.owner.post(`/host/openwop-app/kanban/cards/${card.body.id}/assign`, { assigneeRole: 'editor', handoff: NOTE });
    const record = normalizeHandoffRecord({ intent: 'worker task' }, 'agent')!;
    await notifyHandoffRecorded({ tenantId: s.tenantId, record, origin: { kind: 'run', runId: 'run-x', ref: 'dispatch:e1:w' } });
    expect(await systemTexts(s.projectChat)).toHaveLength(0);
    expect(await systemTexts(s.channelId)).toHaveLength(0);
  });
});
