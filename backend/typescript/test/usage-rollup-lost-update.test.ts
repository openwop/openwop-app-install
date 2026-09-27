/**
 * ADR 0695 (`UAC-3`) — the usage rollup lost almost every concurrent increment.
 *
 * `recordUsage` was a plain read-modify-write. BORN RED, and not marginally:
 * 50 concurrent calls for one (tenant, provider, model) produced `calls=1,
 * inputTokens=1` — 49 of 50 increments dropped. Every caller awaited the same
 * `get`, all read 0, all wrote 1.
 *
 * The filed row said this drops increments "on a MULTI-INSTANCE deploy". That
 * understates it by the margin that matters: the interleave is the Node event
 * loop, so ONE instance serving concurrent chat turns already loses nearly
 * everything. `dispatchTurn.ts` fires this per turn, detached.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { recordUsage, getUsageRollup } from '../src/features/usage-analytics/usageRollupService.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(REPO, 'backend', 'typescript', 'src');
/** Strip comments before asserting on source — a prose mention is not a mechanism
 *  (the "ratchets count comments" trap, hit twice already this session). */
const code = (p: string): string =>
  readFileSync(p, 'utf8').split('\n').filter((l) => !l.trim().startsWith(('*')) && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('ADR 0695 — concurrent increments are not lost', () => {
  it('leg 1: 50 concurrent increments ALL land (was calls=1, inputTokens=1)', async () => {
    const at = new Date().toISOString();
    await Promise.all(Array.from({ length: 50 }, () =>
      recordUsage('uroll-a', { provider: 'p', model: 'm', inputTokens: 2, outputTokens: 3, at })));
    const [row] = await getUsageRollup('uroll-a');
    expect(row?.calls, 'every call counted').toBe(50);
    expect(row?.inputTokens, 'input tokens accumulate exactly').toBe(100);
    expect(row?.outputTokens, 'output tokens accumulate exactly').toBe(150);
  });

  it('leg 2: NO SILENT LOSS at higher concurrency — every call either lands or rejects', async () => {
    const N = 200;
    const at = new Date().toISOString();
    const settled = await Promise.allSettled(Array.from({ length: N }, () =>
      recordUsage('uroll-b', { provider: 'p', model: 'm', inputTokens: 1, at })));
    const rejected = settled.filter((r) => r.status === 'rejected').length;
    const [row] = await getUsageRollup('uroll-b');
    // The invariant that matters is CONSERVATION, not "never rejects": a lost
    // update is invisible, a rejection is not. MEASURED: 50/100/200 all land with
    // zero rejections, so 8 attempts absorbs well past a realistic turn burst.
    expect((row?.calls ?? 0) + rejected, 'landed + rejected must equal N — nothing vanishes').toBe(N);
    expect(row?.inputTokens).toBe(row?.calls);
  });

  it('leg 3: concurrent writes to DIFFERENT keys stay isolated', async () => {
    const at = new Date().toISOString();
    await Promise.all([
      ...Array.from({ length: 20 }, () => recordUsage('uroll-c', { provider: 'p1', model: 'm1', inputTokens: 1, at })),
      ...Array.from({ length: 30 }, () => recordUsage('uroll-c', { provider: 'p2', model: 'm2', inputTokens: 1, at })),
      ...Array.from({ length: 10 }, () => recordUsage('uroll-d', { provider: 'p1', model: 'm1', inputTokens: 1, at })),
    ]);
    const c = await getUsageRollup('uroll-c');
    expect(c.find((r) => r.model === 'm2')?.calls).toBe(30);
    expect(c.find((r) => r.model === 'm1')?.calls).toBe(20);
    const d = await getUsageRollup('uroll-d');
    expect(d.length, 'a different tenant is untouched').toBe(1);
    expect(d[0]?.calls).toBe(10);
  });

  it('leg 4 (structural): exhaustion THROWS — it must never return an unpersisted row', () => {
    const src = code(join(SRC, 'features', 'usage-analytics', 'usageRollupService.ts'));
    expect(src, 'the write goes through compareAndSwap').toContain('compareAndSwap');
    expect(src, 'a bare put would reintroduce the lost update').not.toMatch(/await rollups\.put\(/);
    // Returning the last computed row after the loop would be success-with-wrong-data.
    const after = src.slice(src.indexOf('for (let attempt'));
    expect(after, 'exhaustion throws').toMatch(/throw new Error/);
    expect(after, 'and warns, so a systematic loss is visible even though the caller swallows').toMatch(/logger\.warn\('usage_rollup_contention'/);
  });

  it('leg 5 (structural): the caller logs the failure at WARN, not debug', () => {
    const src = code(join(SRC, 'host', 'exchange', 'dispatchTurn.ts'));
    expect(src, 'a debug-level swallow hides sustained contention').not.toMatch(/logger\.debug\(['"]usage[ _]rollup/);
    expect(src).toMatch(/logger\.warn\('usage_rollup_write_failed'/);
  });
});
