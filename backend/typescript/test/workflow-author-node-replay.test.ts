/**
 * ADR 0673 D1 (`WFAWF-24`) — the workflow-author WRITE nodes must not re-execute on a
 * `mode:'replay'` fork.
 *
 * WHY: all four nodes shipped `role:"action"` with no `side-effectful` capability, so none
 * reached `MANIFEST_FAST_PATH_SERVED` and `isSideEffectingNode` returned false for every one.
 * `executor.ts:983` gates the recorded-outcome serve on exactly that predicate, so `persist`
 * re-executed and could durably register a SECOND workflow. The pack header claimed the
 * opposite ("replay/fork read the recorded result"), and the executor reads `role` zero times.
 *
 * **WHY THIS TEST NEEDS A STAGED DIVERGENCE — and why the obvious version is born GREEN.**
 * A plain replay fork serves `draft`'s `ctx.callAI` from the SOURCE run's invocation record
 * (`aiProvidersHost.ts:729`), so the re-drafted definition is byte-identical, `persist` upserts
 * the same id, and "assert no second row" passes with the BROKEN manifest. The CRM precedent
 * was born red for a mechanism that does not exist here (a per-run id key, which ADR 0596
 * deliberately removed from `parseDefinition`).
 *
 * So the divergence is staged: a pending mock program makes `aiProvidersHost.ts:728` skip the
 * source-run fallback by design (that is how the RFC 0041 §B divergence witness reaches the
 * mock), and the fork's `draft` returns a DIFFERENT workflowId. Only the side-effect
 * classification then keeps the durable count at one.
 *
 * BORN RED on the `role:"action"` manifest: the fork re-executes `persist` with definition B
 * and a second owned workflow appears.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { listOwned } from '../src/host/workflowOwnership.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';

const TENANT = `org:wfa-replay-${Date.now()}`;
const DRAFT_NODE = 'd1';
let server: http.Server;
let BASE = '';
let cookie = '';

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

const settleRun = async (runId: string): Promise<string> => {
  let snap: { status?: string; error?: unknown } = {};
  for (let i = 0; i < 200; i++) {
    snap = (await call('GET', `/v1/runs/${runId}`)).body ?? snap;
    if (['completed', 'failed', 'cancelled'].includes(snap.status ?? '')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return snap.status === 'completed' ? 'completed' : `${snap.status}:${JSON.stringify(snap.error)}`;
};

/** A minimal VALID definition the closed-world validator accepts. */
const defWith = (workflowId: string): Record<string, unknown> => ({
  workflowId,
  nodes: [{ nodeId: 'a', typeId: 'core.flow.noop' }],
  edges: [],
});

const program = (def: Record<string, unknown>): void => {
  programMock(DRAFT_NODE, [{ content: JSON.stringify(def), stopReason: 'end_turn', inputTokens: 8, outputTokens: 8 }]);
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { resetMockPrograms(); await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0673 D1 — a replay :fork must not author a second workflow', () => {
  it('live run authors ONE workflow; a DIVERGED replay fork still leaves ONE, and persist reports the SOURCE id', async () => {
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: 'wfa-replay@acme.test', tenantId: TENANT });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.orgId as string;

    const workflowId = 'wfa.replay.witness';
    registerWorkflow({
      workflowId,
      nodes: [
        // This pack reads `ctx.inputs` ONLY (`index.mjs:181`), unlike the CRM pack which
        // merges `{...config, ...inputs}` itself — so these are node INPUTS, not config.
        { nodeId: DRAFT_NODE, typeId: 'feature.workflow-author.nodes.draft', inputs: { intent: 'a witness workflow', provider: 'mock', model: DRAFT_NODE, orgId } },
        { nodeId: 'p1', typeId: 'feature.workflow-author.nodes.persist', inputs: { orgId } },
      ],
      edges: [{ id: 'e1', sourceNodeId: DRAFT_NODE, targetNodeId: 'p1' }],
    } as never);

    // ── the live run authors definition A ────────────────────────────────────
    program(defWith('authored.A'));
    const create = await call('POST', '/v1/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    expect(await settleRun(runId)).toBe('completed');

    const afterLive = await listOwned(TENANT);
    expect(afterLive.map((r) => r.workflowId), 'the live run authors exactly one').toEqual(['authored.A']);

    // ── the fork is DIVERGED: a pending program makes the invocation-log
    //    fallback skip, so the fork's `draft` returns B, not A ───────────────
    program(defWith('authored.B'));
    const fork = await call('POST', `/v1/runs/${runId}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkRunId = fork.body.runId as string;
    expect(forkRunId).not.toBe(runId);
    expect(await settleRun(forkRunId)).toBe('completed');

    const afterFork = await listOwned(TENANT);
    expect(afterFork.map((r) => r.workflowId).sort(),
      'the fork must not durably author a SECOND workflow — persist is replay-served',
    ).toEqual(['authored.A']);
  });
});
