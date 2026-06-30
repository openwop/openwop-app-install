/**
 * A8 end-to-end: the agent-eval grader seam over HTTP. Boots the real app via
 * createApp and exercises POST /v1/host/openwop-app/agents/eval-run:
 *   - 404 when the eval suite is disabled (honest gate, RFC 0081/0031)
 *   - 200 + a content-free EvalSummary when enabled (golden/rubric/schema)
 *   - 400 on a malformed envelope (length mismatch / missing arrays)
 * Proves `gradeSuite` (host/agentEvalGrader.ts) is reachable from the live app,
 * not just unit-tested — the W-1/A8 wiring acceptance.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const TOKEN = 'dev-token';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let URL: string;

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; URL = `${BASE}/v1/host/openwop-app/agents/eval-run`; res(); }); });
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('A8 — agent-eval grader seam (POST /v1/host/openwop-app/agents/eval-run)', () => {
  it('404s when the eval suite is disabled (honest gate)', async () => {
    delete process.env.OPENWOP_AGENT_EVAL_SUITE_ENABLED;
    const res = await fetch(URL, {
      method: 'POST', headers: H,
      body: JSON.stringify({ tasks: [{ taskId: 't1', criterion: { kind: 'golden', expected: 'x' } }], results: ['x'] }),
    });
    expect(res.status).toBe(404);
  });

  it('grades a golden/rubric/schema suite into a content-free EvalSummary', async () => {
    process.env.OPENWOP_AGENT_EVAL_SUITE_ENABLED = 'true';
    const tasks = [
      { taskId: 'golden-hit', criterion: { kind: 'golden', expected: 'Hello World' } },
      { taskId: 'golden-miss', criterion: { kind: 'golden', expected: 'something else' } },
      { taskId: 'rubric', criterion: { kind: 'rubric', mustInclude: ['invoice'], mustExclude: ['ssn'] } },
      { taskId: 'schema', criterion: { kind: 'schema', schema: { type: 'object', required: ['ok'] } } },
    ];
    const results = [
      'hello world',                       // golden-hit  → 1 (normalized match)
      'a different answer',                // golden-miss → 0
      'the invoice was processed',         // rubric      → 1 (includes invoice, excludes ssn)
      { ok: true },                        // schema      → 1 (valid)
    ];
    const res = await fetch(URL, { method: 'POST', headers: H, body: JSON.stringify({ tasks, results }) });
    expect(res.status).toBe(200);
    const summary = await res.json() as {
      total: number; passed: number; passRate: number; meanScore: number;
      tasks: Array<{ taskId: string; score: number; passed: boolean }>;
    };
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(3);
    expect(summary.passRate).toBeCloseTo(0.75);
    expect(summary.tasks.map((t) => t.passed)).toEqual([true, false, true, true]);
    // Content-free: the summary carries scalars + per-task scores, never the
    // result text (eval-summary-no-content-leak).
    expect(JSON.stringify(summary)).not.toContain('different answer');
    expect(JSON.stringify(summary)).not.toContain('invoice was processed');
  });

  it('400s on a tasks/results length mismatch', async () => {
    process.env.OPENWOP_AGENT_EVAL_SUITE_ENABLED = 'true';
    const res = await fetch(URL, {
      method: 'POST', headers: H,
      body: JSON.stringify({ tasks: [{ taskId: 't1', criterion: { kind: 'golden', expected: 'x' } }], results: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('400s when tasks[] is absent', async () => {
    process.env.OPENWOP_AGENT_EVAL_SUITE_ENABLED = 'true';
    const res = await fetch(URL, { method: 'POST', headers: H, body: JSON.stringify({ results: [] }) });
    expect(res.status).toBe(400);
  });

  it('400s on a malformed task envelope (no criterion kind)', async () => {
    process.env.OPENWOP_AGENT_EVAL_SUITE_ENABLED = 'true';
    const res = await fetch(URL, {
      method: 'POST', headers: H,
      body: JSON.stringify({ tasks: [{ taskId: 't1', criterion: {} }], results: ['x'] }),
    });
    expect(res.status).toBe(400);
  });
});
