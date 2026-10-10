/**
 * ADR 0850 D5 — a per-form burst ceiling on the public submit that does not
 * depend on the client's IP.
 *
 * The global limiter keys on the client IP and trusts the leftmost
 * `X-Forwarded-For` (#4516), so a forged header made it no guard at all. One
 * client could then fill a form's 50 000 real-lead ceiling with clean rows, and
 * from that point the form refused everyone.
 *
 * This window counts only submissions that WOULD become clean rows — it runs
 * after the honeypot, the guards and validation. Past the ceiling the submission
 * is QUARANTINED (`flagged: 'burst'`): same 201, same body, metered against the
 * 1 000-row quarantine budget and releasable by an operator. It is no oracle.
 *
 * What it does NOT do, stated (grade-code FRM2CD-3 — the first docblock said
 * the window "cannot be turned into a denial of service", which was false). A
 * sustained forged-header flood keeps the window full, so real visitors in that
 * minute are HELD (recoverable, not lost); once the quarantine budget is full,
 * flagged submits are refused 429 — real visitors included. And the 50 000
 * real-lead ceiling still fills, at the window's rate (~7 h per instance at the
 * default). It SLOWS the attack and makes its casualties recoverable; it does not
 * stop it. The draft it replaced (a pre-honeypot 429) let ~2 requests a second
 * deny the form outright, with no row as a trace.
 *
 * Per instance, in memory: the fleet bound is the instance count times the
 * limit. A durable counter would cost a write per submit on the hottest public
 * path. Bounded: only resolved, published forms reach it, and past `MAX_FORMS`
 * keys the oldest is evicted.
 */

const WINDOW_MS = 60_000;
const MAX_FORMS = 10_000;
const DEFAULT_PER_MIN = 120;

const windows = new Map<string, number[]>();

function limit(): number {
  const raw = Number(process.env.OPENWOP_FORMS_SUBMIT_PER_MIN);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PER_MIN;
}

/** Record one clean submit for `formId`; true when it is OVER the ceiling. An
 *  over-ceiling submit is not recorded, so the window drains at the real rate. */
export function overSubmitBurst(formId: string, now = Date.now()): boolean {
  const times = (windows.get(formId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= limit()) {
    windows.set(formId, times);
    return true;
  }
  times.push(now);
  // Re-insert so Map order is recency order; evict the least recent beyond the cap.
  windows.delete(formId);
  windows.set(formId, times);
  if (windows.size > MAX_FORMS) {
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }
  return false;
}

/** Test-only. */
export function __resetSubmitBurstForTests(): void {
  windows.clear();
}
