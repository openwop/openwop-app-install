/**
 * ADR 0889 post-merge review H2 — the advertised `maxCostUsdPerSuite` ceiling can
 * actually fail. Before the fix the spend was a sum of `costEstimateUsd`, which
 * the rate tables never produced for current catalog models (Claude 5, GPT-5.x,
 * Gemini 3.x), and judge calls were never counted, so every suite ran uncapped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { computeCostUsd } from '../src/providers/usageEmitter.js';
import { estimateJudgeCallUsd, meterJudge, trialUsageCost } from '../src/host/evals/cost.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const AGENT = 'eval.cost-agent';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Eval subject', modelClass: 'research', systemPrompt: 'Answer.',
    packName: 'test', packVersion: '0', toolAllowlist: [], confidence: { defaultThreshold: 0.1 },
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted */ }
  return { status: res.status, json, text };
}

async function settle(runId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i += 1) {
    const r = await send('GET', `/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(String(r.json['status']))) return r.json;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

const TASK = (taskId: string) => ({ taskId, input: { q: taskId }, expected: { kind: 'golden', match: { strategy: 'contains', value: 'ok' } } });
// One round per trial, a million output tokens each — $20 at Claude Opus 5.5's catalog price.
const EXPENSIVE = [{ content: 'ok', inputTokens: 1000, outputTokens: 1_000_000 }];

async function runSuite(ref: string, tasks: string[], model: string): Promise<Record<string, unknown>> {
  const [suiteId, version] = ref.split('@');
  const put = await send('PUT', `/host/openwop-app/agent-evals/suites/${ref}`, { suiteId, version, modes: ['golden'], tasks: tasks.map(TASK) });
  expect(put.status, put.text.slice(0, 200)).toBe(200);
  const c = await send('POST', '/runs', {
    mode: 'eval', evalSuiteRef: ref, agentId: AGENT,
    configurable: { ai: { model }, mockProvider: { id: 'tool-calls', rounds: Object.fromEntries(tasks.map((t) => [t, EXPENSIVE])) } },
  });
  expect(c.status, c.text.slice(0, 300)).toBe(201);
  return settle(String(c.json['runId']));
}

describe('ADR 0889 H2 — the eval cost ceiling can fail', () => {
  it('the catalog prices current models (providers.json is the SSoT)', () => {
    expect(computeCostUsd('claude-opus-5-5', 0, 1000)).toBeCloseTo(0.02, 6);
  });

  it('a suite whose spend crosses the ceiling stops with eval_cost_ceiling_exceeded', async () => {
    const run = await runSuite('test.acme.evals.cost@1.0.0', ['a', 'b', 'c'], 'claude-opus-5-5');
    expect(run['status']).toBe('failed');
    expect((run['error'] as Record<string, unknown>)['code']).toMatch(/(^|\.)eval_cost_ceiling_exceeded$/);
  });

  it('a model the host cannot price fails closed with eval_cost_unpriced (never $0)', async () => {
    const run = await runSuite('test.acme.evals.unpriced@1.0.0', ['a'], 'no-such-model-x');
    expect(run['status']).toBe('failed');
    expect((run['error'] as Record<string, unknown>)['code']).toMatch(/(^|\.)eval_cost_unpriced$/);
  });

  it('judge calls are counted toward the spend', async () => {
    expect(estimateJudgeCallUsd('is it polite?', { answer: 'yes' })).toBeGreaterThan(0);
    const meter = { usd: 0 };
    const judge = meterJudge(async () => ({ pass: true, detail: 'judge: ok' }), meter);
    await judge({ criteria: 'a', output: 'x' });
    await judge({ criteria: 'b', output: 'y' });
    expect(meter.usd).toBeGreaterThan(0);
    expect(trialUsageCost([{ type: 'provider.usage', payload: { model: 'm', inputTokens: 5, outputTokens: 5 } }]).unpriced).toBe(true);
    expect(trialUsageCost([{ type: 'provider.usage', payload: { model: 'mock', inputTokens: 5, outputTokens: 5 } }]).unpriced).toBe(false);
  });
});
