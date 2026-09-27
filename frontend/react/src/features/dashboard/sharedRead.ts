/**
 * sharedRead (grade-code fix S3, ADR 0377) — a tiny promise memo for tile data
 * reads that MORE THAN ONE tile projects from (crm-pipeline + pipeline-trend
 * both call getPipelineReport; csm-health + health-distribution both call
 * listAccounts; etc.). Without it, enabling both tiles of a pair fires the same
 * request twice on one paint.
 *
 * Semantics mirror the useDashboardOrg memo: the IN-FLIGHT promise is shared
 * (N tiles → 1 request), a rejection clears the slot immediately (retryable),
 * and a resolved value is reused for a short TTL then refetched — a dashboard
 * is a glanceable surface, not a live feed.
 */
const TTL_MS = 30_000;

interface Slot {
  promise: Promise<unknown>;
  resolvedAt: number | null; // null while in flight
}

const slots = new Map<string, Slot>();

export function sharedRead<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = slots.get(key);
  if (hit && (hit.resolvedAt === null || now - hit.resolvedAt < TTL_MS)) {
    return hit.promise as Promise<T>;
  }
  const slot: Slot = { promise: undefined as unknown as Promise<unknown>, resolvedAt: null };
  slot.promise = fetcher()
    .then((v) => {
      slot.resolvedAt = Date.now();
      return v;
    })
    .catch((e: unknown) => {
      if (slots.get(key) === slot) slots.delete(key); // retryable on next mount
      throw e;
    });
  slots.set(key, slot);
  return slot.promise as Promise<T>;
}

/** Test seam: drop all memoized slots. */
export function __resetSharedReads(): void {
  slots.clear();
}
