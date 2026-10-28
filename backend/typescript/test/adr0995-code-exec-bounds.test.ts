/**
 * ADR 0995 — code execution: the node gate and the sandbox bounds (feature loop round 2, row 62).
 *
 * Born as red probes on origin/main `5bc6ba89b`. Each `it` states a property the node lane or
 * the sandbox boundary must hold:
 *   D1/D2  through the REAL executor + interrupt route: the gate's prompt is a string, it shows
 *          the code, and the canonical `{action:'approve'}` RUNS it (it read as a decline);
 *   D3     the WASI guest cannot allocate past the memory cap (the binary declares no max);
 *   D4     guest writes are bounded, and a wall-clock kill leaves no scratch dir behind;
 *   D5     an external sandbox's output is capped and an oversized body is refused;
 *   D6     a far-end timeout is charged, a pre-dispatch refusal is not;
 *   D8     in production the WASI rung needs an explicit opt-in.
 * (TST) Red when: the node reads `{decision:'approved'}` again or suspends with an object prompt;
 * `capWasmMemory` is skipped; the watchdog or the host-owned cleanup is removed; the adapters
 * stop normalizing; the runner records after dispatch; the production opt-in is dropped.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { capWasmMemory, closeFdsUnder, runWasiSandboxedCode, unlinkedOpenBytes, wasiRuntimeEnabled, wasmPath } from '../src/host/wasiSandbox.js';
import { createSandboxRunner, normalizeSandboxResult, readJsonCapped } from '../src/host/sandboxAdapter.js';
import { checkCodeExecBudget } from '../src/host/codeExecBudget.js';
import { getSetCookies } from './headerCookies.js';
import { bareRunId } from './support/bareRunId.js';

const T = 60_000;
const wasm = existsSync(wasmPath());

let BASE = '';
let fake: http.Server;
let fakeMode: 'big' | 'hang' | 'huge' = 'big';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const d = getToggleDefault('code-exec'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  fake = http.createServer((_req, res) => {
    if (fakeMode === 'hang') return; // never answers → the client times out
    res.writeHead(200, { 'content-type': 'application/json' });
    if (fakeMode === 'huge') { res.end(JSON.stringify({ exitCode: 0, stdout: 'X'.repeat(30_000_000), stderr: '' })); return; }
    res.end(JSON.stringify({ exitCode: 0, stdout: 'X'.repeat(5_000_000), stderr: '', files: [] }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
});
afterAll(async () => { await new Promise<void>((r) => fake.close(() => r())); });

function client(): { call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
  };
}

(wasm ? describe : describe.skip)('P-NODE — the workflow node lane through the real executor + interrupt route', () => {
  it('the approval shows the code as a renderable prompt, and approving it RUNS the code', async () => {
    const tenantId = `org:ce62-${randomBytes(3).toString('hex')}`;
    const owner = client();
    expect((await owner.call('POST', '/host/openwop-app/test/login', { email: `ce62-${randomBytes(3).toString('hex')}@acme.test`, tenantId })).status).toBe(201);
    const workflowId = `ce62-${randomBytes(3).toString('hex')}`;
    registerWorkflow({ workflowId, name: 'ce', version: '1', nodes: [{ nodeId: 'run', typeId: 'feature.code-exec.nodes.run', inputs: { language: 'python', code: 'print(6*7)' } }], edges: [] } as never);
    const create = await owner.call('POST', '/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = String(create.body.runId);
    const waitFor = async (pred: (s: string) => boolean): Promise<string> => {
      for (let i = 0; i < 400; i++) { const s = String((await owner.call('GET', `/runs/${runId}`)).body.status); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 25)); }
      return 'timeout';
    };
    const first = await waitFor((s) => s.startsWith("waiting") || ["completed", "failed"].includes(s));
    expect(first, JSON.stringify((await owner.call("GET", `/runs/${runId}`)).body).slice(0, 1500)).toMatch(/^waiting/);
    const list = (await owner.call('GET', `/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts as Array<{ nodeId: string; kind: string; data?: Record<string, unknown> }>;
    const gate = list[0]!;
    expect(gate.kind).toBe('approval');
    expect(typeof gate.data?.prompt, 'both approval cards render data.prompt as a React text child').toBe('string');
    expect(JSON.stringify(gate.data), 'the approver must see the code they approve').toContain('print(6*7)');
    const resolved = await owner.call('POST', `/runs/${runId}/interrupts/${gate.nodeId}`, { resumeValue: { action: 'approve' } });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300);
    expect(await waitFor((s) => ['completed', 'failed'].includes(s))).toBe('completed');
    const run = (await owner.call('GET', `/runs/${runId}`)).body as { nodes?: unknown };
    expect(JSON.stringify(run), 'an approved gate executes; the canonical approve must not read as a decline').not.toContain('execution declined by approver');
    const events = (await owner.call("GET", `/runs/${runId}/events/poll`)).body;
    expect(JSON.stringify(events), 'the sandbox actually ran the approved code').toContain(JSON.stringify({ stdout: '42\n' }).slice(1, -1));
  }, T);
});

describe('D3 — capWasmMemory', () => {
  // A minimal module: magic + version, then a memory section with ONE memory, flags 0, min 1.
  const tiny = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01]);
  const memLimits = (b: Uint8Array): number[] => Array.from(b.subarray(8));
  it('sets flags 1, keeps the minimum, adds the maximum', () => {
    expect(memLimits(capWasmMemory(tiny, 300))).toEqual([0x05, 0x05, 0x01, 0x01, 0x01, 0xac, 0x02]);
  });
  it('refuses a module it cannot bound (no memory, shared/64-bit memory, minimum over the cap)', () => {
    expect(() => capWasmMemory(tiny.subarray(0, 8), 300)).toThrow(/no memory/);
    const shared = tiny.slice(); shared[11] = 0x03;
    expect(() => capWasmMemory(shared, 300)).toThrow(/flags/);
    expect(() => capWasmMemory(tiny, 0)).toThrow(/minimum/);
  });
  (wasm ? it : it.skip)('the vendored CPython binary is rewritten to a bounded memory', () => {
    const out = capWasmMemory(new Uint8Array(readFileSync(wasmPath())), 4096);
    const Wasm = (globalThis as unknown as { WebAssembly: { Module: new (b: Uint8Array) => object } }).WebAssembly;
    expect(() => new Wasm.Module(out)).not.toThrow();
  });
});

describe('D4 (review H1) — open-but-unlinked scratch files are counted and closed', () => {
  // A stand-in for /proc/self/fd: entries named by fd number, linking to the file they hold.
  // The kernel's text for an unlinked file is "<path> (deleted)"; a real file with that name
  // lets the size be read through the link the same way.
  it('counts only unlinked files under the scratch dir, and closes only fds under it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ce995-')));
    const scratch = join(root, 'scratch'); mkdirSync(scratch);
    const proc = join(root, 'fd'); mkdirSync(proc);
    try {
      writeFileSync(join(scratch, 'big (deleted)'), Buffer.alloc(4096));
      writeFileSync(join(scratch, 'linked'), Buffer.alloc(100));
      writeFileSync(join(root, 'elsewhere (deleted)'), Buffer.alloc(999));
      symlinkSync(join(scratch, 'big (deleted)'), join(proc, '901'));
      symlinkSync(join(scratch, 'linked'), join(proc, '902'));
      symlinkSync(join(root, 'elsewhere (deleted)'), join(proc, '903'));
      expect(await unlinkedOpenBytes(scratch, proc)).toBe(4096);

      const inside = openSync(join(scratch, 'linked'), 'r');
      const outside = openSync(join(root, 'elsewhere (deleted)'), 'r');
      const proc2 = join(root, 'fd2'); mkdirSync(proc2);
      symlinkSync(join(scratch, 'linked'), join(proc2, String(inside)));
      symlinkSync(join(root, 'elsewhere (deleted)'), join(proc2, String(outside)));
      expect(await closeFdsUnder(scratch, proc2)).toBe(1);
      expect(() => fstatSync(inside), 'the fd under the scratch dir is closed').toThrow();
      expect(() => fstatSync(outside), 'an fd elsewhere is untouched').not.toThrow();
      closeSync(outside);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('D8 — production needs an explicit WASI opt-in', () => {
  it('asset present: on in dev, off in production, on in production with RUNTIME=wasi', () => {
    if (!wasm) return;
    const env = process.env.NODE_ENV;
    try {
      delete process.env.OPENWOP_CODE_EXEC_RUNTIME;
      process.env.NODE_ENV = 'test';
      expect(wasiRuntimeEnabled()).toBe(true);
      process.env.NODE_ENV = 'production';
      expect(wasiRuntimeEnabled()).toBe(false);
      process.env.OPENWOP_CODE_EXEC_RUNTIME = 'wasi';
      expect(wasiRuntimeEnabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = env;
      delete process.env.OPENWOP_CODE_EXEC_RUNTIME;
    }
  });
});

describe('D5 — normalizeSandboxResult / readJsonCapped', () => {
  it('coerces types, caps text, caps files by count and size', () => {
    const r = normalizeSandboxResult({
      exitCode: 'nope', stdout: { not: 'a string' }, stderr: 'E'.repeat(2_000_000), timedOut: 'yes',
      files: [...Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, base64: 'QQ==' })), { name: 'bad' }],
    }, 7);
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toBe('');
    expect(r.stderr.length).toBeLessThan(1_100_000);
    expect(r.stderr).toContain('file(s) dropped');
    expect(r.timedOut).toBe(false);
    expect(r.files).toHaveLength(16);
  });
  it('refuses a body over the cap without buffering it all', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> { for (let i = 0; i < 100; i++) yield new Uint8Array(1024); }
    await expect(readJsonCapped({ body: chunks() }, 10_000)).rejects.toMatchObject({ code: 'sandbox_transport_error', message: 'sandbox_response_too_large' });
  });
});

(wasm ? describe : describe.skip)('P-WASI — the in-process sandbox bounds', () => {
  it('a timed-out run leaves no scratch directory behind', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('owp-wasi-')));
    const r = await runWasiSandboxedCode({ language: 'python', code: 'open("/tmp/x","w").write("A"*1000000)\nwhile True: pass', timeoutMs: 2_500 });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith('owp-wasi-') && !before.has(n));
    expect(leaked).toEqual([]);
  }, T);

  it('guest memory is capped (a 1.5 GB allocation fails inside the guest)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'b = bytearray(1536*1024*1024)\nprint("ALLOCATED")', timeoutMs: 30_000 });
    expect(r.stdout).not.toContain('ALLOCATED');
  }, T);

  it('guest scratch writes are capped (cannot fill the host tmpfs for the whole wall clock)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'f=open("/tmp/big","wb")\nfor i in range(400): f.write(b"A"*1048576)\nf.close()\nprint("WROTE")', timeoutMs: 60_000 });
    expect(r.stdout).not.toContain('WROTE');
    expect(r.stderr).toBe('sandbox_disk_limit');
  }, T);

  it('a print loop is bounded by the same watchdog (the capture file counts)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'while True: print("A"*65536)', timeoutMs: 60_000 });
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toBe('sandbox_disk_limit');
  }, T);

  it('ordinary code still runs (positive control for the caps)', async () => {
    const r = await runWasiSandboxedCode({ language: 'python', code: 'b = bytearray(32*1024*1024)\nopen("/tmp/x","w").write("A"*1000000)\nprint(len(b))' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(String(32 * 1024 * 1024));
  }, T);
});

describe('P-API — external adapters', () => {
  it('Code-API stdout is capped like the WASI runtime caps it', async () => {
    fakeMode = 'big';
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/exec`;
    try {
      const run = createSandboxRunner(`org:ce62cap-${randomBytes(3).toString('hex')}`)!;
      const r = await run({ language: 'python', code: 'print(1)' });
      expect(r.stdout.length).toBeLessThanOrEqual(1_100_000);
    } finally { delete process.env.OPENWOP_CODE_EXEC_ENDPOINT; }
  }, T);

  it('an oversized response body is refused, not buffered', async () => {
    fakeMode = 'huge';
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/exec`;
    try {
      const run = createSandboxRunner(`org:ce62huge-${randomBytes(3).toString('hex')}`)!;
      await expect(run({ language: 'python', code: 'print(1)' })).rejects.toMatchObject({ code: 'sandbox_transport_error', message: 'sandbox_response_too_large' });
    } finally { delete process.env.OPENWOP_CODE_EXEC_ENDPOINT; fakeMode = 'big'; }
  }, T);

  it('a refusal before dispatch gives its reservation back', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/exec`;
    const tenant = `org:ce62ref-${randomBytes(3).toString('hex')}`;
    try {
      const run = createSandboxRunner(tenant)!;
      await expect(run({ language: 'cobol', code: 'x' })).rejects.toMatchObject({ code: 'validation_error' });
      expect((await checkCodeExecBudget(tenant, new Date().toISOString().slice(0, 10))).used).toBe(0);
    } finally { delete process.env.OPENWOP_CODE_EXEC_ENDPOINT; }
  }, T);

  it('an execution that times out at the far end still counts against the daily budget', async () => {
    fakeMode = 'hang';
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/exec`;
    const tenant = `org:ce62bud-${randomBytes(3).toString('hex')}`;
    try {
      const run = createSandboxRunner(tenant)!;
      await expect(run({ language: 'python', code: 'while True: pass', timeoutMs: 300 })).rejects.toMatchObject({ code: 'sandbox_transport_error' });
      const day = new Date().toISOString().slice(0, 10);
      expect((await checkCodeExecBudget(tenant, day)).used).toBe(1);
    } finally { delete process.env.OPENWOP_CODE_EXEC_ENDPOINT; fakeMode = 'big'; }
  }, T);
});
