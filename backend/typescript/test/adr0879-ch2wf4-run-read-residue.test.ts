/**
 * ADR 0879 — `CH2WF-4` residue (same class as `DSHCD-9`). Tracker TST-BHC-1.
 *
 * A private channel's agent turn carries the POST in its run (`configurable.task`,
 * seeded into the run's variables), and run reads are tenant-scoped
 * (`host/runAccess.ts` `loadByScopeAndTenant`): any member of the workspace — a
 * Viewer, a person who is not in the channel — LISTS the run.
 *
 * NARROWED by #4543 (DSHCD-9): a member who neither started a run nor administers
 * the workspace now reads it WITHOUT its payload: no inputs / variables / channels
 * on the snapshot or the list, event payloads cut to step and status on the poll and
 * every stream, and the debug bundle refused (403). Red when (sabotage-witnessed,
 * wave 62): the debug bundle stops refusing a non-owner (runs.ts), or the payload
 * reader admits every member (runPayloadAccess.ts) — the snapshot/poll then carry
 * the post text.
 *
 * DEFECT PIN, labelled (wave 62 ruling): the LISTING itself (existence, timing,
 * status, the workflow id) still reaches a Viewer outside the channel. The case
 * below asserts that CURRENT behaviour on purpose, next to an owner positive
 * control, so the record cannot go stale. The correct behaviour (the outsider lists
 * nothing) is a product decision tracked as CH2WF-4 (BLOCKED-ON-PRODUCT); when it
 * lands this assertion goes red and must be flipped to `toEqual([])` in the same PR.
 * Exact repro (what the case does over HTTP):
 *   1. Owner creates PRIVATE channel #x with an agent member; posts "@agent <secret>".
 *   2. A workspace Viewer who is NOT in #x calls
 *      `GET /runs?workflowId=openwop-app.channel.turn` → the run is listed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  getAgentRegistry().register({ agentId: 'ch2wf4.agent', persona: 'Helper', modelClass: 'general', systemPrompt: 'help', packName: 'test', packVersion: '0', toolAllowlist: [] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
interface Res<T = Json> { status: number; body: T }
interface RunList { runs?: Array<{ runId: string }> }
function client() {
  let cookie = '';
  const call = async <T = Json>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', 'OpenWOP-Version': '2', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    for (const sc of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T }; // wire JSON: the caller names the shape it reads
  };
  return { get: <T = Json>(p: string) => call<T>('GET', p), post: <T = Json>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
async function signup(c: ReturnType<typeof client>): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `ch2wf4-${Date.now()}-${n++}@acme.test` });
  expect(r.status).toBe(201);
  return r.body.user.userId;
}

describe('CH2WF-4 residue — a private channel post is readable through the run lane', () => {
  it('a Viewer outside the private channel lists the turn run (labelled defect pin, CH2WF-4); a terminal run does not carry the post', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Leak ${n++}` })).body.workspaceId;
    expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const viewer = client();
    const vId = await signup(viewer);
    expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'v', subject: vId, roles: ['viewer'] })).status).toBe(201);
    expect((await viewer.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);

    const ch = await owner.post<{ channel: { conversationId: string } }>('/host/openwop-app/channels', { name: `secret-${n++}`, visibility: 'private', agentIds: ['ch2wf4.agent'] });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    const id = ch.body.channel.conversationId;
    const SECRET = `acquisition-target-${n}-zebra`;
    expect((await owner.post(`/host/openwop-app/channels/${id}/messages`, { content: `@helper ${SECRET}` })).status).toBe(201);
    // The viewer cannot read the channel…
    expect((await viewer.get(`/host/openwop-app/channels/${id}/messages`)).status).toBe(403);

    // Positive control: the OWNER lists the turn (the fire-and-forget dispatch ran).
    const ownerRuns = await vi.waitFor(async () => {
      const listed = (await owner.get<RunList>('/runs?workflowId=openwop-app.channel.turn')).body.runs ?? [];
      expect(listed.length).toBeGreaterThan(0);
      return listed;
    }, { timeout: 5_000, interval: 50 });
    // LABELLED DEFECT PIN (CH2WF-4, BLOCKED-ON-PRODUCT): the Viewer outside the channel
    // lists the same run. The correct outcome is `toEqual([])`; flip it when the
    // run-read visibility decision lands.
    const runs = (await viewer.get<RunList>('/runs?workflowId=openwop-app.channel.turn')).body.runs ?? [];
    expect(runs.map((r) => r.runId)).toEqual(ownerRuns.map((r) => r.runId));

    // #4543 floor: the turn's payload DOES carry the post (wave 62: admitting every
    // member as a payload reader turns this red), and the Viewer reads the run
    // without it on the snapshot and the event poll. Not measured here: a SUCCESSFUL
    // turn's node output (no provider in the test env).
    const rid = encodeURIComponent(ownerRuns[0]!.runId);
    for (const p of [`/runs/${rid}`, `/runs/${rid}/events/poll`]) {
      const r = await viewer.get(p);
      expect(r.status, p).toBe(200);
      expect(JSON.stringify(r.body), p).not.toContain(SECRET);
    }
    // #4543 — the full event log is the run owner's and the admins': refused.
    expect((await viewer.get(`/runs/${rid}/debug-bundle`)).status).toBe(403);
  });
});
