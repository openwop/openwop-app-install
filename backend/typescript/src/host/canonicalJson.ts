/**
 * Canonical JSON: recursively key-sorted, arrays in order. The ONE
 * canonicalizer behind the audit chain's entry hashes, the ADR 0473 definition
 * hash and the content-rules finding ids and digests.
 *
 * Pure and import-free on purpose (ADR 0946 P2, a0's review of #5092): the
 * content-rules library must not pull in storage. It moved here from
 * `auditChainService.ts`, which re-exports it; the move is pinned
 * byte-identical by `test/canonical-json-audit-identity.test.ts`.
 */

/** Recursively sort object keys (arrays keep order) so serialization is stable. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortValue(obj[k]);
    return out;
  }
  return value;
}

/** Deterministic JSON with stably-sorted keys — the hashed, verifiable form. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
