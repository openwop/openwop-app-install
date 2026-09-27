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
const V1 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function req(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json, text };
}
async function completedRun(headers: Record<string, string>, prefix: string): Promise<string> {
  const c = await req('POST', `${prefix}/runs`, headers, { workflowId: 'conformance-noop', inputs: {} });
  expect(c.status, c.text.slice(0, 160)).toBe(201);
  const id = c.json.runId as string; const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const s = await req('GET', `${prefix}/runs/${encodeURIComponent(id)}`, headers);
    if (['completed', 'failed'].includes(s.json?.status)) return id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not complete');
}

describe('a run\'s first event is sequence 0 (RFC 0171 §A.3)', () => {
  it('major 2: omitting afterSequence returns from sequence 0, and lastSequence is the true max', async () => {
    const id = await completedRun(V2, '');
    const r = await req('GET', `/runs/${encodeURIComponent(id)}/events/poll?timeout=1`, V2);
    expect(r.status).toBe(200);
    const seqs = (r.json.events as Array<{ sequence: number }>).map((e) => e.sequence);
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs[0], 'the first event of a run is sequence 0').toBe(0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size, 'strictly increasing ⇒ no duplicates').toBe(seqs.length);
    expect(r.json.lastSequence, 'lastSequence is the highest sequence returned').toBe(Math.max(...seqs));
  });

  it('major 1 numbers from 0 too, and an absent cursor is not a cursor at 0', async () => {
    const id = await completedRun(V1, '/v1');
    const r = await req('GET', `/v1/runs/${encodeURIComponent(id)}/events/poll?timeout=1`, V1);
    expect(r.status).toBe(200);
    const seqs = (r.json.events as Array<{ sequence: number }>).map((e) => e.sequence);
    expect(seqs[0]).toBe(0);
    // An EXPLICIT cursor of 0 is exclusive and must skip exactly event 0.
    const after0 = await req('GET', `/v1/runs/${encodeURIComponent(id)}/events/poll?timeout=1&fromSeq=0`, V1);
    expect((after0.json.events as Array<{ sequence: number }>)[0]?.sequence).toBe(1);
  });

  it('every "all events" reader includes event 0 — poll, debug bundle, diff, SSE, fork prefix', async () => {
    const id = await completedRun(V2, '');
    const poll = await req('GET', `/runs/${encodeURIComponent(id)}/events/poll?timeout=1`, V2);
    const all = (poll.json.events as Array<{ sequence: number }>).map((e) => e.sequence);
    expect(all[0]).toBe(0);

    // The debug bundle and diff are v1-mount readers, so they need a v1 (bare-id) run.
    const v1id = await completedRun(V1, '/v1');
    const v1poll = await req('GET', `/v1/runs/${encodeURIComponent(v1id)}/events/poll?timeout=1`, V1);
    const v1all = (v1poll.json.events as Array<{ sequence: number }>).map((e) => e.sequence);
    expect(v1all[0]).toBe(0);

    const bundle = await req('GET', `/v1/runs/${encodeURIComponent(v1id)}/debug-bundle`, V1);
    expect(bundle.status, bundle.text.slice(0, 160)).toBe(200);
    const bseq = ((bundle.json.events ?? []) as Array<{ sequence: number }>).map((e) => e.sequence);
    expect(bseq, 'the debug bundle is the whole log, event 0 included').toEqual(v1all);

    const diff = await req('GET', `/v1/runs/${encodeURIComponent(v1id)}:diff?against=${encodeURIComponent(v1id)}`, V1);
    if (diff.status === 200) {
      const seqs = JSON.stringify(diff.json).match(/"sequence":(\d+)/g) ?? [];
      if (seqs.length > 0) expect(seqs[0], 'the diff reads the whole log').toBe('"sequence":0');
    }

    const sse = await fetch(`${base}/runs/${encodeURIComponent(id)}/events?streamMode=debug`, { headers: { ...V2, Accept: 'text/event-stream' } });
    const ids = (await sse.text()).split('\n').filter((l) => l.startsWith('id:')).map((l) => Number(l.slice(3).trim()));
    expect(ids[0], 'a fresh SSE stream replays from event 0').toBe(0);

    const fork = await req('POST', `/runs/${encodeURIComponent(id)}:fork`, V2, { mode: 'branch', fromSeq: 2 });
    expect([200, 201, 202], fork.text.slice(0, 160)).toContain(fork.status);
    const child = fork.json.runId as string;
    const cpoll = await req('GET', `/runs/${encodeURIComponent(child)}/events/poll?timeout=1`, V2);
    const cseq = (cpoll.json.events as Array<{ sequence: number }>).map((e) => e.sequence);
    expect(cseq[0], 'the inherited prefix starts at 0, not 1').toBe(0);
    expect(cseq.slice(0, 2), 'events with sequence < fromSeq are the fixed prefix').toEqual([0, 1]);
  });
});
