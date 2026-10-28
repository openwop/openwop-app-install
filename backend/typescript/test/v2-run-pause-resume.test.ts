/**
 * ADR 0632 — `runs.md` §Pause and resume, at the route level, against the
 * `conformance-cancellable` fixture (one `core.delay` node, caller-set `delayMs`).
 *
 * Legs are disjoint by mechanism: pause-on-terminal (409 run_terminal) is the
 * route's state check; `immediate` is the abort path; a second pause is the
 * request check; resume of a non-paused run is the resume state check; drain
 * is the scheduler's dispatch-point check (the in-flight node FINISHES first
 * and `run.paused` follows `node.completed` in the log); resume re-enters
 * through `executeRun` and the run reaches `completed`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server; let base = '';
/** Test lever: delay the executor's `status: 'paused'` write, the way production
 *  latency does, so the pause race is REPRODUCIBLE (in-process it never shows). */
let pausedWriteDelayMs = 0;
/** Same lever for the `run.resumed` append: prod latency made the `:resume` 202
 *  land before it (the certification floor row read the log and missed it). */
let resumedAppendDelayMs = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const storage = app.locals.storage as { updateRun: (id: string, patch: { status?: string }) => Promise<unknown> };
  const realUpdate = storage.updateRun.bind(storage);
  storage.updateRun = async (id, patch) => {
    if (patch?.status === 'paused' && pausedWriteDelayMs > 0) await new Promise((r) => setTimeout(r, pausedWriteDelayMs));
    return realUpdate(id, patch);
  };
  const events = app.locals.storage as { appendEvent: (e: { type?: string }) => Promise<unknown> };
  const realAppend = events.appendEvent.bind(events);
  events.appendEvent = async (e) => {
    if (e?.type === 'run.resumed' && resumedAppendDelayMs > 0) await new Promise((r) => setTimeout(r, resumedAppendDelayMs));
    return realAppend(e);
  };
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
const V2 = { 'OpenWOP-Version': '2' };
interface Snapshot { runId?: string; status?: string; metadata?: Record<string, unknown> }
interface RunEvent { type: string; sequence: number; payload?: { reason?: string; drainPolicy?: string; interruptedNodeId?: string; nodeId?: string; error?: { message?: string } } }
interface EntryError { error?: string; message?: string; code?: string; details?: Record<string, unknown> }
interface Body extends Snapshot {
  error?: string; message?: string; details?: { runStatus?: string; pausedAt?: string; field?: string };
  events?: RunEvent[];
  results?: Array<{ runId?: string; ok?: boolean; status?: string; error?: EntryError }>;
}
async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = V2): Promise<{ status: number; json: Body | undefined; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json: Body | undefined; try { json = JSON.parse(text) as Body; } catch { json = undefined; }
  return { status: res.status, json, text };
}
const enc = (id: string) => encodeURIComponent(id);
async function create(workflowId: string, inputs: Record<string, unknown> = {}): Promise<string> {
  const r = await req('POST', '/runs', { workflowId, inputs });
  expect(r.status, r.text.slice(0, 160)).toBe(201);
  return String(r.json?.runId);
}
async function snapshot(id: string): Promise<Snapshot> { return (await req('GET', `/runs/${enc(id)}`)).json ?? {}; }
async function waitFor(id: string, pred: (s: Snapshot) => boolean, ms = 6000): Promise<Snapshot> {
  const until = Date.now() + ms; let s = await snapshot(id);
  while (!pred(s) && Date.now() < until) { await new Promise((r) => setTimeout(r, 60)); s = await snapshot(id); }
  return s;
}
async function events(id: string): Promise<RunEvent[]> {
  return (await req('GET', `/runs/${enc(id)}/events/poll?afterSequence=0&limit=200`)).json?.events ?? [];
}
/** Leftover delay runs are cancelled so no 20 s node outlives its case. */
async function cancel(id: string): Promise<void> { await req('POST', `/runs/${enc(id)}:cancel`, {}); }

describe('pause', () => {
  it('a terminal run → 409 run_terminal', async () => {
    const id = await create('conformance-noop');
    await waitFor(id, (s) => ['completed', 'failed'].includes(String(s.status)));
    const r = await req('POST', `/runs/${enc(id)}:pause`, {});
    expect(r.status, r.text.slice(0, 160)).toBe(409);
    expect(r.json?.error).toBe('run_terminal');
  });
  it('immediate: 202 {status: paused}; the in-flight delay node is aborted; run.paused carries the registry drainPolicy', async () => {
    const id = await create('conformance-cancellable', { delayMs: 20000 });
    await waitFor(id, (s) => s.status === 'running', 3000);
    const r = await req('POST', `/runs/${enc(id)}:pause`, { reason: 'operator', drainPolicy: 'immediate' });
    expect(r.status, r.text.slice(0, 200)).toBe(202);
    expect(r.json?.runId).toBe(id); expect(r.json?.status).toBe('paused');
    const s = await waitFor(id, (x) => x.status === 'paused', 4000);
    expect(s.status).toBe('paused');
    const paused = (await events(id)).find((e) => e.type === 'run.paused');
    expect(paused?.payload?.reason).toBe('operator');
    // rc.52 ruling (bus `b787`): the payload echoes the REQUEST word, and names the cut attempt.
    expect(paused?.payload?.drainPolicy).toBe('immediate');
    const startedNode = (await events(id)).find((e) => e.type === 'node.started')?.payload?.nodeId;
    expect(typeof paused?.payload?.interruptedNodeId).toBe('string');
    expect(paused?.payload?.interruptedNodeId).toBe(startedNode);
    // The interrupted attempt is NOT a failure: no `node.failed` in the history (replay poison otherwise).
    expect((await events(id)).filter((e) => e.type === 'node.failed')).toEqual([]);
    await cancel(id);
  });
  it('an IMMEDIATE pause is true when answered: a second pause sent with NO delay sees runStatus paused (production race, ad3717cde)', async () => {
    pausedWriteDelayMs = 400;
    try {
    for (let i = 0; i < 3; i++) {
      const id = await create('conformance-cancellable', { delayMs: 20000 });
      await waitFor(id, (s) => s.status === 'running', 3000);
      const first = await req('POST', `/runs/${enc(id)}:pause`, { reason: 'operator', drainPolicy: 'immediate' });
      expect(first.status).toBe(202);
      // No waitFor here — the conformance scenario doesn't wait either.
      const again = await req('POST', `/runs/${enc(id)}:pause`, {});
      expect(again.status).toBe(409);
      // The v2 envelope is flat: `{ error, message, details }`.
      expect(again.json?.error).toBe('run_state_conflict');
      expect(again.json?.details?.runStatus).toBe('paused');
      await cancel(id);
    }
    } finally { pausedWriteDelayMs = 0; }
  });
  it('a second pause → 409 run_state_conflict with details.runStatus', async () => {
    const id = await create('conformance-cancellable', { delayMs: 20000 });
    await waitFor(id, (s) => s.status === 'running', 3000);
    expect((await req('POST', `/runs/${enc(id)}:pause`, { drainPolicy: 'immediate' })).status).toBe(202);
    await waitFor(id, (x) => x.status === 'paused', 4000);
    const r = await req('POST', `/runs/${enc(id)}:pause`, {});
    expect(r.status).toBe(409);
    expect(r.json?.error).toBe('run_state_conflict');
    expect(r.json?.details?.runStatus).toBe('paused');
    await cancel(id);
  });
  it('drain-current-node (default): the running node FINISHES first, then the run pauses; run.paused follows node.completed', async () => {
    // 400 ms is long enough for the pause to land while the node runs (the running
    // wait resolves within one 60 ms poll) and short enough to keep the case under 1.5 s.
    const id = await create('conformance-cancellable', { delayMs: 400 });
    await waitFor(id, (s) => s.status === 'running', 3000);
    const t0 = Date.now();
    const r = await req('POST', `/runs/${enc(id)}:pause`, { reason: 'drain me' });
    expect(r.status).toBe(202); expect(r.json?.status).toBe('paused');
    const early = await snapshot(id);
    expect(['running', 'paused']).toContain(String(early.status));
    const s = await waitFor(id, (x) => x.status === 'paused' || ['completed', 'failed'].includes(String(x.status)), 6000);
    expect(s.status, `after ${Date.now() - t0}ms: ${JSON.stringify(s).slice(0, 120)}`).toBe('paused');
    const ev = await events(id);
    const nc = ev.findIndex((e) => e.type === 'node.completed'); const rp = ev.findIndex((e) => e.type === 'run.paused');
    expect(nc, 'the delay node completed (drain honoured)').toBeGreaterThan(-1);
    expect(rp).toBeGreaterThan(nc);
    expect(ev[rp]!.payload?.drainPolicy).toBe('drain-current-node');
    expect(ev[rp]!.payload?.interruptedNodeId, 'drain cuts nothing').toBeUndefined();
  });
});

describe('resume', () => {
  it('a TERMINAL run → 409 run_terminal (not run_state_conflict)', async () => {
    const id = await create('conformance-noop', {});
    await waitFor(id, (s) => s.status === 'completed', 5000);
    const r = await req('POST', `/runs/${enc(id)}:resume`, {});
    expect(r.status).toBe(409);
    expect(r.json?.error).toBe('run_terminal');
    expect(r.json?.details?.runStatus).toBe('completed');
  });
  it('a running (not paused) run → 409 run_state_conflict', async () => {
    const id = await create('conformance-cancellable', { delayMs: 20000 });
    await waitFor(id, (s) => s.status === 'running', 3000);
    const r = await req('POST', `/runs/${enc(id)}:resume`, {});
    expect(r.status).toBe(409);
    expect(r.json?.error).toBe('run_state_conflict');
    expect(r.json?.details?.runStatus).toBe('running');
    await cancel(id);
  });
  it('a paused run → 202 {status: running}, run.resumed, and the run completes (the aborted node re-executes)', async () => {
    const id = await create('conformance-cancellable', { delayMs: 1200 });
    await waitFor(id, (s) => s.status === 'running', 3000);
    expect((await req('POST', `/runs/${enc(id)}:pause`, { drainPolicy: 'immediate' })).status).toBe(202);
    await waitFor(id, (x) => x.status === 'paused', 4000);
    const r = await req('POST', `/runs/${enc(id)}:resume`, { reason: 'go' });
    expect(r.status, r.text.slice(0, 160)).toBe(202);
    expect(r.json?.status).toBe('running');
    const s = await waitFor(id, (x) => ['completed', 'failed'].includes(String(x.status)), 8000);
    expect(s.status).toBe('completed');
    const ev = await events(id);
    expect(ev.some((e) => e.type === 'run.resumed')).toBe(true);
    expect(ev.filter((e) => e.type === 'run.completed').length).toBe(1);
  });
});

describe('resume — the 202 is true when answered', () => {
  it('run.resumed is already in the log when :resume answers 202, even when the write is slow (prod floor row, rev 00780)', async () => {
    resumedAppendDelayMs = 600;
    try {
      // The node is aborted by the immediate pause and re-executes on resume; it
      // never needs to finish for this claim, so a long delay + cancel keeps the
      // case to the 600 ms write delay instead of a full re-execution.
      const id = await create('conformance-cancellable', { delayMs: 20000 });
      await waitFor(id, (s) => s.status === 'running', 3000);
      expect((await req('POST', `/runs/${enc(id)}:pause`, { drainPolicy: 'immediate' })).status).toBe(202);
      await waitFor(id, (x) => x.status === 'paused', 4000);
      const r = await req('POST', `/runs/${enc(id)}:resume`, { reason: 'go' });
      expect(r.status, r.text.slice(0, 160)).toBe(202);
      // Read IMMEDIATELY, with no wait, exactly as the conformance scenario does.
      const types = (await events(id)).map((e) => e.type);
      const p = types.indexOf('run.paused'); const q = types.indexOf('run.resumed');
      expect(p >= 0 && q > p, `run.paused then run.resumed at 202 time — got ${types.join(', ')}`).toBe(true);
      await cancel(id);
    } finally { resumedAppendDelayMs = 0; }
  });
});

describe('replay/fork safety (ADR 0632 P4)', () => {
  it('a replay fork of a run that was paused + resumed completes: run.paused/run.resumed are inert in the fold', async () => {
    const id = await create('conformance-cancellable', { delayMs: 1200 });
    await waitFor(id, (s) => s.status === 'running', 3000);
    expect((await req('POST', `/runs/${enc(id)}:pause`, { drainPolicy: 'immediate' })).status).toBe(202);
    await waitFor(id, (x) => x.status === 'paused', 4000);
    expect((await req('POST', `/runs/${enc(id)}:resume`, {})).status).toBe(202);
    expect((await waitFor(id, (x) => ['completed', 'failed'].includes(String(x.status)), 8000)).status).toBe('completed');
    const src = await events(id);
    expect(src.some((e) => e.type === 'run.paused') && src.some((e) => e.type === 'run.resumed')).toBe(true);
    expect(src.some((e) => e.type === 'node.completed'), 'source has a completed node to replay').toBe(true);
    // This host's `mode:'replay'` is full deterministic re-execution (fromSeq 0 only).
    const fork = await req('POST', `/runs/${enc(id)}:fork`, { mode: 'replay', fromSeq: 0 });
    expect([200, 201, 202], fork.text.slice(0, 160)).toContain(fork.status);
    const child = String(fork.json?.runId);
    expect(child).not.toBe(id);
    const cs = await waitFor(child, (x) => ['completed', 'failed'].includes(String(x.status)), 8000);
    const cev = await events(child);
    expect(cs.status, `child status=${cs.status} events=${cev.map((e) => e.type + (e.payload?.error?.message ? '(' + String(e.payload.error.message).slice(0, 80) + ')' : '')).join(',')} meta=${JSON.stringify(cs.metadata ?? {}).slice(0, 200)}`).toBe('completed');
    // A replayed child never pauses on its own: the source's pause/resume are the
    // source's history, not instructions the child re-executes.
    expect(cev.filter((e) => e.type === 'run.paused' || e.type === 'run.resumed')).toEqual([]);
    expect(cev.filter((e) => e.type === 'run.completed').length).toBe(1);
  });
});

describe('bulk-cancel entries under major 2 (bus finding cea0)', () => {
  it('an ok:false entry carries the v2 error ENVELOPE, and an already-terminal run is ok:false run_terminal', async () => {
    const done = await create('conformance-noop', {});
    await waitFor(done, (s) => s.status === 'completed', 5000);
    const live = await create('conformance-cancellable', { delayMs: 20000 });
    await waitFor(live, (s) => s.status === 'running', 3000);
    const r = await req('POST', '/runs:bulk-cancel', { runIds: [done, 'openwop-conformance-foreign-tenant/foreignopaque0123456789abcdef', live], reason: 'conformance' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const results = r.json?.results ?? [];
    expect(results.map((x) => x.ok)).toEqual([false, false, true]);
    expect(results[0]!.error).toMatchObject({ error: 'run_terminal', details: { status: 'completed' } });
    expect(results[1]!.error?.error).toBe('not_found');
    for (const e of results.slice(0, 2)) { expect(typeof e.error?.message).toBe('string'); expect(e.error).not.toHaveProperty('code'); }
    expect(results[2]!.status).toBe('cancelled');
  });
});

// ADR 0812 P3c-0 — the "major 1 mount" describe (v1's `conflict` vocabulary on
// :pause/:resume) was deleted with major 1; the v2 codes are pinned above.

// ADR 0812 P3c-0 — ported from the v1 mount: the same :pause idempotency rules,
// now under major 2 (22+ char keys per the v2 Idempotency-Key grammar).
describe(':pause idempotency (rest-endpoints.md:169, bus ruling d4e4)', () => {
  async function runningRun(): Promise<string> {
    const id = await create('conformance-cancellable', { delayMs: 20000 });
    await waitFor(id, (s) => s.status === 'running', 3000);
    return id;
  }
  it('the same Idempotency-Key on both pauses → 202 twice with the cached response', async () => {
    const id = await runningRun();
    const a = await req('POST', `/runs/${enc(id)}:pause`, { drainPolicy: 'immediate' }, { ...V2, 'Idempotency-Key': 'pause-key-1-0123456789abcdef' });
    expect(a.status, a.text.slice(0, 160)).toBe(202);
    await waitFor(id, (x) => x.status === 'paused', 4000);
    const b = await req('POST', `/runs/${enc(id)}:pause`, { drainPolicy: 'immediate' }, { ...V2, 'Idempotency-Key': 'pause-key-1-0123456789abcdef' });
    expect(b.status, b.text.slice(0, 160)).toBe(202);
    expect(b.json).toEqual(a.json);
    const c = await req('POST', `/runs/${enc(id)}:pause`, {}, { ...V2, 'Idempotency-Key': 'a-different-key-0123456789' });
    expect(c.status).toBe(409);
    await cancel(id);
  });
  it('a second pause WITHOUT the key → 409 run_state_conflict with details.runStatus=paused and the existing pausedAt', async () => {
    const id = await runningRun();
    expect((await req('POST', `/runs/${enc(id)}:pause`, { drainPolicy: 'immediate' })).status).toBe(202);
    await waitFor(id, (x) => x.status === 'paused', 4000);
    const r = await req('POST', `/runs/${enc(id)}:pause`, {});
    expect(r.status).toBe(409);
    expect(r.json?.error).toBe('run_state_conflict');
    expect(r.json?.details?.runStatus).toBe('paused');
    expect(typeof r.json?.details?.pausedAt).toBe('string');
    await req('POST', `/runs/${enc(id)}:cancel`, {});
  });
});

describe('v2 create body is closed at the composition (runs.md §Run options; rc.54 v2-run-options-limits)', () => {
  it('an unknown root key → 400 validation_error naming the key', async () => {
    const r = await req('POST', '/runs', { workflowId: 'conformance-noop', conformanceUnknownRootKey: 1 });
    expect(r.status, r.text.slice(0, 160)).toBe(400);
    expect(r.json?.error).toBe('validation_error');
    expect(r.json?.details?.field).toBe('conformanceUnknownRootKey');
    const ok = await req('POST', '/runs', { workflowId: 'conformance-noop', inputs: {}, tags: ['a'], metadata: { k: 1 } });
    expect(ok.status, ok.text.slice(0, 160)).toBe(201);
    // ADR 0812 P3c-0 — the v1 open-bag control leg was deleted with major 1.
  });
});
