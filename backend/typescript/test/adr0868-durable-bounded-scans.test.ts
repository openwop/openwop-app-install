/**
 * ADR 0868 — durable surfaces read a page, not a whole key range.
 *
 * Every durable host surface used to read through `Storage.kvList(prefix)`,
 * which returns EVERY row under the prefix, values included: a table
 * `query({limit:1})`, a queue receive and a `count` each cost the whole table
 * or queue, and an account purge or a one-tenant DLQ snapshot read every
 * tenant's rows. This counts the rows `Storage` hands back (deterministic,
 * unlike a timing) and pins:
 *   - a table page reads `limit + 1` rows; paging returns every row once, in
 *     byte order; `count` reads none; an absent limit is clamped;
 *   - a queue receive / bus consume reads at most one claim page;
 *   - kv `list(prefix)`, fs `stat`, the purge and a tenant's DLQ snapshot never
 *     read another tenant's (or another prefix's) rows;
 *   - the sqlite adapter's page is a byte-order RANGE (its LIKE is
 *     case-insensitive), and the JS fallback for a backend without
 *     `kvListPage` returns the same pages;
 *   - a heavy read logs `surface_scan_heavy`;
 *   - no durable adapter calls `kvList` directly (ratchet).
 *
 * Tracker TST-BFC-1. Red when: an unfiltered table page reads a SCAN_BATCH
 * instead of `limit + 1`; the claim page grows; `count` reads rows (also reds
 * the ratchet); the fallback page repeats its cursor row; `surface_scan_heavy`
 * logs the prefix (and with it the tenant).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { prefixUpperBound } from '../src/storage/sqlite/index.js';
import { listPage, scanPrefix, setDurableStorage } from '../src/host/durable/durableStore.js';
import { createDurableTable } from '../src/host/durable/durableTable.js';
import { createDurableKv } from '../src/host/durable/durableKv.js';
import { createDurableFs } from '../src/host/durable/durableFs.js';
import {
  createDurableQueue, createDurableQueueBus, purgeTenantDurableSurfaces, snapshotDurableDlqSubjects,
} from '../src/host/durable/durableQueue.js';
import { buildHostSurfaceBundle, initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';

let base: Storage;
/** Every key `Storage` returned from a list/page call since the last reset. */
let keysRead: string[] = [];
let withPage = true;

/** `base` with its list reads counted; `withPage=false` hides the paged read
 *  so the durable layer takes its `kvList` fallback. */
function counted(): Storage {
  return new Proxy(base, {
    get(target, prop, recv) {
      if (prop === 'kvList') {
        return async (p: string) => { const r = await target.kvList(p); keysRead.push(...r.map((x) => x.key)); return r; };
      }
      if (prop === 'kvListPage') {
        if (!withPage) return undefined;
        return async (p: string, o: { after?: string; limit: number }) => {
          const r = await target.kvListPage!(p, o); keysRead.push(...r.map((x) => x.key)); return r;
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

beforeAll(async () => {
  base = await openStorage('memory://');
  setDurableStorage(counted());
});
afterAll(async () => {
  setDurableStorage(null);
  await base.close();
});
beforeEach(() => { keysRead = []; withPage = true; });

const pad = (i: number) => String(i).padStart(4, '0');

describe('ADR 0868 — table pages in the database', () => {
  const table = createDurableTable({ tenantId: 'tbl-t' });
  beforeAll(async () => {
    for (let i = 0; i < 2000; i++) await table.insert({ table: 'big', row: { id: `r${pad(i)}`, even: i % 2 === 0 } });
  });

  it('query({limit:10}) reads 11 rows of 2000 and returns a cursor', async () => {
    keysRead = [];
    const r = await table.query({ table: 'big', limit: 10 }) as { rows: Array<{ id: string }>; nextCursor: string | null };
    expect(r.rows.map((x) => x.id)).toEqual(Array.from({ length: 10 }, (_, i) => `r${pad(i)}`));
    expect(r.nextCursor).not.toBeNull();
    expect(keysRead).toHaveLength(11);
  });

  it('paging returns every row exactly once, in order, each page bounded', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      keysRead = [];
      const r = await table.query({ table: 'big', limit: 300, cursor }) as { rows: Array<{ id: string }>; nextCursor: string | null };
      expect(keysRead.length).toBeLessThanOrEqual(301);
      seen.push(...r.rows.map((x) => x.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 2000 }, (_, i) => `r${pad(i)}`));
  });

  it('an absent limit is clamped to 1000 with a cursor, never the whole table', async () => {
    keysRead = [];
    const r = await table.query({ table: 'big' }) as { rows: unknown[]; nextCursor: string | null };
    expect(r.rows).toHaveLength(1000);
    expect(r.nextCursor).not.toBeNull();
    expect(keysRead).toHaveLength(1001);
  });

  it('a filtered page scans in batches until full, and stops there', async () => {
    keysRead = [];
    const r = await table.query({ table: 'big', filter: { even: true }, limit: 5 }) as { rows: Array<{ id: string }> };
    expect(r.rows.map((x) => x.id)).toEqual(['r0000', 'r0002', 'r0004', 'r0006', 'r0008']);
    expect(keysRead.length).toBeLessThanOrEqual(500); // one SCAN_BATCH, not 2000
  });

  it('count reads no rows', async () => {
    keysRead = [];
    expect(await table.count({ table: 'big' })).toEqual({ count: 2000 });
    expect(keysRead).toEqual([]);
  });

  it('memory and durable tables return mixed-case ids in the same (byte) order', async () => {
    const ids = ['b', 'B', 'a', 'A', '_', 'é', 'Z'];
    const savedEnv = { table: process.env.OPENWOP_SURFACE_TABLE, backend: process.env.OPENWOP_SURFACE_BACKEND };
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'adr0868-')) });
    delete process.env.OPENWOP_SURFACE_TABLE; delete process.env.OPENWOP_SURFACE_BACKEND;
    try {
    const mem = buildHostSurfaceBundle({ tenantId: 'order-t' }).storage.table;
    const dur = createDurableTable({ tenantId: 'order-t' });
    for (const id of ids) { await mem.insert({ table: 'o', row: { id } }); await dur.insert({ table: 'o', row: { id } }); }
    const walk = async (t: typeof dur) => {
      const out: string[] = []; let cursor: string | undefined;
      for (;;) {
        const r = await t.query({ table: 'o', limit: 2, cursor }) as { rows: Array<{ id: string }>; nextCursor: string | null };
        out.push(...r.rows.map((x) => x.id)); if (!r.nextCursor) return out; cursor = r.nextCursor;
      }
    };
    const want = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(await walk(dur)).toEqual(want);
    expect(await walk(mem as typeof dur)).toEqual(want);
    } finally {
      if (savedEnv.table === undefined) delete process.env.OPENWOP_SURFACE_TABLE; else process.env.OPENWOP_SURFACE_TABLE = savedEnv.table;
      if (savedEnv.backend === undefined) delete process.env.OPENWOP_SURFACE_BACKEND; else process.env.OPENWOP_SURFACE_BACKEND = savedEnv.backend;
    }
  });
});

describe('ADR 0868 — queue receive reads one claim page', () => {
  it('dequeue from a 1000-deep queue reads at most 8 rows, FIFO', async () => {
    const q = createDurableQueue({ tenantId: 'q-t' });
    for (let i = 0; i < 1000; i++) await q.enqueue({ queue: 'deep', payload: i });
    keysRead = [];
    expect(await q.dequeue({ queue: 'deep' })).toMatchObject({ found: true, payload: 0 });
    expect(keysRead.length).toBeLessThanOrEqual(8);
    expect(await q.dequeue({ queue: 'deep' })).toMatchObject({ found: true, payload: 1 });
  });

  it('bus consume reads at most 8 rows', async () => {
    const bus = createDurableQueueBus({ tenantId: 'q-t' });
    for (let i = 0; i < 500; i++) await bus.publish({ subject: 's', payload: i });
    keysRead = [];
    expect(await bus.consume({ subject: 's' })).toMatchObject({ found: true, payload: 0 });
    expect(keysRead.length).toBeLessThanOrEqual(8);
  });
});

describe('ADR 0868 — reads stay inside their prefix and tenant', () => {
  it('kv list(prefix) reads only keys under that prefix', async () => {
    const kv = createDurableKv({ tenantId: 'kv-t' });
    for (let i = 0; i < 50; i++) await kv.set({ key: `other/${i}`, value: i });
    await kv.set({ key: 'want/1', value: 1 });
    await kv.set({ key: 'want/2', value: 2 });
    keysRead = [];
    expect(await kv.list({ prefix: 'want/' })).toEqual({ keys: ['want/1', 'want/2'] });
    expect(keysRead).toHaveLength(2);
  });

  it('fs stat of a directory reads one row', async () => {
    const fs = createDurableFs({ tenantId: 'fs-t' });
    for (let i = 0; i < 30; i++) await fs.write({ path: `dir/f${i}.txt`, contentBase64: 'eA==' });
    keysRead = [];
    expect(await fs.stat({ path: 'dir' })).toMatchObject({ found: true, isDirectory: true });
    expect(keysRead).toHaveLength(1);
  });

  it('purge deletes every family of one tenant and never reads another tenant', async () => {
    for (const t of ['purge-a', 'purge-b']) {
      await createDurableTable({ tenantId: t }).insert({ table: 'x', row: { id: '1' } });
      await createDurableQueue({ tenantId: t }).enqueue({ queue: 'q', payload: 1 });
      await createDurableKv({ tenantId: t }).set({ key: 'k', value: 1 });
      await createDurableFs({ tenantId: t }).write({ path: 'f', contentBase64: 'eA==' });
      await createDurableQueueBus({ tenantId: t }).publish({ subject: 's', payload: 1 });
    }
    keysRead = [];
    const purged = await purgeTenantDurableSurfaces('purge-a');
    // MEASURED 2026-10-24: 8 rows for the five families seeded above (the
    // queue and bus keep bookkeeping rows besides their item); a skipped
    // family lowers it.
    expect(purged).toBe(8);
    // Only the one-row family probes may land on another tenant's key.
    const foreign = keysRead.filter((k) => k.split(':')[2] === 'purge-b');
    const familyCount = new Set(keysRead.map((k) => k.split(':')[1])).size;
    expect(foreign.length).toBeLessThanOrEqual(familyCount);
    const left = await base.kvList('hostsurf:');
    expect(left.filter((r) => r.key.split(':')[2] === 'purge-a')).toEqual([]);
    expect(left.filter((r) => r.key.split(':')[2] === 'purge-b').length).toBeGreaterThanOrEqual(5);
  });

  it("a tenant's DLQ snapshot reads only that tenant's bus", async () => {
    for (const t of ['dlq-a', 'dlq-b']) {
      const bus = createDurableQueueBus({ tenantId: t });
      for (let i = 0; i < 20; i++) await bus.publish({ subject: 'work', payload: i });
      const c = await bus.consume({ subject: 'work' }) as { deliveryToken: string };
      await bus.deadLetter({ deliveryToken: c.deliveryToken, reason: 'boom' });
    }
    keysRead = [];
    const snap = await snapshotDurableDlqSubjects('dlq-a');
    expect(snap).toEqual([expect.objectContaining({ tenantId: 'dlq-a', subject: 'work.dlq', depth: 1 })]);
    expect(keysRead.some((k) => k.includes(':dlq-b:'))).toBe(false);
  });
});

describe('ADR 0868 — the sqlite page and the fallback agree', () => {
  it('prefixUpperBound is the exclusive byte-order bound', () => {
    expect(prefixUpperBound('a:')).toBe('a;');
    expect(prefixUpperBound('')).toBeNull();
    expect(prefixUpperBound('x퟿')).toBe('x');
    expect(prefixUpperBound('x\u{10FFFF}')).toBe('y');
  });

  it('the sqlite page is case-sensitive and treats LIKE metacharacters literally', async () => {
    for (const k of ['cs:a:1', 'cs:A:1', 'cs:_:1', 'cs:%:1', 'cs:b:1']) await base.kvSet(k, '1');
    expect((await base.kvListPage!('cs:a:', { limit: 10 })).map((r) => r.key)).toEqual(['cs:a:1']);
    expect((await base.kvListPage!('cs:_:', { limit: 10 })).map((r) => r.key)).toEqual(['cs:_:1']);
    expect(await base.kvCount!('cs:')).toBe(5);
  });

  it('the kvList fallback returns the same pages as kvListPage', async () => {
    for (const k of ['fb:b', 'fb:B', 'fb:é', 'fb:a', 'fb:_', 'fb:z']) await base.kvSet(k, k);
    const walk = async () => {
      const out: string[] = []; let after: string | undefined;
      for (;;) {
        const p = await listPage('fb:', { after, limit: 2 });
        out.push(...p.map((r) => r.key)); if (p.length < 2) return out; after = p[p.length - 1]!.key;
      }
    };
    withPage = true; const paged = await walk();
    withPage = false; const fallback = await walk();
    expect(fallback).toEqual(paged);
    expect(paged).toEqual(['fb:B', 'fb:_', 'fb:a', 'fb:b', 'fb:z', 'fb:é']);
  });
});

describe('ADR 0868 — telemetry', () => {
  const out: string[] = [];
  beforeEach(() => {
    out.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write);
    process.env.OPENWOP_SURFACE_SCAN_WARN_ROWS = '50';
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.OPENWOP_SURFACE_SCAN_WARN_ROWS; });

  it('a read past the row threshold logs surface_scan_heavy once, with the family and no tenant', async () => {
    for (let i = 0; i < 60; i++) await base.kvSet(`hostsurf:fs:tele-t:p${pad(i)}`, '{}');
    let n = 0;
    for await (const _ of scanPrefix('hostsurf:fs:tele-t:', { batch: 25, op: 'fs.list' })) n++;
    expect(n).toBe(60);
    const lines = out.filter((l) => l.includes('surface_scan_heavy'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"family":"fs"');
    expect(lines[0]).toContain('"rows":60');
    expect(lines[0]).not.toContain('tele-t');
  });

  it('a small page logs nothing', async () => {
    await listPage('hostsurf:fs:tele-t:', { limit: 5 });
    expect(out.filter((l) => l.includes('surface_scan_heavy'))).toEqual([]);
  });
});

describe('ADR 0868 — ratchet: no durable adapter reads a whole range with kvList', () => {
  it('only durableStore.ts (the helpers and their fallback) calls kvList', () => {
    const dir = join(__dirname, '../src/host/durable');
    const offenders = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'durableStore.ts')
      .filter((f) => /\.kvList\(/.test(readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    expect(offenders).toEqual([]);
  });
});
