/**
 * ADR 0114 Phase 5 — code-exec spend governance (a per-tenant daily execution cap on a
 * paid, high-blast-radius surface).
 *
 * Breaks if the cap is checked after dispatch instead of before, if a successful run is
 * not recorded, if `max=0` stops meaning uncapped, or if concurrent records lose
 * increments (CXE-3). The `it.fails` case pins a KNOWN defect (BLOCKED-ON-PRODUCT, filed
 * to grade-code): check → execute → record is not atomic, so concurrent calls at the cap
 * all pass the check and all execute.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkCodeExecBudget, recordCodeExec } from '../src/host/codeExecBudget.js';
import { createSandboxRunner } from '../src/host/sandboxAdapter.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { codeExecFeature } from '../src/features/code-exec/feature.js';

let server: http.Server;
let PORT = 0;
let hits = 0; // executions that actually reached the sandbox
const DAY = '2026-06-24';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault(codeExecFeature.toggleDefault!); // ADR 0820 §8.2 — the runner's access gate reads it
  server = http.createServer((_req, res) => { hits += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '', files: [] })); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; r(); }));
});
afterEach(() => {
  delete process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY;
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});

describe('codeExecBudget', () => {
  it('allows under the cap, denies at it', async () => {
    process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY = '2';
    expect((await checkCodeExecBudget('t1', DAY)).allowed).toBe(true);
    await recordCodeExec('t1', DAY);
    await recordCodeExec('t1', DAY);
    expect((await checkCodeExecBudget('t1', DAY)).allowed).toBe(false); // 2/2
  });

  it('max=0 is uncapped', async () => {
    process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY = '0';
    for (let i = 0; i < 5; i++) await recordCodeExec('t2', DAY);
    expect((await checkCodeExecBudget('t2', DAY)).allowed).toBe(true);
  });

  it('CXE-3: concurrent records do not lose increments (atomic CAS)', async () => {
    process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY = '1000';
    const N = 8;
    await Promise.all(Array.from({ length: N }, () => recordCodeExec('t-cas', DAY)));
    expect((await checkCodeExecBudget('t-cas', DAY)).used).toBe(N); // a read-then-write would drop some
  });
});

describe('tenant-bound sandbox runner', () => {
  it('executes up to the budget then throws resource_exhausted (no execution over budget)', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${PORT}/run`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY = '2';
    const runner = createSandboxRunner('t-budget')!;
    const before = hits;
    expect((await runner({ language: 'python', code: 'print(1)' })).stdout).toBe('ok'); // 1
    expect((await runner({ language: 'python', code: 'print(2)' })).stdout).toBe('ok'); // 2
    await expect(runner({ language: 'python', code: 'print(3)' })).rejects.toMatchObject({ code: 'resource_exhausted' }); // 3 → over
    expect(hits - before, 'the over-budget call must never reach the sandbox').toBe(2);
  });

  // BLOCKED-ON-PRODUCT (w24 g2): `createSandboxRunner` reads the budget, awaits the sandbox,
  // THEN records — so N concurrent calls under the cap all pass the check before any of them
  // records. Asserts the CORRECT outcome (exactly `max` executions); `it.fails` until the
  // check-and-reserve is atomic. Deterministic: each execution awaits network I/O, so every
  // check resolves before the first record.
  it.fails('concurrent calls at the cap execute at most max times (check→execute→record is not atomic)', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${PORT}/run`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY = '1';
    const runner = createSandboxRunner('t-budget-race')!;
    const before = hits;
    const settled = await Promise.allSettled([1, 2, 3].map((i) => runner({ language: 'python', code: `print(${i})` })));
    expect(hits - before).toBe(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(2);
  });
});
