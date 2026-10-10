/**
 * The window a periodic interrupt sweep inspects on one tick.
 *
 * WHY THIS EXISTS. Both sweeps (`approvalGateTimeout.ts`, `timerResume.ts`)
 * used to read `listOpenInterruptsAll(200)`, which is the 200 OLDEST open
 * interrupts, every tick. Interrupts that never expire (clarifications, gates
 * without a deadline) accumulate at the front of that window forever. Past 200
 * of them, no newer interrupt is ever looked at: a gate's timeout never fires
 * and a timer never resumes. MEASURED on prod (rev 00782, 2026-09-28): suite
 * 2.43.1's RFC 0223 timeout rows passed locally, against a small table, and
 * failed on the production database, where the timeout path never ran.
 *
 * So each tick reads two windows:
 *  - the NEWEST `limit/2`, so a fresh short deadline fires promptly whatever
 *    the backlog; and
 *  - the next `limit` along a round-robin keyset cursor, so EVERY open interrupt
 *    is inspected within ⌈open / limit⌉ ticks, and none can starve.
 * The union is deduplicated. Each sweep keeps its own cursor.
 */
import type { Storage } from '../storage/storage.js';
import type { InterruptRecord } from '../types.js';

type Cursor = { createdAt: string; interruptId: string };
const cursors = new Map<string, Cursor | undefined>();

export async function openInterruptsForSweep(
  storage: Storage,
  sweep: string,
  limit: number,
): Promise<InterruptRecord[]> {
  const newest = await storage.listOpenInterruptsAll(Math.max(1, Math.ceil(limit / 2)), { newestFirst: true });
  const at = cursors.get(sweep);
  const page = await storage.listOpenInterruptsAll(limit, at ? { after: at } : undefined);
  const last = page[page.length - 1];
  // A short page means the cursor reached the end: wrap to the start next tick.
  cursors.set(sweep, page.length < limit || !last ? undefined : { createdAt: last.createdAt, interruptId: last.interruptId });
  const seen = new Set<string>();
  const out: InterruptRecord[] = [];
  for (const it of [...newest, ...page]) {
    if (seen.has(it.interruptId)) continue;
    seen.add(it.interruptId);
    out.push(it);
  }
  return out;
}

/** Test seam: forget every sweep's cursor. */
export function _resetSweepCursors(): void {
  cursors.clear();
}
