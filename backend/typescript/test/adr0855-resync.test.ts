/**
 * ADR 0855 D3 — the re-sync checkpoint.
 *   - once someone who has looked is 5 accepted changes behind, the project chat
 *     (and bound channels) get ONE "what changed" summary listing the newest
 *     changes and asking to confirm; a 6th change the same day posts nothing more;
 *   - 10 waiting proposals also trigger it; fewer behind / waiting ⇒ nothing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createMember } from '../src/host/accessControlService.js';
import { subjectConversationId } from '../src/host/conversationStore.js';

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
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}
const notices = async (sessionId: string) => (await storage.listChatSessionMessages(sessionId)).filter((m) => m.role === 'system').map((m) => m.content);

async function setup() {
  const tenantId = `org:rs-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `rs-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'SyncCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  expect((await owner.post(`/host/openwop-app/projects/${proj.id}/chat`)).status).toBeLessThan(300);
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  const mate = client();
  const mateId = (await mate.post('/host/openwop-app/test/login', { email: `rsm-${n++}@acme.test`, tenantId })).body.user.userId as string;
  await createMember({ tenantId, orgId, subject: mateId, displayName: 'Mate', roles: ['editor'] });
  return { owner, mate, L, chat: subjectConversationId(tenantId, { kind: 'project', id: proj.id }) };
}
async function writeN(s: Awaited<ReturnType<typeof setup>>, from: number, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const v = from + i;
    const r = await s.owner.post(`${s.L}/write`, { patch: { inScope: [`item ${v}`] }, why: `change ${v}`, baseVersion: v });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
}

describe('ADR 0855 D3 — re-sync checkpoint', () => {
  it('5 accepted changes behind ⇒ one summary listing the newest; a 6th the same day posts nothing', async () => {
    const s = await setup();
    await s.mate.post(`${s.L}/seen`, { version: 1 });
    await writeN(s, 1, 4); // v5: the mate is 4 behind
    expect(await notices(s.chat)).toHaveLength(0);
    await writeN(s, 5, 1); // v6: 5 behind
    const [summary, ...rest] = await notices(s.chat);
    expect(rest).toHaveLength(0);
    expect(summary).toContain('is at version 6: 5 accepted changes since some of you last looked');
    expect(summary).toContain('• v6: change 5');
    expect(summary).toContain('confirm the current intent');
    await writeN(s, 6, 1);
    expect(await notices(s.chat)).toHaveLength(1);
  });

  it('10 waiting proposals also trigger it', async () => {
    const s = await setup();
    for (let i = 0; i < 9; i++) await s.mate.post(`${s.L}/deltas`, { patch: { openQuestions: [`q${i}`] }, why: `p${i}`, baseVersion: 1 });
    expect(await notices(s.chat)).toHaveLength(0);
    await s.mate.post(`${s.L}/deltas`, { patch: { openQuestions: ['q9'] }, why: 'p9', baseVersion: 1 });
    const [summary] = await notices(s.chat);
    expect(summary).toContain('and 10 waiting for the owner');
  });
});
