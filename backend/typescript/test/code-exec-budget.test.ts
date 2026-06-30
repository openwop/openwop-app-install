/**
 * ADR 0114 Phase 5 — code-exec spend governance.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkCodeExecBudget, recordCodeExec } from '../src/host/codeExecBudget.js';
import { createSandboxRunner } from '../src/host/sandboxAdapter.js';

let server: http.Server;
let PORT = 0;
const DAY = '2026-06-24';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '', files: [] })); });
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
    expect((await runner({ language: 'python', code: 'print(1)' })).stdout).toBe('ok'); // 1
    expect((await runner({ language: 'python', code: 'print(2)' })).stdout).toBe('ok'); // 2
    await expect(runner({ language: 'python', code: 'print(3)' })).rejects.toMatchObject({ code: 'resource_exhausted' }); // 3 → over
  });
});
