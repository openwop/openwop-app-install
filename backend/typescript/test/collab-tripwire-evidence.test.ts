/**
 * ADR 0829 P5 / ADR 0831 P5 — the protocol tripwires are MEASURED.
 *
 *   - the bar (`host/usageEvidence.ts`): span ≥ 30 days, ≥ 8 active days, ONE
 *     record version; recording is idempotent per day; two qualifying subjects
 *     meet the tripwire, one does not;
 *   - a workflow run that writes a handoff record is counted under its workflow;
 *     a card note is not (a person's handoff, not a workflow's);
 *   - a run the ledger STAMPS is counted under its project;
 *   - both evidence routes are superadmin-only: a signed-in member gets 403.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { notifyHandoffRecorded } from '../src/host/handoff/handoffObservers.js';
import { normalizeHandoffRecord } from '../src/host/handoff/handoffRecord.js';
import { usageEvidenceStore, EVIDENCE_BAR } from '../src/host/usageEvidence.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const bearer = (path: string) => fetch(`${BASE}${path}`, { headers: { authorization: 'Bearer dev-token' } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => undefined) as any }));
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
const day = (d: number): Date => new Date(Date.UTC(2026, 0, 1) + d * 24 * 60 * 60 * 1000);
async function newRun(tenantId: string, workflowId: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `run-ev-${n++}`, workflowId, tenantId, status: 'pending', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now };
  await insertRunWithStartContext(storage, run);
  return run.runId;
}

describe('usage evidence — the bar', () => {
  it('qualifies on span + active days + one version; idempotent per day; two subjects meet the tripwire', async () => {
    const ev = usageEvidenceStore(`test:evidence:${n++}`);
    // Subject A: 9 active days across 40 days, one version ⇒ qualifies.
    for (const d of [0, 5, 10, 15, 20, 25, 30, 35, 40]) await ev.record('t1', 'a', day(d), 1);
    await ev.record('t1', 'a', day(40), 1); // same day again: no new active day
    // Subject B: long span but only 3 active days ⇒ does not.
    for (const d of [0, 20, 45]) await ev.record('t1', 'b', day(d), 1);
    let s = await ev.summarize('x');
    const a = s.subjects.find((x) => x.subject === 'a')!;
    expect(a).toMatchObject({ spanDays: 40, activeDays: 9, count: 10, qualifies: true });
    expect(s.subjects.find((x) => x.subject === 'b')!.qualifies).toBe(false);
    expect(s.qualifying).toBe(1);
    expect(s.tripwireMet).toBe(false);
    expect(EVIDENCE_BAR.minQualifying).toBe(2);

    // Subject C qualifies too ⇒ the tripwire is met.
    for (const d of [0, 4, 8, 12, 16, 20, 24, 28, 32]) await ev.record('t2', 'c', day(d), 1);
    s = await ev.summarize('x');
    expect(s.qualifying).toBe(2);
    expect(s.tripwireMet).toBe(true);

    // A shape change (a second version) disqualifies.
    await ev.record('t2', 'c', day(33), 2);
    s = await ev.summarize('x');
    expect(s.subjects.find((x) => x.subject === 'c')).toMatchObject({ versions: [1, 2], qualifies: false });
    expect(s.tripwireMet).toBe(false);
  });
});

describe('collab tripwire evidence — recorded where the work happens', () => {
  it('a workflow run writing a handoff record counts under its workflow; a card note does not', async () => {
    const tenantId = `org:ev-${n++}`;
    const wf = `wf.test.ev.${n++}`;
    const runId = await newRun(tenantId, wf);
    const record = normalizeHandoffRecord({ intent: 'Draft the page' }, 'agent')!;
    await notifyHandoffRecorded({ tenantId, record, origin: { kind: 'run', runId, ref: 'dispatch:e1:w' } });
    await notifyHandoffRecorded({ tenantId, record: normalizeHandoffRecord({ intent: 'x' }, 'human')!, origin: { kind: 'card', cardId: 'c', boardId: 'b', ref: 'card:c:1', by: 'u' } });
    const r = await bearer('/host/openwop-app/structured-handoffs/evidence');
    expect(r.status).toBe(200);
    const mine = (r.body.subjects as any[]).filter((s) => s.tenantId === tenantId);
    expect(mine.map((s) => s.subject)).toEqual([`workflow:${wf}`]);
    expect(mine[0]).toMatchObject({ count: 1, versions: [1], activeDays: 1 });
  });

  it('a run the ledger stamps counts under its project; an unbound run does not', async () => {
    const owner = client();
    const tenantId = `org:evl-${Date.now()}-${n++}`;
    expect((await owner.post('/host/openwop-app/test/login', { email: `ev-${n++}@acme.test`, tenantId })).status).toBe(201);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'EvCo' })).body.orgId as string;
    const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string; boardId: string };
    expect((await owner.post(`/host/openwop-app/team-ledger/projects/${proj.id}`)).status).toBe(201);
    await newRun(tenantId, 'wf.test.evl', { kanban: { boardId: proj.boardId, cardId: 'c1' } });
    await newRun(tenantId, 'wf.test.evl', {});
    const r = await bearer('/host/openwop-app/team-ledger/evidence');
    expect(r.status).toBe(200);
    const mine = (r.body.subjects as any[]).filter((s) => s.tenantId === tenantId);
    expect(mine.map((s) => s.subject)).toEqual([`project:${proj.id}`]);
    expect(mine[0].count).toBe(1);
  });

  it('both evidence routes are superadmin-only', async () => {
    const member = client();
    expect((await member.post('/host/openwop-app/test/login', { email: `evm-${n++}@acme.test` })).status).toBe(201);
    for (const p of ['/host/openwop-app/structured-handoffs/evidence', '/host/openwop-app/team-ledger/evidence']) {
      expect((await member.get(p)).status, p).toBe(403);
      expect((await bearer(p)).status, p).toBe(200);
    }
  });
});
