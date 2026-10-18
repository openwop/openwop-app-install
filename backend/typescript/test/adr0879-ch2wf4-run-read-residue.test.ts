/**
 * ADR 0879 — `CH2WF-4` RESIDUE PIN (filed, NOT fixed; same class as `DSHCD-9`).
 *
 * A private channel's agent turn carries the POST in its run (`configurable.task`,
 * seeded into the run's variables), and run reads are tenant-scoped
 * (`host/runAccess.ts` `loadByScopeAndTenant`): any member of the workspace — a
 * Viewer, a person who is not in the channel — LISTS the run. MEASURED below: on a
 * terminal run the post text is not in the snapshot / event poll / debug bundle.
 * NOT measured (no live provider in the test env): a successful turn's node output
 * (the agent's reply) and a running turn's live `variables` (which hold `task`). The
 * catch-up run carries the private transcript the same way.
 *
 * NARROWED by #4543 (DSHCD-9): a member who neither started a run nor administers
 * the workspace now reads it WITHOUT its payload: no inputs / variables / channels
 * on the snapshot or the list, event payloads cut to step and status on the poll and
 * every stream, and the debug bundle refused (403). So the turn's live `variables`
 * and its node output no longer reach this Viewer by any run read. What stays
 * pinned is the LISTING itself (existence, timing, status, the workflow id).
 *
 * This test PINS the exposure as it stands, so the record cannot go stale: when a
 * run-read visibility decision for conversation-bound runs lands, this test goes red
 * and must be flipped (assert the outsider sees nothing) in the same PR. Exact repro
 * (what the cases below do over HTTP):
 *   1. Owner creates PRIVATE channel #x with an agent member; posts "@agent <secret>".
 *   2. A workspace Viewer who is NOT in #x calls
 *      `GET /runs?workflowId=openwop-app.channel.turn` → the run is listed;
 *   3. `GET /v1/runs/<runId>` → the snapshot carries the secret.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', 'OpenWOP-Version': '2', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    for (const sc of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function signup(c: ReturnType<typeof client>): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: `ch2wf4-${Date.now()}-${n++}@acme.test` });
  expect(r.status).toBe(201);
  return r.body.user.userId as string;
}

describe('CH2WF-4 residue — a private channel post is readable through the run lane', () => {
  it('a Viewer outside the private channel lists the turn run (PINNED — flip when fixed); a terminal run does not carry the post', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/host/openwop-app/workspaces', { name: `Leak ${n++}` })).body.workspaceId as string;
    expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const viewer = client();
    const vId = await signup(viewer);
    expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'v', subject: vId, roles: ['viewer'] })).status).toBe(201);
    expect((await viewer.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);

    const ch = await owner.post('/host/openwop-app/channels', { name: `secret-${n++}`, visibility: 'private', agentIds: ['ch2wf4.agent'] });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    const id = ch.body.channel.conversationId as string;
    const SECRET = `acquisition-target-${n}-zebra`;
    expect((await owner.post(`/host/openwop-app/channels/${id}/messages`, { content: `@helper ${SECRET}` })).status).toBe(201);
    // The viewer cannot read the channel…
    expect((await viewer.get(`/host/openwop-app/channels/${id}/messages`)).status).toBeGreaterThanOrEqual(400);

    // …but the run lane lists the private channel's turn to them (PINNED exposure:
    // existence, timing, status, the channel-turn workflow id). Poll briefly for the
    // fire-and-forget dispatch.
    let runs: Array<{ runId: string }> = [];
    for (let i = 0; i < 40 && runs.length === 0; i++) {
      runs = ((await viewer.get('/runs?workflowId=openwop-app.channel.turn')).body?.runs ?? []) as Array<{ runId: string }>;
      if (runs.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    // PINNED EXPOSURE (CH2WF-4) — flip to `toBe(0)` when the run-read decision lands.
    expect(runs.length).toBeGreaterThan(0);

    // MEASURED, and pinned as a floor: on a TERMINAL turn (this one fails — no
    // provider in the test env) the post text is NOT in the snapshot, the event
    // poll or the debug bundle. Not measured here: a SUCCESSFUL turn's node output
    // (the agent's reply text) and a RUNNING turn's live `variables` (which hold
    // `task`) — the parts of CH2WF-4 that still need the platform decision.
    const rid = encodeURIComponent(runs[0]!.runId);
    for (const p of [`/runs/${rid}`, `/runs/${rid}/events/poll`]) {
      const r = await viewer.get(p);
      expect(r.status, p).toBe(200);
      expect(JSON.stringify(r.body), p).not.toContain(SECRET);
    }
    // #4543 — the full event log is the run owner's and the admins': refused.
    expect((await viewer.get(`/runs/${rid}/debug-bundle`)).status).toBe(403);
  });
});
