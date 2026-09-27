import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { RUN_LIST, mintRunListCursor, parseRunListCursor } from '../src/host/runList.js';

/**
 * ADR 0658 / RFC 0182 — `GET /runs` under major 2 is `listRuns`: tenant-scoped
 * by construction, closed snapshots with bound ids, `limit` clamped to the
 * advertised `runList.maxPageSize`, a host-minted opaque cursor (a foreign
 * one is 400 validation_error), and only the advertised filters honoured.
 * The v1 twin (`GET /v1/runs`) is the host-extension list it always was.
 */
let server: Server;
let base = '';
const V2 = { Authorization: 'Bearer dev-token', Accept: 'application/json', 'OpenWOP-Version': '2', 'Content-Type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  // Five runs of the noop fixture, created in order.
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/runs`, { method: 'POST', headers: V2, body: JSON.stringify({ workflowId: 'conformance-noop' }) });
    expect(res.status, 'fixture create').toBe(201);
  }
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const list = (qs = '') => fetch(`${base}/runs${qs}`, { headers: V2 });

describe('ADR 0658 — GET /runs under major 2 is RFC 0182 listRuns', () => {
  it('advertises runList with the facets the handler enforces (one owner)', async () => {
    const doc = await (await fetch(`${base}/.well-known/openwop`, { headers: { Accept: 'application/json', 'OpenWOP-Version': '2' } })).json() as {
      protocolVersions?: string[];
      runList?: { status: string; since: string; until?: string; witness: string; maxPageSize: number; filters?: string[] };
    };
    expect(doc.runList).toBeDefined();
    expect(doc.runList!.maxPageSize).toBe(RUN_LIST.maxPageSize);
    expect(doc.runList!.filters).toEqual([...RUN_LIST.filters]);
    expect(doc.runList!.witness).toBe('witnessable-gated');
    expect(doc.runList!.since < doc.runList!.until!).toBe(true);
    // Steward ruling `5d9b`: `since` is THIS HOST's minor, not the corpus minor
    // that introduced the family — it carries the axis-1 grammar, so it must be
    // a version this host actually advertises. Shipped once as "2.1" (the
    // corpus timeline) on a host advertising ["1.1","2.0"]; this leg is what
    // makes that unshippable rather than merely noticed in review.
    expect(doc.protocolVersions).toContain(doc.runList!.since);
  });

  it('returns the closed envelope { runs, nextCursor? } newest first with TENANT-BOUND ids, and pages without overlap or gap', async () => {
    const p1 = await list('?limit=2');
    expect(p1.status).toBe(200);
    expect(p1.headers.get('openwop-version')).toBe('2.0');
    const b1 = await p1.json() as { runs: Array<{ runId: string; startedAt?: string; createdAt?: string }>; nextCursor?: string };
    expect(Object.keys(b1).sort()).toEqual(['nextCursor', 'runs']);
    expect(b1.runs).toHaveLength(2);
    for (const r of b1.runs) expect(r.runId).toMatch(/^[^/]+\/[^/]+$/); // <tenant>/<opaque>
    // The closed v2 snapshot carries `startedAt` (run-snapshot.schema.json), not the storage `createdAt`.
    expect(b1.runs[0]!.createdAt).toBeUndefined();
    expect(String(b1.runs[0]!.startedAt) >= String(b1.runs[1]!.startedAt)).toBe(true);
    const p2 = await (await list(`?limit=2&cursor=${encodeURIComponent(b1.nextCursor!)}`)).json() as typeof b1;
    const p3 = await (await list(`?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}`)).json() as typeof b1;
    const ids = [...b1.runs, ...p2.runs, ...p3.runs].map((r) => r.runId);
    expect(new Set(ids).size).toBe(5); // disjoint
    expect(ids).toHaveLength(5); // complete
    expect(p3.nextCursor).toBeUndefined(); // the last page mints no cursor
  });

  it('a cursor this host did not mint is 400 validation_error; a tampered one too', async () => {
    const foreign = await list('?cursor=v1.eyJmYWtlIjp0cnVlfQ.AAAA');
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toBe('validation_error');
    const minted = mintRunListCursor({ createdAt: '2026-09-11T00:00:00.000Z', runId: 'r' });
    const tampered = minted.slice(0, -2) + 'zz';
    expect(parseRunListCursor(tampered)).toBeNull();
    expect((await list(`?cursor=${encodeURIComponent(tampered)}`)).status).toBe(400);
    expect(parseRunListCursor(minted)).toEqual({ createdAt: '2026-09-11T00:00:00.000Z', runId: 'r' });
  });

  it('limit is clamped to maxPageSize and refused when not a positive integer', async () => {
    const big = await (await list(`?limit=${RUN_LIST.maxPageSize * 10}`)).json() as { runs: unknown[] };
    expect(big.runs.length).toBeLessThanOrEqual(RUN_LIST.maxPageSize);
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?limit=abc')).status).toBe(400);
  });

  it('the advertised filters narrow the list; the v1 twin is untouched (no cursor, no closed envelope)', async () => {
    const none = await (await list('?workflowId=does-not-exist')).json() as { runs: unknown[] };
    expect(none.runs).toEqual([]);
    const v1 = await fetch(`${base}/v1/runs?limit=2`, { headers: { Authorization: 'Bearer dev-token', Accept: 'application/json' } });
    expect(v1.headers.get('openwop-version')).toBe('1.1');
    const b = await v1.json() as { runs: Array<{ runId: string }>; nextCursor?: string };
    expect(b.nextCursor).toBeUndefined();
    expect(b.runs[0]!.runId).not.toContain('/'); // bare ids on the v1 contract
  });
});
