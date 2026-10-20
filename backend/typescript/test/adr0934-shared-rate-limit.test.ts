/**
 * ADR 0934 P0/P1 — the shared rate limit (`host/sharedRateLimit.ts`).
 *
 * The property that matters is cross-instance: two storage CLIENTS over the same
 * database (SQLite file; pg-mem, which runs the real Postgres adapter SQL) racing
 * on one key never admit more than the limit (on pg-mem, concurrent callers on
 * one pooled client, because pg-mem cannot migrate a second client). Plus: a refusal spends nothing, a
 * new window starts fresh, keys are hashed, both failure postures, and the KV
 * age-out lane reclaims old windows.
 *
 * Sabotage notes (each run, 2026-10-19):
 *  - replace the CAS with kvGet + kvSet → red (the race admits more than 10);
 *  - write the incremented row before the limit check → red (a refusal spends);
 *  - make `closed` degrade like `open` → red (no 503);
 *  - drop the registerKvAgeOut call → red (the old window survives the sweep).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const { pgMemAdapters } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb } = require('pg-mem') as typeof import('pg-mem');
  return { pgMemAdapters: newDb().adapters.createPg() };
});
vi.mock('pg', () => ({ default: pgMemAdapters, ...pgMemAdapters }));

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { SHARED_RATE_LIMIT_PREFIX, takeShared } from '../src/host/sharedRateLimit.js';
import { OpenwopError } from '../src/types.js';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const pairs: Array<{ name: string; a: Storage; b: Storage }> = [];

beforeAll(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'openwop-adr0934-')), 'shared.db');
  pairs.push({ name: 'sqlite', a: await openSqliteStorage(file), b: await openSqliteStorage(file) });
  // pg-mem cannot re-run the migrations for a second client, so on Postgres the
  // racers share one pooled client (concurrent queries through the real adapter
  // SQL); SQLite gets two genuine clients on one file.
  const pg = await openPostgresStorage('postgres://test/test');
  pairs.push({ name: 'postgres', a: pg, b: pg });
});
afterAll(async () => {
  for (const p of pairs) { await p.a.close().catch(() => undefined); if (p.b !== p.a) await p.b.close().catch(() => undefined); }
  __resetHostExtPersistence();
});

describe.each(['sqlite', 'postgres'])('ADR 0934 D1 on %s', (name) => {
  const pair = () => pairs.find((p) => p.name === name)!;

  // pg-mem reports `INSERT … ON CONFLICT DO NOTHING RETURNING` as a row even when
  // it inserted nothing (measured 2026-10-19), so it cannot witness the absent-key
  // race; real Postgres returns no row. The race runs on SQLite here.
  it.skipIf(name === 'postgres')('concurrent takers on two clients never exceed the limit', async () => {
    const { a, b } = pair();
    const key = `token-race-${name}`;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      takeShared({ scope: 'test.race', key, limit: 10, windowS: 600, failure: 'closed', storage: i % 2 ? a : b, now: T0 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed).every((r) => r.remaining === 0 && r.retryAfterS > 0)).toBe(true);
  });

  it('a refusal spends nothing, and a new window starts fresh', async () => {
    const { a, b } = pair();
    const base = { scope: 'test.spend', key: `k-${name}`, limit: 3, windowS: 60, failure: 'closed' as const, now: T0 };
    expect((await takeShared({ ...base, cost: 2, storage: a })).allowed).toBe(true);
    const refused = await takeShared({ ...base, cost: 2, storage: b });
    expect(refused).toMatchObject({ allowed: false, remaining: 1 });
    // The refused 2 were not counted: 1 unit is still there.
    expect(await takeShared({ ...base, storage: b })).toMatchObject({ allowed: true, remaining: 0 });
    expect((await takeShared({ ...base, storage: a })).allowed).toBe(false);
    expect((await takeShared({ ...base, storage: a, now: T0 + 60_000 })).allowed).toBe(true);
  });

  it('stores a hash, never the key', async () => {
    const { a } = pair();
    const secret = `cap-token-${name}-SECRET`;
    await takeShared({ scope: 'test.hash', key: secret, limit: 5, windowS: 60, failure: 'closed', storage: a, now: T0 });
    // pg-mem cannot parse kvList's `LIKE … ESCAPE`, so read the row by its derived key.
    const rowKey = `${SHARED_RATE_LIMIT_PREFIX}test.hash:${createHash('sha256').update(secret).digest('hex').slice(0, 40)}:${Math.floor(T0 / 60_000)}`;
    expect(rowKey).not.toContain(secret);
    const raw = await a.kvGet(rowKey);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw!)).toMatchObject({ n: 1 });
  });
});

describe('ADR 0934 D2 — failure posture', () => {
  const broken = { kvGet: async () => { throw new Error('db down'); }, kvCompareAndSwap: async () => { throw new Error('db down'); } } as unknown as Storage;

  it('closed: a counter failure is a 503 with Retry-After 5, never an unmetered write', async () => {
    const err = await takeShared({ scope: 'test.closed', key: 'k', limit: 5, windowS: 60, failure: 'closed', storage: broken, now: T0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenwopError);
    expect(err).toMatchObject({ code: 'service_unavailable', httpStatus: 503, details: { retryAfterS: 5 } });
  });

  it('open: falls back to a per-process window, marked degraded, still limited', async () => {
    const take = () => takeShared({ scope: 'test.open', key: 'k', limit: 2, windowS: 60, failure: 'open', storage: broken, now: T0 });
    expect(await take()).toMatchObject({ allowed: true, degraded: true });
    expect(await take()).toMatchObject({ allowed: true, degraded: true });
    expect(await take()).toMatchObject({ allowed: false, degraded: true });
  });

  it('refuses a malformed scope or limit', async () => {
    await expect(takeShared({ scope: 'Bad Scope', key: 'k', limit: 1, windowS: 1, failure: 'closed', storage: broken })).rejects.toThrow(/invalid scope/);
    await expect(takeShared({ scope: 'test.x', key: 'k', limit: 0, windowS: 1, failure: 'closed', storage: broken })).rejects.toThrow(/must be > 0/);
  });
});

describe('ADR 0934 P1 — old windows age out on the KV lane', () => {
  it('a window row older than a day is deleted; a current one is kept', async () => {
    const storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    const now = Date.now();
    await takeShared({ scope: 'test.age', key: 'old', limit: 5, windowS: 60, failure: 'closed', now: now - 3 * 86_400_000 });
    await takeShared({ scope: 'test.age', key: 'new', limit: 5, windowS: 60, failure: 'closed', now });
    expect((await storage.kvList(`${SHARED_RATE_LIMIT_PREFIX}test.age:`))).toHaveLength(2);
    const results = await __runKvAgeOutOnce(storage, new Date(now));
    expect(results.find((r) => r.id === 'ratelimit:shared')?.deleted).toBe(1);
    expect((await storage.kvList(`${SHARED_RATE_LIMIT_PREFIX}test.age:`))).toHaveLength(1);
    await storage.close();
  });
});
