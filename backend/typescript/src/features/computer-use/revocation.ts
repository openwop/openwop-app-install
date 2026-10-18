/**
 * ADR 0894 D4 — membership loss ends a browser session at once, not at its next
 * advance. A session halted for approval makes no call until someone answers, so
 * the per-advance recheck alone would leave a removed member's session live (and
 * resumable by a later re-add) for as long as the provider holds it.
 *
 * The hook re-runs the SAME predicate the advance uses (`authorityLapse`) over
 * every live session in the org, rather than matching the removed subject: a
 * member row's `subject` and a run's `actingUserId` can be different spellings of
 * one person, and re-asking is never wrong where matching might be. `reason` is
 * ignored for the same reason — `demoted` fires only for `host:members:manage`
 * (ADR 0894 A4); the predicate decides.
 */
import { onMemberAuthorityLost } from '../../host/accessControlService.js';
import { onAnyRunTerminal } from '../../executor/runLifecycle.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { createLogger } from '../../observability/logger.js';
import type { Storage } from '../../storage/storage.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { authorityLapse, endSession, isLive } from './computerUseService.js';
import { listSessions, sessions } from './sessionStore.js';
import type { ComputerUseAdapter } from './adapter.js';

const log = createLogger('computer-use');

/** The adapter, or null when none is configured (A5: the row still ends). */
async function adapterOrNull(): Promise<ComputerUseAdapter | null> {
  try {
    const { resolveAdapter } = await import('./feature.js');
    return resolveAdapter();
  } catch {
    return null;
  }
}

export async function endLapsedSessionsInOrg(tenantId: string, orgId: string): Promise<number> {
  const live = (await listSessions(tenantId)).filter((s) => s.orgId === orgId && isLive(s));
  if (live.length === 0) return 0;
  const adapter = await adapterOrNull();
  let ended = 0;
  for (const s of live) {
    const lapsed = await authorityLapse(s);
    if (!lapsed) continue;
    await endSession(adapter, s, lapsed);
    ended += 1;
  }
  return ended;
}

/**
 * Grade-ux CU2UX-2 — a session lives inside the run that opened it. When that
 * run ends for any reason (completed, failed, cancelled), a still-live session
 * ends with it: cancelling the run is the stop button a person already has, and
 * a run that finished with a session still awaiting approval (career.apply,
 * ADR 0894 CU2-R2) no longer strands a billed browser.
 */
export async function endSessionsOfRun(storage: Pick<Storage, 'getRun'>, runId: string, status: string): Promise<number> {
  const run = await storage.getRun(runId);
  if (!run) return 0;
  const live = (await listSessions(run.tenantId)).filter((s) => s.runId === runId && isLive(s));
  if (live.length === 0) return 0;
  const adapter = await adapterOrNull();
  for (const s of live) await endSession(adapter, s, `run_${status}`);
  return live.length;
}

/**
 * Grade-code CU2CD-5 — the reconciling sweep. The ceiling is checked on every
 * advance, but a session waiting on an approval nobody answers makes no call;
 * and the run-terminal fan-out is in-process and best-effort (a cold start in
 * its window fires nothing). This ends any live session past the wall-clock
 * ceiling or whose run is already terminal. Bounded, unref'd, idempotent guard
 * (the commerce `reservationSweep` shape), with a wedge bound so one hung tick
 * cannot stop every later one.
 */
export async function sweepComputerUseSessions(storage: Pick<Storage, 'getRun'>): Promise<number> {
  const live = (await sessions.list()).filter(isLive);
  if (live.length === 0) return 0;
  const adapter = await adapterOrNull();
  let ended = 0;
  for (const s of live) {
    const lapsed = await authorityLapse(s).catch(() => null);
    if (lapsed) { await endSession(adapter, s, lapsed); ended += 1; continue; }
    if (s.runId) {
      const run = await storage.getRun(s.runId).catch(() => null);
      if (run && (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')) {
        await endSession(adapter, s, `run_${run.status}`);
        ended += 1;
      }
    }
  }
  return ended;
}

const SWEEP_MS = (() => {
  const raw = Number(process.env.OPENWOP_COMPUTER_USE_SWEEP_MS);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 300_000;
})();
let sweepStarted = false;

export function registerComputerUseRevocation(storage?: Pick<Storage, 'getRun'>): void {
  onMemberAuthorityLost('computer-use', async (lost) => {
    const n = await endLapsedSessionsInOrg(lost.tenantId, lost.orgId);
    if (n > 0) log.info('computer-use sessions ended on membership loss', { tenantId: lost.tenantId, orgId: lost.orgId, count: n });
    return n;
  });
  if (!storage) return;
  onAnyRunTerminal('computer-use', async (runId, status) => {
    const n = await endSessionsOfRun(storage, runId, status).catch((err) => {
      log.warn('computer-use run-terminal end failed', { runId, error: err instanceof Error ? err.message : String(err) });
      return 0;
    });
    if (n > 0) log.info('computer-use sessions ended with their run', { runId, count: n });
  });
  if (sweepStarted) return;
  sweepStarted = true;
  let runningSince = 0;
  const tick = async (): Promise<void> => {
    // Wedge bound: a tick still "running" after three intervals is presumed hung.
    if (runningSince && Date.now() - runningSince < SWEEP_MS * 3) return;
    runningSince = Date.now();
    try {
      const n = await sweepComputerUseSessions(storage);
      if (n > 0) log.info('computer-use sweep ended sessions', { count: n });
    } catch (err) {
      log.warn('computer-use sweep tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { runningSince = 0; }
  };
  // ADR 0650 — an interval worker enters the event seat explicitly.
  const timer = setInterval(() => void runUnderWorkerContract(tick), SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// Retention (grade-code CU2CD-8) — finished session rows are the audit of what an
// agent did; keep 180 days, then age them out so the tenant scans above stay
// bounded. A live session is at most the wall-clock ceiling old, so the TTL can
// never reach one. Tenant-indexed: the sweep deletes through the collection.
registerKvAgeOut({ id: 'computer-use:session', prefix: 'hostext:computer-use:session:', ttlDays: 180, timestampField: 'updatedAt', acceptIndexed: true });
