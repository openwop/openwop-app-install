/**
 * RFC 0171 §A.3 / `spec/v2/core/events.md` §Shape / `schemas/run-event.schema.json`:
 * "The one ordering field: integer ≥ 0, first event `0`, strictly increasing per run."
 * The v1 schema says the same ("First event is 0"), so this is not a v2-only rule —
 * this host numbered from 1 under BOTH majors until now (found by the rc.56 origin
 * bundle: `v2-poll-cursor-v2`, "expected 1 to be 0").
 *
 * The dangerous half of the fix is not the numbering: the storage cursor is
 * EXCLUSIVE (`sequence > fromSeq`), so every reader that passed `fromSeq: 0` to mean
 * "all events" would now silently DROP event 0 and still answer 200. Each leg below
 * pins one such reader, because a missed one has no symptom.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface Ev { sequence: number; type: string }
interface Poll { events: Ev[]; lastSequence?: number }
/** `json` is `unknown` and each call site names the shape it reads (no `any`). */
async function req<T = unknown>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: T; text: string }> {
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json: json as T, text };
}
/** Run-settle poll — an honest ceiling: there is no completion hook to await over HTTP. */
async function completedRun(headers: Record<string, string>, prefix: string, workflowId = 'conformance-noop'): Promise<string> {
  const c = await req<{ runId: string }>('POST', `${prefix}/runs`, headers, { workflowId, inputs: {} });
  expect(c.status, c.text.slice(0, 160)).toBe(201);
  const id = c.json.runId; const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const s = await req<{ status?: string } | undefined>('GET', `${prefix}/runs/${encodeURIComponent(id)}`, headers);
    if (['completed', 'failed'].includes(s.json?.status ?? '')) return id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not complete');
}

describe('a run\'s first event is sequence 0 (RFC 0171 §A.3)', () => {
  it('major 2: omitting afterSequence returns from sequence 0, and lastSequence is the true max', async () => {
    const id = await completedRun(V2, '');
    const r = await req<Poll>('GET', `/runs/${encodeURIComponent(id)}/events/poll?timeout=1`, V2);
    expect(r.status).toBe(200);
    const seqs = r.json.events.map((e) => e.sequence);
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs[0], 'the first event of a run is sequence 0').toBe(0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size, 'strictly increasing ⇒ no duplicates').toBe(seqs.length);
    expect(r.json.lastSequence, 'lastSequence is the highest sequence returned').toBe(Math.max(...seqs));
  });

  // ADR 0812 P3c-0 — the major-1 numbering leg was deleted with major 1; its
  // cursor half (an explicit cursor of 0 is exclusive) is kept under major 2.
  it('an absent cursor is not a cursor at 0 — an explicit afterSequence=0 skips exactly event 0', async () => {
    const id = await completedRun(V2, '');
    const r = await req<Poll>('GET', `/runs/${encodeURIComponent(id)}/events/poll?timeout=1`, V2);
    expect(r.status).toBe(200);
    expect(r.json.events[0]?.sequence).toBe(0);
    const after0 = await req<Poll>('GET', `/runs/${encodeURIComponent(id)}/events/poll?timeout=1&afterSequence=0`, V2);
    expect(after0.status, after0.text.slice(0, 160)).toBe(200);
    expect(after0.json.events[0]?.sequence).toBe(1);
  });

  it('every "all events" reader includes event 0 — poll, debug bundle, SSE, fork prefix', async () => {
    const id = await completedRun(V2, '');
    const poll = await req<Poll>('GET', `/runs/${encodeURIComponent(id)}/events/poll?timeout=1`, V2);
    const all = poll.json.events.map((e) => e.sequence);
    const types = poll.json.events.map((e) => e.type);
    expect(all[0]).toBe(0);
    expect(types[0], 'event 0 of a run is run.started').toBe('run.started');

    // ADR 0812 P3c-0 — the debug bundle and diff are read under major 2 with the
    // bound id (they used to need a v1 bare-id run).
    const bundle = await req<{ events?: Ev[] }>('GET', `/runs/${encodeURIComponent(id)}/debug-bundle`, V2);
    expect(bundle.status, bundle.text.slice(0, 160)).toBe(200);
    const bseq = (bundle.json.events ?? []).map((e) => e.sequence);
    expect(bseq, 'the debug bundle is the whole log, event 0 included').toEqual(all);

    // The `:diff` reader is pinned in its own case below (DIFF-AGAINST-BOUND-1).

    const sse = await fetch(`${base}/runs/${encodeURIComponent(id)}/events?streamMode=debug`, { headers: { ...V2, Accept: 'text/event-stream' } });
    const ids = (await sse.text()).split('\n').filter((l) => l.startsWith('id:')).map((l) => Number(l.slice(3).trim()));
    expect(ids[0], 'a fresh SSE stream replays from event 0').toBe(0);

    const fork = await req<{ runId: string }>('POST', `/runs/${encodeURIComponent(id)}:fork`, V2, { mode: 'branch', fromSeq: 2 });
    expect(fork.status, fork.text.slice(0, 160)).toBe(201);
    const child = fork.json.runId;
    const cpoll = await req<Poll>('GET', `/runs/${encodeURIComponent(child)}/events/poll?timeout=1`, V2);
    const cseq = cpoll.json.events.map((e) => e.sequence);
    expect(cseq[0], 'the inherited prefix starts at 0, not 1').toBe(0);
    // The child RENUMBERS its copy, so sequences alone cannot show WHICH source events
    // were copied: the types must be the source's first two (event 0 = run.started).
    expect(cpoll.json.events.slice(0, 2).map((e) => e.type), 'the copied prefix is source events 0 and 1').toEqual(types.slice(0, 2));
    expect(cseq.slice(0, 2), 'events with sequence < fromSeq are the fixed prefix').toEqual([0, 1]);
  });

  /**
   * DIFF-AGAINST-BOUND-1 (BLOCKED-ON-PRODUCT) — the `:diff` reader cannot be reached
   * under major 2. `routes/runs.ts:1020` parses `?against=` RAW and uses it raw TWICE:
   * `storage.getRun(against)` (:1024, so a bound id answers `404 run_not_found`) and
   * `getEventLog().list(against, …)` (:1042, so even a resolved run would diff against an
   * EMPTY log). Only the PATH id is translated by the v2 identity guard. The leg that used
   * to sit in the case above was wrapped in `if (diff.status === 200)` and therefore never
   * ran (round-1 probe 8fw4g1-es-diff: vacuous). Correct behaviour below.
   *
   * The pin fails ONLY because of the defect: run with `?against=<bare opaque>` (the
   * value the fix would resolve to), every assertion below passes (measured in round 3).
   * Fix-probe 8fw4g1-es-diff-fix-r3 resolves `against` with `fromWireRunId` at the ONE
   * parse site and turns this red. (Round-2's es-diff-fix-r2 fixed only the getRun read,
   * left the event-log read raw, and so stayed vacuous — the fix was incomplete.)
   *
   * The second run uses a different workflow so the two logs differ AT event 0
   * (run.started carries `workflowId`): a reader that dropped event 0 on either side
   * turns that `changed` row into `added`/`removed` or moves `divergedAtSeq` off 0.
   */
  it.fails('the :diff reader includes event 0 — a BOUND ?against= resolves (DIFF-AGAINST-BOUND-1)', async () => {
    const id = await completedRun(V2, '');
    const other = await completedRun(V2, '', 'conformance-multi-node');
    const diff = await req<{ divergedAtSeq: number | null; eventDiffs: Array<{ seq: number; op: string; aEvent?: Ev; bEvent?: Ev }> }>(
      'GET', `/runs/${encodeURIComponent(id)}:diff?against=${encodeURIComponent(other)}`, V2);
    expect(diff.status, diff.text.slice(0, 160)).toBe(200);
    expect(diff.json.divergedAtSeq, 'the diff reads the whole log').toBe(0);
    expect(diff.json.eventDiffs[0]).toMatchObject({ seq: 0, op: 'changed', aEvent: { sequence: 0 }, bEvent: { sequence: 0 } });
  });
});
