/**
 * ADR 0856 D2 — a mission ledger (ADR 0136) drafted in a project's conversation
 * starts from the team ledger and can only narrow it. Over real HTTP:
 *   - in the project chat and a bound channel, `/prefill` carries the team
 *     ledger's goal, scope and tool policy, and a draft that omits them is saved
 *     WITH them (goal + forbidden + requireApproval);
 *   - nothing in an unrelated conversation;
 *   - a draft or edit that DROPS an inherited restriction is refused (400), on
 *     the REST routes and the agent tool; a broader prefix or forbidding a
 *     require-approval tool counts as narrowing;
 *   - a project the caller cannot read contributes nothing (no text leak) —
 *     and a bound channel composes nothing once its project is private — while
 *     the gate still enforces the policy (this is drafting only).
 *
 * TST-BWD-7 (grade-tests w62): each refusal asserts `validation_error` and names the
 * dropped restriction. Red when a draft omitting the inherited goal or `forbidden` is not
 * filled from the ledger; when a dropped restriction is accepted (the shared check, the
 * draft route, the PUT route, or the agent tool); when an unreadable project still
 * composes a pre-fill; when a bound channel composes one after its project went private;
 * or when the team ledger stops narrowing the conversation's tool gate.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { ensureConversationMeta, subjectConversationId } from '../src/host/conversationStore.js';
import { resolveConversationToolGate } from '../src/host/conversationToolScope.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { INTENT_LEDGER_DRAFT_TOOL_ID } from '../src/features/intent-ledger/agentTools.js';

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
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const payload = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: (payload ?? {}) as Reply };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
/** The response fields these legs read. */
interface Reply {
  error?: string; // the error envelope's code (middleware/errorEnvelope.ts)
  message?: string;
  user?: { userId: string };
  orgId?: string;
  id?: string;
  channel?: { conversationId: string };
  prefill?: { goal?: string; forbidden: string[]; requireApproval: string[]; sources: Array<Record<string, unknown>> } | null;
  ledger?: { goal: string; forbidden: string[]; requireApproval: string[]; status: string };
}
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const POLICY = { forbidden: ['openwop:email.send'], requireApproval: ['openwop:web.search'] };
const GOAL = 'Ship the EU launch';
const IL = (c: string) => `/host/openwop-app/intent-ledger/conversations/${encodeURIComponent(c)}`;

async function setup() {
  const tenantId = `org:mp-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('mp-owner'), tenantId })).body.user!.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'PrefillCo' })).body.orgId!;
  const proj = { id: (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body.id! };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  const w = await owner.post(`${L}/write`, { patch: { goal: GOAL, inScope: ['EU markets'], outOfScope: ['US markets'], toolPolicy: POLICY }, why: 'kickoff', baseVersion: 1 });
  expect(w.status, JSON.stringify(w.body)).toBeLessThan(300);
  const chat = subjectConversationId(tenantId, { kind: 'project', id: proj.id });
  await ensureConversationMeta(tenantId, chat, { type: 'group', ownerUserId: ownerId, ownerSubject: { kind: 'project', id: proj.id } });
  const channelId = (await owner.post('/host/openwop-app/channels', { name: `mp-${n++}`, visibility: 'public' })).body.channel!.conversationId;
  expect((await owner.put(`/host/openwop-app/channels/${channelId}/project`, { projectId: proj.id })).status).toBe(200);
  const loose = (await owner.post('/host/openwop-app/channels', { name: `loose-${n++}`, visibility: 'public' })).body.channel!.conversationId;
  return { tenantId, orgId, owner, ownerId, projectId: proj.id, chat, channelId, loose };
}

describe('ADR 0856 D2 — the mission pre-fill', () => {
  it('a mission drafted in the project chat and in a bound channel starts from the team ledger', async () => {
    const s = await setup();
    for (const c of [s.chat, s.channelId]) {
      const pf = await s.owner.get(`${IL(c)}/prefill`);
      expect(pf.status, c).toBe(200);
      expect(pf.body.prefill).toMatchObject({ goal: GOAL, ...POLICY });
      expect(pf.body.prefill!.sources[0]).toMatchObject({ kind: 'project', id: s.projectId, name: 'Launch', inScope: ['EU markets'], outOfScope: ['US markets'] });
      // A draft that omits the inherited fields is saved WITH them.
      const d = await s.owner.post(`${IL(c)}/draft`, {});
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(d.body.ledger).toMatchObject({ goal: GOAL, ...POLICY, status: 'draft' });
      // Narrowing further is fine: an own goal, an extra forbidden tool.
      const e = await s.owner.put(IL(c), { goal: 'EU launch, docs only', forbidden: ['openwop:email.send', 'openwop:crm'] });
      expect(e.status, JSON.stringify(e.body)).toBe(200);
      expect(e.body.ledger).toMatchObject({ goal: 'EU launch, docs only', forbidden: ['openwop:email.send', 'openwop:crm'], requireApproval: POLICY.requireApproval });
    }
  });

  it('nothing in an unrelated conversation', async () => {
    const s = await setup();
    expect((await s.owner.get(`${IL(s.loose)}/prefill`)).body).toEqual({ prefill: null });
    const noGoal = await s.owner.post(`${IL(s.loose)}/draft`, {});
    expect([noGoal.status, noGoal.body.error]).toEqual([400, 'validation_error']); // no inherited goal: still required
    const d = await s.owner.post(`${IL(s.loose)}/draft`, { goal: 'free' });
    expect(d.body.ledger).toMatchObject({ forbidden: [], requireApproval: [] });
  });

  it('a draft or edit that drops an inherited restriction is refused — routes and agent tool', async () => {
    const s = await setup();
    const drop = await s.owner.post(`${IL(s.chat)}/draft`, { goal: 'g', forbidden: [] });
    expect([drop.status, drop.body.error]).toEqual([400, 'validation_error']);
    expect(drop.body.message).toContain('forbidden: openwop:email.send');
    const dropApproval = await s.owner.post(`${IL(s.chat)}/draft`, { goal: 'g', requireApproval: ['openwop:docs.read'] });
    expect([dropApproval.status, dropApproval.body.error]).toEqual([400, 'validation_error']);
    expect(dropApproval.body.message).toContain('requireApproval: openwop:web.search');
    // Narrower forms are accepted: a covering prefix; forbidding a require-approval tool.
    const ok = await s.owner.post(`${IL(s.chat)}/draft`, { goal: 'g', forbidden: ['openwop:email', 'openwop:web.search'], requireApproval: [] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const putDrop = await s.owner.put(IL(s.chat), { goal: 'g', forbidden: [] });
    expect([putDrop.status, putDrop.body.error]).toEqual([400, 'validation_error']);
    expect((await s.owner.get(IL(s.chat))).body.ledger!.forbidden).toEqual(['openwop:email', 'openwop:web.search']); // unchanged
    // The agent's draft-contract tool: the same rule, a typed defect.
    const run = (input: Record<string, unknown>) => createAgentToolProvider({ tenantId: s.tenantId, runId: `run-mp-${n++}`, actingUserId: s.ownerId, conversationId: s.channelId })
      .executeTool({ name: INTENT_LEDGER_DRAFT_TOOL_ID, input });
    const bad = await run({ goal: 'g', forbidden: [], requireApproval: [] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('validation_error');
    const good = await run({ goal: 'g' });
    expect(good.isError, good.content).toBeFalsy();
    expect(JSON.parse(good.content).ledger).toMatchObject(POLICY);
  });

  it('a project the caller cannot read contributes nothing (no text leak)', async () => {
    const s = await setup();
    // A signed-in user of the tenant with no access to the (org-visible) project,
    // who CAN see the public bound channel.
    const outsider = client();
    await outsider.post('/host/openwop-app/test/login', { email: email('mp-outsider'), tenantId: s.tenantId });
    const pf = await outsider.get(`${IL(s.channelId)}/prefill`);
    expect(pf.status, JSON.stringify(pf.body)).toBe(200);
    expect(pf.body).toEqual({ prefill: null });
    expect(JSON.stringify(pf.body)).not.toContain(GOAL);
    expect((await s.owner.get(`${IL(s.channelId)}/prefill`)).body.prefill).toMatchObject({ goal: GOAL });
  });

  it('a bound channel composes nothing once its project is private; the gate still enforces', async () => {
    const s = await setup();
    expect((await s.owner.patch(`/host/openwop-app/projects/${s.projectId}/visibility`, { visibility: 'private' })).status).toBeLessThan(300);
    // The owner (who can read it) still gets it in the project chat …
    expect((await s.owner.get(`${IL(s.chat)}/prefill`)).body.prefill).toMatchObject({ goal: GOAL });
    // … but not in the bound channel, which every member reads (ADR 0852 D5).
    expect((await s.owner.get(`${IL(s.channelId)}/prefill`)).body).toEqual({ prefill: null });
    const d = await s.owner.post(`${IL(s.channelId)}/draft`, { goal: 'mine' });
    expect(d.body.ledger).toMatchObject({ goal: 'mine', forbidden: [], requireApproval: [] });
    // Drafting only: the one gate keeps applying the policy there.
    const { scope } = await resolveConversationToolGate({ tenantId: s.tenantId, conversationKey: s.channelId, ceiling: ['openwop:email.send', 'openwop:docs.read'], approvals: [] });
    expect(scope!.enabled).not.toContain('openwop:email.send');
  });
});
