/**
 * ADR 0855 D3 — the re-sync checkpoint.
 *   - once someone who has looked is 5 accepted changes behind, the project chat
 *     (and bound channels) get ONE "what changed" summary listing the newest
 *     changes and asking to confirm; a 6th change the same day posts nothing more;
 *   - 10 waiting proposals also trigger it; fewer behind / waiting ⇒ nothing.
 *   - "behind" counts from the LOWEST version anyone marked seen (not v1), and the
 *     summary lists the 5 newest changes, newest first.
 *
 * Sabotage-witnessed (/grade-tests w29): both thresholds, the once-a-day key,
 * the lowest-seen base, the newest-first sort and the `onLedgerChanged` wiring
 * each red a case. Cases 1–2 freeze `Date` at 12:00Z of the current (possibly
 * clock-shifted) day: the once-a-day key is the real UTC date, and writes
 * straddling 00:00Z would otherwise post a second summary. Not covered here: the
 * fan-out to bound channels (`postProjectNotice`'s own claim).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

/** The fields these legs read off a response. */
interface ResBody { user?: { userId: string }; orgId?: string; id?: string; seenVersion?: number }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: ResBody }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const parsed = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as ResBody | undefined);
    return { status: res.status, body: parsed ?? {} };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}
const notices = async (sessionId: string) => (await storage.listChatSessionMessages(sessionId)).filter((m) => m.role === 'system').map((m) => m.content);

async function setup() {
  const tenantId = `org:rs-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `rs-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'SyncCo' })).body.orgId!;
  const proj = { id: (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body.id! };
  expect((await owner.post(`/host/openwop-app/projects/${proj.id}/chat`)).status).toBeLessThan(300);
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  const mate = client();
  const mateId = (await mate.post('/host/openwop-app/test/login', { email: `rsm-${n++}@acme.test`, tenantId })).body.user!.userId;
  await createMember({ tenantId, orgId, subject: mateId, displayName: 'Mate', roles: ['editor'] });
  return { owner, mate, L, chat: subjectConversationId(tenantId, { kind: 'project', id: proj.id }) };
}
/** Freeze `Date` at 12:00Z of the current (possibly clock-shifted) day: the once-a-day key is the real UTC date. */
async function atNoon(fn: () => Promise<void>): Promise<void> {
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  vi.useFakeTimers({ toFake: ['Date'], now: noon });
  try { await fn(); } finally { vi.useRealTimers(); }
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
    await atNoon(async () => {
      const s = await setup();
      await writeN(s, 1, 2); // v3
      expect(await s.mate.post(`${s.L}/seen`, { version: 3 })).toMatchObject({ status: 200, body: { seenVersion: 3 } });
      await writeN(s, 3, 4); // v7: the mate (the only one who looked) is 4 behind
      expect(await notices(s.chat)).toHaveLength(0);
      // Someone else last looked at v1: the base drops to the LOWEST seen version.
      expect(await s.owner.post(`${s.L}/seen`, { version: 1 })).toMatchObject({ status: 200, body: { seenVersion: 1 } });
      // The next change (a teammate's proposal) finds the team 6 behind v1.
      expect((await s.mate.post(`${s.L}/deltas`, { patch: { openQuestions: ['q'] }, why: 'p', baseVersion: 7 })).status).toBeLessThan(300);
      const [summary, ...rest] = await notices(s.chat);
      expect(rest).toHaveLength(0);
      // The 5 newest of the 6, newest first.
      expect(summary!.split('\n')).toEqual([
        'The team ledger for “Launch” is at version 7: 6 accepted changes since some of you last looked, and 1 waiting for the owner.',
        '• v7: change 6', '• v6: change 5', '• v5: change 4', '• v4: change 3', '• v3: change 2',
        'Please open the Ledger tab and confirm the current intent (Mark as seen).',
      ]);
      await writeN(s, 7, 1);
      expect(await notices(s.chat)).toHaveLength(1);
    });
  });

  // BLOCKED-ON-PRODUCT (grade-code TL-RESYNC-1): the owner's own `/write` is
  // proposeDelta + acceptDelta, and the re-sync check runs on BOTH announcements.
  // When the threshold is crossed at the propose step, the summary reports the
  // pre-accept version and counts the owner's in-flight write as "1 waiting for
  // the owner" — a proposal that never waits. Correct: the summary reflects the
  // accepted write (version 8, 7 behind, nothing waiting).
  it.fails('an owner\'s direct write is never reported as waiting (TL-RESYNC-1)', async () => {
    await atNoon(async () => {
      const s = await setup();
      await writeN(s, 1, 2);
      await s.mate.post(`${s.L}/seen`, { version: 3 });
      await writeN(s, 3, 4);
      await s.owner.post(`${s.L}/seen`, { version: 1 });
      await writeN(s, 7, 1); // v8
      const [summary] = await notices(s.chat);
      expect(summary!.split('\n')[0]).toBe('The team ledger for “Launch” is at version 8: 7 accepted changes since some of you last looked.');
    });
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
