/**
 * Axe exception ledger (ADR 0510 Phase 2, DSA-021). The a11y suite fails EVERY
 * in-scope WCAG A/AA violation; the ONLY way to ship one is a row here — narrow,
 * owned, reasoned, issue-linked, and expiring. An EXPIRED row fails the suite
 * harder than the violation would (the ledger exists to shrink, not to hide).
 *
 * This is NOT for axe "cannot determine" contrast nodes (gradient/image
 * backgrounds) — those are filtered as a measurement limitation in a11y.spec.ts,
 * not excepted here.
 */
export interface AxeException {
  /** The axe rule id, e.g. 'color-contrast'. */
  rule: string;
  /** Route the exception applies to (exact match against the audited route). */
  route: string;
  /** CSS selector prefix that must match the violating node's target. */
  selectorPrefix: string;
  owner: string;
  reason: string;
  /** Tracking issue / PR link. */
  issue: string;
  /** ISO date — the suite FAILS once this passes. */
  expires: string;
}

export const AXE_EXCEPTIONS: AxeException[] = [
  // (empty — the strict policy launched clean; keep it that way)
];

/** True when a violating node is covered by a live (unexpired) exception. */
export function isExcepted(route: string, rule: string, target: string, now: Date): boolean {
  return AXE_EXCEPTIONS.some((e) =>
    e.rule === rule && e.route === route && target.startsWith(e.selectorPrefix) && new Date(e.expires) > now,
  );
}

/** Rows whose expiry has passed — each one fails the suite loudly. */
export function expiredExceptions(now: Date): AxeException[] {
  return AXE_EXCEPTIONS.filter((e) => new Date(e.expires) <= now);
}
