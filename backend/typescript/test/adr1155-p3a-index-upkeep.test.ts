/**
 * ADR 1155 P3a — one upkeep sweep for every declared index (ADR 1110).
 *
 * Commerce and media each ran their own copy of the index upkeep (intent repair,
 * queued builds, an hourly drift check of their own types) over the same global
 * queues. The upkeep now lives once, in `features/entities/systemIndexSweep.ts`, and
 * its drift check covers every registered type, so a new indexed store (kanban,
 * ADR 1155 P3) is checked without adding a third copy.
 *
 * Red if: the drift check stops covering a type no sweep names; it runs twice in one
 * UTC hour; the entities feature stops starting the sweep; or any other module calls
 * the global repair, drain or drift-check functions again.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { builtTenants, queuedBuildCount, rebuildSystemIndex, registerStoreIndex } from '../src/features/entities/systemIndex.js';
import { runSystemIndexUpkeep } from '../src/features/entities/systemIndexSweep.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TYPE = 'test.p3a-upkeep';
const HOUR = 3_600_000;

interface Row { id: string; tenantId: string }
const rows = new Map<string, Row>();
registerStoreIndex<Row>(TYPE, {
  isRow: (v): v is Row => typeof v === 'object' && v !== null && typeof (v as Row).id === 'string' && typeof (v as Row).tenantId === 'string',
  idOf: (r) => r.id,
  tenantOf: (r) => r.tenantId,
  orgOf: () => undefined,
  countedFamily: 'all',
  markers: (r) => [{ family: 'all', segments: [r.id], p: {} }],
  read: async (tenantId, id) => { const r = rows.get(id); return r && r.tenantId === tenantId ? r : null; },
  scan: async function* (tenantId) { for (const r of rows.values()) if (r.tenantId === tenantId) yield r; },
  count: async (tenantId) => [...rows.values()].filter((r) => r.tenantId === tenantId).length,
});

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  rows.clear();
});

describe('ADR 1155 P3a — the one index upkeep sweep', () => {
  it('drift-checks a type that no feature sweep names, once per UTC hour', async () => {
    rows.set('r1', { id: 'r1', tenantId: 'tA' });
    rows.set('r2', { id: 'r2', tenantId: 'tA' });
    await rebuildSystemIndex('tA', TYPE);
    const built: string[] = [];
    for await (const t of builtTenants(TYPE)) built.push(t);
    expect(built).toEqual(['tA']);

    // A row written without the index's hooks (an older revision, say): the store now
    // counts 3 rows and the index 2.
    rows.set('r3', { id: 'r3', tenantId: 'tA' });
    const t0 = Date.UTC(2026, 10, 23, 12);
    expect((await runSystemIndexUpkeep(t0)).drifted).toBe(1);
    expect(await queuedBuildCount()).toBe(1);
    expect((await runSystemIndexUpkeep(t0 + 60_000)).built).toBe(1); // the next tick builds it
    rows.set('r4', { id: 'r4', tenantId: 'tA' });
    expect((await runSystemIndexUpkeep(t0 + 30 * 60_000)).drifted).toBe(0); // same hour: no second check
    expect((await runSystemIndexUpkeep(t0 + HOUR)).drifted).toBe(1); // the next hour catches it
  });

  it('the entities feature starts the sweep, and nothing else runs the global upkeep', () => {
    expect(readFileSync(path.join(SRC, 'features/entities/feature.ts'), 'utf8')).toMatch(/^\s+startSystemIndexSweep\(\);/m);

    const OWNERS = new Set(['features/entities/systemIndex.ts', 'features/entities/systemIndexSweep.ts']);
    const CALL = /\b(repairSystemIndex|drainSystemIndexBuilds|checkSystemIndex)\(/;
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== '__tests__') walk(full); continue; }
        if (!name.endsWith('.ts')) continue;
        scanned += 1;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        if (OWNERS.has(rel)) continue;
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => { if (CALL.test(line)) offenders.push(`${rel}:${i + 1}`); });
      }
    };
    walk(SRC);
    expect(scanned, 'the src walk found almost nothing — the walker is broken').toBeGreaterThan(500);
    expect(offenders, 'a second module runs the global index upkeep — call runSystemIndexUpkeep\'s sweep instead').toEqual([]);
  });
});
