/**
 * ADR 0977 D2 (architect finding 2) — the live counter door is keyed on the
 * suite's SOURCE, not on the agent.
 *
 * Under the conformance posture the scripted agent is in the public registry, so
 * a TENANT suite can target it, and `runTrial` hands that run to
 * `runScriptedTrial`. A tenant script that calls the counter under
 * `onMiss: "live"` must still fail closed: the miss never reaches the counter,
 * and the trial fails.
 *
 * Red when (sabotage-witnessed): the door predicate ignores `suiteSource`.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { SCRIPTED_AGENT_ID } from '../src/host/evals/fixtureSuites.js';
import { COUNTER_TOOL } from '../src/host/evals/evalCounter.js';
import { MEMORY_TOOL } from '../src/host/evals/evalMemoryTool.js';

let server: Server;
let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };

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
  await new Promise<void>((r) => server.close(() => r()));
});

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted below */ }
  return { status: res.status, json, text };
}
async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const status = String(((await send('GET', `/runs/${runId}`)).json as { status?: string }).status ?? '');
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

describe('ADR 0977 D2 — a tenant suite cannot open the live counter door', () => {
  it('a tenant script calling the counter under onMiss "live" fails closed and never counts', async () => {
    const suite = {
      suiteId: 'test.acme.evals.counter-door', version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 },
      targetAgentId: SCRIPTED_AGENT_ID,
      tasks: [{
        taskId: 'door',
        input: { script: [{ tool: COUNTER_TOOL, arguments: { key: 'D', op: 'inc' } }], output: 'done' },
        expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } },
        fixtures: { onMiss: 'live', toolResponses: [{ tool: 'conformance.eval:lookup', args: { id: 1 }, argsMatch: 'exact', response: { ok: true } }] },
      }],
    };
    const put = await send('PUT', `/host/openwop-app/agent-evals/suites/${suite.suiteId}@${suite.version}`, suite);
    expect(put.status, put.text.slice(0, 300)).toBe(200);
    const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${suite.suiteId}@${suite.version}`, agentId: SCRIPTED_AGENT_ID });
    // Control: under the posture the tenant suite CAN name the scripted agent, so the door is really reached.
    expect(c.status, c.text.slice(0, 300)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');
    const evs = (((await send('GET', `/runs/${runId}/events/poll?limit=500`)).json as { events?: Array<{ type: string; payload: Record<string, unknown> }> }).events ?? []);
    const ret = evs.filter((e) => e.type === 'agent.tool-returned' && e.payload['toolName'] === COUNTER_TOOL);
    expect(ret, JSON.stringify(evs.map((e) => e.type))).toHaveLength(1);
    expect((ret[0]!.payload['error'] as { code?: string } | undefined)?.code).toBe('fixture_miss');
    expect(ret[0]!.payload['outcome']).toBeUndefined();
    const s = await send('GET', `/runs/${runId}/eval-summary`);
    const t = ((s.json['tasks'] as Array<Record<string, unknown>>) ?? [])[0];
    expect(t, s.text.slice(0, 300)).toMatchObject({ passed: false, fixtureMissCount: 1 });
  });
  // ADR 0989 D3 — the memory tool shares the counter's door: a tenant suite naming
  // it never reaches a trial's memory and gets no `outcome`.
  it('a tenant script calling the memory tool never reaches trial memory', async () => {
    const suite = {
      suiteId: 'test.acme.evals.memory-door', version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 },
      targetAgentId: SCRIPTED_AGENT_ID,
      tasks: [{
        taskId: 'door',
        input: { script: [{ tool: MEMORY_TOOL, arguments: { op: 'read', id: 'seeded' } }], output: 'done' },
        expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } },
        fixtures: { memorySeed: [{ id: 'seeded', content: 'seed' }] },
      }],
    };
    const put = await send('PUT', `/host/openwop-app/agent-evals/suites/${suite.suiteId}@${suite.version}`, suite);
    expect(put.status, put.text.slice(0, 300)).toBe(200);
    const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${suite.suiteId}@${suite.version}`, agentId: SCRIPTED_AGENT_ID });
    expect(c.status, c.text.slice(0, 300)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');
    const evs = (((await send('GET', `/runs/${runId}/events/poll?limit=500`)).json as { events?: Array<{ type: string; payload: Record<string, unknown> }> }).events ?? []);
    const ret = evs.filter((e) => e.type === 'agent.tool-returned' && e.payload['toolName'] === MEMORY_TOOL);
    expect(ret).toHaveLength(1);
    expect(ret[0]!.payload['outcome']).toBeUndefined();
    expect(JSON.stringify(ret[0]!.payload)).not.toContain('"seed"');
  });
});
