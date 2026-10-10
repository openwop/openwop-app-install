/**
 * Saturation probes — the two signals whose absence left EVID-1/EVID-3
 * undecidable from the logs.
 *
 * A request that takes seconds on a host at 5% CPU is WAITING, and there are two
 * things it can be waiting on in this process: a Postgres connection (the pool
 * is small — `OPENWOP_PG_POOL_MAX`, 4 in production) or the event loop itself
 * (one synchronous stretch stalls every request and every background worker).
 * Neither was recorded, so a slow window could be described and not explained.
 *
 * Both probes are QUIET by default: they sample continuously and log once per
 * report window, only when the window saw pressure. A healthy host logs
 * nothing, so this adds no volume and a line's presence is itself the signal.
 *
 *   pg_pool_pressure   — callers were queued for a connection this window,
 *                        with the call sites that asked while it was full.
 *   event_loop_lag     — the loop was held past the threshold this window,
 *                        with what the process did during the worst stall
 *                        (`worst`: CPU spent and loop-active time).
 *
 * Timers are unref'd: a probe never keeps the process alive past SIGTERM.
 */
import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';

const log = createLogger('observability.saturation');

/** The three gauges `pg.Pool` exposes; structural so tests need no pool. */
export interface PoolGauges {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface ProbeTimers {
  sampleMs?: number;
  reportMs?: number;
}

interface Stoppable { stop(): void }

/**
 * Accumulates pool samples for one report window. Separate from the timers so
 * the arithmetic is tested directly: `sample()` on each tick, `flush()` at the
 * window edge returns the line to log, or null when nobody waited.
 */
export function createPoolPressureWindow(poolMax: number): {
  sample(g: PoolGauges): void;
  /** One connection request made while every connection was in use. */
  callerWaited(signature: string): void;
  flush(): {
    poolMax: number; maxWaiting: number; samplesWaiting: number; samples: number; maxInUse: number;
    topCallers?: Array<{ caller: string; waits: number }>;
  } | null;
} {
  let maxWaiting = 0; let samplesWaiting = 0; let samples = 0; let maxInUse = 0;
  const callers = new Map<string, number>();
  return {
    callerWaited(signature) {
      // Bounded: a window keeps at most 64 distinct call sites; the rest are
      // counted under one bucket so a burst can never grow this map.
      const key = callers.has(signature) || callers.size < 64 ? signature : '(other)';
      callers.set(key, (callers.get(key) ?? 0) + 1);
    },
    sample(g) {
      samples += 1;
      if (g.waitingCount > 0) samplesWaiting += 1;
      if (g.waitingCount > maxWaiting) maxWaiting = g.waitingCount;
      const inUse = g.totalCount - g.idleCount;
      if (inUse > maxInUse) maxInUse = inUse;
    },
    flush() {
      const top = [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([caller, waits]) => ({ caller, waits }));
      // A caller that waited is pressure even if no 250 ms sample landed on it.
      const pressured = maxWaiting > 0 || top.length > 0;
      const line = pressured
        ? { poolMax, maxWaiting, samplesWaiting, samples, maxInUse, ...(top.length > 0 ? { topCallers: top } : {}) }
        : null;
      maxWaiting = 0; samplesWaiting = 0; samples = 0; maxInUse = 0; callers.clear();
      return line;
    },
  };
}

/** Frames that say nothing about WHO asked: the pool, the driver, the runtime,
 *  and anonymous glue. What is left is the application's call path. */
const NOISE_FRAME = /^(?:new Promise|Promise\.all(?:Settled)?|Array\.(?:map|forEach)|process\.processTicksAndRejections|(?:Bound)?Pool\.(?:connect|query)|Client\.query|Object\.<anonymous>|<anonymous>|Generator\.next|async Promise\.all)$/;

/**
 * The application call path of a stack, as `outer < … < inner` function names —
 * the first three named, non-noise frames. The production bundle is one file, so
 * function names are the only stable identity a frame has; line numbers are not.
 */
export function callerSignature(stack: string | undefined): string {
  if (!stack) return '(no stack)';
  const names: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /^\s*at (?:async )?([^\s(]+(?: [^\s(]+)?)\s*\(/.exec(line);
    const name = m?.[1];
    if (!name || NOISE_FRAME.test(name) || name.startsWith('patchedConnect')) continue;
    names.push(name);
    if (names.length === 3) break;
  }
  return names.length > 0 ? names.reverse().join(' < ') : '(anonymous)';
}

/** The pool's `connect`, which `query` also goes through. */
export interface ProbedPool extends PoolGauges {
  connect: (...args: never[]) => unknown;
}

/** Sample the pool every `sampleMs`; log `pg_pool_pressure` once per `reportMs`
 *  when at least one sample saw a queued caller. When `pool.connect` is present
 *  it is wrapped so a request made while every connection is busy records its
 *  call path (a stack is captured ONLY then, so a healthy pool pays nothing);
 *  the window's top five ride the line as `topCallers`. */
export function startPoolPressureProbe(pool: PoolGauges | ProbedPool, poolMax: number, t: ProbeTimers = {}): Stoppable {
  const window = createPoolPressureWindow(poolMax);
  let restoreConnect: (() => void) | null = null;
  if ('connect' in pool && typeof pool.connect === 'function') {
    const probed = pool as ProbedPool;
    const original = probed.connect;
    const patchedConnect = function patchedConnect(this: unknown, ...args: never[]): unknown {
      if (probed.idleCount === 0 && probed.totalCount >= poolMax) {
        window.callerWaited(callerSignature(new Error().stack));
      }
      return original.apply(probed, args);
    };
    probed.connect = patchedConnect;
    restoreConnect = () => { probed.connect = original; };
  }
  const sampler = setInterval(() => window.sample(pool), t.sampleMs ?? 250);
  const reporter = setInterval(() => {
    const line = window.flush();
    if (line) log.warn('pg_pool_pressure', line);
  }, t.reportMs ?? 30_000);
  sampler.unref();
  reporter.unref();
  return { stop() { clearInterval(sampler); clearInterval(reporter); restoreConnect?.(); } };
}

/** The loop was held at least this long at some point in the window. */
export const EVENT_LOOP_LAG_THRESHOLD_MS = 250;

/**
 * What the process did during one stall (EVID-6). A late timer alone cannot say
 * WHY the loop was held, and the three causes need different fixes:
 *
 *   cpuMs ≈ stallMs                 — JavaScript ran (a hot synchronous stretch, or GC).
 *   activeMs ≈ stallMs, cpuMs ≈ 0   — the loop was inside a blocking call that
 *                                     used no CPU (a synchronous syscall: a full
 *                                     stdout pipe, sync fs, sync DNS).
 *   activeMs ≈ 0, cpuMs ≈ 0         — the loop sat idle waiting for I/O and the
 *                                     PROCESS was not running (a platform pause).
 *
 * `activeMs` is the loop's time outside its I/O poll (`eventLoopUtilization`).
 */
export interface StallAccount { stallMs: number; cpuMs: number; activeMs: number }

/** The line for one window, or null when the worst delay stayed under the
 *  threshold. Pure, so the quiet case is tested without racing a real clock. */
export function eventLoopLagLine(
  w: { maxNs: number; p99Ns: number; meanNs: number; worst?: StallAccount },
  thresholdMs: number,
): { maxMs: number; p99Ms: number; meanMs: number; thresholdMs: number; worst?: StallAccount } | null {
  const maxMs = w.maxNs / 1e6;
  if (!(maxMs >= thresholdMs)) return null; // also refuses NaN (an empty window)
  return {
    maxMs: Math.round(maxMs), p99Ms: Math.round(w.p99Ns / 1e6), meanMs: Math.round(w.meanNs / 1e6), thresholdMs,
    ...(w.worst ? { worst: w.worst } : {}),
  };
}

/** How often the lag sampler wakes. A wake that arrives late by more than this
 *  is the loop having been held. */
const LAG_SAMPLE_MS = 20;

/**
 * A window of event-loop delays, measured by our OWN timer.
 *
 * This replaced `monitorEventLoopDelay` + `reset()` at the window edge, which
 * could DROP a block: when the reporter's tick came due during a block, it could
 * run before Node's histogram recorded the delay, and `reset()` then discarded
 * it. Traced under vitest: one run in three lost a 400 ms block outright, and at
 * a 30 s window a multi-second production block had roughly the same odds. Here
 * a delay is recorded by the sampler whenever it next runs, into whichever
 * window is open then — a reset can move a block into the NEXT line, never lose
 * it.
 */
export function createLagWindow(): {
  /** `gap` is what the process did between this wake and the previous one. */
  record(delayMs: number, gap?: { cpuMs: number; activeMs: number }): void;
  flush(): { maxNs: number; p99Ns: number; meanNs: number; worst?: StallAccount };
} {
  let samples: number[] = [];
  let worst: StallAccount | undefined;
  return {
    record(delayMs, gap) {
      // Bounded: a 30 s window at 20 ms is ~1,500 samples.
      if (samples.length < 10_000) samples.push(Math.max(0, delayMs));
      else samples[samples.length - 1] = Math.max(samples[samples.length - 1]!, delayMs);
      if (gap && (!worst || delayMs > worst.stallMs)) {
        worst = { stallMs: Math.round(delayMs), cpuMs: Math.round(gap.cpuMs), activeMs: Math.round(gap.activeMs) };
      }
    },
    flush() {
      const s = samples; samples = [];
      const w = worst; worst = undefined;
      if (s.length === 0) return { maxNs: Number.NaN, p99Ns: Number.NaN, meanNs: Number.NaN };
      const sorted = [...s].sort((a, b) => a - b);
      const ms = (v: number): number => v * 1e6;
      return {
        maxNs: ms(sorted[sorted.length - 1]!),
        p99Ns: ms(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!),
        meanNs: ms(s.reduce((a, b) => a + b, 0) / s.length),
        ...(w ? { worst: w } : {}),
      };
    },
  };
}

/** Log `event_loop_lag` once per `reportMs` when the worst delay in the window
 *  reached the threshold. Delay is how late our own 20 ms timer woke. */
export function startEventLoopLagProbe(t: ProbeTimers & { thresholdMs?: number } = {}): Stoppable {
  const threshold = t.thresholdMs ?? EVENT_LOOP_LAG_THRESHOLD_MS;
  const window = createLagWindow();
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  let lastElu = performance.eventLoopUtilization();
  const sampler = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(lastCpu);
    const elu = performance.eventLoopUtilization(lastElu);
    window.record(now - last - LAG_SAMPLE_MS, { cpuMs: (cpu.user + cpu.system) / 1000, activeMs: elu.active });
    last = now;
    lastCpu = process.cpuUsage();
    lastElu = performance.eventLoopUtilization();
  }, LAG_SAMPLE_MS);
  const reporter = setInterval(() => {
    const line = eventLoopLagLine(window.flush(), threshold);
    if (line) log.warn('event_loop_lag', line);
  }, t.reportMs ?? 30_000);
  sampler.unref();
  reporter.unref();
  return { stop() { clearInterval(sampler); clearInterval(reporter); } };
}
