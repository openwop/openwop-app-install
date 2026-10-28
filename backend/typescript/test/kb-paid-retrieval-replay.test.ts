/** ADR 0904: real run/fork witness for paid KB retrieval. A fake operator
 * ranker deliberately changes its answer after the live run. Replay must
 * serve identical recorded node outputs without another provider attempt. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __setByokTextForTest } from '../src/host/headlessAi.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { createCollection, ingestDocument, setRetrievalConfig } from '../src/features/kb/kbService.js';
import { __setVertexRerankDepsForTest } from '../src/features/kb/vertexReranker.js';
import { getSetCookies } from './headerCookies.js';

let server: http.Server; let base = ''; let cookie = ''; let calls = 0; let enrichCalls = 0; let enrichModel = 'prefix-first';
const tenant = `org:paid-kb-replay-${Date.now()}`;
const saved = new Map(['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_KB_VERTEX_RERANK', 'OPENWOP_KB_VERTEX_RERANK_DAILY_CAP'].map(k => [k, process.env[k]]));
interface Body {
  runId?: string; orgId?: string; status?: string; error?: unknown;
  events?: Array<{ type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown> } }>;
}
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const entry of getSetCookies(response.headers)) {
    const match = /(__session=[^;]+)/.exec(entry); if (match) cookie = match[1]!;
  }
  return { status: response.status, body: await response.json() as Body };
}
async function settle(id: string): Promise<void> {
  // The executor runs detached; no completion hook is available at this API.
  await vi.waitFor(async () => {
    const result = await call('GET', `/runs/${encodeURIComponent(id)}`);
    if (!['completed', 'failed', 'cancelled'].includes(result.body.status ?? '')) throw new Error('run is still active');
    expect(result.body.status, JSON.stringify(result.body.error)).toBe('completed');
  }, { timeout: 8000, interval: 25 });
}
async function outputs(id: string): Promise<Record<string, unknown>> {
  const bundle = await call('GET', `/runs/${encodeURIComponent(id)}/debug-bundle`);
  expect(bundle.status).toBe(200);
  const completed = bundle.body.events?.find(event => event.type === 'node.completed' && event.nodeId === 'retrieve');
  if (!completed?.payload?.outputs) throw new Error('missing recorded retrieval output');
  return completed.payload.outputs;
}
beforeAll(async () => {
  Object.assign(process.env, {
    OPENWOP_STORAGE_DSN: 'memory://', OPENWOP_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    OPENWOP_TEST_AUTH_ENABLED: 'true', OPENWOP_KB_VERTEX_RERANK: '1', OPENWOP_KB_VERTEX_RERANK_DAILY_CAP: '100',
  });
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }); });
});
afterAll(async () => {
  __setVertexRerankDepsForTest(null); __setByokTextForTest(null);
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

it.each(['search', 'rag'] as const)('%s replay serves the source result without a second paid ranking attempt', async node => {
  expect((await call('POST', '/host/openwop-app/test/login', { email: 'kb-replay-owner@acme.test', tenantId: tenant })).status).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: `KB ${node}` });
  expect(org.status).toBe(201); const orgId = org.body.orgId; if (!orgId) throw new Error('missing org');
  const col = await createCollection(tenant, orgId, 'actor', { name: 'Replayable ranking' });
  await ingestDocument(tenant, orgId, 'actor', col.collectionId, { title: 'Leave', text: 'Parental leave is sixteen weeks.' }, { documentId: `leave-${node}` });
  await ingestDocument(tenant, orgId, 'actor', col.collectionId, { title: 'Meals', text: 'Meals are reimbursed up to fifty dollars.' }, { documentId: `meals-${node}` });
  enrichModel = 'prefix-first'; enrichCalls = 0;
  __setByokTextForTest(async () => ({ provider: 'anthropic', model: enrichModel, route: 'byok-default', dispatch: async () => { enrichCalls++; return 'Context for the employee handbook.'; } }));
  await setRetrievalConfig(tenant, orgId, col.collectionId, 'actor', { mode: 'hybrid+rerank', enrichment: 'llm', rerank: { kind: 'vertex' } });
  calls = 0;
  __setVertexRerankDepsForTest({
    metadata: { accessToken: async () => 'fixture', metadataText: async () => 'fixture-project', invalidate: () => {} },
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ records: calls === 1
        ? [{ id: `meals-${node}:0`, score: 0.9 }, { id: `leave-${node}:0`, score: 0.2 }]
        : [{ id: `leave-${node}:0`, score: 0.8 }, { id: `meals-${node}:0`, score: 0.1 }] }) };
    },
  });
  const workflowId = `kb.paid-replay.${node}`;
  registerWorkflow({ workflowId, nodes: [{ nodeId: 'retrieve', typeId: `feature.kb.nodes.${node}`, config: {} }], edges: [] });
  const live = await call('POST', '/runs', { workflowId, inputs: { orgId, collectionId: col.collectionId, query: 'parental leave', topK: 2 } });
  expect(live.status, JSON.stringify(live.body)).toBe(201); const liveId = live.body.runId; if (!liveId) throw new Error('missing live run');
  await settle(liveId); expect(calls).toBe(1); expect(enrichCalls).toBe(2);
  const recorded = await outputs(liveId);
  expect(JSON.stringify(recorded)).toContain('Meals');
  enrichModel = 'prefix-changed-after-source'; // a stale cache would require another unlogged BYOK call
  const fork = await call('POST', `/runs/${encodeURIComponent(liveId)}:fork`, { mode: 'replay' });
  expect(fork.status, JSON.stringify(fork.body)).toBe(201); const forkId = fork.body.runId; if (!forkId) throw new Error('missing fork');
  expect(forkId).not.toBe(liveId); await settle(forkId);
  expect(calls, 'replay must not re-enter the paid retrieval provider').toBe(1);
  expect(enrichCalls, 'replay must not redispatch contextual enrichment after a model change').toBe(2);
  expect(await outputs(forkId)).toEqual(recorded);
}, 30_000);
