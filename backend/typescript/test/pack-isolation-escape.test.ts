/**
 * ADR 0555 P2 — THE ESCAPE SUITE. The gate for the first production isolation
 * adapter: filesystem, env, network, process, CPU, memory, timeout, cross-pack.
 *
 * Every test below runs a REAL pack in a REAL forked process through the REAL
 * adapter, broker and dispatch registry. Nothing is mocked, because the property
 * under test is a property of the runtime and the OS, and a mock of the runtime
 * would be a test of the mock.
 *
 * ── THE TWO WAYS THIS SUITE COULD LIE, AND WHAT STOPS EACH ────────────────
 *
 * 1. "Denied" that is really "never ran". A probe that simply failed to execute
 *    would satisfy every `expect(denied)` here. So each probe REPORTS its
 *    outcome back through a brokered host-call and the assertions read that
 *    report — a probe that never ran reports nothing and `probeOf` throws.
 *    The first describe block additionally proves the harness can observe an
 *    ALLOWED escape, by asserting the allowed cases really are allowed.
 * 2. "Enforced" that is really "this Node has no permission model". The
 *    guarantees are computed from `process.allowedNodeEnvironmentFlags`, so a
 *    runtime without it reports `not-enforced` and the untrusted tier becomes
 *    undispatchable. The first block asserts the flag IS present here, so a
 *    silent downgrade of the whole suite to a weaker runtime is itself a red.
 *
 * NETWORK IS DELIBERATELY ASSERTED AS NOT CONTAINED. `node:net` reaches the
 * network from inside the isolate and this suite pins that fact rather than
 * omitting it, because the honest record and the test have to say the same
 * thing. See `isolationGuarantees.ts` for why it cannot be closed on this
 * platform, and note the adapter reports `network-denied: 'not-enforced'`
 * accordingly — that pairing is what makes the gap auditable instead of
 * forgotten.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __resetPackDispatchRegistryForTests } from '../src/host/packDispatchRegistry.js';
import {
  childAdapterGuarantees,
  childSpawnOptions,
  permissionFlag,
} from '../src/host/isolation/childProcessAdapter.js';
import {
  ISOLATION_MEMORY_CODE,
  ISOLATION_TIMEOUT_CODE,
} from '../src/host/packWorkerContract.js';
import { probeBody, probeOf, runProbe, writeProbePack } from './support/isolatedPack.js';

/** Directories the suite creates and must remove — enumerated, never globbed. */
const created: string[] = [];
function pack(body: string, prefix?: string): string {
  const dir = writeProbePack(body, prefix ? { dirPrefix: prefix } : {});
  created.push(dir);
  return dir;
}

beforeEach(() => {
  __resetPackDispatchRegistryForTests();
  delete process.env.OPENWOP_PACK_ISOLATION_EXTRA_FS_READ;
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENWOP_PACK_ISOLATION_EXTRA_FS_READ;
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('the suite is not vacuous', () => {
  it('this runtime HAS the permission model, so the enforced guarantees are real here', () => {
    // If this ever goes red the rest of the suite is testing a different,
    // weaker adapter than the one production runs, and every "denied" below
    // would need re-reading. Better to fail loudly on the premise.
    expect(permissionFlag()).not.toBeNull();
    const g = childAdapterGuarantees();
    expect(g['filesystem-allowlist']).toBe('enforced');
    expect(g['no-subprocess']).toBe('enforced');
    expect(g['no-worker-threads']).toBe('enforced');
    expect(g['no-native-addons']).toBe('enforced');
    // The honest gap, pinned in the same breath as the guarantees.
    expect(g['network-denied']).toBe('not-enforced');
  });

  it('a probe really executes, really returns, and really runs in ANOTHER process', async () => {
    const dir = pack(`
      await ctx.report({ label: 'pid', ok: true, value: String(process.pid) });
      return { status: 'success', outputs: { ran: true } };`);
    const run = await runProbe(dir);
    expect(run.result.status).toBe('success');
    expect(run.result.status === 'success' && run.result.outputs).toEqual({ ran: true });
    // The whole difference from P1's fake adapter, in one assertion.
    expect(probeOf(run, 'pid').value).not.toBe(String(process.pid));
  }, 30_000);
});

/* ── filesystem ───────────────────────────────────────────────────────────── */

describe('FILESYSTEM: reads and writes are confined to the allowlist', () => {
  it('reading a host file OUTSIDE the allowlist is denied by the runtime', async () => {
    const dir = pack(probeBody('read-outside', `
      const fs = await import('node:fs');
      return fs.readFileSync('/etc/hosts', 'utf-8').length;`));
    const p = probeOf(await runProbe(dir), 'read-outside');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('ERR_ACCESS_DENIED');
  }, 30_000);

  it('reading its OWN pack directory is ALLOWED — the allowlist is a boundary, not a blanket', async () => {
    // Without this, the test above would also pass on an adapter that denied
    // EVERYTHING including the pack's own files — a broken adapter, not a
    // contained one, and indistinguishable from a working one by denial alone.
    // The path comes from `import.meta.url` rather than an env var, because the
    // isolate has no environment at all.
    const dir = pack(probeBody('read-own', `
      const fs = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      return fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8').length;`));
    const p = probeOf(await runProbe(dir), 'read-own');
    expect(p.ok, `expected the pack to read its own entry, got ${JSON.stringify(p)}`).toBe(true);
    expect(Number(p.value)).toBeGreaterThan(0);
  }, 30_000);

  it('writing into the host tree is denied', async () => {
    const target = join(tmpdir(), `owp-escape-target-${process.pid}.txt`);
    const dir = pack(probeBody('write-host', `
      const fs = await import('node:fs');
      fs.writeFileSync(${JSON.stringify(target)}, 'escaped');
      return 'wrote';`));
    const p = probeOf(await runProbe(dir), 'write-host');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('ERR_ACCESS_DENIED');
    // The negative half: nothing landed. A denial that still wrote the file
    // would be a permission error raised after the effect.
    expect(existsSync(target)).toBe(false);
  }, 30_000);

  it('writing into its OWN per-dispatch scratch cwd is allowed', async () => {
    const dir = pack(probeBody('write-scratch', `
      const fs = await import('node:fs');
      const path = await import('node:path');
      const f = path.join(process.cwd(), 'scratch.txt');
      fs.writeFileSync(f, 'ok');
      return fs.readFileSync(f, 'utf-8');`));
    const p = probeOf(await runProbe(dir), 'write-scratch');
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect(p.value).toBe('ok');
  }, 30_000);
});

/* ── env ──────────────────────────────────────────────────────────────────── */

describe('ENV: the host environment does not reach the isolate', () => {
  /**
   * The ENFORCED half, asserted structurally because it cannot be seen from
   * inside.
   *
   * Found by the sabotage pass: replacing `env: {}` with `env: process.env` left
   * the behavioural test below GREEN, because the worker entry also blanks
   * `process.env` in-realm and a probe reading its own environment sees an empty
   * bag either way. The attenuation was masking the enforcement, so the one test
   * that looked like it proved `scrubbed-env` proved only the cosmetic half —
   * and the real guarantee could have been deleted silently.
   */
  it('the isolate is SPAWNED with an empty environment, whatever the host holds', () => {
    process.env.OPENWOP_TEST_ISOLATION_SECRET = 'super-secret-value';
    try {
      const options = childSpawnOptions({
        entryPath: '/w/worker.mjs',
        packDir: '/p',
        scratch: '/s',
        flags: new Set(['--permission']),
        env: process.env,
      });
      expect(options.env).toEqual({});
      expect(Object.keys(options.env)).toHaveLength(0);
    } finally {
      delete process.env.OPENWOP_TEST_ISOLATION_SECRET;
    }
  });

  it('a host secret set in process.env is invisible, and the env is empty', async () => {
    process.env.OPENWOP_TEST_ISOLATION_SECRET = 'super-secret-value';
    try {
      const dir = pack(`
        await ctx.report({
          label: 'env',
          ok: true,
          keys: Object.keys(process.env).length,
          leaked: process.env.OPENWOP_TEST_ISOLATION_SECRET ?? null,
          anyOpenwop: Object.keys(process.env).filter((k) => k.startsWith('OPENWOP_')),
        });
        return { status: 'success', outputs: {} };`);
      const run = await runProbe(dir);
      const p = run.reported[0] as { keys: number; leaked: string | null; anyOpenwop: string[] };
      expect(p.leaked).toBeNull();
      expect(p.anyOpenwop).toEqual([]);
      expect(p.keys).toBe(0);
    } finally {
      delete process.env.OPENWOP_TEST_ISOLATION_SECRET;
    }
  }, 30_000);
});

/* ── network ──────────────────────────────────────────────────────────────── */

describe('NETWORK: attenuated, NOT denied — and the record says so', () => {
  let server: Server;
  let port = 0;

  beforeEach(async () => {
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('the network GLOBALS are gone from the isolate (attenuation)', async () => {
    const dir = pack(`
      await ctx.report({
        label: 'globals',
        fetch: typeof globalThis.fetch,
        ws: typeof globalThis.WebSocket,
        es: typeof globalThis.EventSource,
      });
      return { status: 'success', outputs: {} };`);
    const run = await runProbe(dir);
    expect(run.reported[0]).toEqual({ label: 'globals', fetch: 'undefined', ws: 'undefined', es: 'undefined' });
  }, 30_000);

  it('`node:net` STILL REACHES THE NETWORK — the gap this adapter does not close', async () => {
    // This assertion is deliberately positive. If a future change actually
    // contains network egress, THIS test goes red and the change is required to
    // flip `network-denied` to `enforced` in the same commit — which is exactly
    // the coupling that keeps the guarantee record true.
    const dir = pack(probeBody('net', `
      const net = await import('node:net');
      return await new Promise((res, rej) => {
        const s = net.connect(${port}, '127.0.0.1', () => { s.destroy(); res('connected'); });
        s.on('error', rej);
      });`));
    const p = probeOf(await runProbe(dir), 'net');
    expect(p.ok, 'network egress is expected to SUCCEED; see isolationGuarantees.ts').toBe(true);
    expect(p.value).toBe('connected');
    expect(childAdapterGuarantees()['network-denied']).toBe('not-enforced');
  }, 30_000);
});

/* ── process ──────────────────────────────────────────────────────────────── */

describe('PROCESS: no subprocess, no worker, no native addon, no dynamic code', () => {
  it('spawning a subprocess is denied', async () => {
    const dir = pack(probeBody('spawn', `
      const cp = await import('node:child_process');
      return cp.execSync('echo escaped').toString();`));
    const p = probeOf(await runProbe(dir), 'spawn');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('ERR_ACCESS_DENIED');
  }, 30_000);

  it('creating a worker thread is denied', async () => {
    const dir = pack(probeBody('worker', `
      const wt = await import('node:worker_threads');
      const w = new wt.Worker('1', { eval: true });
      await w.terminate();
      return 'created';`));
    const p = probeOf(await runProbe(dir), 'worker');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('ERR_ACCESS_DENIED');
  }, 30_000);

  it('loading a native addon is denied — an addon escapes every JS-level control', async () => {
    const dir = pack(probeBody('dlopen', `
      process.dlopen({ exports: {} }, '/nonexistent.node');
      return 'loaded';`));
    const p = probeOf(await runProbe(dir), 'dlopen');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('ERR_DLOPEN_DISABLED');
  }, 30_000);

  it('`eval` and `new Function` are denied', async () => {
    const dir = pack(probeBody('eval', `
      return String(eval('1+1')) + ':' + String(new Function('return 2')());`));
    const p = probeOf(await runProbe(dir), 'eval');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('EvalError');
  }, 30_000);

  it('`process.binding` is denied, so the internal bindings are not a side door', async () => {
    const dir = pack(probeBody('binding', `
      return typeof process.binding('fs');`));
    const p = probeOf(await runProbe(dir), 'binding');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('ERR_ACCESS_DENIED');
  }, 30_000);

  it('`process.send` is gone, and the channel that must remain exposes nothing that can send', async () => {
    // `process.channel` cannot be removed — doing so stops the child receiving
    // messages and breaks the transport (measured; see the worker entry). So
    // this asserts the MEASURED shape of what is left rather than pretending it
    // is absent: ref/unref/fd, and no callable member.
    const dir = pack(`
      const ch = process.channel;
      await ctx.report({
        label: 'ipc',
        send: typeof process.send,
        disconnect: typeof process.disconnect,
        channelFns: ch ? Object.getOwnPropertyNames(ch).filter((k) => typeof ch[k] === 'function') : null,
        channelProto: ch ? Object.getOwnPropertyNames(Object.getPrototypeOf(ch)).sort() : null,
      });
      return { status: 'success', outputs: {} };`);
    const run = await runProbe(dir);
    const p = run.reported[0] as { send: string; disconnect: string; channelFns: string[]; channelProto: string[] };
    expect(p.send).toBe('undefined');
    expect(p.disconnect).toBe('undefined');
    expect(p.channelFns).toEqual([]);
    // A new member appearing here is a change in what a pack can reach through
    // the channel, and must be re-assessed rather than absorbed silently.
    expect(p.channelProto).toEqual(['constructor', 'fd', 'ref', 'refCounted', 'unref', 'unrefCounted']);
  }, 30_000);
});

/* ── CPU / memory / wall clock ────────────────────────────────────────────── */

describe('CPU, MEMORY and WALL CLOCK end in TERMINATION, not abandonment', () => {
  it('a busy loop is KILLED at the deadline', async () => {
    // P1's fake adapter could only abandon this — the loop would keep the event
    // loop pinned for the rest of the process's life. Here it dies.
    const dir = pack(`
      for (;;) { Math.sqrt(Math.random()); }`);
    const started = Date.now();
    const run = await runProbe(dir, { wallClockMs: 1_200 });
    expect(run.result.status).toBe('failure');
    expect(run.result.status === 'failure' && run.result.error.code).toBe(ISOLATION_TIMEOUT_CODE);
    // Bounded ABOVE as well: a "timeout" that took ten times the budget would
    // mean the kill did not happen and the process merely finished.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('an IDLE node that never returns is killed at the deadline too', async () => {
    const dir = pack(`
      await new Promise(() => {});
      return { status: 'success', outputs: {} };`);
    const run = await runProbe(dir, { wallClockMs: 1_200 });
    expect(run.result.status === 'failure' && run.result.error.code).toBe(ISOLATION_TIMEOUT_CODE);
  }, 30_000);

  it('the CONFIGURED heap ceiling is passed to the isolate', () => {
    // Structural, for the same reason as the env pin above: the sabotage pass
    // found that DELETING `--max-old-space-size` left the behavioural test
    // green, because V8 still has a default ~4GB ceiling and the bomb
    // eventually hit THAT instead. That test proved "some limit exists"; this
    // one proves we set the one we claim.
    process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB = '77';
    try {
      const options = childSpawnOptions({
        entryPath: '/w/worker.mjs', packDir: '/p', scratch: '/s',
        flags: new Set(['--permission']), env: process.env,
      });
      expect(options.execArgv).toContain('--max-old-space-size=77');
    } finally {
      delete process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB;
    }
  });

  /**
   * The BOUNDED allocation is the discriminator, and finding that took three
   * attempts worth recording, because the first two were tests that could not
   * fail.
   *
   * An UNBOUNDED bomb (below) proves containment but cannot prove WHOSE ceiling
   * stopped it: with the flag deleted, V8's default limit catches it anyway and
   * the test stays green. A DURATION bound on that bomb looked like the fix —
   * measured standalone, 32MB aborts in 96ms and the default in 2374ms — but
   * under the test runner the sabotaged path came back in 890ms, because V8
   * sizes its default heap from available memory and vitest's workers had eaten
   * it. A threshold between 91ms and 890ms is a flake waiting for a quiet box.
   *
   * ~120MB allocated and then STOPPED needs no timing at all: it is over a 32MB
   * ceiling and far under any plausible default. MEASURED both ways — with the
   * ceiling `pack_isolation_memory_exceeded`, with the flag deleted `success`.
   */
  it('an allocation ABOVE the configured ceiling but below any default is killed — the real discriminator', async () => {
    process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB = '32';
    try {
      const dir = pack(`
        const held = [];
        for (let i = 0; i < 75; i += 1) held.push(new Array(200000).fill(i)); // ~120MB, then stop
        return { status: 'success', outputs: { held: held.length } };`);
      const run = await runProbe(dir, { wallClockMs: 20_000 });
      expect(run.result.status).toBe('failure');
      expect(run.result.status === 'failure' && run.result.error.code).toBe(ISOLATION_MEMORY_CODE);
    } finally {
      delete process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB;
    }
  }, 40_000);

  it('a RUNAWAY allocation bomb is terminated too, and typed as memory rather than as a timeout', async () => {
    // Complements the bounded case: that one proves the ceiling we configured is
    // the one that bit; this one proves a genuine runaway is contained at all,
    // and that the classifier files it as capacity rather than as a wall clock.
    process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB = '32';
    try {
      const dir = pack(`
        const held = [];
        for (;;) { held.push(new Array(200000).fill(Math.random())); }`);
      // A wall clock far larger than the ~90ms the ceiling takes, so a timeout
      // cannot be what produces the failure.
      const run = await runProbe(dir, { wallClockMs: 20_000 });
      expect(run.result.status === 'failure' && run.result.error.code).toBe(ISOLATION_MEMORY_CODE);
    } finally {
      delete process.env.OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB;
    }
  }, 40_000);
});

/* ── cross-pack / cross-dispatch ──────────────────────────────────────────── */

describe('CROSS-PACK: one dispatch cannot reach another dispatch or another pack', () => {
  it("a pack cannot read ANOTHER pack's code", async () => {
    const victim = pack('return { status: "success", outputs: {} };', 'owp-iso-victim-');
    const attacker = pack(probeBody('read-other-pack', `
      const fs = await import('node:fs');
      return fs.readFileSync(${JSON.stringify(join(victim, 'index.mjs'))}, 'utf-8').length;`));
    const p = probeOf(await runProbe(attacker), 'read-other-pack');
    expect(p.ok).toBe(false);
    expect(p.code).toBe('ERR_ACCESS_DENIED');
  }, 30_000);

  it('a pack cannot read a sibling temp directory — the scratch PARENT is not blanket-allowed', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'owp-iso-sibling-'));
    writeFileSync(join(sibling, 'other.txt'), 'another dispatch scratch', 'utf-8');
    try {
      const dir = pack(probeBody('read-sibling', `
        const fs = await import('node:fs');
        return fs.readFileSync(${JSON.stringify(join(sibling, 'other.txt'))}, 'utf-8');`));
      const p = probeOf(await runProbe(dir), 'read-sibling');
      expect(p.ok).toBe(false);
      expect(p.code).toBe('ERR_ACCESS_DENIED');
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  }, 30_000);

  it('each dispatch gets its OWN scratch directory, and it is removed afterwards', async () => {
    const dir = pack(probeBody('cwd', 'return process.cwd();'));
    const a = probeOf(await runProbe(dir), 'cwd');
    const b = probeOf(await runProbe(dir), 'cwd');
    expect(a.value).not.toBe(b.value);
    expect(existsSync(String(a.value))).toBe(false);
    expect(existsSync(String(b.value))).toBe(false);
  }, 30_000);

  it('a FORGED dispatch credential is refused by the broker, across the real boundary', async () => {
    // A compromised worker that presents a bad token gets nothing. Simulated by
    // handing the isolate a tampered envelope — the strongest form the pack
    // itself cannot reach (the IPC channel is gone from its realm), but a broken
    // or hostile adapter could.
    //
    // The outcome rides the RESULT, not `ctx.report`: with the token forged,
    // every brokered call fails, so a probe that reported its own error would
    // have had that report refused too and the test would assert on nothing.
    const dir = pack(`
      try {
        await ctx.report({ smuggled: true });
        return { status: 'success', outputs: { called: 'allowed' } };
      } catch (err) {
        return { status: 'success', outputs: { called: 'denied', code: String(err && err.code) } };
      }`);
    const run = await runProbe(dir, { tamper: (e) => ({ ...e, token: 'forged-token-not-the-real-one' }) });
    expect(run.result.status).toBe('success');
    expect(run.result.status === 'success' && run.result.outputs).toEqual({
      called: 'denied',
      code: 'dispatch_token_invalid',
    });
    // …and the seam behind the grant never ran.
    expect(run.reported).toEqual([]);
  }, 30_000);
});

/* ── no warm pool ─────────────────────────────────────────────────────────── */

describe('NO WARM POOL: every dispatch gets its own process, and nothing reuses one', () => {
  /**
   * ADR 0555 leans on "a clean isolate per invocation" for two separate
   * guarantees — `cross-dispatch-isolation` above, and the claim that a
   * compromised pack cannot observe or poison a LATER dispatch. Both hold only
   * because the adapter forks per dispatch and pools nothing.
   *
   * Until now that was true by construction and by nothing else: the ADR
   * records "no warm pool by design", but `grep pool test/pack-isolation-*`
   * returned nothing, so a future optimisation adding reuse would have gone in
   * green. A property everything else depends on deserves a guard that can go
   * red — and a "no pool exists" assertion is only meaningful behaviourally,
   * because a pool could be introduced anywhere.
   */
  it('two dispatches of the SAME pack never share a process', async () => {
    const dir = pack(`
      await ctx.report({ label: 'pid', ok: true, value: String(process.pid) });
      return { status: 'success', outputs: { ran: true } };`);

    const first = await runProbe(dir);
    const second = await runProbe(dir);

    expect(first.result.status).toBe('success');
    expect(second.result.status).toBe('success');

    const a = probeOf(first, 'pid').value;
    const b = probeOf(second, 'pid').value;
    // Neither is the host — that is the P2 property the suite already pins —
    // and, the point here, neither is the OTHER.
    expect(a).not.toBe(String(process.pid));
    expect(b).not.toBe(String(process.pid));
    expect(a).not.toBe(b);
  }, 60_000);

  it('a global set by one dispatch is not visible to the next', async () => {
    // The observable consequence of the above, asserted independently: even if
    // pids were somehow recycled by the OS, state must not survive. A pooled
    // worker would carry `globalThis.__owp_leak` across.
    const dir = pack(`
      const seen = typeof globalThis.__owp_leak === 'undefined' ? 'absent' : 'PRESENT';
      globalThis.__owp_leak = 'set-by-a-previous-dispatch';
      await ctx.report({ label: 'seen', ok: true, value: seen });
      return { status: 'success', outputs: { seen } };`);

    const first = await runProbe(dir);
    const second = await runProbe(dir);

    expect(probeOf(first, 'seen').value).toBe('absent');
    expect(probeOf(second, 'seen').value).toBe('absent');
  }, 60_000);
});
