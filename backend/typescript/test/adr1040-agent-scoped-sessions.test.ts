/**
 * ADR 1040 D2 — "this agent's conversations" and the agent stamp that makes a
 * persisted embed findable under its agent.
 *
 *  - `GET /chat/sessions?agentId=` only NARROWS what the caller already sees:
 *    another member's conversation with the same agent never appears;
 *  - it matches one agent under both ADR 0763 spellings; a roster id means
 *    that ONE persona, a registry id means the agent and all its personas;
 *  - a meta created FIRST (an embed's focus bind) keeps the creator's `agent:`
 *    stamp when the session row is created later, also when the two race;
 *  - creating a row on top of a meta someone else owns is a 409, never a 201.
 *
 * Red when: the filter runs before (or instead of) the visibility filter, or
 * compares raw ids (routes/chatSessions.ts, host/conversationAgentFilter.ts);
 * `unionAgentParticipants` is not called or `setConversationFocus` goes back to
 * a plain put (host/conversationStore.ts); or the create route drops its prior-
 * owner check.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { ensureConversationMeta, getConversationMeta, setConversationFocus } from '../src/host/conversationStore.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { createRosterEntry } from '../src/host/rosterService.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body { user?: { userId: string }; sessions?: Array<{ sessionId: string }>; error?: string }
interface Res { status: number; body: Body }
interface Client { userId: string; get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
async function loginTo(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user?.userId ?? '', get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

const SESSIONS = '/host/openwop-app/chat/sessions';
const sid = (tag: string): string => `a1040-${tag}-${Date.now()}-${n++}`;
const ids = (r: Res): string[] => (r.body.sessions ?? []).map((s) => s.sessionId).sort();
const create = (c: Client, sessionId: string, participants?: string[]) =>
  c.post(SESSIONS, { sessionId, title: 'Guide', ...(participants ? { participants } : {}) });

describe('GET /chat/sessions?agentId= narrows, never widens', () => {
  it("lists only the caller's conversations that name the agent — never another member's", async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    const b = await loginTo(tenantId, 'b');
    const mine = sid('mine');
    const other = sid('other-agent');
    const plain = sid('plain');
    const theirs = sid('theirs');
    expect((await create(a, mine, ['agent:host:guide'])).status).toBe(201);
    expect((await create(a, other, ['agent:host:someone-else'])).status).toBe(201);
    expect((await create(a, plain)).status).toBe(201);
    expect((await create(b, theirs, ['agent:host:guide'])).status).toBe(201);

    expect(ids(await a.get(`${SESSIONS}?agentId=host%3Aguide`))).toEqual([mine]);
    expect(ids(await b.get(`${SESSIONS}?agentId=host%3Aguide`))).toEqual([theirs]);
    // Without the filter the list is unchanged (A sees its three, never B's).
    const all = ids(await a.get(SESSIONS));
    expect(all).toEqual(expect.arrayContaining([mine, other, plain]));
    expect(all).not.toContain(theirs);
  });

  it('matches one agent under both ADR 0763 spellings', async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    const legacy = sid('legacy');
    const canonical = sid('canonical');
    expect((await create(a, legacy, ['agent:feature.crm.agents.sales-ops'])).status).toBe(201);
    expect((await create(a, canonical, ['agent:vendor.openwop-app.crm.agents.sales-ops'])).status).toBe(201);
    const both = [legacy, canonical].sort();
    expect(ids(await a.get(`${SESSIONS}?agentId=${encodeURIComponent('vendor.openwop-app.crm.agents.sales-ops')}`))).toEqual(both);
    expect(ids(await a.get(`${SESSIONS}?agentId=${encodeURIComponent('feature.crm.agents.sales-ops')}`))).toEqual(both);
  });

  it('a roster id lists that persona only; the registry id lists the agent and every persona of it', async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    const registry = 'vendor.openwop-app.kicktodo.agents.kickbot';
    const coach = await createRosterEntry({ tenantId, persona: 'Coach', agentRef: { agentId: registry } });
    const buddy = await createRosterEntry({ tenantId, persona: 'Buddy', agentRef: { agentId: 'feature.kicktodo.agents.kickbot' } });
    const byCoach = sid('coach');
    const byBuddy = sid('buddy');
    const byRegistry = sid('registry');
    expect((await create(a, byCoach, [`agent:${coach.rosterId}`])).status).toBe(201);
    expect((await create(a, byBuddy, [`agent:${buddy.rosterId}`])).status).toBe(201);
    expect((await create(a, byRegistry, [`agent:${registry}`])).status).toBe(201);
    expect(ids(await a.get(`${SESSIONS}?agentId=${encodeURIComponent(coach.rosterId)}`))).toEqual([byCoach]);
    expect(ids(await a.get(`${SESSIONS}?agentId=${encodeURIComponent(buddy.rosterId)}`))).toEqual([byBuddy]);
    // Buddy's agentRef is the LEGACY spelling of the same agent: still one agent.
    expect(ids(await a.get(`${SESSIONS}?agentId=${encodeURIComponent(registry)}`))).toEqual([byCoach, byBuddy, byRegistry].sort());
  });

  it('an unknown agent lists nothing; a malformed agentId is a 400', async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    expect((await create(a, sid('x'), ['agent:host:guide'])).status).toBe(201);
    const none = await a.get(`${SESSIONS}?agentId=host%3Anobody`);
    expect(none.status).toBe(200);
    expect(ids(none)).toEqual([]);
    expect((await a.get(`${SESSIONS}?agentId=${'x'.repeat(201)}`)).status).toBe(400);
    expect((await a.get(`${SESSIONS}?agentId=`)).status).toBe(400);
  });
});

describe('the agent stamp survives a meta that already exists', () => {
  const FOCUS = { kind: 'canvas', id: 'canvas-any' } as const;

  it('a focus bind first, then the first send creates the row: still listed under the agent', async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    const id = sid('focus-first');
    await setConversationFocus(tenantId, id, FOCUS, a.userId);
    expect((await create(a, id, ['agent:host:guide'])).status).toBe(201);
    expect(ids(await a.get(`${SESSIONS}?agentId=host%3Aguide`))).toEqual([id]);
    expect((await getConversationMeta(tenantId, id))?.focus).toEqual(FOCUS);
  });

  it('a focus bind racing the create keeps BOTH the stamp and the focus', async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    for (let i = 0; i < 8; i++) {
      const id = sid(`race-${i}`);
      const [, created] = await Promise.all([setConversationFocus(tenantId, id, FOCUS, a.userId), create(a, id, ['agent:host:guide'])]);
      expect(created.status).toBe(201);
      const meta = await getConversationMeta(tenantId, id);
      expect(meta?.participants.map((p) => p.subjectRef)).toContain('agent:host:guide');
      expect(meta?.focus).toEqual(FOCUS);
    }
  });

  it('a create landing between the focus write\'s read and its write keeps the stamp (the write is a CAS)', async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    const id = sid('interleave');
    const key = `${tenantId}:${id}`;
    const realGet = DurableCollection.prototype.get;
    let injected = false;
    // Deterministic interleave: the focus writer reads "no meta", then the
    // first send's create lands, then the focus writer writes.
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, k: string) {
      const v = await realGet.call(this, k);
      if (!injected && k === key && v === null) {
        injected = true;
        await ensureConversationMeta(tenantId, id, { type: 'agent', ownerUserId: a.userId, participants: ['agent:host:guide'] });
      }
      return v;
    });
    try {
      await setConversationFocus(tenantId, id, FOCUS, a.userId);
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    const meta = await getConversationMeta(tenantId, id);
    expect(meta?.participants.map((p) => p.subjectRef)).toContain('agent:host:guide');
    expect(meta?.focus).toEqual(FOCUS);
  });

  it("creating a row on a meta someone else owns is a 409, and adds nothing to it", async () => {
    const tenantId = `org:a1040-${Date.now()}-${n++}`;
    const a = await loginTo(tenantId, 'a');
    const b = await loginTo(tenantId, 'b');
    const id = sid('foreign');
    await setConversationFocus(tenantId, id, FOCUS, a.userId);
    // With and without a stamp: the refusal is the owner check, not the union.
    expect((await create(b, id)).status).toBe(409);
    const r = await create(b, id, ['agent:host:guide']);
    expect(r.status).toBe(409);
    const meta = await getConversationMeta(tenantId, id);
    expect(meta?.ownerUserId).toBe(a.userId);
    expect(meta?.participants.map((p) => p.subjectRef)).not.toContain('agent:host:guide');
    expect(ids(await b.get(SESSIONS))).not.toContain(id);
  });
});
