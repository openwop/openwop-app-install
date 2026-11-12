/**
 * ADR 1104 — the CMS integrity gauge: the ADR 1038 data probes (PROBE-1038-1…3
 * in docs/steward/DATA-ASSESSMENT-adr1038.md), counted once a day across every
 * tenant's pages and logged as aggregates. Each count is expected to be 0.
 *
 *  - staleItemOverlays: a locale overlay whose list items carry presentation
 *    keys (`state`, …) that differ from the base at the same index. Page saves
 *    sync them since M38-1, so only rows written before that fix can count;
 *    `resolveSection` (the RFC 0103 merge) serves the overlay's copy, so these
 *    show on translated pages until the page is saved again.
 *  - dormantHeroFlows: a hero holding `flow` while its visual is not `flow`
 *    (invisible to humans and, since FLOW-4, to crawlers).
 *  - oversizedFlowOverlays: a columns `flow` whose overlay holds more steps than
 *    the base may (the cap is checked on the base layer only).
 */
import { INTEGRITY_GAUGE_ROW_CAP } from '../../host/integrityGauges.js';
import { FLOW_MAX_NODES, listAllPagesForIntegrityGauge, restoreItemStates, type Page } from './cmsService.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type CmsIntegrityCounts = {
  pages: number;
  sections: number;
  tenants: number;
  staleItemOverlays: number;
  staleItemPages: number;
  dormantHeroFlows: number;
  oversizedFlowOverlays: number;
};

/** Pure: the probe counts over a set of pages. */
export function countCmsIntegrity(pages: readonly Page[]): CmsIntegrityCounts {
  const tenants = new Set<string>();
  let sections = 0, staleItemOverlays = 0, dormantHeroFlows = 0, oversizedFlowOverlays = 0;
  const stalePages = new Set<string>();
  for (const page of pages) {
    tenants.add(page.tenantId);
    for (const section of page.sections ?? []) {
      sections += 1;
      const data = isObj(section.data) ? section.data : {};
      if (section.type === 'hero' && isObj(data.flow) && data.visual !== 'flow') dormantHeroFlows += 1;
      for (const overlay of Object.values(section.localizations ?? {})) {
        if (!isObj(overlay)) continue;
        if (JSON.stringify(restoreItemStates(data, overlay)) !== JSON.stringify(overlay)) {
          staleItemOverlays += 1;
          stalePages.add(`${page.tenantId}\u0000${page.pageId}`);
        }
        if (section.type === 'columns' && data.layout === 'flow' && Array.isArray(overlay.columns) && overlay.columns.length > FLOW_MAX_NODES) {
          oversizedFlowOverlays += 1;
        }
      }
    }
  }
  return {
    pages: pages.length, sections, tenants: tenants.size,
    staleItemOverlays, staleItemPages: stalePages.size, dormantHeroFlows, oversizedFlowOverlays,
  };
}

/** The registered gauge: every tenant's pages (capped per tenant), counted.
 *  With `truncatedTenants > 0` every count is a floor. */
export async function cmsIntegrityGauge(): Promise<CmsIntegrityCounts & { truncatedTenants: number }> {
  const { pages, truncatedTenants } = await listAllPagesForIntegrityGauge(INTEGRITY_GAUGE_ROW_CAP);
  return { ...countCmsIntegrity(pages), truncatedTenants };
}
