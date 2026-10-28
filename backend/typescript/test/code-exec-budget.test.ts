/**
 * ADR 0114 Phase 5 — code-exec spend governance (a per-tenant daily execution cap on a
 * paid, high-blast-radius surface).
 *
 * Breaks if the cap is checked after dispatch instead of before, if a successful run is
 * not charged, if `max=0` stops meaning uncapped, or if concurrent reservations lose
 * increments (CXE-3). The race case used to be `it.fails` (BLOCKED-ON-PRODUCT, w24 g2):
 * check → execute → record was not atomic. ADR 0995 D6 made it a reservation, so it is a
 * plain `it` now.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkCodeExecBudget, releaseCodeExec, reserveCodeExec } from '../src/host/codeExecBudget.js';
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
    expect((await reserveCodeExec('t1', DAY)).reserved).toBe(true);
    expect((await reserveCodeExec('t1', DAY)).reserved).toBe(true);
    expect((await checkCodeExecBudget('t1', DAY)).allowed).toBe(false); // 2/2
    expect(await reserveCodeExec('t1', DAY)).toMatchObject({ allowed: false, reserved: false, used: 2 });
    await releaseCodeExec('t1', DAY); // a pre-dispatch refusal gives its unit back
    expect((await checkCodeExecBudget('t1', DAY)).used).toBe(1);
  });

  it('max=0 is uncapped', async () => {
    process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY = '0';
    for (let i = 0; i < 5; i++) expect((await reserveCodeExec('t2', DAY)).allowed).toBe(true);
    expect((await checkCodeExecBudget('t2', DAY)).allowed).toBe(true);
  });

  it('CXE-3: concurrent reservations do not lose increments (atomic CAS)', async () => {
    process.env.OPENWOP_CODE_EXEC_MAX_PER_DAY = '1000';
    const N = 8;
    await Promise.all(Array.from({ length: N }, () => reserveCodeExec('t-cas', DAY)));
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

  // Was `it.fails` (BLOCKED-ON-PRODUCT, w24 g2): the runner read the budget, awaited the sandbox,
  // THEN recorded, so N concurrent calls under the cap all passed the check. ADR 0995 D6 reserves
  // before dispatch. Deterministic: each execution awaits network I/O, so under the old order
  // every check resolved before the first record.
  it('concurrent calls at the cap execute at most max times (ADR 0995 D6 reservation)', async () => {
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
