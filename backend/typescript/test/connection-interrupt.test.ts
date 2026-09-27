/**
 * ADR 0189 Phase 1 — connect-to-continue at the connector seam.
 *
 * Pins the three behavioral boundaries:
 *  1. an INTERACTIVE run (metadata.chatSessionId + acting human) suspends on
 *     connector_no_connection with the `openwop-connection` profile payload
 *     and the deterministic `conn:<nodeId>:<ref>` resume key;
 *  2. resolving with {action:'skip'} resumes the node into TODAY'S graceful
 *     no-connection outcome — terminal state byte-identical to headless;
 *  3. a HEADLESS run (no chatSessionId) never suspends: same terminal state,
 *     no node.suspended event, no open interrupts (ADR 0033 unchanged).
 *
 * Plus unit coverage of the fail-closed resume parser.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { parseConnectionResume } from '../src/host/connectionInterrupt.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const TENANT = '_anon';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }

async function pollStatus(runId: string): Promise<{ status: string; events: BundleEvent[] }> {
  let status = 'pending';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const snap = await jsonFetch<{ status: string }>(`/v1/runs/${runId}`);
    status = snap.body.status;
    if (['completed', 'failed', 'cancelled'].includes(status) || status.startsWith('waiting')) break;
  }
  const bundle = await jsonFetch<{ events?: BundleEvent[] }>(`/v1/runs/${runId}/debug-bundle`);
  return { status, events: bundle.body.events ?? [] };
}

const WF_NODES = [{
  nodeId: 'bq',
  typeId: 'core.bigquery.query',
  config: { projectId: 'p1', sql: 'SELECT 1', connectorId: 'bigquery' },
}];

async function startRun(workflowId: string, metadata?: Record<string, unknown>): Promise<string> {
  await jsonFetch('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: WF_NODES, edges: [] }) });
  const create = await jsonFetch<{ runId: string }>('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, inputs: {}, tenantId: TENANT, ...(metadata ? { metadata } : {}) }),
  });
  expect(create.status).toBe(201);
  return create.body.runId;
}

describe('connect-to-continue (ADR 0189 P1)', () => {
  it('an interactive run suspends with the openwop-connection profile + deterministic key, and skip resumes into the graceful no-op', async () => {
    const runId = await startRun('conn.int.skip', { chatSessionId: 'sess-1' });

    const sus = await pollStatus(runId);
    expect(sus.status.startsWith('waiting'), `should suspend, was ${sus.status}`).toBe(true);
    expect(sus.events.some((e) => e.type === 'node.suspended' && e.nodeId === 'bq')).toBe(true);

    const ints = await jsonFetch<{ interrupts: Array<{ token: string; nodeId: string; kind: string; data?: Record<string, unknown> }> }>(
      `/v1/host/openwop-app/runs/${runId}/interrupts`,
    );
    const it0 = ints.body.interrupts.find((i) => i.nodeId === 'bq');
    expect(it0, 'an open interrupt for the connector node').toBeTruthy();
    expect(it0?.data?.profile).toBe('openwop-connection');
    const connMeta = it0?.data?.connection as Record<string, unknown> | undefined;
    expect(connMeta?.ref).toBe('bigquery');
    // The deterministic resume key (replay short-circuit contract).
    expect(it0?.data?.__resumeKey ?? it0?.data?.key).toBe('conn:bq:bigquery');

    const resolve = await jsonFetch(`/v1/interrupts/${it0?.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'skip' } }) });
    expect([200, 202, 204]).toContain(resolve.status);

    const done = await pollStatus(runId);
    // Skip degrades to TODAY'S graceful no-connection outcome: the bigquery
    // node maps it to a node failure, so the run fails exactly as headless.
    expect(['failed', 'completed']).toContain(done.status);
    const bundle = JSON.stringify(done.events);
    expect(bundle).toContain('connector_no_connection');
  });

  it('a headless run never suspends — terminal state with no interrupt (ADR 0033 unchanged)', async () => {
    const runId = await startRun('conn.headless');
    const done = await pollStatus(runId);
    expect(done.status.startsWith('waiting'), `must NOT suspend, was ${done.status}`).toBe(false);
    expect(done.events.some((e) => e.type === 'node.suspended')).toBe(false);
    const ints = await jsonFetch<{ interrupts: unknown[] }>(`/v1/host/openwop-app/runs/${runId}/interrupts`);
    expect(ints.body.interrupts).toHaveLength(0);
    expect(JSON.stringify(done.events)).toContain('connector_no_connection');
  });

  it('interactive + headless reach the SAME terminal outcome after skip (byte-equal degradation)', async () => {
    const a = await startRun('conn.parity.a', { chatSessionId: 'sess-2' });
    const sus = await pollStatus(a);
    expect(sus.status.startsWith('waiting')).toBe(true);
    const ints = await jsonFetch<{ interrupts: Array<{ token: string }> }>(`/v1/host/openwop-app/runs/${a}/interrupts`);
    await jsonFetch(`/v1/interrupts/${ints.body.interrupts[0]?.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'skip' } }) });
    const doneA = await pollStatus(a);

    const b = await startRun('conn.parity.b');
    const doneB = await pollStatus(b);
    expect(doneA.status).toBe(doneB.status);
  });
});

describe('parseConnectionResume (fail closed)', () => {
  it('only an explicit connected action connects', () => {
    expect(parseConnectionResume({ action: 'connected' })).toEqual({ action: 'connected' });
    expect(parseConnectionResume({ action: 'connected', providerId: 'google' })).toEqual({ action: 'connected', providerId: 'google' });
  });
  it('everything else reads as skip', () => {
    expect(parseConnectionResume({ action: 'skip' }).action).toBe('skip');
    expect(parseConnectionResume(undefined).action).toBe('skip');
    expect(parseConnectionResume('connected').action).toBe('skip');
    expect(parseConnectionResume({ action: 'CONNECTED' }).action).toBe('skip');
    expect(parseConnectionResume({ providerId: 'x' }).action).toBe('skip');
  });
});

describe('connect-to-continue expiry → skip (lazy, CAS-claimed)', () => {
  it('an expired prompt auto-resumes as skip on the next open-interrupts read, exactly once', async () => {
    // Shrink the prompt deadline so it expires within the test window. Read
    // per-suspend (connectionPromptTimeoutMs), so setting it here is enough.
    const prev = process.env.OPENWOP_CONNECTION_PROMPT_TIMEOUT_SEC;
    process.env.OPENWOP_CONNECTION_PROMPT_TIMEOUT_SEC = '1';
    try {
      const runId = await startRun('conn.expiry', { chatSessionId: 'sess-exp' });
      const sus = await pollStatus(runId);
      expect(sus.status.startsWith('waiting'), `should suspend, was ${sus.status}`).toBe(true);

      // Wait past the 1s deadline, then hit the open-interrupts read (the chat's
      // poll) — the lazy path claims + resumes-as-skip.
      await new Promise((r) => setTimeout(r, 1300));
      const first = await jsonFetch<{ interrupts: unknown[] }>(`/v1/host/openwop-app/runs/${runId}/interrupts`);
      expect(first.body.interrupts, 'expired prompt drops out of the open listing').toHaveLength(0);

      // A second concurrent-style read must not double-resume; the run settles
      // to the graceful no-connection terminal, same as skip/headless.
      await jsonFetch(`/v1/host/openwop-app/runs/${runId}/interrupts`);
      const done = await pollStatus(runId);
      expect(done.status.startsWith('waiting')).toBe(false);
      const resolved = done.events.filter((e) => e.type === 'interrupt.resolved' && e.nodeId === 'bq');
      expect(resolved.length, 'resolved exactly once (CAS claim)').toBeLessThanOrEqual(1);
      expect(JSON.stringify(done.events)).toContain('connector_no_connection');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_CONNECTION_PROMPT_TIMEOUT_SEC;
      else process.env.OPENWOP_CONNECTION_PROMPT_TIMEOUT_SEC = prev;
    }
  });
});
