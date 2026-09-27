/**
 * Timer-sweep daemon (ADR 0267 / CDP-E) — periodically resolves due `timer`
 * interrupts by resuming their runs. Rides its own interval (like scheduleDaemon);
 * the CAS in `sweepDueTimers` makes it fire-once across the fleet. The `resume`
 * continuation is injected (index.ts wires `resolveAndResume`) to keep this host
 * daemon free of a routes import.
 */
import type { Storage } from '../storage/storage.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import type { InterruptRecord } from '../types.js';
import { sweepDueTimers } from '../executor/timerResume.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('timerSweepDaemon');
const DEFAULT_INTERVAL_MS = 30_000;

export interface TimerSweepDaemon {
  stop: () => void;
}

export function startTimerSweepDaemon(deps: {
  storage: Storage;
  resume: (interrupt: InterruptRecord) => Promise<void>;
}): TimerSweepDaemon {
  const intervalMs = Number(process.env.OPENWOP_TIMER_SWEEP_MS) || DEFAULT_INTERVAL_MS;
  const tick = (): void => {
    void sweepDueTimers(deps.storage, deps.resume).catch((err) =>
      log.warn('timer sweep tick failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  };
  const handle = setInterval(() => runUnderWorkerContract(tick), intervalMs);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
}
