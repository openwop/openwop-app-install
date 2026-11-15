/**
 * CHAN-F19 (ADR 0464 §9) — `team-ledger:suggester-queue` held a person's chat text until the
 * decision classifier read it, with no author on the row, so no eraser could find it and the
 * text still reached the model after a DSAR.
 *
 * What is pinned here (through the real channel post route, the model injected):
 *  - a queued row records the posting person as `authorUserId`;
 *  - a DSAR for that person deletes their queued rows, so the classifier never sees the text,
 *    and leaves another person's queued row alone;
 *  - the queue is on the kvAgeOut lane, so an author-less row (queued before CHAN-F19) ages
 *    out after QUEUE_TTL_DAYS, and a fresh one stays.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - `authorUserId` dropped from the enqueue                     → "records the posting person"
 *  - the delete in eraseSuggesterQueueSubject removed            → "never reaches the classifier"
 *  - registerSuggesterQueueErasure() not called in feature.ts    → "never reaches the classifier"
 *  - the registerKvAgeOut line removed                           → "ages out"
 *  - the `authorUserId?: string` field removed from Pending → the census reds in
 *    subject-erasure-feature-stores (the store has no signal again)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({ calls: [] as Array<Array<{ role: string; content: string }>> }));
vi.mock('../src/host/headlessAi.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveHeadlessAi: async () => async (messages: Array<{ role: string; content: string }>) => { ai.calls.push(messages); return '{"isDecision": false}'; },
}));

import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { DurableCollection, __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { __listKvAgeOutForTest, __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { processSuggesterQueue, QUEUE_TTL_DAYS } from '../src/features/team-intent-ledger/decisionSuggester.js';

interface Row { key: string; tenantId: string; projectId: string; conversationId: string; messageRef: string; text: string; createdAt: string; authorUserId?: string }
const PREFIX = 'hostext:team-ledger:suggester-queue:';
const rows = () => new DurableCollection<Row>('team-ledger:suggester-queue', (p) => p.key, undefined, (p) => p.tenantId);

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const payload = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: (payload ?? {}) as { orgId?: string; id?: string; channel?: { conversationId: string } } };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
const CH = '/host/openwop-app/channels';
const LONG = 'Agreed — we will launch in the EU first and the US next quarter.';

/** A tenant with a project ledger and a public channel bound to it; returns a poster. */
async function setup() {
  const tenantId = `org:f19q-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `f19q-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'QueueCo' })).body.orgId!;
  const projectId = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body.id!;
  expect((await owner.post(`/host/openwop-app/team-ledger/projects/${projectId}`)).status).toBe(201);
  const channelId = (await owner.post(CH, { name: `f19q-${n++}`, visibility: 'public' })).body.channel!.conversationId;
  expect((await owner.put(`${CH}/${channelId}/project`, { projectId })).status).toBe(200);
  const post = async (text: string) => expect((await owner.post(`${CH}/${channelId}/messages`, { content: text })).status).toBeLessThan(300);
  return { tenantId, projectId, channelId, post };
}

const queued = async (tenantId: string): Promise<Row[]> => (await rows().listForTenantIndexed(tenantId)).filter((r) => r.tenantId === tenantId);

describe('CHAN-F19 — the suggester queue is erasable and bounded', () => {
  it('a queued row records the posting person', async () => {
    const s = await setup();
    await s.post(LONG);
    const q = await queued(s.tenantId);
    expect(q).toHaveLength(1);
    expect(q[0]!.authorUserId, 'the queue row must name its author so a DSAR can find it').toMatch(/\S/);
    await processSuggesterQueue(async () => null); // drain
  });

  it('a DSAR deletes the person’s queued text, so it never reaches the classifier; another author’s row stays', async () => {
    const s = await setup();
    await s.post(LONG);
    const [mine] = await queued(s.tenantId);
    const author = mine!.authorUserId!;
    await rows().put({ ...mine!, key: `${s.tenantId}:other-ref`, messageRef: 'other-ref', authorUserId: 'someone-else', text: 'We decided to keep the Friday release.' });

    await eraseSubject(s.tenantId, author);

    const left = await queued(s.tenantId);
    expect(left.map((r) => r.authorUserId)).toEqual(['someone-else']);
    ai.calls.length = 0;
    await processSuggesterQueue();
    const seen = ai.calls.flat().map((m) => m.content).join('\n');
    expect(seen).not.toContain('launch in the EU first');
    expect(seen).toContain('keep the Friday release');
  });

  it('is on the age-out lane: an author-less row past the TTL ages out, a fresh one stays', async () => {
    expect(__listKvAgeOutForTest().find((r) => r.id === 'team-ledger:suggester-queue'))
      .toMatchObject({ prefix: PREFIX, ttlDays: QUEUE_TTL_DAYS, timestampField: 'createdAt' });
    const t = `org:f19q-ttl-${n++}`;
    const now = new Date();
    const old = new Date(now.getTime() - (QUEUE_TTL_DAYS + 1) * 86_400_000).toISOString();
    const base = { tenantId: t, projectId: 'p', conversationId: 'c', text: 'An old queued message from before CHAN-F19.' };
    await rows().put({ ...base, key: `${t}:legacy`, messageRef: 'legacy', createdAt: old }); // no authorUserId
    await rows().put({ ...base, key: `${t}:fresh`, messageRef: 'fresh', createdAt: now.toISOString() });
    await __runKvAgeOutOnce(__hostExtStorage()!, now);
    expect((await queued(t)).map((r) => r.messageRef)).toEqual(['fresh']);
    await processSuggesterQueue(async () => null); // drain
  });
});
