/**
 * Replay divergence detection (`src/executor/replayDivergence.ts`) +
 * an end-to-end replay round-trip proving the host honestly advertises the v2
 * `replay` family and re-executes deterministically (replay.md §"Failure surfaces").
 *
 * Sabotages that red this file (8fw1g4 round 1): the observable-type filter, the
 * divergence index, the `type@nodeId` key, the truncation branch, the exclusive
 * source cursor (`fromSeq - 1` → `fromSeq` makes every full replay "diverge"), and
 * the advertised `modes`.
 *
 * The e2e absence check waits for the REAL settle signal: the fork route calls
 * `detectAndRecordReplayDivergence` only after `executeRun` resolves, which is
 * AFTER `run.completed` is visible — a bundle read at `run.completed` could race
 * the append. The module is wrapped (pass-through) so the case awaits that call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { compareObservableSequences, type DivergenceResult } from '../src/executor/replayDivergence.js';
import type { EventRecord } from '../src/types.js';

// Every divergence detection the fork route starts — the real settle signal.
const detections = vi.hoisted((): Array<Promise<DivergenceResult>> => []);
vi.mock('../src/executor/replayDivergence.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/executor/replayDivergence.js')>();
  return {
    ...real,
    detectAndRecordReplayDivergence: (...args: Parameters<typeof real.detectAndRecordReplayDivergence>) => {
      const p = real.detectAndRecordReplayDivergence(...args);
      detections.push(p);
      return p;
    },
  };
});

function ev(seq: number, type: string, nodeId?: string): EventRecord {
  return {
    eventId: `e${seq}`,
    runId: 'r',
    sequence: seq,
    type,
    ...(nodeId ? { nodeId } : {}),
    payload: {},
    timestamp: new Date(seq * 1000).toISOString(),
  };
}

describe('compareObservableSequences', () => {
  it('reports no divergence for identical structural sequences', () => {
    const a = [ev(0, 'run.started'), ev(1, 'node.started', 'op'), ev(2, 'node.completed', 'op'), ev(3, 'run.completed')];
    const b = a.map((e, i) => ({ ...e, eventId: `b${i}` }));
    expect(compareObservableSequences(a, b).diverged).toBe(false);
  });

  it('ignores recorded-fact / cost events (memory.written, provider.usage)', () => {
    const source = [
      ev(0, 'run.started'),
      ev(1, 'node.started', 'op'),
      ev(2, 'provider.usage', 'op'),
      ev(3, 'node.completed', 'op'),
      ev(4, 'run.completed'),
      ev(5, 'memory.written'),
    ];
    // replay omits the recorded-fact + cost events but matches structurally
    const replay = [
      ev(0, 'run.started'),
      ev(1, 'node.started', 'op'),
      ev(2, 'node.completed', 'op'),
      ev(3, 'run.completed'),
    ];
    expect(compareObservableSequences(source, replay).diverged).toBe(false);
  });

  it('flags divergence at the first structural mismatch', () => {
    const source = [ev(0, 'run.started'), ev(1, 'node.started', 'op'), ev(2, 'node.completed', 'op'), ev(3, 'run.completed')];
    const replay = [ev(0, 'run.started'), ev(1, 'node.started', 'op'), ev(2, 'node.failed', 'op'), ev(3, 'run.failed')];
    const r = compareObservableSequences(source, replay);
    expect(r.diverged).toBe(true);
    expect(r.index).toBe(2);
    expect(r.expected).toBe('node.completed@op');
    expect(r.actual).toBe('node.failed@op');
  });

  it('flags divergence when replay is truncated', () => {
    const source = [ev(0, 'run.started'), ev(1, 'node.started', 'op'), ev(2, 'run.completed')];
    const replay = [ev(0, 'run.started'), ev(1, 'node.started', 'op')];
    const r = compareObservableSequences(source, replay);
    expect(r.diverged).toBe(true);
    expect(r.index).toBe(2);
    expect(r.actual).toBeUndefined();
  });
});

describe('replay round-trip (end-to-end)', () => {
  let server: http.Server;
  let BASE: string;

  beforeAll(async () => {
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
    });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  const jf = async <T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) },
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  // A run-settle poll on the real condition (the run status); no hook exists to await.
  const waitTerminal = async (id: string): Promise<string> => vi.waitFor(async () => {
    const s = (await jf<{ status: string }>(`/runs/${id}`)).body.status;
    if (!['completed', 'failed', 'cancelled'].includes(s)) throw new Error(`run ${id} still ${s}`);
    return s;
  }, { timeout: 5000, interval: 25 });

  it('advertises the replay family honestly — supported, both modes, fork', async () => {
    // FLIPPED 2026-08-08 (ADR 0326 flip trigger). This previously asserted
    // `fork: false`, which was the honest advert while mid-run BRANCH forks
    // were implemented (ADR 0326 P3b) but had no conformance witness. The
    // witness now exists — 10 passed / 7 skipped / 0 failed across the
    // conformance replay-fork set against a pack-clean local boot, with the
    // branch case confirmed non-vacuous — so the advert was raised.
    //
    // What this test still guards: that the advert stays HONEST, i.e. that it
    // never claims more than the witness covers.
    //
    // CORRECTED — this said "Mid-sequence `replay` remains a 501
    // (`fork_from_seq_unsupported`)". It does not: the fork route now derives
    // `snapshotFromEventPrefix` for BOTH modes, which is the same mechanism
    // `branch` already used, so the prefix never re-executes and the refusal's
    // only stated reason no longer applies. See `v2-replay-midseq-fork.test.ts`
    // for the behavioural witness. The narrower `fork_checkpoint_unsupported`
    // (a prefix ending on an open interrupt) is GONE too since ADR 0751: the
    // fork inherits the open gate as state instead of refusing.
    // ADR 0812 P3c-0 — v2 spelling: the `replay` record sits at the closed v2 root and its
    // PRESENCE is the claim (no `supported`/`fork` flags; the fork endpoint IS the replay surface).
    const { body } = await jf<{ replay?: { status?: string; modes?: string[] } }>('/.well-known/openwop', { headers: { 'OpenWOP-Version': '2' } });
    // Twin: `modes` is also asserted by v2-family-adverts.test.ts "replay.effectSeamsManifest
    // names the route…" (probe div-advert-modes reds both). Kept: protected file.
    const replay = body.replay;
    expect(replay?.status).toBe('experimental');
    expect(replay?.modes).toEqual(['replay', 'branch']);
  });

  // ADR 0812 P3c-0 — the `x-host-openwop-workforce` advert leg is deleted: that block exists only
  // in the retired v1 document (the closed v2 root admits no `x-host-*` keys).

  it('full replay of a deterministic run reproduces it with no replay.diverged', async () => {
    await jf('/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: 'wf.det.replay',
        nodes: [{ nodeId: 'op', typeId: 'core.db.nosql-insert', config: { datasource: 'ds', collection: 'c' } }],
        edges: [],
      }),
    });
    const create = await jf<{ runId: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'wf.det.replay', inputs: { docs: [{ name: 'Ada' }] } }),
    });
    expect(create.status).toBe(201);
    expect(await waitTerminal(create.body.runId)).toBe('completed');

    const fork = await jf<{ runId: string }>(`/runs/${create.body.runId}:fork`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay', fromSeq: 0 }),
    });
    expect(fork.status).toBe(201);
    expect(await waitTerminal(fork.body.runId)).toBe('completed');

    // Divergence detection runs AFTER completion: await the detection itself
    // (started for this fork only — this file forks once), then read the log.
    await vi.waitFor(() => { if (detections.length === 0) throw new Error('detection not started'); }, { timeout: 5000, interval: 10 });
    expect(detections, 'exactly one replay fork was detected').toHaveLength(1);
    const result = await detections[0];
    expect(result?.diverged, `deterministic replay reported divergence: ${JSON.stringify(result)}`).toBe(false);
    const bundle = (await jf<{ events?: { type: string }[] }>(`/runs/${fork.body.runId}/debug-bundle`)).body;
    const evs = bundle.events ?? [];
    expect(evs.some((e) => e.type === 'run.completed')).toBe(true);
    expect(evs.some((e) => e.type === 'replay.diverged')).toBe(false);
  });
});
