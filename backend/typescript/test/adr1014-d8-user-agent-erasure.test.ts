/**
 * ADR 1014 D8 — the text a person types into a user agent has an ADR 0464
 * erasure path.
 *
 * Each revision records who wrote it (`authoredBy`, the session user of the
 * create or edit). Erasing that person deletes their revisions, prompt and all,
 * except the ones the agent is serving (the head, or a revision a deployment row
 * names), which keep their text and lose only the attribution.
 *
 * Red when: a create or edit stops recording its author (the subject's old
 * revision survives); the eraser deletes a serving revision (the live agent
 * breaks); it reaches another subject's revisions; or a second run finds the
 * subject still named (the attribution was not redacted).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { enableToggle } from './planningHarness.js';
import { eraseSubjectUserAgentRevisions, getRevision, setUserAgentPinnedRevisions } from '../src/host/userAgentRevisions.js';
import { listDeployments, mintDraft } from '../src/features/agent-deployments/service.js';

let server: http.Server;
let BASE = '';
let seq = 0;
interface Res { status: number; body: any }

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await enableToggle('users', 'on');
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_AGENT_DEPLOYMENT;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 1014 D8 — erasing a person reaches the agent text they wrote', () => {
  it('deletes their unserved revisions, keeps the served ones, and touches nobody else', async () => {
    const tenantId = `org:d8-${Date.now()}-${seq++}`;
    const call = client();
    const login = await call('POST', '/host/openwop-app/test/login', { email: `d8-${Date.now()}-${seq++}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const userId = login.body.user.userId as string;
    expect((await call('POST', '/host/openwop-app/orgs', { name: 'D8' })).status).toBe(201);
    const agent = await call('POST', '/host/openwop-app/agents', { persona: 'Eraser', modelClass: 'chat', systemPrompt: 'v1 call Ana on 555-0100' });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    const agentId = agent.body.agentId as string;
    const dep = `/agents/${encodeURIComponent(agentId)}/deployments`;
    const edit = async (systemPrompt: string) => {
      const r = await call('PATCH', `/host/openwop-app/agents/${encodeURIComponent(agentId)}`, { systemPrompt });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.packVersion as string;
    };
    expect((await call('POST', dep, { version: '0', transition: 'pause' })).status).toBe(200); // a row names 0
    expect(await edit('v2 call Ana on 555-0100')).toBe('1');
    expect(await edit('v3')).toBe('2'); // the head

    expect(await eraseSubjectUserAgentRevisions(tenantId, 'user:someone-else')).toEqual({ rowsTouched: 0 });
    expect(await eraseSubjectUserAgentRevisions(`org:other-${seq}`, userId)).toEqual({ rowsTouched: 0 });
    expect(await getRevision(tenantId, agentId, '1'), 'untouched by another subject').not.toBeNull();

    expect(await eraseSubjectUserAgentRevisions(tenantId, userId)).toEqual({ rowsTouched: 3 });
    expect(await getRevision(tenantId, agentId, '1'), 'unserved: deleted with its text').toBeNull();
    expect((await getRevision(tenantId, agentId, '0'))?.systemPrompt, 'pinned by a deployment row: kept').toBe('v1 call Ana on 555-0100');
    expect((await getRevision(tenantId, agentId, '2'))?.systemPrompt, 'the head: kept').toBe('v3');
    expect(await eraseSubjectUserAgentRevisions(tenantId, userId), 'the kept rows no longer name the subject').toEqual({ rowsTouched: 0 });
  });

  it('puts back a revision a deployment pins while the eraser is deleting it', async () => {
    const tenantId = `org:d8-race-${Date.now()}-${seq++}`;
    const call = client();
    const login = await call('POST', '/host/openwop-app/test/login', { email: `d8r-${Date.now()}-${seq++}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const userId = login.body.user.userId as string;
    expect((await call('POST', '/host/openwop-app/orgs', { name: 'D8 race' })).status).toBe(201);
    const agent = await call('POST', '/host/openwop-app/agents', { persona: 'Racer', modelClass: 'chat', systemPrompt: 'r0' });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    const agentId = agent.body.agentId as string;
    expect((await call('PATCH', `/host/openwop-app/agents/${encodeURIComponent(agentId)}`, { systemPrompt: 'r1' })).status).toBe(200); // head = 1, 0 unserved

    // A row naming 0 lands right after the eraser's first read of the serving set.
    // It is minted, not POSTed: a transition needs a row at that version already.
    // The result is checked outside: servingRevisions swallows what the hook throws.
    const real = async (t: string, a: string) => new Set((await listDeployments(t, a)).map((r) => r.version));
    let pinned = false;
    setUserAgentPinnedRevisions(async (t, a) => {
      const before = await real(t, a);
      if (!pinned && a === agentId) pinned = await mintDraft(t, a, '0', 'pack-install');
      return before;
    });
    try {
      expect(await eraseSubjectUserAgentRevisions(tenantId, userId)).toEqual({ rowsTouched: 2 });
    } finally {
      setUserAgentPinnedRevisions(real);
    }
    expect(pinned, 'the row was written inside the window').toBe(true);
    expect((await getRevision(tenantId, agentId, '0'))?.systemPrompt, 'pinned mid-erase: put back').toBe('r0');
    expect(await eraseSubjectUserAgentRevisions(tenantId, userId), 'the put-back row no longer names the subject').toEqual({ rowsTouched: 0 });
  });
});
