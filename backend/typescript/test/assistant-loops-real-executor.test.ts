/**
 * ADR 0862 D6 (`WF-COS-7`, `PROBE-COS-2`) — the morning briefing loop through the REAL
 * executor, then a replay `:fork` of it.
 *
 * Every earlier briefing test was structural: it read the registered definition and
 * checked `notify:true` and the node's manifest role. Nothing ever RAN the loop, so the
 * claim "a fork does not re-brief the principal" rested on a table lookup
 * (`compose-briefing` is `role:"side-effect"` and in `SIDE_EFFECTING_TYPE_PATTERNS`).
 * This runs the chain-backed `assistant.loop.morning-briefing` by its original id through
 * `POST /runs` (the real scheduler + `executeRun` + the real `ctx.features.assistant`
 * surface), forks the completed run in replay mode from the start, and counts the
 * `assistant.briefing` EMITS: exactly ONE. A fork that re-executed the node would emit a
 * second (sabotage-witnessed: drop both classification legs and this goes red;
 * /grade-tests w11 re-witnessed it by forcing `isSideEffectingNode` false for
 * compose-briefing, and by dropping the surface's `notify` emit).
 *
 * Honest ceiling: `settle` polls the run row — the executor exposes no terminal hook
 * this test can await.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The notification store coalesces a repeat of the same unread notice ("stop re-alerting
// every tick"), so a row COUNT cannot see a second emit — a fork that re-briefed would
// still read as one row. Count the EMITS instead, at the one emitter seam.
const emits = vi.hoisted(() => ({ briefing: 0 }));
vi.mock('../src/notifications/emitter.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/notifications/emitter.js')>();
  return {
    ...orig,
    getNotificationEmitter: () => {
      const real = orig.getNotificationEmitter();
      return {
        ...real,
        emit: async (n: Parameters<typeof real.emit>[0]) => {
          if ((n as { type?: string }).type === 'assistant.briefing') emits.briefing += 1;
          return real.emit(n);
        },
      };
    },
  };
});
import { createApp } from '../src/index.js';
import { fromWireRunId } from '../src/host/v2Ids.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const TOKEN = 'dev-token';
let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await __clearToggleStore();
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'OpenWOP-Version': '2' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
async function settle(runId: string): Promise<RunRecord | null> {
  let run: RunRecord | null = null;
  await vi.waitFor(async () => {
    run = await storage.getRun(runId);
    if (!run || !TERMINAL.has(run.status)) throw new Error(`run ${runId} not terminal yet`);
  }, { timeout: 10_000, interval: 25 });
  return run;
}

async function briefNodeOutputs(runId: string): Promise<unknown> {
  const ev = await storage.listEvents(runId);
  const payload = ev.find((e) => e.type === 'node.completed' && String(e.nodeId ?? '').endsWith('_brief'))?.payload;
  return payload && typeof payload === 'object' && 'outputs' in payload ? payload.outputs : undefined;
}

describe('assistant.loop.morning-briefing — REAL executor + replay fork', () => {
  it('runs to completion and notifies once; a replay fork from the start does NOT notify again', async () => {
    const before = emits.briefing;
    const start = await post('/runs', { workflowId: 'assistant.loop.morning-briefing', inputs: {} });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const wireRunId = start.body.runId as string;
    const decoded = fromWireRunId(wireRunId, 'default');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('start returned a foreign run id');
    const runId = decoded.runId;
    const run = await settle(runId);
    expect(run?.status, `run did not complete: ${JSON.stringify(run)}`).toBe('completed');
    expect(emits.briefing, 'the loop\'s only product is the notification').toBe(before + 1);

    const fork = await post(`/runs/${encodeURIComponent(wireRunId)}:fork`, { fromSeq: 0, mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkDecoded = fromWireRunId(fork.body.runId as string, 'default');
    expect(forkDecoded.ok).toBe(true);
    if (!forkDecoded.ok) throw new Error('fork returned a foreign run id');
    const forkRunId = forkDecoded.runId;
    const forked = await settle(forkRunId);
    expect(forked?.status, `fork did not complete: ${JSON.stringify(forked)}`).toBe('completed');
    expect(emits.briefing, 'a replay fork re-briefed the principal').toBe(before + 1);
    // …and the fork's brief IS the source's recorded brief (served, not recomposed: a
    // recomposed brief carries a fresh `generatedAt`). Assert the source side is REAL
    // first — two `undefined`s (no matching event) would otherwise compare equal.
    const sourceBrief = await briefNodeOutputs(runId);
    expect(sourceBrief, 'the source run must record the brief node\'s output').toMatchObject({ brief: { generatedAt: expect.any(String) } });
    expect(await briefNodeOutputs(forkRunId)).toEqual(sourceBrief);
  });
});
