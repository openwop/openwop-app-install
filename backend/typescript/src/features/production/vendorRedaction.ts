/**
 * Vendor pricing redaction (ADR 0356 P6) — the ONE place vendor `priceRanges`
 * visibility is decided. Pricing is sensitive (the spec's editors+ rule): only
 * a caller holding `host:members:manage` in the org sees it; every other
 * projection — REST reads without the scope, the `ctx.features.production`
 * workflow/agent surface, the KB index — gets the redacted shape. Extracted
 * from the route-local implementation (grade-pass ORCH-CODE-1) so the surface
 * and KB paths can't drift unredacted again. Fail-closed: redact whenever the
 * capability check errors or the caller has no principal (system runs).
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

export function redactVendorPricing<T extends { priceRanges?: unknown }>(v: T, canSee: boolean): T {
  if (canSee) return v;
  const { priceRanges: _p, ...rest } = v;
  return rest as T;
}

/** Does `subject` hold `host:members:manage` in the org? Absent subject (a
 *  system run — no human principal) or a check failure → false (redact). */
export async function canSeeVendorPricing(tenantId: string, orgId: string, subject: string | undefined): Promise<boolean> {
  if (!subject) return false;
  try {
    const { resolveEffectiveAccess } = await import('../../host/accessControlService.js');
    const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
    return access.scopes.includes('host:members:manage');
  } catch {
    return false;
  }
}
