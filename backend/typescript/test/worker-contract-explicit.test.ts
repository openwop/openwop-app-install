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
 * tick is wrapped in `runUnderWorkerContract`, so December's flip is one
 * constant and THIS test enumerates the readers it flips: every file under
 * src/host, src/features, src/executor that schedules a `setInterval` and
 * touches storage must enter the seat explicitly.
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
    expect(candidates).toBeGreaterThanOrEqual(10); // non-vacuous: the ten known workers are found
    expect(offenders, `interval workers reaching the event seat through the ambient default:\n${offenders.join('\n')}`).toEqual([]);
  });
});
