/**
 * ADR 0555 P1 — end to end: a REAL pack, through the REAL loader, run by the
 * REAL executor, over the isolated-worker contract.
 *
 * Everything else in this phase is unit-level. This file is the one that can
 * fail if the seam is wired wrong, because nothing here is constructed: the
 * pack is bytes on disk with an install marker, `tarballLoader` imports it and
 * stamps the origin, the executor decides placement, the fake adapter
 * `structuredClone`s every message, the broker projects the live ctx, and the
 * run's own event log is where a brokered `ctx.emit` has to land.
 *
 * Each behaviour is asserted TWICE — isolated and in-process — because the
 * claim is parity, and a suite that only ever ran one placement could not tell
 * "the contract preserves the behaviour" from "the behaviour is trivial".
 *
 * The one deliberate DIFFERENCE is asserted too: `trustBoundary` is widened to
 * `'untrusted'` under isolation and inherited from the run in-process.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/index.js';
import { loadPackFromManifest } from '../src/packs/tarballLoader.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { snapshotRunVariables } from '../src/host/variablesRuntime.js';
import { __resetPackTrustCachesForTests } from '../src/host/packTrust.js';

const PACK_NAME = 'community.test.isoe2e';
const ECHO = `${PACK_NAME}.echo`;
const BOOM = `${PACK_NAME}.boom`;
const PAUSE = `${PACK_NAME}.pause`;

let server: http.Server;
let BASE: string;
let packRoot: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

interface RunEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function settle(runId: string): Promise<string> {
  let status = 'pending';
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 25));
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (status.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  return status;
}

async function events(runId: string): Promise<RunEvent[]> {
  return (await api<{ events?: RunEvent[] }>(`/v1/runs/${runId}/debug-bundle`)).body.events ?? [];
}

/** Register a one-node workflow, run it, and wait for it to settle. */
async function runNode(workflowId: string, typeId: string, inputs: Record<string, unknown> = {}) {
  await api('/v1/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n1', typeId }], edges: [] }),
  });
  const create = await api<{ runId: string }>('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, inputs, tenantId: '_anon' }),
  });
  expect(create.status).toBe(201);
  const status = await settle(create.body.runId);
  return { runId: create.body.runId, status };
}

/** Run `fn` with the isolation mode forced, restoring whatever was there. */
async function withIsolation<T>(mode: 'fake' | 'off', fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENWOP_PACK_ISOLATION;
  if (mode === 'fake') process.env.OPENWOP_PACK_ISOLATION = 'fake';
  else delete process.env.OPENWOP_PACK_ISOLATION;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OPENWOP_PACK_ISOLATION;
    else process.env.OPENWOP_PACK_ISOLATION = prev;
  }
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_PACK_ISOLATION;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  // A REAL pack on disk, marked the way `registryInstaller` marks one, so
  // `classifyPackDir` returns `operator-trusted` and the loader imports it.
  packRoot = mkdtempSync(join(tmpdir(), 'owp-iso-e2e-'));
  const dir = join(packRoot, 'pack');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({
      name: PACK_NAME,
      version: '1.0.0',
      nodes: [ECHO, BOOM, PAUSE].map((typeId) => ({ typeId, version: '1.0.0' })),
      runtime: { format: 'esm', entry: './index.mjs' },
    }),
  );
  writeFileSync(
    join(dir, 'index.mjs'),
    [
      'export const nodes = {',
      `  ${JSON.stringify(ECHO)}: async (ctx) => {`,
      // A brokered host-call that must land in the REAL run event log.
      "    await ctx.emit('isolation.probe', { from: 'pack', hasSecrets: 'secrets' in ctx });",
      "    ctx.variables.set('iso_marker', 'set-by-pack');",
      '    return { status: \'success\', outputs: { tenant: ctx.tenantId, trust: ctx.trustBoundary, marker: ctx.variables.get(\'iso_marker\') } };',
      '  },',
      `  ${JSON.stringify(BOOM)}: async (ctx) => {`,
      // The trust marker rides the message so this test can tell WHICH
      // placement produced the failure — otherwise the parity assertion would
      // hold no matter where the node ran, and could not fail if the executor
      // stopped isolating.
      "    const err = new Error('denied by policy on ' + ctx.trustBoundary);",
      "    err.code = 'policy_denied';",
      '    throw err;',
      '  },',
      `  ${JSON.stringify(PAUSE)}: async (ctx) => {`,
      "    const answer = await ctx.suspend({ reason: 'approval', resumeKey: 'gate', prompt: 'ok?' });",
      '    return { status: \'success\', outputs: { answer, trust: ctx.trustBoundary } };',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  const hash = (f: string) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  writeFileSync(
    join(dir, '.openwop-installed.json'),
    JSON.stringify({
      name: PACK_NAME, version: '1.0.0', integrity: 'sha256-fixture', publicKeyRef: 'fixture',
      registry: 'https://packs.example.test', installedAt: new Date(0).toISOString(),
      contentHashes: { 'pack.json': hash('pack.json'), 'index.mjs': hash('index.mjs') },
    }),
  );
  __resetPackTrustCachesForTests();
  await loadPackFromManifest(dir);
}, 60_000);

afterAll(async () => {
  delete process.env.OPENWOP_PACK_ISOLATION;
  await new Promise<void>((res) => server.close(() => res()));
  rmSync(packRoot, { recursive: true, force: true });
});

describe('the fixture is a real, isolation-eligible pack', () => {
  it('registered through the real loader with a packOrigin the policy can read', async () => {
    const module = await getNodeRegistry().resolve(ECHO);
    expect(module?.packOrigin?.tier).toBe('operator-trusted');
    expect(module?.packOrigin?.isolation.eligible).toBe(true);
    // If this were a refusal stub or a hand-registered module, every assertion
    // below would be testing something other than the contract.
    expect(module?.packOrigin?.entryUrl).toContain('index.mjs');
  });
});

describe('success, both placements', () => {
  it('ISOLATED: the run completes, the brokered emit lands in the run event log, the variable write is applied', async () => {
    const { runId, status } = await withIsolation('fake', () => runNode('iso.e2e.echo.isolated', ECHO));
    expect(status).toBe('completed');

    const log = await events(runId);
    const probe = log.find((e) => e.type === 'isolation.probe');
    // The emit went worker → broker → the real `eventLog.append`. A projection
    // that faked it would not appear here.
    expect(probe).toBeDefined();
    expect(probe?.payload?.from).toBe('pack');
    // `secrets` never crossed into the worker.
    expect(probe?.payload?.hasSecrets).toBe(false);

    const completed = log.find((e) => e.type === 'node.completed');
    const outputs = completed?.payload?.outputs as Record<string, unknown> | undefined;
    expect(outputs?.tenant).toBe('_anon');
    // The deliberate widening: isolated code always sees `untrusted` inputs.
    expect(outputs?.trust).toBe('untrusted');
    // `variables.get` saw the pack's own `set` synchronously inside the worker…
    expect(outputs?.marker).toBe('set-by-pack');
    // …and the write-behind was applied host-side on the result CAS.
    expect(snapshotRunVariables(runId)?.iso_marker).toBe('set-by-pack');
  }, 30_000);

  it('IN-PROCESS: identical behaviour, except `trustBoundary` is the run\'s own', async () => {
    const { runId, status } = await withIsolation('off', () => runNode('iso.e2e.echo.inprocess', ECHO));
    expect(status).toBe('completed');
    const log = await events(runId);
    expect(log.find((e) => e.type === 'isolation.probe')?.payload?.from).toBe('pack');
    const outputs = log.find((e) => e.type === 'node.completed')?.payload?.outputs as Record<string, unknown> | undefined;
    expect(outputs?.tenant).toBe('_anon');
    expect(outputs?.trust).toBe('trusted');
    expect(snapshotRunVariables(runId)?.iso_marker).toBe('set-by-pack');
  }, 30_000);
});

describe('failure codes, both placements', () => {
  it('ISOLATED: a pack error code reaches the run event log as itself', async () => {
    const { runId, status } = await withIsolation('fake', () => runNode('iso.e2e.boom.isolated', BOOM));
    expect(status).toBe('failed');
    const failed = (await events(runId)).find((e) => e.type === 'node.failed');
    expect((failed?.payload?.error as { code?: string } | undefined)?.code).toBe('policy_denied');
    // …and it came from the ISOLATED placement, not a silent in-process fallback.
    expect((failed?.payload?.error as { message?: string } | undefined)?.message).toBe('denied by policy on untrusted');
  }, 30_000);

  it('IN-PROCESS: the same code, from the same pack', async () => {
    const { runId, status } = await withIsolation('off', () => runNode('iso.e2e.boom.inprocess', BOOM));
    expect(status).toBe('failed');
    const failed = (await events(runId)).find((e) => e.type === 'node.failed');
    expect((failed?.payload?.error as { code?: string } | undefined)?.code).toBe('policy_denied');
    expect((failed?.payload?.error as { message?: string } | undefined)?.message).toBe('denied by policy on trusted');
  }, 30_000);
});

describe('suspend/resume, both placements', () => {
  async function suspendAndResume(workflowId: string) {
    const { runId, status } = await runNode(workflowId, PAUSE);
    // A `suspended` RESULT ARM, not an error: the run PAUSES rather than fails.
    expect(status.startsWith('waiting'), `expected a waiting-* status, got '${status}'`).toBe(true);

    const resolve = await api(`/v1/runs/${runId}/interrupts/n1`, {
      method: 'POST',
      body: JSON.stringify({ resumeValue: { approved: true } }),
    });
    expect(resolve.status).toBeLessThan(300);
    const finalStatus = await settle(runId);
    return { runId, finalStatus };
  }

  it('ISOLATED: the run pauses, and resuming re-invokes with the resolution short-circuited inline', async () => {
    const { runId, finalStatus } = await withIsolation('fake', () => suspendAndResume('iso.e2e.pause.isolated'));
    expect(finalStatus).toBe('completed');
    const outputs = (await events(runId)).find((e) => e.type === 'node.completed')?.payload?.outputs as Record<string, unknown> | undefined;
    expect(outputs?.answer).toEqual({ approved: true });
    expect(outputs?.trust).toBe('untrusted');
  }, 40_000);

  it('IN-PROCESS: the same pause and the same resumed answer', async () => {
    const { runId, finalStatus } = await withIsolation('off', () => suspendAndResume('iso.e2e.pause.inprocess'));
    expect(finalStatus).toBe('completed');
    const outputs = (await events(runId)).find((e) => e.type === 'node.completed')?.payload?.outputs as Record<string, unknown> | undefined;
    expect(outputs?.answer).toEqual({ approved: true });
    expect(outputs?.trust).toBe('trusted');
  }, 40_000);
});
