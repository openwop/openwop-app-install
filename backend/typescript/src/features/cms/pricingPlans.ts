/**
 * ADR 1069 D4 — the authored `pricing.plans` list, read back from a validated
 * section's data. ONE reader for every server projection (prerender HTML,
 * Markdown, the static share), so they cannot disagree about which plans a
 * section shows. The validator (`cmsService` `case 'pricing'`) is the only
 * writer; this reader stays defensive because a stored row is still `unknown`.
 *
 * A plan carries no price: there is no price field, and no projection invents one.
 */
export interface PricingPlan {
  name: string;
  status?: string;
  blurb?: string;
  ctaLabel?: string;
  ctaUrl: string;
  highlight: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function pricingPlans(d: Record<string, unknown>): PricingPlan[] {
  if (!Array.isArray(d.plans)) return [];
  return (d.plans as unknown[]).flatMap((p) => {
    const pp = (p ?? {}) as Record<string, unknown>;
    const name = str(pp.name).trim();
    if (!name) return [];
    return [{
      name,
      ...(str(pp.status) ? { status: str(pp.status) } : {}),
      ...(str(pp.blurb) ? { blurb: str(pp.blurb) } : {}),
      ...(str(pp.ctaLabel) ? { ctaLabel: str(pp.ctaLabel) } : {}),
      ctaUrl: str(pp.ctaUrl),
      highlight: pp.highlight === true,
    }];
  });
}
