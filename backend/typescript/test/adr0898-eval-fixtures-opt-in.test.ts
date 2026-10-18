/**
 * ADR 0898 — `OPENWOP_CONFORMANCE_EVAL_FIXTURES=true` lists and runs the RFC 0244
 * eval-suite fixtures on a host booted the way production is (conformance nodes
 * OFF), WITHOUT putting the scripted agent in the agent registry.
 *
 * Why the registry is the hazard: a manifest with no `ownerTenant` is public
 * (`agentVisibility.ts`), so a registered scripted agent would be listed by
 * `/agents` and resolvable by chat, dispatch, workflow nodes, channels, voice
 * and the widget — a live-dispatch agent making real model calls. Every one of
 * those surfaces resolves through `resolveAgentForTenant`, so its `null` is the
 * single witness for all of them; `/agents` and dispatch are also checked over HTTP.
 *
 *   1. the fixture suites are in discovery `fixtures[]` and an eval run of one completes;
 *   2. the scripted agent is absent from GET /agents, 404s on dispatch and does not
 *      resolve for chat / workflow nodes / channels;
 *   3. an eval run of a TENANT suite cannot name the scripted agent (404);
 *   4. LEAK-8 — `core.conformance.*` nodes and the mock agent stay unmounted.
 *
 * The env is set in `vi.hoisted` because the fixture loader and the scripted-agent
 * registration run at module load (`host/index.ts`).
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
  process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES = 'true';
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { resolveAgentForTenant } from '../src/host/agentVisibility.js';
import { conformanceNodesEnabled } from '../src/bootstrap/conformanceMockAgent.js';
import { CONFORMANCE_SUITE_PREFIX, SCRIPTED_AGENT_ID, listFixtureSuiteIds } from '../src/host/evals/fixtureSuites.js';

let server: Server;
let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const TENANT = 'default';
const SUITE = 'conformance-eval-trajectory';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
  delete process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES;
  await new Promise<void>((r) => server.close(() => r()));
});

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted below */ }
  return { status: res.status, json, text };
}

async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const r = await send('GET', `/runs/${runId}`, V2);
    const status = String((r.json as { status?: string }).status ?? '');
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

describe('ADR 0898 — eval-suite fixtures under the opt-in, conformance nodes off', () => {
  it('control: the posture really is nodes-off', () => {
    expect(conformanceNodesEnabled()).toBe(false);
  });

  it('lists the fixture suites in discovery fixtures[]', async () => {
    expect(listFixtureSuiteIds()).toContain(SUITE);
    const doc = await send('GET', '/.well-known/openwop', {});
    const fixtures = JSON.stringify(doc.json);
    for (const id of listFixtureSuiteIds()) expect(fixtures, id).toContain(`"${id}"`);
    expect(listFixtureSuiteIds().length).toBeGreaterThanOrEqual(5);
  });

  it('runs a fixture suite against the scripted agent, graded task by task', async () => {
    const c = await send('POST', '/runs', V2, { mode: 'eval', evalSuiteRef: `${CONFORMANCE_SUITE_PREFIX}${SUITE}`, agentId: SCRIPTED_AGENT_ID });
    expect(c.status, c.text.slice(0, 400)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');
    const s = await send('GET', `/runs/${runId}/eval-summary`, V2);
    expect(s.status, s.text.slice(0, 400)).toBe(200);
    // The fixture mixes passing and failing tasks on purpose; both verdicts prove it was graded.
    const tasks = new Map(((s.json['tasks'] as Array<{ taskId: string; passed: boolean }>) ?? []).map((t) => [t.taskId, t.passed]));
    expect(tasks.get('in-order-match'), s.text.slice(0, 400)).toBe(true);
    expect(tasks.get('in-order-wrong-order')).toBe(false);
    expect(tasks.get('forbidden-hit')).toBe(false);
  });

  it('the scripted agent is NOT in the registry and resolves for no tenant (chat, nodes, channels, voice, widget)', async () => {
    expect(getAgentRegistry().get(SCRIPTED_AGENT_ID)).toBeFalsy();
    expect(await resolveAgentForTenant(SCRIPTED_AGENT_ID, TENANT)).toBeNull();
    expect(await resolveAgentForTenant(SCRIPTED_AGENT_ID, '*')).toBeNull();
  });

  it('GET /agents does not list it', async () => {
    const r = await send('GET', '/agents', V2);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(((r.json['agents'] as Array<{ agentId?: string }>) ?? []).length, 'control: the list is not empty').toBeGreaterThan(0);
    expect(r.text).not.toContain(SCRIPTED_AGENT_ID);
  });

  it('dispatch 404s as an unknown agent', async () => {
    const r = await send('POST', `/host/openwop-app/agents/${SCRIPTED_AGENT_ID}/dispatch`, V2, { input: { q: 'hi' } });
    expect(r.status, r.text.slice(0, 300)).toBe(404);
    expect(r.json['message']).toBe(`agent '${SCRIPTED_AGENT_ID}' is not installed on this host`);
  });

  it('an eval run of a TENANT suite cannot name the scripted agent (404, the dispatch refusal)', async () => {
    const suite = {
      suiteId: 'test.acme.evals.optin', version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 },
      tasks: [{ taskId: 't', input: { output: 'x' }, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }],
    };
    const put = await send('PUT', `/host/openwop-app/agent-evals/suites/${suite.suiteId}@${suite.version}`, V2, suite);
    expect(put.status, put.text.slice(0, 300)).toBe(200);
    const r = await send('POST', '/runs', V2, { mode: 'eval', evalSuiteRef: 'test.acme.evals.optin@1.0.0', agentId: SCRIPTED_AGENT_ID });
    expect(r.status, r.text.slice(0, 300)).toBe(404);
    expect(r.text).toContain('is not installed on this host');
  });

  it('LEAK-8: core.conformance.* nodes and the mock agent stay unmounted', () => {
    const reg = getNodeRegistry();
    expect(reg.isResolvable('core.conformance.mock-agent')).toBe(false);
    expect(reg.isResolvable('conformance.secret.echo')).toBe(false);
  });
});
