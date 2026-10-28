/**
 * `observability/saturationProbe.ts` — the pool-wait and event-loop-lag signals
 * EVID-3 could not be decided without, plus the worst-stall account EVID-6 added
 * (#4687: what the process was doing during the stall — CPU, a blocking call,
 * or a platform pause).
 *
 * Timers: the POOL probe is pure `setInterval`, so its two cases run on fake
 * timers and assert exact windows. The four LAG cases that run the live probe
 * (`event_loop_lag is logged…` and the two `accountOf` cases) are an HONEST
 * CEILING on the real clock: they measure real `performance.now`, `cpuUsage`
 * and event-loop utilisation across a real stall, which fake timers cannot
 * produce; they poll for the line against a deadline rather than sleeping a
 * fixed time.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): every window reported
 * (`8fw2g3-sat-pressured`), every sample counted as waiting (`-sat-samplesw`),
 * the caller map unbounded (`-sat-bound`), the top callers sorted ascending
 * (`-sat-sort`), callers recorded while a connection was free
 * (`-sat-busyonly`), connect not restored (`-sat-restore`), the probe's own
 * frame not skipped (`-sat-noise`), a NaN window reported (`-sat-nan`), the
 * worst stall not kept (`-sat-worst`) or not reset (`-sat-worstreset`), CPU
 * mis-scaled (`-sat-cpu`), active time dropped (`-sat-active`), and the lag
 * not recorded (`-sat-lagrecord`).
 */
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callerSignature, createLagWindow, createPoolPressureWindow, eventLoopLagLine, startEventLoopLagProbe, startPoolPressureProbe, type PoolGauges,
} from '../src/observability/saturationProbe.js';

/** The logger writes one JSON line per call to stdout/stderr; collect them. */
function captureLogs(): { lines: () => Array<Record<string, unknown>>; restore: () => void } {
  const out: string[] = [];
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write),
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stderr.write),
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); }),
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); }),
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); }),
  ];
  return {
    lines: () => out.flatMap((s) => s.split('\n')).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const POOL_TIMERS = { toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const };

describe('pool pressure window', () => {
  it('reports nothing when no caller waited, however busy the pool was', () => {
    const w = createPoolPressureWindow(4);
    for (let i = 0; i < 10; i += 1) w.sample({ totalCount: 4, idleCount: 0, waitingCount: 0 });
    expect(w.flush()).toBeNull();
  });

  it('reports the worst queue depth, how often callers waited, and resets', () => {
    const w = createPoolPressureWindow(4);
    w.sample({ totalCount: 4, idleCount: 1, waitingCount: 0 });
    w.sample({ totalCount: 4, idleCount: 0, waitingCount: 3 });
    w.sample({ totalCount: 4, idleCount: 0, waitingCount: 7 });
    w.sample({ totalCount: 4, idleCount: 2, waitingCount: 0 });
    expect(w.flush()).toEqual({ poolMax: 4, maxWaiting: 7, samplesWaiting: 2, samples: 4, maxInUse: 4 });
    expect(w.flush()).toBeNull(); // the next window starts clean
  });
});

describe('probes', () => {
  it('pg_pool_pressure is logged for a window in which a caller queued, and not for a quiet one', async () => {
    vi.useFakeTimers({ toFake: [...POOL_TIMERS.toFake] });
    const cap = captureLogs();
    const pool: { -readonly [K in keyof PoolGauges]: PoolGauges[K] } = { totalCount: 4, idleCount: 4, waitingCount: 0 };
    // Samples every 5 ms, reports every 40 ms (the sampler is created first, so at a
    // shared instant the sample lands before the report).
    const probe = startPoolPressureProbe(pool, 4, { sampleMs: 5, reportMs: 40 });
    try {
      vi.advanceTimersByTime(40); // window 1 (0, 40]: quiet
      const quiet = cap.lines().filter((l) => l.msg === 'pg_pool_pressure');
      pool.idleCount = 0; pool.waitingCount = 5;
      vi.advanceTimersByTime(20); // samples at 45..60 see 5 waiting
      pool.idleCount = 4; pool.waitingCount = 0;
      vi.advanceTimersByTime(20); // samples at 65..80 are quiet; report at 80
      vi.advanceTimersByTime(40); // window 3 (80, 120]: quiet again
      const after = cap.lines().filter((l) => l.msg === 'pg_pool_pressure');
      cap.restore();
      expect(quiet).toHaveLength(0);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ poolMax: 4, maxWaiting: 5, samplesWaiting: 4, samples: 8, maxInUse: 4 });
    } finally { probe.stop(); cap.restore(); }
  });

  it('event_loop_lag is logged when the loop is held past the threshold', async () => {
    // Only the HELD case races a real clock. It is NOT immune to it, as the
    // first version of this comment claimed (it went red about 1 run in 4 at
    // load 30–70). Two timing traps, both handled here: the block must start
    // after the histogram's first tick, and the line can land a report later
    // than the block, so it is awaited with a deadline, not a fixed sleep. The
    // quiet case is the pure test below.
    const cap = captureLogs();
    const probe = startEventLoopLagProbe({ reportMs: 60, thresholdMs: 150 });
    try {
      // Let the histogram take its first samples: a delay is measured between
      // two of its own ticks, so a block that starts before the first tick is
      // never recorded at all. Under load 30 ms was not enough.
      await wait(300);
      const until = Date.now() + 400; while (Date.now() < until) { /* hold the loop */ }
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !cap.lines().some((l) => l.msg === 'event_loop_lag')) await wait(25);
      const after = cap.lines().filter((l) => l.msg === 'event_loop_lag');
      cap.restore();
      expect(after.length).toBeGreaterThanOrEqual(1);
      expect(Math.max(...after.map((l) => Number(l.maxMs)))).toBeGreaterThanOrEqual(300);
    } finally { probe.stop(); cap.restore(); }
  });

  it('the lag line is withheld under the threshold and for an empty window', () => {
    expect(eventLoopLagLine({ maxNs: 249e6, p99Ns: 20e6, meanNs: 5e6 }, 250)).toBeNull();
    expect(eventLoopLagLine({ maxNs: Number.NaN, p99Ns: Number.NaN, meanNs: Number.NaN }, 250)).toBeNull();
    expect(eventLoopLagLine({ maxNs: 1_400e6, p99Ns: 900e6, meanNs: 30e6 }, 250)).toEqual({ maxMs: 1400, p99Ms: 900, meanMs: 30, thresholdMs: 250 });
  });
});

describe('pool pressure — WHO asked while the pool was full', () => {
  it('names the application call path, skipping the pool, the driver and runtime glue', () => {
    const stack = [
      'Error',
      '    at patchedConnect (file:///app/lib/index.js:10:1)',
      '    at BoundPool.query (file:///app/node_modules/pg-pool/index.js:400:12)',
      '    at Object.kvList (file:///app/lib/index.js:85000:31)',
      '    at async Promise.all (index 3)',
      '    at async DurableCollection.list (file:///app/lib/index.js:91000:20)',
      '    at async listJobs (file:///app/lib/index.js:92000:10)',
      '    at async processDueSchedules (file:///app/lib/index.js:93000:5)',
    ].join('\n');
    expect(callerSignature(stack)).toBe('listJobs < DurableCollection.list < Object.kvList');
    expect(callerSignature(undefined)).toBe('(no stack)');
    expect(callerSignature('Error\n    at <anonymous>')).toBe('(anonymous)');
  });

  it('a window reports its top callers, most frequent first, and a bounded map', () => {
    const w = createPoolPressureWindow(4);
    for (let i = 0; i < 7; i += 1) w.callerWaited('a < b');
    for (let i = 0; i < 3; i += 1) w.callerWaited('c < d');
    for (let i = 0; i < 100; i += 1) w.callerWaited(`unique-${i}`); // overflows into '(other)'
    const line = w.flush();
    // 64 distinct call sites are kept (a < b, c < d, unique-0..61); the other 38
    // share '(other)'. Most frequent first; ties keep first-seen order; five kept.
    expect(line?.topCallers).toEqual([
      { caller: '(other)', waits: 38 },
      { caller: 'a < b', waits: 7 },
      { caller: 'c < d', waits: 3 },
      { caller: 'unique-0', waits: 1 },
      { caller: 'unique-1', waits: 1 },
    ]);
    expect(w.flush()).toBeNull(); // cleared
  });

  it('the wrapped connect records a caller ONLY while every connection is busy, and stop() restores it', async () => {
    vi.useFakeTimers({ toFake: [...POOL_TIMERS.toFake] });
    const cap = captureLogs();
    const calls: number[] = [];
    const original = (..._a: never[]): unknown => { calls.push(1); return 'conn'; };
    const pool = { totalCount: 4, idleCount: 1, waitingCount: 0, connect: original };
    // The sampler never ticks inside this case (1 s), so only the wrapped connect can
    // make a window pressured.
    const probe = startPoolPressureProbe(pool, 4, { sampleMs: 1000, reportMs: 40 });
    try {
      expect(pool.connect()).toBe('conn'); // a free connection: nothing recorded
      vi.advanceTimersByTime(40);
      expect(cap.lines().filter((l) => l.msg === 'pg_pool_pressure')).toHaveLength(0);
      pool.idleCount = 0;
      function busyCaller(): unknown { return pool.connect(); }
      busyCaller(); busyCaller();
      vi.advanceTimersByTime(40);
      const lines = cap.lines().filter((l) => l.msg === 'pg_pool_pressure');
      cap.restore();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ poolMax: 4, maxWaiting: 0, samplesWaiting: 0, samples: 0, maxInUse: 0 });
      const top = lines[0]!.topCallers as Array<{ caller: string; waits: number }>;
      expect(top).toHaveLength(1);
      expect(top[0]!.waits).toBe(2);
      expect(top[0]!.caller).toContain('busyCaller');
      expect(calls).toHaveLength(3); // every call still reached the real connect
    } finally { probe.stop(); cap.restore(); }
    expect(pool.connect).toBe(original);
  });
});

describe('event-loop lag window — a block is never lost across a report', () => {
  it('a delay recorded after a flush lands in the NEXT window instead of vanishing', () => {
    const w = createLagWindow();
    w.record(2); w.record(3);
    // The reporter fires first after a block — it sees no block yet…
    expect(eventLoopLagLine(w.flush(), 250)).toBeNull();
    // …then the sampler wakes 400 ms late and records it into the open window.
    w.record(400); w.record(1);
    expect(eventLoopLagLine(w.flush(), 250)).toMatchObject({ maxMs: 400, thresholdMs: 250 });
  });

  it('an empty window yields no line', () => {
    expect(eventLoopLagLine(createLagWindow().flush(), 250)).toBeNull();
  });
});

describe('event-loop lag — WHAT the process did during the worst stall (EVID-6)', () => {
  it('the window keeps the account of its worst stall, rides the line, and resets', () => {
    const w = createLagWindow();
    w.record(300, { cpuMs: 290, activeMs: 300 });
    w.record(7_000, { cpuMs: 4, activeMs: 6_990 });
    w.record(500, { cpuMs: 1, activeMs: 2 });
    expect(eventLoopLagLine(w.flush(), 250)).toMatchObject({
      maxMs: 7000, worst: { stallMs: 7000, cpuMs: 4, activeMs: 6990 },
    });
    w.record(260, { cpuMs: 0, activeMs: 1 });
    expect(eventLoopLagLine(w.flush(), 250)?.worst).toEqual({ stallMs: 260, cpuMs: 0, activeMs: 1 });
  });

  /** Run the live probe across one stall and return the stall's account. */
  async function accountOf(stall: () => void): Promise<{ stallMs: number; cpuMs: number; activeMs: number }> {
    const cap = captureLogs();
    const probe = startEventLoopLagProbe({ reportMs: 60, thresholdMs: 150 });
    try {
      await wait(300); // see the held-loop case above: let the sampler tick first
      stall();
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !cap.lines().some((l) => l.msg === 'event_loop_lag')) await wait(25);
      const lines = cap.lines().filter((l) => l.msg === 'event_loop_lag');
      cap.restore();
      const worst = lines.map((l) => l.worst as { stallMs: number; cpuMs: number; activeMs: number })
        .sort((a, b) => b.stallMs - a.stallMs)[0];
      expect(worst).toBeDefined();
      return worst!;
    } finally { probe.stop(); cap.restore(); }
  }

  it('a stall spent running JavaScript shows CPU', async () => {
    // The property under test is ATTRIBUTION: the probe's cpuMs must cover the
    // CPU the spin actually got. It used to assert cpuMs >= 0.4 × stallMs, a
    // fixed share of wall time that the OS, not the probe, decides. Under gate
    // load (8 cores, load 17–50) the spin got 94–151 ms of a ~400 ms stall, and
    // the test went red twice on 2026-10-10 with the probe correct (#4687). So
    // measure the spin's own CPU and require the probe to account for it.
    let spinCpuMs = 0;
    const a = await accountOf(() => {
      const before = process.cpuUsage();
      const until = Date.now() + 400; while (Date.now() < until) { /* spin */ }
      const d = process.cpuUsage(before);
      spinCpuMs = (d.user + d.system) / 1000;
    });
    const load = `loadavg ${os.loadavg().map((n) => n.toFixed(1)).join('/')} on ${os.cpus().length} cpus`;
    expect(a.stallMs, load).toBeGreaterThanOrEqual(300);
    // Non-vacuity: however loaded, a 400 ms spin gets SOME CPU (measured floor 94 ms at load ~17).
    expect(spinCpuMs, `spin got ${spinCpuMs.toFixed(1)} ms CPU; ${load}`).toBeGreaterThan(20);
    // The probe's window contains the spin, so it must report at least the spin's CPU
    // (minus rounding; the probe rounds to whole ms).
    expect(a.cpuMs, `probe cpuMs ${a.cpuMs} < spin's own ${spinCpuMs.toFixed(1)} ms; ${load}`)
      .toBeGreaterThanOrEqual(Math.floor(spinCpuMs) - 1);
  });

  it('a stall inside a blocking call shows the loop busy and almost no CPU', async () => {
    // Atomics.wait blocks the thread in the kernel: the same shape as a
    // synchronous write to a full stdout pipe.
    const a = await accountOf(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); });
    expect(a.stallMs).toBeGreaterThanOrEqual(300);
    expect(a.cpuMs).toBeLessThan(a.stallMs * 0.3);
    expect(a.activeMs).toBeGreaterThanOrEqual(a.stallMs * 0.7);
  });
});
