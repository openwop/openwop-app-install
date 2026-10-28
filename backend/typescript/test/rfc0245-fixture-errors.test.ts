/**
 * ADR 0929 — RFC 0245 host witness: an eval fixture entry marked `isError: true`
 * is replayed as a TOOL ERROR, never as a success.
 *
 * The suite is ec's `conformance-eval-fixture-error` fixture, vendored with suite
 * 2.46.18 under `conformance-fixtures/eval-suites/` and loaded by the host at boot
 * (ADR 0898 opt-in). Its one task scripts the same call twice;
 * the fixtures serve an `isError` entry, then a success (RFC 0244 §D, first
 * unconsumed match). The end-to-end case judges the log the way the conformance
 * judge `lib/eval-fixture-error-witness.ts` does:
 *  - two `agent.tool-called` + two `agent.tool-returned`, paired by `callId`;
 *  - the first: `error {code, message}` both non-empty, NO `outcome`, `status: "error"`;
 *  - the second: no `error`, and `status` is not "error" (suite 2.46.18 relaxed this
 *    leg; it no longer requires `outcome`, which RFC 0064 §F keeps optional);
 *  - `fixtureMissCount` 0.
 * Sabotage-witnessed (wave 64, probes 8fw5g1-rf-*): serving the entry as a success
 * (`rf-served-error`), retrying it live (`rf-never-live`), `status: 'ok'` on the
 * served failure (`rf-status-error`), echoing the payload into `message`
 * (`rf-no-echo`), dropping the advert (`rf-advert`), the create-time refusal
 * (`rf-refusal`), the boolean check (`rf-iserror-type`), `suiteFeatures`
 * (`rf-features`) and promotion (`rf-promote`) each turn their case red.
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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFORMANCE_SUITE_PREFIX, SCRIPTED_AGENT_ID, listFixtureSuiteIds } from '../src/host/evals/fixtureSuites.js';
import { validateEvalSuite, suiteFeatures, type EvalTaskDef } from '../src/host/evals/suiteStore.js';
import { evalSuiteCapability, resetRfc0245WireCache } from '../src/host/evals/evalCapability.js';
import { fixtureInterceptor } from '../src/host/evals/agentEvalRun.js';
import { buildTaskFromRun } from '../src/host/evals/promoteRun.js';

const FIXTURE_ID = 'conformance-eval-fixture-error';
const FIXTURE_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../conformance-fixtures/eval-suites/conformance-eval-fixture-error.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Record<string, unknown>;
const TOOL = 'conformance.eval:lookup';

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
  delete process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES;
  resetRfc0245WireCache();
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
type Ev = { type: string; sequence: number; payload: Record<string, unknown> };
async function events(runId: string): Promise<Ev[]> {
  const r = await send('GET', `/runs/${runId}/events/poll?limit=500`, V2);
  return ((r.json as { events?: unknown[] }).events ?? []) as Ev[];
}

describe('RFC 0245 §A — the fixture field', () => {
  it('an isError boolean validates; a string is refused by name', () => {
    expect(() => validateEvalSuite(JSON.parse(JSON.stringify(FIXTURE)))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(FIXTURE));
    bad.tasks[0].fixtures.toolResponses[0].isError = 'true';
    expect(() => validateEvalSuite(bad)).toThrow(/toolResponses\[0\]\.isError/);
  });
  it('suiteFeatures reports fixtureErrors only when an entry is isError: true', () => {
    expect(suiteFeatures(validateEvalSuite(JSON.parse(JSON.stringify(FIXTURE)))).fixtureErrors).toBe(true);
    const plain = JSON.parse(JSON.stringify(FIXTURE));
    for (const r of plain.tasks[0].fixtures.toolResponses) delete r.isError;
    expect(suiteFeatures(validateEvalSuite(plain)).fixtureErrors).toBe(false);
  });
});

describe('RFC 0245 §B — the tool boundary', () => {
  const task = (): EvalTaskDef => validateEvalSuite(JSON.parse(JSON.stringify(FIXTURE))).tasks[0]!;
  it('an isError entry is served as a typed tool error, is not a miss, and never reaches the live tool', async () => {
    let live = 0;
    const ic = fixtureInterceptor({ ...task(), fixtures: { ...task().fixtures, onMiss: 'live' } }, { allowLive: true, agentId: 'a' });
    const exec = ic.wrap(async () => { live += 1; return { content: 'LIVE' }; });
    const first = await exec({ name: TOOL, input: { orderId: 'o-1' } });
    expect(first.isError).toBe(true);
    // The fixture's content carries no top-level `code`/`error`, so the live lane's
    // derivation yields exactly the generic code.
    expect(first.errorCode).toBe('tool_execution_failed');
    const second = await exec({ name: TOOL, input: { orderId: 'o-1' } });
    expect(second.isError).toBeFalsy();
    expect(second.content).toBe('{"status":"shipped"}');
    expect(ic.misses()).toBe(0);
    expect(live, 'a matched isError entry is never retried live, whatever onMiss says').toBe(0);
  });
});

describe('RFC 0245 §C — capability and refusal', () => {
  it('advertises agents.evalSuite.fixtureErrors from the one builder, and lists the fixture', async () => {
    expect(evalSuiteCapability().fixtureErrors).toBe(true);
    const doc = await send('GET', '/.well-known/openwop', {});
    // Where `agents` sits depends on the discovery shape: read both, as adr0889-eval-run does.
    const agents = ((doc.json['capabilities'] as Record<string, unknown> | undefined)?.['agents'] ?? doc.json['agents']) as Record<string, unknown> | undefined;
    const evalSuite = agents?.['evalSuite'] as Record<string, unknown> | undefined;
    expect(evalSuite, 'control: discovery carries agents.evalSuite').toBeTruthy();
    expect(evalSuite?.['fixtureErrors']).toBe(true);
    // Loaded from the VENDORED file at boot, so the loader accepted isError (a
    // suite that fails validation is skipped, never half-loaded).
    expect(listFixtureSuiteIds()).toContain(FIXTURE_ID);
    expect(JSON.stringify(doc.json)).toContain(`"${FIXTURE_ID}"`);
  });
  it('without the advert, run create refuses the suite naming the field (400 validation_error)', async () => {
    resetRfc0245WireCache(false);
    try {
      const r = await send('POST', '/runs', V2, { mode: 'eval', evalSuiteRef: `${CONFORMANCE_SUITE_PREFIX}${FIXTURE_ID}`, agentId: SCRIPTED_AGENT_ID });
      expect(r.status, r.text.slice(0, 300)).toBe(400);
      expect(r.text).toContain('validation_error');
      expect(r.text).toContain('tasks[0].fixtures.toolResponses[0].isError');
    } finally { resetRfc0245WireCache(); }
  });
});

describe('RFC 0245 — the replay leg, end to end (the conformance judge, host side)', () => {
  it('the isError call is recorded as an error with no outcome; the next call is not an error; no miss', async () => {
    const c = await send('POST', '/runs', V2, { mode: 'eval', evalSuiteRef: `${CONFORMANCE_SUITE_PREFIX}${FIXTURE_ID}`, agentId: SCRIPTED_AGENT_ID });
    expect(c.status, c.text.slice(0, 400)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');
    const evs = (await events(runId)).sort((a, b) => a.sequence - b.sequence);
    const mine = (e: Ev): boolean => e.payload['agentId'] === SCRIPTED_AGENT_ID && e.payload['toolName'] === TOOL;
    const called = evs.filter((e) => e.type === 'agent.tool-called' && mine(e));
    const returned = evs.filter((e) => e.type === 'agent.tool-returned' && mine(e));
    expect(called, JSON.stringify(evs.map((e) => e.type))).toHaveLength(2);
    expect(returned).toHaveLength(2);
    const by = (c: Ev): Record<string, unknown> | undefined => returned.find((r) => r.payload['callId'] === c.payload['callId'])?.payload;
    const first = by(called[0]!)!;
    const second = by(called[1]!)!;
    const err = first['error'] as Record<string, unknown> | undefined;
    expect(typeof err?.['code'] === 'string' && (err['code'] as string).length > 0, JSON.stringify(first)).toBe(true);
    expect(typeof err?.['message'] === 'string' && (err['message'] as string).length > 0).toBe(true);
    expect(first['outcome'], 'a served failure MUST NOT carry outcome').toBeUndefined();
    expect(first['status']).toBe('error');
    // §D — the payload is not echoed: the message is fixed, not the upstream text.
    expect(JSON.stringify(first)).not.toContain('upstream_down');
    expect(second['error'], JSON.stringify(second)).toBeUndefined();
    expect(second['status']).not.toBe('error');
    // ADR 0929 D2 rejected: no placeholder outcome is invented for the success.
    expect(second['outcome']).toBeUndefined();
    const s = await send('GET', `/runs/${runId}/eval-summary`, V2);
    const t = ((s.json['tasks'] as Array<Record<string, unknown>>) ?? []).find((x) => x['taskId'] === 'recovers');
    expect(t, s.text.slice(0, 300)).toBeTruthy();
    expect(t!['fixtureMissCount']).toBe(0);
  });
});

describe('RFC 0245 (optional) — run→suite promotion keeps a failure a failure', () => {
  it('an errored boundary row is promoted as an isError entry', () => {
    const task = buildTaskFromRun({ taskId: 't', input: {}, boundary: [
      { tool: TOOL, input: { orderId: 'o-1' }, result: '{"error":"upstream_down"}', isError: true },
      { tool: TOOL, input: { orderId: 'o-1' }, result: '{"status":"shipped"}', isError: false },
    ] });
    expect(task.fixtures?.toolResponses?.map((r) => r.isError === true)).toEqual([true, false]);
  });
});
