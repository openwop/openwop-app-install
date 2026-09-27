/**
 * seams-v2 `armIdempotencyHold` (RFC 0213 §B witness). A single-use hold keyed by
 * (tenant, Idempotency-Key): the tenant's next real `POST /runs` carrying that key
 * keeps its Layer-1 claim IN FLIGHT for `holdMs` after claiming, then completes
 * normally. The seam never answers a create or emits a 409 itself — the refusal a
 * concurrent same-key create receives comes from the production in-flight branch
 * of `routes/runs.ts`. Process-local (a seams deployment runs one instance); an
 * unarmed key is never delayed.
 */
const holds = new Map<string, number>();
const keyOf = (tenantId: string, key: string): string => `${tenantId}\u0000${key}`;

export function armIdempotencyHold(tenantId: string, key: string, holdMs: number): void {
  holds.set(keyOf(tenantId, key), holdMs);
}

/** Consume (single-use) the hold armed for this tenant + key, if any. */
export function takeIdempotencyHold(tenantId: string, key: string): number | undefined {
  const k = keyOf(tenantId, key);
  const ms = holds.get(k);
  if (ms !== undefined) holds.delete(k);
  return ms;
}
