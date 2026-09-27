/**
 * CS-BE-1 (conversation-stack audit 2026-07-09) — per-conversation authz on the
 * interrupt resolve route.
 *
 * Before the fix, POST /v1/runs/:runId/interrupts/:nodeId (kind:'conversation')
 * gated only `runs:read`: any same-tenant caller who learned a runId could drive
 * another user's conversation (context exfil — the run's stamped actingUserId is
 * the VICTIM's), and a forged `run.metadata.chatSessionId` at run-create pointed
 * a fresh run at a victim's thread (write injection into their chat feed).
 *
 * The fix binds every exchange AND close to the AUTHENTICATED HTTP caller via
 * the one membership-aware visibility predicate (`isVisibleToAsync`), fail-closed
 * 404 masking existence. Legacy/unowned conversations stay tenant-visible so
 * conformance + anon/demo flows are unchanged.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';

let server: http.Server;
let BASE: string;
const ADMIN = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const TENANT = 'authz-t1'; // shared tenant — both cookie users co-tenant

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // mock provider
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

type Client = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

/** A signed-in cookie user in the shared TENANT (the test-auth seam). */
async function loginClient(email: string): Promise<{ call: Client; userId: string }> {
  let cookie = '';
  const call: Client = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(ck);
      if (m?.[1]) cookie = m[1];
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const login = await call('POST', '/v1/host/openwop-app/test/login', { email, tenantId: TENANT });
  expect(login.status).toBe(201);
  return { call, userId: (login.body.user as { userId: string }).userId };
}

async function waitSuspended(call: Client, runId: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const { body } = await call('GET', `/v1/runs/${runId}`);
    if (typeof body.status === 'string' && body.status.startsWith('waiting')) return;
  }
  throw new Error(`run ${runId} never suspended`);
}

const WORKFLOW_ID = 'openwop-app.conversation.authz-test';
async function createConversationRun(call: Client, chatSessionId?: string): Promise<string> {
  const create = await call('POST', '/v1/runs', {
    workflowId: WORKFLOW_ID,
    inputs: { provider: 'mock', model: 'mock-1' },
    tenantId: TENANT,
    ...(chatSessionId ? { metadata: { chatSessionId } } : {}),
  });
  expect(create.status).toBe(201);
  const runId = create.body.runId as string;
  await waitSuspended(call, runId);
  return runId;
}

const exchange = (call: Client, runId: string, content: string) =>
  call('POST', `/v1/runs/${runId}/interrupts/gate`, { resumeValue: { operation: 'exchange', turn: { content } } });

describe('CS-BE-1 — conversation resolve is caller-visibility gated', () => {
  let alice: { call: Client; userId: string };
  let mallory: { call: Client; userId: string };

  beforeAll(async () => {
    alice = await loginClient('alice-authz@x.test');
    mallory = await loginClient('mallory-authz@x.test');
    // Workflow registration (admin surface).
    const wf = await fetch(`${BASE}/v1/host/openwop-app/workflows`, {
      method: 'POST', headers: ADMIN, body: JSON.stringify({
        workflowId: WORKFLOW_ID,
        nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'hi' } }], edges: [],
      }),
    });
    expect([200, 201, 409]).toContain(wf.status);
    // Alice's OWNED conversation.
    await ensureConversationMeta(TENANT, 'conv-owned-by-alice', { type: 'agent', ownerUserId: alice.userId });
  });

  it('the owner exchanges + closes normally on their own conversation run', async () => {
    const runId = await createConversationRun(alice.call, 'conv-owned-by-alice');
    const ex = await exchange(alice.call, runId, 'hello from alice');
    expect(ex.status).toBe(200);
    const close = await alice.call('POST', `/v1/runs/${runId}/interrupts/gate`, { resumeValue: { operation: 'close' } });
    expect(close.status).toBe(200);
  });

  it('a same-tenant stranger who learned the runId is 404ed on exchange AND close (existence masked)', async () => {
    const runId = await createConversationRun(alice.call, 'conv-owned-by-alice');
    const ex = await exchange(mallory.call, runId, 'injected');
    expect(ex.status).toBe(404);
    const close = await mallory.call('POST', `/v1/runs/${runId}/interrupts/gate`, { resumeValue: { operation: 'close' } });
    expect(close.status).toBe(404);
    // The owner is unaffected afterwards.
    expect((await exchange(alice.call, runId, 'still mine')).status).toBe(200);
  });

  it("a FORGED chatSessionId at run-create (vector B) cannot inject into the victim's thread", async () => {
    // Mallory creates her OWN run pointing at Alice's conversation.
    const runId = await createConversationRun(mallory.call, 'conv-owned-by-alice');
    expect((await exchange(mallory.call, runId, 'forged injection')).status).toBe(404);
  });

  it('an ANONYMOUS caller (no session cookie) is 404ed on an owned conversation — fail-soft caller resolution stays fail-closed', async () => {
    const runId = await createConversationRun(alice.call, 'conv-owned-by-alice');
    const res = await fetch(`${BASE}/v1/runs/${runId}/interrupts/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'anon probe' } } }),
    });
    expect(res.status).toBe(404);
  });

  it('a legacy/unowned conversation (no meta) stays exchangeable — conformance/anon flows unchanged', async () => {
    // No chatSessionId, no meta for the gate-derived id → unowned → visible.
    const runId = await createConversationRun(alice.call);
    expect((await exchange(mallory.call, runId, 'unowned is tenant-visible')).status).toBe(200);
  });
});
