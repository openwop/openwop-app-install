/**
 * ADR 1009 / RFC 0256 §C — an approval in a run that read untrusted content is
 * refused on the capability-token lane and stays open in the app.
 *
 * Route-level, through the real stack and the deterministic `mock` provider.
 * Each refusal has a control: the same token on an unmarked run succeeds, so a
 * 403 cannot pass by the path being unreachable.
 *
 * Sabotage-witnessed (2026-10-30): dropping the check in `resolveAndResume` reds
 * the token and boundary cases; dropping the wrapper in `agentRunnerNode` reds
 * the tool case; treating every run as marked reds the token control and the
 * empty-metadata assertion.
 *
 * Re-probed /grade-tests w81: each refusal asserts its exact body, and the
 * boundary case has its in-app control too. The tool case asserts the WRITER
 * (the bit on `run.metadata`), not the reader: dropping the reader's
 * `untrustedContext` arm reds the token cases, never the tool case, by design.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { markRunUntrustedContext, RUN_UNTRUSTED_CONTEXT_KEY, runHasUntrustedContext } from '../src/host/approvalTrust.js';
import type { Storage } from '../src/storage/storage.js';
import { bareRunId } from './support/bareRunId.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let n = 0;
const AGENT = 'probe.trust.aide';
const TOOL = 'openwop:schema.lookup';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // gates the `mock` provider
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Trust Aide', modelClass: 'chat', systemPrompt: 'You prepare reports.',
    packName: 'test.trust', packVersion: '0.0.1', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
  });
  __clearAgentIdentityCache();
}, 120_000);
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    anon: async <T = unknown>(p: string, b?: unknown): Promise<Res<T>> => {
      const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: res.status, body: await res.json().catch(() => undefined) as T };
    },
  };
}
type Client = ReturnType<typeof client>;
async function login(): Promise<Client> {
  const c = client();
  const stamp = `${Date.now()}-${n++}`;
  await c.post('/host/openwop-app/test/login', { email: `trust-${stamp}@acme.test`, tenantId: `org:trust-${stamp}` });
  return c;
}
/** Run settle: no hook to await, so poll the real condition (bounded; fails naming the state). */
async function waitStatus(c: Client, runId: string, pred: (s: string) => boolean): Promise<string> {
  return vi.waitFor(async () => {
    const s = (await c.get<{ status?: string }>(`/runs/${encodeURIComponent(runId)}`)).body?.status ?? '';
    if (!pred(s)) throw new Error(`run ${runId} stuck at ${s}`);
    return s;
  }, { timeout: 20_000, interval: 50 });
}
const terminal = (s: string): boolean => ['completed', 'failed', 'cancelled'].includes(s);
const waiting = (s: string): boolean => s.startsWith('waiting') || terminal(s);

interface Open { nodeId: string; kind: string; token?: string }
async function gate(c: Client): Promise<{ runId: string; open: Open & { token: string } }> {
  const created = await c.post<{ runId: string }>('/runs', { workflowId: 'openwop-app.approval-gate', inputs: {} });
  expect([200, 201, 202], JSON.stringify(created.body)).toContain(created.status);
  const runId = created.body.runId;
  await waitStatus(c, runId, waiting);
  const list = await c.get<{ interrupts: Open[] }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`);
  const open = list.body.interrupts?.[0];
  expect(open?.kind).toBe('approval');
  if (!open?.token) throw new Error('no token projected');
  return { runId, open: { ...open, token: open.token } };
}
const accept = { resumeValue: { action: 'accept' } };
interface Refusal { error?: string; message?: string; details?: { reason?: string } }
/** The token lane's refusal, exactly: a 403 from any other guard carries another reason. */
function expectSessionOnly(r: Res<Refusal>): void {
  expect(r.status, JSON.stringify(r.body)).toBe(403);
  expect(r.body?.error).toBe('forbidden');
  expect(r.body?.details?.reason).toBe('approval_requires_session');
}

describe('ADR 1009 — the token lane on a run that read untrusted content', () => {
  it('control: an unmarked run resolves over the token', async () => {
    const c = await login();
    const { runId, open } = await gate(c);
    const viaToken = await c.anon(`/interrupts/${open.token}`, accept);
    expect(viaToken.status, JSON.stringify(viaToken.body)).toBe(200);
    expect(await waitStatus(c, runId, terminal)).toBe('completed');
  });

  it('refuses the token on a marked run, and the person in the app can still decide', async () => {
    const c = await login();
    const { runId, open } = await gate(c);
    await markRunUntrustedContext(storage, bareRunId(runId));
    expectSessionOnly(await c.anon<Refusal>(`/interrupts/${open.token}`, accept));
    const inApp = await c.post(`/runs/${encodeURIComponent(runId)}/interrupts/${open.nodeId}`, accept);
    expect(inApp.status, JSON.stringify(inApp.body)).toBe(200);
    expect(await waitStatus(c, runId, terminal)).toBe('completed');
  });

  it('refuses the token on a run started across the untrusted boundary', async () => {
    const c = await login();
    const { runId, open } = await gate(c);
    await storage.mergeRunMetadata(bareRunId(runId), { trustBoundary: 'untrusted' });
    expectSessionOnly(await c.anon<Refusal>(`/interrupts/${open.token}`, accept));
    // The gate stays open to the person in the app.
    const inApp = await c.post(`/runs/${encodeURIComponent(runId)}/interrupts/${open.nodeId}`, accept);
    expect(inApp.status, JSON.stringify(inApp.body)).toBe(200);
    expect(await waitStatus(c, runId, terminal)).toBe('completed');
  });

  it('an agent turn that ran a tool marks its run, and one that ran none does not', async () => {
    const c = await login();
    const run = async (offerTools: string[]): Promise<Record<string, unknown>> => {
      const created = await c.post<{ runId: string }>('/runs', {
        workflowId: 'openwop-app.agent-mention',
        inputs: { agentId: AGENT, task: 'prepare the report', provider: 'mock', model: 'mock-1', offerTools },
      });
      expect(await waitStatus(c, created.body.runId, terminal)).toBe('completed');
      return (await storage.getRun(bareRunId(created.body.runId)))?.metadata ?? {};
    };
    resetMockPrograms();
    programMock('run', [{ content: 'DONE' }]);
    expect((await run([]))[RUN_UNTRUSTED_CONTEXT_KEY]).toBeUndefined();
    resetMockPrograms();
    programMock('run', [{ toolCalls: [{ name: TOOL, input: { kind: 'node' } }] }, { content: 'DONE' }]);
    expect((await run([TOOL]))[RUN_UNTRUSTED_CONTEXT_KEY]).toBe(true);
  });

  it('fails closed when the run row is missing', () => {
    expect(runHasUntrustedContext(undefined)).toBe(true);
    expect(runHasUntrustedContext({})).toBe(false);
  });
});
