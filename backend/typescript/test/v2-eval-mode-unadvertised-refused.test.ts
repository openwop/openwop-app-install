/**
 * #4318 → ADR 0889 — `POST /runs { mode: "eval" }` follows the `agents.evalSuite`
 * ADVERT (spec/v2/core/runs.md §Refusals; suite leg
 * `v2-eval-mode-unadvertised-refused`).
 *
 * HISTORY: the create handler never read `mode`. A complete eval body (no
 * `workflowId`) answered `400 workflowId is required`, and the same body WITH a
 * `workflowId` answered `201` and started an ordinary run. #4318 added the
 * `422 capability_not_provided` refusal for an unadvertised host. Since ADR 0889
 * this host ADVERTISES and serves `mode: eval`, so that 422 branch is not
 * reachable here (the PREMISE case pins the advert). What this file pins now:
 * an eval body takes the EVAL branch (never an ordinary run), an unknown suite
 * is the eval branch's own 404 naming the ref, a missing ref is 400 naming the
 * field, and a refused eval create leaves no run behind.
 *
 * Every refusal has a CONTROL: the route has many ways to refuse, so the code,
 * the details and the unchanged run count pin WHICH refusal fired (a "workflow
 * not found" 404 would otherwise pass the eval 404).
 * Witnessed (grade-tests w63): skipping the eval branch → the two 404 cases and
 * the 400 case red; dropping the evalSuiteRef check → the 400 case red.
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

// ADR 0889 (2026-10-14): this host now SERVES `mode: eval` (RFC 0081 + RFC 0244), so
// the #4318 refusal no longer applies. What #4318 guarded still stands and is pinned
// here: the handler follows the advert, an eval body is never run as an ordinary
// workflow run, and a refused eval create leaves no run behind.
describe('#4318 → ADR 0889 — mode: eval follows the advert (major 2)', () => {
  it('PREMISE: the predicate the handler reads agrees with the v2 discovery document the suite reads', async () => {
    const doc = await send('GET', '/.well-known/openwop', { 'OpenWOP-Version': '2.0' });
    expect(doc.status, doc.text.slice(0, 200)).toBe(200);
    const agents = doc.json['agents'] as Record<string, unknown> | undefined;
    expect(agents, 'the agents family is advertised, so the facet check below is not vacuous').toBeTypeOf('object');
    const advertised = agents?.['evalSuite'] !== undefined && agents?.['evalSuite'] !== null;
    expect(advertised).toBe(true);
    expect(hostSatisfies('agents', ['evalSuite'])).toBe(advertised);
  });

  it('CONTROL: an ordinary create is accepted', async () => {
    const r = await send('POST', '/runs', V2, { workflowId: 'conformance-noop', inputs: {} });
    expect(r.status, r.text.slice(0, 200)).toBe(201);
  });

  it('an eval body naming an unknown suite is 404 and creates no run', async () => {
    const before = await runCount();
    const r = await send('POST', '/runs', V2, EVAL);
    expect(r.status, r.text.slice(0, 200)).toBe(404);
    expect(r.json['error']).toBe('not_found');
    // The eval branch's own 404 names the ref (URL-redacted by the error
    // envelope, so the origin prefix is what can be pinned).
    expect(String((r.json['details'] as Record<string, unknown> | undefined)?.['evalSuiteRef'])).toMatch(/^https:\/\/conformance\.openwop\./);
    expect(await runCount()).toBe(before);
  });

  it('an eval body that ALSO names a workflow takes the eval branch — never a 201 ordinary run', async () => {
    const before = await runCount();
    const r = await send('POST', '/runs', V2, { ...EVAL, workflowId: 'conformance-noop' });
    expect(r.status, r.text.slice(0, 200)).toBe(404);
    expect(r.json['error']).toBe('not_found');
    // The eval branch's own 404 names the ref (URL-redacted by the error
    // envelope, so the origin prefix is what can be pinned).
    expect(String((r.json['details'] as Record<string, unknown> | undefined)?.['evalSuiteRef'])).toMatch(/^https:\/\/conformance\.openwop\./);
    expect(await runCount()).toBe(before);
  });

  it('an eval body without evalSuiteRef is 400 naming the field', async () => {
    const r = await send('POST', '/runs', V2, { mode: 'eval', agentId: 'x' });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    expect((r.json['details'] as Record<string, unknown> | undefined)?.['field']).toBe('evalSuiteRef');
  });

  it('CONTROL: a body with no workflowId and no eval mode keeps its 400 (the refusal is tied to mode, not to the missing id)', async () => {
    const r = await send('POST', '/runs', V2, { inputs: {} });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    expect(r.json['message']).toBe('workflowId is required');
  });
});
