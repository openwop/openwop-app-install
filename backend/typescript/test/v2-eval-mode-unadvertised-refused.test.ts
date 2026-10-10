/**
 * #4318 — `POST /runs { mode: "eval" }` on a host that does not advertise
 * `agents.evalSuite` is `422 capability_not_provided` (spec/v2/core/runs.md
 * §Refusals; suite leg `v2-eval-mode-unadvertised-refused`).
 *
 * The defect: the create handler never read `mode`. A complete eval body
 * (`evalSuiteRef` + `agentId`, no `workflowId` — which v2 does not require under
 * `mode: eval`) fell into the `workflowId is required` guard and answered
 * `400 invalid_request`; the same body WITH a `workflowId` answered `201` and
 * started an ordinary run — a yes to a request this host cannot honour.
 *
 * Every refusal has a CONTROL: the route has many ways to refuse, so the code,
 * the named capability and the unchanged run count pin WHICH refusal fired.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';
import { hostSatisfies } from '../src/bootstrap/agentPackResolver.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a non-JSON body fails the assertions below */ }
  return { status: res.status, json, text };
}
async function runCount(): Promise<number> {
  const r = await send('GET', '/runs?limit=100', V2);
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  expect(Array.isArray(r.json['runs'])).toBe(true);
  return (r.json['runs'] as unknown[]).length;
}

const EVAL = { mode: 'eval', evalSuiteRef: 'https://conformance.openwop.dev/eval-suites/unadvertised-probe', agentId: 'conformance-eval-unadvertised-probe' };

describe('#4318 — mode: eval on a host that does not advertise agents.evalSuite (major 2)', () => {
  it('PREMISE: the predicate the handler reads agrees with the v2 discovery document the suite reads', async () => {
    // The suite decides applicability from `/.well-known/openwop` `agents.evalSuite`;
    // the handler decides from `hostSatisfies`. If the two ever disagree the host
    // refuses what it advertises, or serves what it does not.
    const doc = await send('GET', '/.well-known/openwop', { 'OpenWOP-Version': '2.0' });
    expect(doc.status, doc.text.slice(0, 200)).toBe(200);
    const agents = doc.json['agents'] as Record<string, unknown> | undefined;
    expect(agents, 'the agents family is advertised, so the facet check below is not vacuous').toBeTypeOf('object');
    const advertised = agents?.['evalSuite'] !== undefined && agents?.['evalSuite'] !== null;
    expect(advertised).toBe(false);
    expect(hostSatisfies('agents', ['evalSuite'])).toBe(advertised);
  });

  it('CONTROL: an ordinary create is accepted', async () => {
    const r = await send('POST', '/runs', V2, { workflowId: 'conformance-noop', inputs: {} });
    expect(r.status, r.text.slice(0, 200)).toBe(201);
  });

  it('a complete eval body is 422 capability_not_provided and creates no run', async () => {
    const before = await runCount();
    const r = await send('POST', '/runs', V2, EVAL);
    expect(r.status, r.text.slice(0, 200)).toBe(422);
    expect(r.json['error']).toBe('capability_not_provided');
    expect((r.json['details'] as Record<string, unknown> | undefined)?.['capability']).toBe('agents.evalSuite');
    expect(await runCount()).toBe(before);
  });

  it('an eval body that ALSO names a workflow is refused the same way — never a 201 ordinary run', async () => {
    const before = await runCount();
    const r = await send('POST', '/runs', V2, { ...EVAL, workflowId: 'conformance-noop' });
    expect(r.status, r.text.slice(0, 200)).toBe(422);
    expect(r.json['error']).toBe('capability_not_provided');
    expect(await runCount()).toBe(before);
  });

  it('CONTROL: a body with no workflowId and no eval mode keeps its 400 (the refusal is tied to mode, not to the missing id)', async () => {
    const r = await send('POST', '/runs', V2, { inputs: {} });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
  });
});
