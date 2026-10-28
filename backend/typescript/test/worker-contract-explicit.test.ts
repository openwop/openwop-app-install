import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKER_CONTRACT, runUnderWorkerContract, runUnderContract, currentContract } from '../src/storage/eventEraAdapter.js';

/**
 * ADR 0650 — background workers enter the event seat under a NAMED contract.
 *
 * Before this ADR every daemon reached the seat by falling through
 * `currentContract()`'s `?? 1` — an ambient default no worker chose, and
 * indistinguishable from a request that forgot to negotiate. Now each worker
 * tick is wrapped in `runUnderWorkerContract`, and THIS test enumerates the
 * readers: every file under src/host, src/features, src/executor that schedules a
 * `setInterval` and touches storage must enter the seat explicitly.
 *
 * (CORRECTED wave 64: this used to say "December's flip is one constant". Per the
 * product's own ADR 0812 D1 correction in `storage/eventEraAdapter.ts`, the worker
 * contract is the storage vocabulary every worker was written against and does NOT
 * flip with v1 retirement.)
 *
 * Sabotage-witnessed: unwrapping a worker's tick (8fw5g1-wk-ratchet) reds case 3;
 * making `runUnderWorkerContract` a pass-through (wk-explicit) reds case 2. Case 1's
 * second assertion is DOUBLE-GUARDED by `currentContract()`'s `?? 1` fallback, which
 * equals WORKER_CONTRACT today — case 2 (inside a major-2 context) carries the claim.
 */
function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

describe('ADR 0650 — the worker contract is explicit', () => {
  it('is 1 today, and a worker sees exactly that', () => {
    expect(WORKER_CONTRACT).toBe(1);
    expect(runUnderWorkerContract(() => currentContract())).toBe(WORKER_CONTRACT);
  });

  it('a worker entering from inside a major-2 request context still reads as a worker (explicit beats ambient)', () => {
    const seen = runUnderContract(2, () => ({ outer: currentContract(), inner: runUnderWorkerContract(() => currentContract()) }));
    expect(seen.outer).toBe(2);
    expect(seen.inner).toBe(WORKER_CONTRACT);
  });

  it('every storage-touching interval worker enters the seat explicitly', () => {
    const offenders: string[] = [];
    let candidates = 0;
    for (const dir of ['src/host', 'src/features', 'src/executor']) {
      for (const f of tsFiles(dir)) {
        const text = readFileSync(f, 'utf8');
        if (!/setInterval\(/.test(text)) continue;
        if (!/\bstorage\.|\bStorage\b/.test(text)) continue;
        candidates += 1;
        if (!/runUnderWorkerContract\(/.test(text)) offenders.push(f);
      }
    }
    // Non-vacuous: MEASURED 16 storage-touching interval workers at 19d13e682 (wave 64).
    expect(candidates).toBeGreaterThanOrEqual(16);
    expect(offenders, `interval workers reaching the event seat through the ambient default:\n${offenders.join('\n')}`).toEqual([]);
  });
});
