/**
 * ADR 0744 — A2A ErrorInfo on the 1.0 interface and three v2 outcomes.
 *
 *   1. A card-listed A2A 1.0 interface URL never answers with this host's
 *      `{ error, message, details? }` envelope — a pre-dispatch refusal (auth,
 *      malformed body) is re-rendered as a JSON-RPC error on the same status.
 *      A header-less (0.3) request and a disabled interface are untouched.
 *   2. Under major 2 a run-scoped resolve against a terminal run is
 *      `409 interrupt_already_resolved` (v2 `errors.md` §One code per state),
 *      not the unregistered `interrupt_gone` 410. Major 1 keeps its 410.
 *   3. The bundle-v3 verifiers order rows by UTF-16 code unit and put
 *      `host.relaxations[]` in the witness preimage when non-empty — the suite's
 *      `certification-bundle-v3.ts` rule — in BOTH copies.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import { canonicalJSON as tsCanonicalJSON, witnessDigest as tsWitnessDigest } from '../src/host/certificationEvidence.js';
import { toA2aJsonRpcRefusal } from '../src/middleware/a2aInterfaceErrors.js';
// @ts-expect-error — plain ESM deploy-side twin, no type declarations.
import { witnessDigest as mjsWitnessDigest } from '../../../scripts/lib/bundle-v3-verify.mjs';

let app: Express;
let server: http.Server;
let BASE = '';
let storage: Storage;
const TOKEN = 'dev-token';
const A2A_PATH = '/v1/host/openwop-app/a2a';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
});

async function rawPost(path: string, body: string, headers: Record<string, string>): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}

describe('ADR 0744 §1 — no OpenWOP envelope on the A2A 1.0 interface URL', () => {
  it('an unauthenticated 1.0 request gets a JSON-RPC error on the 401, not the host envelope', async () => {
    const res = await rawPost(A2A_PATH, JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'GetTask', params: { id: 'x' } }), {
      'a2a-version': '1.0',
    });
    expect(res.status).toBe(401);
    expect(res.body['jsonrpc']).toBe('2.0');
    expect(res.body['id']).toBe(11);
    expect(typeof res.body['error']).toBe('object');
    const error = res.body['error'] as { code?: number; data?: Array<Record<string, unknown>> };
    expect(error.code).toBe(-32000);
    expect(error.data).toEqual([
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'UNAUTHENTICATED', domain: 'openwop.dev' },
    ]);
  });

  it('a malformed 1.0 body is JSON-RPC -32700 Parse error', async () => {
    const res = await rawPost(A2A_PATH, '{ not json', { 'a2a-version': '1.0', authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
    const error = res.body['error'] as { code?: number; data?: Array<Record<string, unknown>> };
    expect(res.body['jsonrpc']).toBe('2.0');
    expect(res.body['id']).toBeNull();
    expect(error.code).toBe(-32700);
    expect(error.data?.[0]?.['reason']).toBe('PARSE_ERROR');
  });

  it('a header-less (0.3) request keeps the host envelope byte-for-byte — the 0.3 codec is untouched', async () => {
    const res = await rawPost(A2A_PATH, JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tasks/get', params: {} }), {});
    expect(res.status).toBe(401);
    expect(typeof res.body['error']).toBe('string');
    expect(res.body['jsonrpc']).toBeUndefined();
  });

  it('a JSON-RPC body from the handler passes through unchanged', async () => {
    const res = await rawPost(A2A_PATH, JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'GetTask', params: { id: 'run_nope' } }), {
      'a2a-version': '1.0',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
    const error = res.body['error'] as { code?: number; data?: Array<Record<string, unknown>> };
    expect(error.code).toBe(-32001);
    expect(error.data?.[0]?.['domain']).toBe('a2a-protocol.org');
  });

  it('the renderer keeps 5xx as JSON-RPC -32603 and leaves the id null when the caller sent none', () => {
    expect(toA2aJsonRpcRefusal(503, { error: 'runner_unavailable', message: 'busy' }, undefined)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        message: 'busy',
        data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'UNAVAILABLE', domain: 'openwop.dev' }],
      },
    });
  });
});

let seq = 0;
async function seedSuspendedRun(status: RunRecord['status']): Promise<{ run: RunRecord; interrupt: InterruptRecord }> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-adr0744-${++seq}-${Math.random().toString(36).slice(2)}`,
    workflowId: 'wf-adr0744',
    tenantId: 'demo',
    status,
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  const interrupt: InterruptRecord = {
    interruptId: `int-adr0744-${seq}`,
    runId: run.runId,
    nodeId: 'gate',
    kind: 'clarification',
    token: `tok-adr0744-${seq}-${Math.random().toString(36).slice(2)}`,
    data: { prompt: 'go?' },
    createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await storage.insertInterrupt(interrupt);
  return { run, interrupt };
}

describe('ADR 0744 §2 — run-scoped resolve on a terminal run', () => {
  it.each(['cancelled', 'completed', 'failed'] as const)(
    'under major 2 a %s run answers 409 interrupt_already_resolved, never a vendor-prefixed 410',
    async (status) => {
      const { run } = await seedSuspendedRun(status);
      const res = await rawPost(
        `/runs/${encodeURIComponent(run.runId)}/interrupts/gate`,
        JSON.stringify({ resumeValue: { answer: 'too-late' } }),
        { authorization: `Bearer ${TOKEN}`, 'openwop-version': '2' },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body['error']).toBe('interrupt_already_resolved');
      expect(res.body['error']).not.toMatch(/interrupt_gone/);
    },
  );

  // RFC 0213 §C, the REALISTIC path. The legs above seed an UNRESOLVED interrupt
  // on a terminal run — a state this host never produces — so they stayed green
  // while the real second resolve answered 404: `getInterruptByNode` returns open
  // interrupts only, and the handler 404'd before the terminal check. This leg
  // drives the real transitions (resolve through storage, then the run ends) and
  // is what `v2-interrupt-resolve-terminal` leg 2 asserts.
  it.each(['completed', 'cancelled'] as const)(
    'under major 2 a second resolve after the interrupt was resolved and the run %s answers 409, not 404',
    async (status) => {
      const { run, interrupt } = await seedSuspendedRun('waiting-input');
      expect(await storage.resolveInterrupt(interrupt.interruptId, { answer: 'yes' }, new Date().toISOString())).toBe(true);
      await storage.updateRun(run.runId, { status });
      expect(await storage.getInterruptByNode(run.runId, 'gate'), 'precondition: no OPEN interrupt remains').toBeFalsy();
      const res = await rawPost(
        `/runs/${encodeURIComponent(run.runId)}/interrupts/gate`,
        JSON.stringify({ resumeValue: { answer: 'again' } }),
        { authorization: `Bearer ${TOKEN}`, 'openwop-version': '2' },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body['error']).toBe('interrupt_already_resolved');
    },
  );

  it('under major 2 a resolve on a LIVE run with no open interrupt is still 404', async () => {
    const { run, interrupt } = await seedSuspendedRun('waiting-input');
    await storage.resolveInterrupt(interrupt.interruptId, { answer: 'yes' }, new Date().toISOString());
    await storage.updateRun(run.runId, { status: 'running' });
    const res = await rawPost(
      `/runs/${encodeURIComponent(run.runId)}/interrupts/gate`,
      JSON.stringify({ resumeValue: { answer: 'again' } }),
      { authorization: `Bearer ${TOKEN}`, 'openwop-version': '2' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it('major 1 keeps the 410 interrupt_gone it always answered on a cancelled run', async () => {
    const { run } = await seedSuspendedRun('cancelled');
    const res = await rawPost(
      `/v1/runs/${encodeURIComponent(run.runId)}/interrupts/gate`,
      JSON.stringify({ resumeValue: { answer: 'too-late' } }),
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(410);
    expect(res.body['error']).toBe('interrupt_gone');
  });
});

describe('ADR 0744 §3 — witness digest: code-unit order + relaxations, in both verifier copies', () => {
  const rows = [
    // `ch` sorts AFTER `h` under Czech collation and before it by code unit;
    // `_` and uppercase are where 'en' collation and code units disagree.
    { id: 'openwop.it.x.h-row', scenario: 's', result: 'executed-pass' as const, assertions: 1 },
    { id: 'openwop.it.x.ch-row', scenario: 's', result: 'executed-pass' as const, assertions: 1 },
    { id: 'openwop.it.x.Z_row', scenario: 's', result: 'skipped' as const },
    { id: 'openwop.it.x.a-row', scenario: 's', result: 'inapplicable' as const },
  ];
  const codeUnitSorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const expected = (preimage: unknown): string => createHash('sha256').update(tsCanonicalJSON(preimage), 'utf8').digest('hex');

  it('orders by UTF-16 code unit, not by a collation (TS and ESM copies agree)', () => {
    const want = expected(codeUnitSorted);
    expect(tsWitnessDigest(rows)).toBe(want);
    expect(mjsWitnessDigest(rows)).toBe(want);
    // Sabotage witness: an 'en' collation order is a DIFFERENT digest for these
    // ids, so the assertion above can fail.
    const enSorted = [...rows].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    expect(expected(enSorted)).not.toBe(want);
  });

  it('puts non-empty relaxations in the preimage and leaves an empty list out', () => {
    const relaxations = [{ id: 'openwop.relaxation.sandbox', reason: 'dev box' }];
    const want = expected({ rows: codeUnitSorted, relaxations });
    expect(tsWitnessDigest(rows, relaxations)).toBe(want);
    expect(mjsWitnessDigest(rows, relaxations)).toBe(want);
    expect(tsWitnessDigest(rows, [])).toBe(expected(codeUnitSorted));
    expect(mjsWitnessDigest(rows, [])).toBe(expected(codeUnitSorted));
  });
});
